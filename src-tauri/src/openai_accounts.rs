//! Native, profile-scoped ChatGPT subscription credential registry.
//!
//! The registry deliberately separates display-safe metadata from OAuth
//! credentials. Registry and profile payloads use independently verified A/B
//! slots, and all account identity comparisons use an installation-local HMAC
//! rather than persisting the raw remote account ID in the index.

use crate::secrets::{
    clear_legacy_openai_oauth_from, load_legacy_openai_oauth_from, OpenAiOAuthTokens, SecretStore,
    SecretStoreError, SystemSecretStore,
};
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD};
use base64::Engine as _;
use hmac::{Hmac, Mac as _};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest as _, Sha256};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::str::FromStr;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use thiserror::Error;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use uuid::Uuid;

const SCHEMA_VERSION: u8 = 1;
const REGISTRY_PREFIX: &str = "openai-accounts-v1-registry";
const MIGRATION_PREFIX: &str = "openai-accounts-v1-migration";
const PROFILE_PREFIX: &str = "openai-accounts-v1-profile";
const IDENTITY_HMAC_KEY: &str = "openai-accounts-v1-identity-hmac-key";
const CHUNK_CHARS: usize = 1_024;
const MAX_CHUNKS: usize = 64;
const MAX_ACCOUNTS: usize = 64;
const MAX_REGISTRY_BYTES: usize = 128 * 1_024;
const MAX_PROFILE_BYTES: usize = 48 * 1_024;
const MAX_JOURNAL_BYTES: usize = 8 * 1_024;
// Keep this identical to the authenticated-request header bound. A profile that
// the registry accepts must never become unusable only when a request is built.
const MAX_REMOTE_ID_BYTES: usize = 512;
const MAX_LABEL_CHARS: usize = 320;
const MAX_TIER_CHARS: usize = 64;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Error)]
pub enum OpenAiAccountError {
    #[error(transparent)]
    Storage(#[from] SecretStoreError),
    #[error("invalid account profile id; expected a canonical UUID")]
    InvalidProfileId,
    #[error("ChatGPT account profile was not found")]
    ProfileNotFound,
    #[error("ChatGPT account profile was removed")]
    ProfileRemoved,
    #[error("ChatGPT account must be reconnected")]
    ReconnectRequired,
    #[error("ChatGPT sign-in did not provide a stable account identity")]
    MissingRemoteIdentity,
    #[error("the signed-in ChatGPT account does not match this profile")]
    IdentityMismatch,
    #[error("the ChatGPT credential changed while this operation was in flight")]
    CredentialConflict,
    #[error("the ChatGPT account profile has an active run")]
    ActiveRuns,
    #[error("the ChatGPT account profile is already being removed")]
    RemovalInProgress,
    #[error("another ChatGPT browser sign-in is already in progress")]
    LoginInProgress,
    #[error("the ChatGPT account registry reached its {MAX_ACCOUNTS}-profile limit")]
    RegistryFull,
    #[error("ChatGPT account registry data is invalid: {0}")]
    InvalidRegistry(String),
}

impl OpenAiAccountError {
    /// Stable, display-safe text for IPC and streamed errors. Internal storage
    /// details are intentionally collapsed so malformed secret values, keyring
    /// diagnostics, and local paths can never cross the native boundary.
    pub fn user_message(&self) -> &'static str {
        match self {
            Self::InvalidProfileId => "Invalid ChatGPT account profile. Choose the account again.",
            Self::ProfileNotFound => "ChatGPT account profile was not found.",
            Self::ProfileRemoved => "This ChatGPT account was removed. Reconnect it before use.",
            Self::ReconnectRequired => "This ChatGPT account must be reconnected before use.",
            Self::MissingRemoteIdentity => {
                "ChatGPT sign-in did not provide a stable account identity."
            }
            Self::IdentityMismatch => "The signed-in ChatGPT account does not match this profile.",
            Self::CredentialConflict => {
                "The ChatGPT credential changed during this request. Please retry."
            }
            Self::ActiveRuns => "Finish this ChatGPT account's active work before removing it.",
            Self::RemovalInProgress => "This ChatGPT account is currently being removed.",
            Self::LoginInProgress => "Another ChatGPT browser sign-in is already in progress.",
            Self::RegistryFull => "The local ChatGPT account limit has been reached.",
            Self::Storage(_) | Self::InvalidRegistry(_) => {
                "ChatGPT account storage is unavailable or corrupt. No credentials were changed."
            }
        }
    }
}

/// Opaque, filesystem-safe local account identity. Parsing rejects alternate
/// UUID spellings so an untrusted IPC value cannot influence credential keys.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AccountProfileId(String);

impl AccountProfileId {
    pub fn new() -> Self {
        Self(Uuid::new_v4().hyphenated().to_string())
    }

    pub fn parse(value: &str) -> Result<Self, OpenAiAccountError> {
        let uuid = Uuid::parse_str(value).map_err(|_| OpenAiAccountError::InvalidProfileId)?;
        let canonical = uuid.hyphenated().to_string();
        if value != canonical {
            return Err(OpenAiAccountError::InvalidProfileId);
        }
        Ok(Self(canonical))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for AccountProfileId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for AccountProfileId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for AccountProfileId {
    type Err = OpenAiAccountError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

impl Serialize for AccountProfileId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for AccountProfileId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenAiAccountState {
    Connected,
    ReconnectRequired,
    Removed,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiAccountSummary {
    pub id: AccountProfileId,
    pub account_label: Option<String>,
    pub tier: Option<String>,
    pub expires_at: Option<i64>,
    pub state: OpenAiAccountState,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenAiAccountProfile {
    pub id: AccountProfileId,
    pub tokens: OpenAiOAuthTokens,
    /// Optimistic concurrency token for credential replacement. Old profile
    /// payloads deserialize as generation zero and advance on their next write.
    #[serde(default)]
    pub credential_generation: u64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct RegistryIndex {
    schema: u8,
    generation: u64,
    profiles: Vec<RegistryEntry>,
}

impl Default for RegistryIndex {
    fn default() -> Self {
        Self {
            schema: SCHEMA_VERSION,
            generation: 0,
            profiles: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct RegistryEntry {
    id: AccountProfileId,
    identity_fingerprint: String,
    #[serde(default)]
    credential_generation: u64,
    account_label: Option<String>,
    tier: Option<String>,
    expires_at: Option<i64>,
    state: OpenAiAccountState,
    created_at: i64,
    updated_at: i64,
    last_used_at: Option<i64>,
}

impl RegistryEntry {
    fn summary(&self, state: OpenAiAccountState) -> OpenAiAccountSummary {
        OpenAiAccountSummary {
            id: self.id.clone(),
            account_label: self.account_label.clone(),
            tier: self.tier.clone(),
            expires_at: self.expires_at,
            state,
            created_at: self.created_at,
            updated_at: self.updated_at,
            last_used_at: self.last_used_at,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct BlobManifest {
    schema: u8,
    slot: String,
    chunks: usize,
    byte_len: usize,
    sha256: String,
    generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum MigrationPhase {
    Reserved,
    ProfileWritten,
    Indexed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct MigrationJournal {
    schema: u8,
    id: AccountProfileId,
    identity_fingerprint: String,
    created_at: i64,
    phase: MigrationPhase,
}

fn manifest_key(prefix: &str) -> String {
    format!("{prefix}-manifest")
}

fn chunk_key(prefix: &str, slot: &str, index: usize) -> String {
    format!("{prefix}-{slot}-{index}")
}

fn profile_prefix(id: &AccountProfileId) -> String {
    format!("{PROFILE_PREFIX}-{}", id.as_str())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn base64_encoded_len(byte_len: usize) -> Option<usize> {
    byte_len.checked_add(2)?.checked_div(3)?.checked_mul(4)
}

fn read_manifest(
    store: &dyn SecretStore,
    prefix: &str,
    max_bytes: usize,
) -> Result<Option<BlobManifest>, SecretStoreError> {
    let value = match store.get(&manifest_key(prefix)) {
        Ok(value) => value,
        Err(SecretStoreError::Absent) => return Ok(None),
        Err(error) => return Err(error),
    };
    let manifest: BlobManifest = serde_json::from_str(&value)
        .map_err(|_| SecretStoreError::Corrupt(format!("invalid manifest JSON for {prefix}")))?;
    let expected_encoded_len = base64_encoded_len(manifest.byte_len);
    let expected_chunks = expected_encoded_len
        .and_then(|length| length.checked_add(CHUNK_CHARS - 1))
        .map(|length| length / CHUNK_CHARS);
    if manifest.schema != SCHEMA_VERSION
        || !matches!(manifest.slot.as_str(), "a" | "b")
        || !(1..=MAX_CHUNKS).contains(&manifest.chunks)
        || manifest.byte_len == 0
        || manifest.byte_len > max_bytes
        || expected_chunks != Some(manifest.chunks)
        || !valid_sha256(&manifest.sha256)
    {
        return Err(SecretStoreError::Corrupt(format!(
            "invalid manifest for {prefix}"
        )));
    }
    Ok(Some(manifest))
}

fn read_slot(
    store: &dyn SecretStore,
    prefix: &str,
    manifest: &BlobManifest,
) -> Result<Vec<u8>, SecretStoreError> {
    let expected_encoded_len = base64_encoded_len(manifest.byte_len)
        .ok_or_else(|| SecretStoreError::Corrupt(format!("invalid length for {prefix}")))?;
    let mut encoded = String::with_capacity(expected_encoded_len);
    for index in 0..manifest.chunks {
        match store.get(&chunk_key(prefix, &manifest.slot, index)) {
            Ok(chunk) => {
                let remaining = expected_encoded_len.saturating_sub(encoded.len());
                let expected_chunk_len = remaining.min(CHUNK_CHARS);
                if chunk.len() != expected_chunk_len || !chunk.is_ascii() {
                    return Err(SecretStoreError::Corrupt(format!(
                        "invalid chunk length or encoding for {prefix}"
                    )));
                }
                encoded.push_str(&chunk);
            }
            Err(SecretStoreError::Absent) => {
                return Err(SecretStoreError::Integrity(format!(
                    "missing chunk {index} for {prefix}"
                )));
            }
            Err(error) => return Err(error),
        }
    }
    if encoded.len() != expected_encoded_len {
        return Err(SecretStoreError::Integrity(format!(
            "encoded length mismatch for {prefix}"
        )));
    }
    let bytes = B64
        .decode(encoded)
        .map_err(|_| SecretStoreError::Corrupt(format!("invalid base64 for {prefix}")))?;
    if bytes.len() != manifest.byte_len || sha256_hex(&bytes) != manifest.sha256 {
        return Err(SecretStoreError::Integrity(format!(
            "length or digest mismatch for {prefix}"
        )));
    }
    Ok(bytes)
}

fn read_blob<T: DeserializeOwned>(
    store: &dyn SecretStore,
    prefix: &str,
    max_bytes: usize,
) -> Result<Option<T>, SecretStoreError> {
    let Some(manifest) = read_manifest(store, prefix, max_bytes)? else {
        return Ok(None);
    };
    let bytes = read_slot(store, prefix, &manifest)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| SecretStoreError::Corrupt(format!("invalid payload JSON for {prefix}")))
}

fn delete_slot(
    store: &dyn SecretStore,
    prefix: &str,
    slot: &str,
    chunks: usize,
) -> Result<(), SecretStoreError> {
    let mut first_error = None;
    for index in 0..chunks.min(MAX_CHUNKS) {
        if let Err(error) = store.delete(&chunk_key(prefix, slot, index)) {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn write_blob<T: Serialize>(
    store: &dyn SecretStore,
    prefix: &str,
    max_bytes: usize,
    value: &T,
) -> Result<(), SecretStoreError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| SecretStoreError::Corrupt(format!("could not serialize {prefix}")))?;
    if bytes.is_empty() || bytes.len() > max_bytes {
        return Err(SecretStoreError::TooLarge(format!(
            "{prefix} exceeds {max_bytes} bytes"
        )));
    }
    let encoded = B64.encode(&bytes);
    let chunks: Vec<&str> = encoded
        .as_bytes()
        .chunks(CHUNK_CHARS)
        .map(|chunk| std::str::from_utf8(chunk).expect("base64 is ASCII"))
        .collect();
    if chunks.is_empty() || chunks.len() > MAX_CHUNKS {
        return Err(SecretStoreError::TooLarge(format!(
            "{prefix} exceeds {MAX_CHUNKS} chunks"
        )));
    }

    let previous = read_manifest(store, prefix, max_bytes)?;
    let slot = if previous
        .as_ref()
        .is_some_and(|manifest| manifest.slot == "a")
    {
        "b"
    } else {
        "a"
    };
    for (index, chunk) in chunks.iter().enumerate() {
        if let Err(error) = store.set(&chunk_key(prefix, slot, index), chunk) {
            let _ = delete_slot(store, prefix, slot, index);
            return Err(error);
        }
    }

    let next_generation = match previous.as_ref() {
        Some(current) => current.generation.checked_add(1).ok_or_else(|| {
            SecretStoreError::Corrupt(format!("generation overflow for {prefix}"))
        })?,
        None => 1,
    };
    let manifest = BlobManifest {
        schema: SCHEMA_VERSION,
        slot: slot.into(),
        chunks: chunks.len(),
        byte_len: bytes.len(),
        sha256: sha256_hex(&bytes),
        generation: next_generation,
    };
    // Verify the complete inactive slot before changing the authoritative key.
    if read_slot(store, prefix, &manifest)? != bytes {
        let _ = delete_slot(store, prefix, slot, chunks.len());
        return Err(SecretStoreError::Integrity(format!(
            "pre-commit verification failed for {prefix}"
        )));
    }
    if read_manifest(store, prefix, max_bytes)? != previous {
        let _ = delete_slot(store, prefix, slot, chunks.len());
        return Err(SecretStoreError::Conflict);
    }
    let manifest_json = serde_json::to_string(&manifest)
        .map_err(|_| SecretStoreError::Corrupt(format!("could not serialize {prefix} manifest")))?;
    if let Err(error) = store.set(&manifest_key(prefix), &manifest_json) {
        let _ = delete_slot(store, prefix, slot, chunks.len());
        return Err(error);
    }
    let committed_manifest = read_manifest(store, prefix, max_bytes)?
        .ok_or_else(|| SecretStoreError::Integrity(format!("missing commit for {prefix}")))?;
    if read_slot(store, prefix, &committed_manifest)? != bytes {
        return Err(SecretStoreError::Integrity(format!(
            "post-commit verification failed for {prefix}"
        )));
    }
    if let Some(previous) = previous.filter(|old| old.slot != slot) {
        let _ = delete_slot(store, prefix, &previous.slot, previous.chunks);
    }
    Ok(())
}

fn delete_blob(store: &dyn SecretStore, prefix: &str) -> Result<(), SecretStoreError> {
    // Deleting the manifest first makes every remaining chunk unreachable.
    store.delete(&manifest_key(prefix))?;
    let mut first_error = None;
    for slot in ["a", "b"] {
        if let Err(error) = delete_slot(store, prefix, slot, MAX_CHUNKS) {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn normalize_display(value: Option<&str>, max_chars: usize) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    let sanitized: String = value
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect();
    (!sanitized.is_empty()).then_some(sanitized)
}

fn remote_identity(tokens: &OpenAiOAuthTokens) -> Result<&str, OpenAiAccountError> {
    let value = tokens
        .account_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or(OpenAiAccountError::MissingRemoteIdentity)?;
    if value.len() > MAX_REMOTE_ID_BYTES || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(OpenAiAccountError::MissingRemoteIdentity);
    }
    Ok(value)
}

fn decode_identity_key(value: &str) -> Result<[u8; 32], SecretStoreError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| SecretStoreError::Corrupt("invalid identity HMAC key".into()))?;
    bytes
        .try_into()
        .map_err(|_| SecretStoreError::Corrupt("invalid identity HMAC key length".into()))
}

fn identity_key(store: &dyn SecretStore, allow_create: bool) -> Result<[u8; 32], SecretStoreError> {
    match store.get(IDENTITY_HMAC_KEY) {
        Ok(value) => decode_identity_key(&value),
        Err(SecretStoreError::Absent) if allow_create => {
            let generated: [u8; 32] = rand::random();
            store.set(IDENTITY_HMAC_KEY, &URL_SAFE_NO_PAD.encode(generated))?;
            let stored = store.get(IDENTITY_HMAC_KEY)?;
            decode_identity_key(&stored)
        }
        Err(SecretStoreError::Absent) => Err(SecretStoreError::Integrity(
            "identity HMAC key is missing for an existing registry".into(),
        )),
        Err(error) => Err(error),
    }
}

fn identity_fingerprint(key: &[u8; 32], remote_id: &str) -> String {
    let mut hmac = HmacSha256::new_from_slice(key).expect("HMAC accepts 32-byte keys");
    hmac.update(remote_id.as_bytes());
    hmac.finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn validate_index(index: &RegistryIndex) -> Result<(), OpenAiAccountError> {
    if index.schema != SCHEMA_VERSION {
        return Err(OpenAiAccountError::InvalidRegistry(
            "unsupported schema version".into(),
        ));
    }
    if index.profiles.len() > MAX_ACCOUNTS {
        return Err(OpenAiAccountError::InvalidRegistry(
            "profile count exceeds bound".into(),
        ));
    }
    let mut ids = HashSet::with_capacity(index.profiles.len());
    let mut fingerprints = HashSet::with_capacity(index.profiles.len());
    for entry in &index.profiles {
        if !ids.insert(entry.id.clone()) || !fingerprints.insert(&entry.identity_fingerprint) {
            return Err(OpenAiAccountError::InvalidRegistry(
                "duplicate profile identity".into(),
            ));
        }
        if !valid_sha256(&entry.identity_fingerprint)
            || entry
                .account_label
                .as_ref()
                .is_some_and(|value| value.chars().count() > MAX_LABEL_CHARS)
            || entry
                .tier
                .as_ref()
                .is_some_and(|value| value.chars().count() > MAX_TIER_CHARS)
        {
            return Err(OpenAiAccountError::InvalidRegistry(
                "invalid profile metadata".into(),
            ));
        }
    }
    Ok(())
}

fn load_index(store: &dyn SecretStore) -> Result<RegistryIndex, OpenAiAccountError> {
    let index = read_blob(store, REGISTRY_PREFIX, MAX_REGISTRY_BYTES)?.unwrap_or_default();
    validate_index(&index)?;
    Ok(index)
}

fn persist_index(
    store: &dyn SecretStore,
    index: &mut RegistryIndex,
    expected_generation: u64,
) -> Result<(), OpenAiAccountError> {
    let current = load_index(store)?;
    if current.generation != expected_generation {
        return Err(SecretStoreError::Conflict.into());
    }
    index.generation = expected_generation
        .checked_add(1)
        .ok_or_else(|| OpenAiAccountError::InvalidRegistry("generation overflow".into()))?;
    validate_index(index)?;
    write_blob(store, REGISTRY_PREFIX, MAX_REGISTRY_BYTES, index)?;
    Ok(())
}

fn profile_from_tokens(
    id: AccountProfileId,
    previous: Option<&OpenAiAccountProfile>,
    persisted_generation: u64,
    tokens: OpenAiOAuthTokens,
    now: i64,
) -> Result<OpenAiAccountProfile, OpenAiAccountError> {
    let credential_generation = previous
        .map_or(0, |profile| profile.credential_generation)
        .max(persisted_generation)
        .checked_add(1)
        .ok_or_else(|| {
            OpenAiAccountError::InvalidRegistry("credential generation overflow".into())
        })?;
    Ok(OpenAiAccountProfile {
        id,
        tokens,
        credential_generation,
        created_at: previous.map_or(now, |profile| profile.created_at),
        updated_at: now,
        last_used_at: previous.and_then(|profile| profile.last_used_at),
    })
}

fn entry_from_profile(
    profile: &OpenAiAccountProfile,
    fingerprint: String,
    state: OpenAiAccountState,
) -> RegistryEntry {
    RegistryEntry {
        id: profile.id.clone(),
        identity_fingerprint: fingerprint,
        credential_generation: profile.credential_generation,
        account_label: normalize_display(profile.tokens.email.as_deref(), MAX_LABEL_CHARS),
        tier: normalize_display(profile.tokens.plan.as_deref(), MAX_TIER_CHARS),
        expires_at: Some(profile.tokens.expires_at),
        state,
        created_at: profile.created_at,
        updated_at: profile.updated_at,
        last_used_at: profile.last_used_at,
    }
}

fn write_profile(
    store: &dyn SecretStore,
    profile: &OpenAiAccountProfile,
) -> Result<(), OpenAiAccountError> {
    // Re-parse even generated IDs at the key boundary; deserialized/test values
    // cannot bypass canonical path construction.
    AccountProfileId::parse(profile.id.as_str())?;
    write_blob(
        store,
        &profile_prefix(&profile.id),
        MAX_PROFILE_BYTES,
        profile,
    )?;
    let written: OpenAiAccountProfile =
        read_blob(store, &profile_prefix(&profile.id), MAX_PROFILE_BYTES)?.ok_or(
            SecretStoreError::Integrity("profile disappeared after commit".into()),
        )?;
    if written != *profile {
        return Err(SecretStoreError::Integrity("profile readback mismatch".into()).into());
    }
    Ok(())
}

fn load_profile_blob(
    store: &dyn SecretStore,
    id: &AccountProfileId,
) -> Result<Option<OpenAiAccountProfile>, OpenAiAccountError> {
    AccountProfileId::parse(id.as_str())?;
    let profile: Option<OpenAiAccountProfile> =
        read_blob(store, &profile_prefix(id), MAX_PROFILE_BYTES)?;
    if profile.as_ref().is_some_and(|profile| profile.id != *id) {
        return Err(SecretStoreError::Integrity("profile id mismatch".into()).into());
    }
    Ok(profile)
}

fn load_profile_for_replacement(
    store: &dyn SecretStore,
    id: &AccountProfileId,
) -> Result<Option<OpenAiAccountProfile>, OpenAiAccountError> {
    // A genuinely missing manifest is already represented by `Ok(None)` from
    // `read_blob`. Any error after a manifest exists means the committed profile
    // is unreadable and must be preserved for recovery; treating corruption as
    // absence would let login/reconnect overwrite its inactive slot and flip the
    // authoritative manifest over recoverable evidence.
    load_profile_blob(store, id)
}

fn validate_profile_for_replacement(
    profile: Option<&OpenAiAccountProfile>,
    identity_key: &[u8; 32],
    expected_fingerprint: &str,
    indexed_generation: u64,
) -> Result<(), OpenAiAccountError> {
    let Some(profile) = profile else {
        return Ok(());
    };
    let remote = remote_identity(&profile.tokens)?;
    if identity_fingerprint(identity_key, remote) != expected_fingerprint {
        return Err(SecretStoreError::Integrity(
            "replacement profile identity does not match the registry".into(),
        )
        .into());
    }
    if profile.credential_generation < indexed_generation {
        return Err(SecretStoreError::Integrity(
            "replacement profile generation is older than the registry".into(),
        )
        .into());
    }
    Ok(())
}

fn verify_indexed_migration(
    store: &dyn SecretStore,
    journal: &MigrationJournal,
) -> Result<AccountProfileId, OpenAiAccountError> {
    if journal.schema != SCHEMA_VERSION || journal.phase != MigrationPhase::Indexed {
        return Err(SecretStoreError::Integrity(
            "migration cleanup requires an indexed journal".into(),
        )
        .into());
    }
    let index = load_index(store)?;
    let entry = index
        .profiles
        .iter()
        .find(|entry| entry.id == journal.id)
        .ok_or_else(|| {
            SecretStoreError::Integrity(
                "indexed migration profile is missing from the registry".into(),
            )
        })?;
    if entry.state != OpenAiAccountState::Connected
        || entry.identity_fingerprint != journal.identity_fingerprint
    {
        return Err(SecretStoreError::Integrity(
            "indexed migration journal does not match the registry".into(),
        )
        .into());
    }
    let profile = load_profile_blob(store, &entry.id)?.ok_or_else(|| {
        SecretStoreError::Integrity(
            "indexed migration profile is missing before legacy cleanup".into(),
        )
    })?;
    let remote = remote_identity(&profile.tokens)?;
    let fingerprint = identity_fingerprint(&identity_key(store, false)?, remote);
    if fingerprint != entry.identity_fingerprint
        || fingerprint != journal.identity_fingerprint
        || profile.credential_generation != entry.credential_generation
    {
        return Err(SecretStoreError::Integrity(
            "indexed migration profile failed identity verification".into(),
        )
        .into());
    }
    Ok(entry.id.clone())
}

#[derive(Default)]
struct LifecycleState {
    active_runs: usize,
    removing: bool,
}

#[derive(Default)]
struct ProfileLifecycle {
    states: Mutex<HashMap<AccountProfileId, LifecycleState>>,
}

impl ProfileLifecycle {
    fn acquire(
        self: &Arc<Self>,
        id: &AccountProfileId,
    ) -> Result<ProfileRunLease, OpenAiAccountError> {
        let mut states = self
            .states
            .lock()
            .map_err(|_| SecretStoreError::Backend("account lifecycle lock poisoned".into()))?;
        let state = states.entry(id.clone()).or_default();
        if state.removing {
            return Err(OpenAiAccountError::RemovalInProgress);
        }
        state.active_runs = state.active_runs.checked_add(1).ok_or_else(|| {
            SecretStoreError::Backend("account run-lease counter overflow".into())
        })?;
        Ok(ProfileRunLease {
            lifecycle: Arc::clone(self),
            id: id.clone(),
        })
    }

    fn begin_removal(
        self: &Arc<Self>,
        id: &AccountProfileId,
    ) -> Result<ProfileRemovalLease, OpenAiAccountError> {
        let mut states = self
            .states
            .lock()
            .map_err(|_| SecretStoreError::Backend("account lifecycle lock poisoned".into()))?;
        let state = states.entry(id.clone()).or_default();
        if state.removing {
            return Err(OpenAiAccountError::RemovalInProgress);
        }
        if state.active_runs != 0 {
            return Err(OpenAiAccountError::ActiveRuns);
        }
        state.removing = true;
        Ok(ProfileRemovalLease {
            lifecycle: Arc::clone(self),
            id: id.clone(),
        })
    }
}

/// Holds a profile admission from credential resolution through the terminal
/// turn receipt. Dropping it atomically re-enables account removal.
pub struct ProfileRunLease {
    lifecycle: Arc<ProfileLifecycle>,
    id: AccountProfileId,
}

impl Drop for ProfileRunLease {
    fn drop(&mut self) {
        if let Ok(mut states) = self.lifecycle.states.lock() {
            if let Some(state) = states.get_mut(&self.id) {
                state.active_runs = state.active_runs.saturating_sub(1);
                if state.active_runs == 0 && !state.removing {
                    states.remove(&self.id);
                }
            }
        }
    }
}

struct ProfileRemovalLease {
    lifecycle: Arc<ProfileLifecycle>,
    id: AccountProfileId,
}

impl Drop for ProfileRemovalLease {
    fn drop(&mut self) {
        if let Ok(mut states) = self.lifecycle.states.lock() {
            if let Some(state) = states.get_mut(&self.id) {
                state.removing = false;
                if state.active_runs == 0 {
                    states.remove(&self.id);
                }
            }
        }
    }
}

#[derive(Default)]
struct ProfileRefreshLocks {
    locks: Mutex<HashMap<AccountProfileId, Weak<AsyncMutex<()>>>>,
}

impl ProfileRefreshLocks {
    fn mutex_for(&self, id: &AccountProfileId) -> Result<Arc<AsyncMutex<()>>, OpenAiAccountError> {
        let mut locks = self
            .locks
            .lock()
            .map_err(|_| SecretStoreError::Backend("refresh-lock map poisoned".into()))?;
        locks.retain(|_, weak| weak.strong_count() != 0);
        if let Some(lock) = locks.get(id).and_then(Weak::upgrade) {
            return Ok(lock);
        }
        let lock = Arc::new(AsyncMutex::new(()));
        locks.insert(id.clone(), Arc::downgrade(&lock));
        Ok(lock)
    }
}

struct RegistrySynchronization {
    commit: Mutex<()>,
    browser_login: Arc<AsyncMutex<()>>,
    refresh: ProfileRefreshLocks,
    lifecycle: Arc<ProfileLifecycle>,
}

impl Default for RegistrySynchronization {
    fn default() -> Self {
        Self {
            commit: Mutex::new(()),
            browser_login: Arc::new(AsyncMutex::new(())),
            refresh: ProfileRefreshLocks::default(),
            lifecycle: Arc::new(ProfileLifecycle::default()),
        }
    }
}

static SYSTEM_SYNCHRONIZATION: OnceLock<Arc<RegistrySynchronization>> = OnceLock::new();

#[derive(Clone)]
pub struct OpenAiAccountRegistry {
    store: Arc<dyn SecretStore>,
    synchronization: Arc<RegistrySynchronization>,
}

impl Default for OpenAiAccountRegistry {
    fn default() -> Self {
        Self::system()
    }
}

impl OpenAiAccountRegistry {
    pub fn system() -> Self {
        Self {
            store: Arc::new(SystemSecretStore),
            synchronization: Arc::clone(
                SYSTEM_SYNCHRONIZATION.get_or_init(|| Arc::new(RegistrySynchronization::default())),
            ),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_store(store: Arc<dyn SecretStore>) -> Self {
        Self {
            store,
            synchronization: Arc::new(RegistrySynchronization::default()),
        }
    }

    fn commit_guard(&self) -> Result<std::sync::MutexGuard<'_, ()>, OpenAiAccountError> {
        self.synchronization
            .commit
            .lock()
            .map_err(|_| SecretStoreError::Backend("registry commit lock poisoned".into()).into())
    }

    pub async fn lock_browser_login(&self) -> OwnedMutexGuard<()> {
        Arc::clone(&self.synchronization.browser_login)
            .lock_owned()
            .await
    }

    pub fn try_lock_browser_login(&self) -> Result<OwnedMutexGuard<()>, OpenAiAccountError> {
        Arc::clone(&self.synchronization.browser_login)
            .try_lock_owned()
            .map_err(|_| OpenAiAccountError::LoginInProgress)
    }

    pub async fn lock_refresh(
        &self,
        id: &AccountProfileId,
    ) -> Result<OwnedMutexGuard<()>, OpenAiAccountError> {
        let lock = self.synchronization.refresh.mutex_for(id)?;
        Ok(lock.lock_owned().await)
    }

    pub fn acquire_run_lease(
        &self,
        id: &AccountProfileId,
    ) -> Result<ProfileRunLease, OpenAiAccountError> {
        self.synchronization.lifecycle.acquire(id)
    }

    pub fn list_accounts(&self) -> Result<Vec<OpenAiAccountSummary>, OpenAiAccountError> {
        let _guard = self.commit_guard()?;
        let index = load_index(self.store.as_ref())?;
        let key = (!index.profiles.is_empty())
            .then(|| identity_key(self.store.as_ref(), false))
            .transpose()?;
        let mut summaries = Vec::with_capacity(index.profiles.len());
        for entry in &index.profiles {
            let effective_state = match entry.state {
                OpenAiAccountState::Connected => {
                    match load_profile_blob(self.store.as_ref(), &entry.id)? {
                        Some(profile) => {
                            let remote = remote_identity(&profile.tokens)?;
                            let fingerprint = identity_fingerprint(
                                key.as_ref().expect("connected profile loads identity key"),
                                remote,
                            );
                            if fingerprint != entry.identity_fingerprint {
                                return Err(SecretStoreError::Integrity(
                                    "profile identity mismatch".into(),
                                )
                                .into());
                            }
                            if profile.credential_generation < entry.credential_generation {
                                return Err(SecretStoreError::Integrity(
                                    "profile credential generation is older than the registry"
                                        .into(),
                                )
                                .into());
                            }
                            OpenAiAccountState::Connected
                        }
                        None => OpenAiAccountState::Unavailable,
                    }
                }
                state => state,
            };
            summaries.push(entry.summary(effective_state));
        }
        summaries.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(summaries)
    }

    pub fn load_profile(
        &self,
        id: &AccountProfileId,
    ) -> Result<OpenAiAccountProfile, OpenAiAccountError> {
        let _guard = self.commit_guard()?;
        let index = load_index(self.store.as_ref())?;
        let entry = index
            .profiles
            .iter()
            .find(|entry| entry.id == *id)
            .ok_or(OpenAiAccountError::ProfileNotFound)?;
        match entry.state {
            OpenAiAccountState::Removed => return Err(OpenAiAccountError::ProfileRemoved),
            OpenAiAccountState::ReconnectRequired => {
                return Err(OpenAiAccountError::ReconnectRequired);
            }
            OpenAiAccountState::Unavailable => {
                return Err(OpenAiAccountError::ReconnectRequired);
            }
            OpenAiAccountState::Connected => {}
        }
        let mut profile = load_profile_blob(self.store.as_ref(), id)?
            .ok_or(OpenAiAccountError::ReconnectRequired)?;
        let remote = remote_identity(&profile.tokens)?;
        let fingerprint = identity_fingerprint(&identity_key(self.store.as_ref(), false)?, remote);
        if fingerprint != entry.identity_fingerprint {
            return Err(SecretStoreError::Integrity("profile identity mismatch".into()).into());
        }
        if profile.credential_generation < entry.credential_generation {
            return Err(SecretStoreError::Integrity(
                "profile credential generation is older than the registry".into(),
            )
            .into());
        }
        profile.created_at = entry.created_at;
        profile.updated_at = entry.updated_at;
        profile.last_used_at = entry.last_used_at;
        Ok(profile)
    }

    pub fn register_account(
        &self,
        tokens: OpenAiOAuthTokens,
        now: i64,
    ) -> Result<OpenAiAccountSummary, OpenAiAccountError> {
        let remote = remote_identity(&tokens)?.to_owned();
        let _guard = self.commit_guard()?;
        let mut index = load_index(self.store.as_ref())?;
        let migration_exists = read_blob::<MigrationJournal>(
            self.store.as_ref(),
            MIGRATION_PREFIX,
            MAX_JOURNAL_BYTES,
        )?
        .is_some();
        let key = identity_key(
            self.store.as_ref(),
            index.profiles.is_empty() && !migration_exists,
        )?;
        let fingerprint = identity_fingerprint(&key, &remote);

        if let Some(position) = index
            .profiles
            .iter()
            .position(|entry| entry.identity_fingerprint == fingerprint)
        {
            let id = index.profiles[position].id.clone();
            let previous = load_profile_for_replacement(self.store.as_ref(), &id)?;
            validate_profile_for_replacement(
                previous.as_ref(),
                &key,
                &fingerprint,
                index.profiles[position].credential_generation,
            )?;
            let profile = profile_from_tokens(
                id,
                previous.as_ref(),
                index.profiles[position].credential_generation,
                tokens,
                now,
            )?;
            write_profile(self.store.as_ref(), &profile)?;
            let created_at = index.profiles[position].created_at;
            let last_used_at = index.profiles[position].last_used_at;
            let mut replacement =
                entry_from_profile(&profile, fingerprint, OpenAiAccountState::Connected);
            replacement.created_at = created_at;
            replacement.last_used_at = last_used_at;
            index.profiles[position] = replacement;
            let generation = index.generation;
            persist_index(self.store.as_ref(), &mut index, generation)?;
            return Ok(index.profiles[position].summary(OpenAiAccountState::Connected));
        }

        if index.profiles.len() >= MAX_ACCOUNTS {
            return Err(OpenAiAccountError::RegistryFull);
        }
        let id = AccountProfileId::new();
        let profile = profile_from_tokens(id.clone(), None, 0, tokens, now)?;
        let mut reserved = entry_from_profile(
            &profile,
            fingerprint.clone(),
            OpenAiAccountState::Unavailable,
        );
        reserved.expires_at = None;
        index.profiles.push(reserved);
        let position = index.profiles.len() - 1;
        let generation = index.generation;
        persist_index(self.store.as_ref(), &mut index, generation)?;

        // The recoverable reservation means a crash here reuses this ID on the
        // next login instead of leaking an unindexed profile under a new UUID.
        write_profile(self.store.as_ref(), &profile)?;
        index.profiles[position] =
            entry_from_profile(&profile, fingerprint, OpenAiAccountState::Connected);
        let generation = index.generation;
        persist_index(self.store.as_ref(), &mut index, generation)?;
        Ok(index.profiles[position].summary(OpenAiAccountState::Connected))
    }

    pub fn reconnect_account(
        &self,
        id: &AccountProfileId,
        tokens: OpenAiOAuthTokens,
        now: i64,
    ) -> Result<OpenAiAccountSummary, OpenAiAccountError> {
        let remote = remote_identity(&tokens)?.to_owned();
        let _guard = self.commit_guard()?;
        let mut index = load_index(self.store.as_ref())?;
        let key = identity_key(self.store.as_ref(), false)?;
        let fingerprint = identity_fingerprint(&key, &remote);
        let position = index
            .profiles
            .iter()
            .position(|entry| entry.id == *id)
            .ok_or(OpenAiAccountError::ProfileNotFound)?;
        if index.profiles[position].identity_fingerprint != fingerprint {
            return Err(OpenAiAccountError::IdentityMismatch);
        }
        let previous = load_profile_for_replacement(self.store.as_ref(), id)?;
        validate_profile_for_replacement(
            previous.as_ref(),
            &key,
            &fingerprint,
            index.profiles[position].credential_generation,
        )?;
        let profile = profile_from_tokens(
            id.clone(),
            previous.as_ref(),
            index.profiles[position].credential_generation,
            tokens,
            now,
        )?;
        write_profile(self.store.as_ref(), &profile)?;
        let created_at = index.profiles[position].created_at;
        let last_used_at = index.profiles[position].last_used_at;
        let mut replacement =
            entry_from_profile(&profile, fingerprint, OpenAiAccountState::Connected);
        replacement.created_at = created_at;
        replacement.last_used_at = last_used_at;
        index.profiles[position] = replacement;
        let generation = index.generation;
        persist_index(self.store.as_ref(), &mut index, generation)?;
        Ok(index.profiles[position].summary(OpenAiAccountState::Connected))
    }

    /// Store a refresh response only when it belongs to the expected local and
    /// remote identity. Missing or changed identity is never persisted.
    pub fn store_refreshed_profile(
        &self,
        id: &AccountProfileId,
        expected_generation: u64,
        tokens: OpenAiOAuthTokens,
        now: i64,
    ) -> Result<OpenAiAccountProfile, OpenAiAccountError> {
        let remote = remote_identity(&tokens)?.to_owned();
        let _guard = self.commit_guard()?;
        let mut index = load_index(self.store.as_ref())?;
        let key = identity_key(self.store.as_ref(), false)?;
        let fingerprint = identity_fingerprint(&key, &remote);
        let position = index
            .profiles
            .iter()
            .position(|entry| entry.id == *id)
            .ok_or(OpenAiAccountError::ProfileNotFound)?;
        match index.profiles[position].state {
            OpenAiAccountState::Connected => {}
            OpenAiAccountState::Removed => return Err(OpenAiAccountError::ProfileRemoved),
            OpenAiAccountState::ReconnectRequired | OpenAiAccountState::Unavailable => {
                return Err(OpenAiAccountError::ReconnectRequired);
            }
        }
        if index.profiles[position].identity_fingerprint != fingerprint {
            return Err(OpenAiAccountError::IdentityMismatch);
        }
        let previous = load_profile_blob(self.store.as_ref(), id)?
            .ok_or(OpenAiAccountError::ReconnectRequired)?;
        validate_profile_for_replacement(
            Some(&previous),
            &key,
            &fingerprint,
            index.profiles[position].credential_generation,
        )?;
        if previous.credential_generation != expected_generation {
            return Err(OpenAiAccountError::CredentialConflict);
        }
        let profile = profile_from_tokens(
            id.clone(),
            Some(&previous),
            index.profiles[position].credential_generation,
            tokens,
            now,
        )?;
        write_profile(self.store.as_ref(), &profile)?;
        let created_at = index.profiles[position].created_at;
        let last_used_at = index.profiles[position].last_used_at;
        let mut replacement =
            entry_from_profile(&profile, fingerprint, OpenAiAccountState::Connected);
        replacement.created_at = created_at;
        replacement.last_used_at = last_used_at;
        index.profiles[position] = replacement;
        let generation = index.generation;
        persist_index(self.store.as_ref(), &mut index, generation)?;
        Ok(profile)
    }

    pub fn mark_reconnect_required(
        &self,
        id: &AccountProfileId,
        expected_generation: u64,
        now: i64,
    ) -> Result<(), OpenAiAccountError> {
        let _guard = self.commit_guard()?;
        let mut index = load_index(self.store.as_ref())?;
        let position = index
            .profiles
            .iter()
            .position(|entry| entry.id == *id)
            .ok_or(OpenAiAccountError::ProfileNotFound)?;
        if index.profiles[position].state == OpenAiAccountState::Removed {
            return Err(OpenAiAccountError::ProfileRemoved);
        }

        // Credential payloads commit before their index entry. A successful
        // profile write followed by an interrupted index write therefore leaves
        // a valid, newer profile beside a stale registry generation. Verify the
        // exact stored credential under the commit guard before deciding whether
        // this terminal failure still owns it.
        let profile = load_profile_blob(self.store.as_ref(), id)?;
        if let Some(profile) = profile.as_ref() {
            let remote = remote_identity(&profile.tokens)?;
            let fingerprint =
                identity_fingerprint(&identity_key(self.store.as_ref(), false)?, remote);
            if fingerprint != index.profiles[position].identity_fingerprint {
                return Err(SecretStoreError::Integrity("profile identity mismatch".into()).into());
            }
            if index.profiles[position].credential_generation > profile.credential_generation {
                return Err(SecretStoreError::Integrity(
                    "registry credential generation exceeds profile generation".into(),
                )
                .into());
            }
            if profile.credential_generation > expected_generation {
                return Err(OpenAiAccountError::CredentialConflict);
            }
            if profile.credential_generation < expected_generation {
                return Err(SecretStoreError::Integrity(
                    "profile credential generation regressed".into(),
                )
                .into());
            }
        } else if index.profiles[position].credential_generation != expected_generation {
            // Absence is recoverable only for the exact indexed generation (for
            // example after an older delete-before-index quarantine attempt).
            // Without a profile, a lagging index cannot prove that the caller's
            // generation is the credential that should be quarantined.
            if index.profiles[position].credential_generation > expected_generation {
                return Err(OpenAiAccountError::CredentialConflict);
            }
            return Err(SecretStoreError::Integrity(
                "missing profile for unindexed credential generation".into(),
            )
            .into());
        }

        let already_committed = {
            let entry = &index.profiles[position];
            entry.credential_generation == expected_generation
                && entry.state == OpenAiAccountState::ReconnectRequired
                && entry.expires_at.is_none()
        };
        if !already_committed {
            let entry = &mut index.profiles[position];
            entry.credential_generation = expected_generation;
            entry.state = OpenAiAccountState::ReconnectRequired;
            entry.expires_at = None;
            entry.updated_at = now;
            let generation = index.generation;
            persist_index(self.store.as_ref(), &mut index, generation)?;
        }

        // Commit the quarantine before credential cleanup. Once the index is
        // ReconnectRequired the rejected token cannot be loaded even if keyring
        // deletion fails, and a retry idempotently sweeps any residual blob.
        delete_blob(self.store.as_ref(), &profile_prefix(id))?;
        Ok(())
    }

    pub fn remove_account(
        &self,
        id: &AccountProfileId,
        now: i64,
    ) -> Result<(), OpenAiAccountError> {
        let _removal = self.synchronization.lifecycle.begin_removal(id)?;
        let _guard = self.commit_guard()?;
        let mut index = load_index(self.store.as_ref())?;
        let entry = index
            .profiles
            .iter_mut()
            .find(|entry| entry.id == *id)
            .ok_or(OpenAiAccountError::ProfileNotFound)?;
        // Always sweep the exact credential blob, including for an already
        // tombstoned entry. A prior reconnect may have written a fresh inactive
        // profile slot and then failed before committing Connected in the index.
        delete_blob(self.store.as_ref(), &profile_prefix(id))?;
        if entry.state != OpenAiAccountState::Removed {
            entry.state = OpenAiAccountState::Removed;
            entry.expires_at = None;
            entry.updated_at = now;
            let generation = index.generation;
            persist_index(self.store.as_ref(), &mut index, generation)?;
        }
        Ok(())
    }

    pub fn record_last_used(
        &self,
        id: &AccountProfileId,
        now: i64,
    ) -> Result<(), OpenAiAccountError> {
        let _guard = self.commit_guard()?;
        let mut index = load_index(self.store.as_ref())?;
        let entry = index
            .profiles
            .iter_mut()
            .find(|entry| entry.id == *id)
            .ok_or(OpenAiAccountError::ProfileNotFound)?;
        if entry.state != OpenAiAccountState::Connected {
            return Err(match entry.state {
                OpenAiAccountState::Removed => OpenAiAccountError::ProfileRemoved,
                OpenAiAccountState::ReconnectRequired | OpenAiAccountState::Unavailable => {
                    OpenAiAccountError::ReconnectRequired
                }
                OpenAiAccountState::Connected => unreachable!(),
            });
        }
        entry.last_used_at = Some(now);
        entry.updated_at = now;
        let generation = index.generation;
        persist_index(self.store.as_ref(), &mut index, generation)
    }

    /// Migrate the singleton credential without ever inventing a second UUID on
    /// retry. The journal is committed before the profile write and retained
    /// until the registry is indexed and the legacy slot is deleted.
    pub fn migrate_legacy(&self, now: i64) -> Result<Option<AccountProfileId>, OpenAiAccountError> {
        let _guard = self.commit_guard()?;
        let mut journal: Option<MigrationJournal> =
            read_blob(self.store.as_ref(), MIGRATION_PREFIX, MAX_JOURNAL_BYTES)?;

        // Once Indexed is durable, the registry/profile pair is authoritative
        // and the remaining work is deletion only. Resume that cleanup without
        // decoding the legacy source: an interrupted sweep can legitimately
        // leave its manifest pointing at an already-deleted chunk, and treating
        // that expected partial deletion as source corruption would deadlock the
        // migration forever. The indexed UUID is verified before any sweep.
        if let Some(existing) = journal
            .as_ref()
            .filter(|journal| journal.phase == MigrationPhase::Indexed)
        {
            let id = verify_indexed_migration(self.store.as_ref(), existing)?;
            clear_legacy_openai_oauth_from(self.store.as_ref())?;
            delete_blob(self.store.as_ref(), MIGRATION_PREFIX)?;
            return Ok(Some(id));
        }

        let legacy = load_legacy_openai_oauth_from(self.store.as_ref())?;

        if legacy.is_none() {
            if let Some(existing) = journal {
                debug_assert_ne!(existing.phase, MigrationPhase::Indexed);
                return Err(SecretStoreError::Integrity(
                    "legacy credential vanished before migration committed".into(),
                )
                .into());
            }
            return Ok(None);
        }
        let tokens = legacy.expect("checked above");
        let remote = remote_identity(&tokens)?.to_owned();
        let identity_index = load_index(self.store.as_ref())?;
        let key = identity_key(
            self.store.as_ref(),
            identity_index.profiles.is_empty() && journal.is_none(),
        )?;
        let fingerprint = identity_fingerprint(&key, &remote);

        if let Some(existing) = &journal {
            if existing.schema != SCHEMA_VERSION || existing.identity_fingerprint != fingerprint {
                return Err(SecretStoreError::Integrity(
                    "migration journal identity mismatch".into(),
                )
                .into());
            }
        } else {
            let reserved = MigrationJournal {
                schema: SCHEMA_VERSION,
                id: AccountProfileId::new(),
                identity_fingerprint: fingerprint.clone(),
                created_at: now,
                phase: MigrationPhase::Reserved,
            };
            write_blob(
                self.store.as_ref(),
                MIGRATION_PREFIX,
                MAX_JOURNAL_BYTES,
                &reserved,
            )?;
            journal = Some(reserved);
        }
        let mut journal = journal.expect("journal created above");

        if journal.phase != MigrationPhase::Indexed {
            let previous = load_profile_for_replacement(self.store.as_ref(), &journal.id)?;
            let current_index = load_index(self.store.as_ref())?;
            let persisted_entry = current_index
                .profiles
                .iter()
                .find(|entry| entry.id == journal.id);
            if persisted_entry
                .is_some_and(|entry| entry.identity_fingerprint != journal.identity_fingerprint)
            {
                return Err(SecretStoreError::Integrity(
                    "journaled migration profile conflicts with the registry".into(),
                )
                .into());
            }
            let persisted_generation =
                persisted_entry.map_or(0, |entry| entry.credential_generation);
            validate_profile_for_replacement(
                previous.as_ref(),
                &key,
                &fingerprint,
                persisted_generation,
            )?;
            let profile = profile_from_tokens(
                journal.id.clone(),
                previous.as_ref(),
                persisted_generation,
                tokens,
                now,
            )?;
            write_profile(self.store.as_ref(), &profile)?;
            journal.phase = MigrationPhase::ProfileWritten;
            write_blob(
                self.store.as_ref(),
                MIGRATION_PREFIX,
                MAX_JOURNAL_BYTES,
                &journal,
            )?;

            let mut index = load_index(self.store.as_ref())?;
            if let Some(position) = index
                .profiles
                .iter()
                .position(|entry| entry.identity_fingerprint == fingerprint)
            {
                if index.profiles[position].id != journal.id {
                    // The same legacy identity was already registered. Restore
                    // that exact ID from the verified legacy tokens, including
                    // when it is a credential-free tombstone. Never trust its
                    // lifecycle state or delete the recoverable sources first.
                    let established_id = index.profiles[position].id.clone();
                    let previous =
                        load_profile_for_replacement(self.store.as_ref(), &established_id)?;
                    validate_profile_for_replacement(
                        previous.as_ref(),
                        &key,
                        &fingerprint,
                        index.profiles[position].credential_generation,
                    )?;
                    let established_profile = profile_from_tokens(
                        established_id.clone(),
                        previous.as_ref(),
                        index.profiles[position].credential_generation,
                        profile.tokens.clone(),
                        now,
                    )?;
                    write_profile(self.store.as_ref(), &established_profile)?;
                    let created_at = index.profiles[position].created_at;
                    let last_used_at = index.profiles[position].last_used_at;
                    let mut replacement = entry_from_profile(
                        &established_profile,
                        fingerprint.clone(),
                        OpenAiAccountState::Connected,
                    );
                    replacement.created_at = created_at;
                    replacement.last_used_at = last_used_at;
                    index.profiles[position] = replacement;
                    let generation = index.generation;
                    persist_index(self.store.as_ref(), &mut index, generation)?;

                    // The established profile and index are now durable. The
                    // journal still anchors the duplicate until its removal
                    // succeeds, so any failure leaves both the singleton and
                    // journaled credentials recoverable on retry.
                    delete_blob(self.store.as_ref(), &profile_prefix(&journal.id))?;
                    journal.id = established_id;
                } else {
                    index.profiles[position] = entry_from_profile(
                        &profile,
                        fingerprint.clone(),
                        OpenAiAccountState::Connected,
                    );
                    let generation = index.generation;
                    persist_index(self.store.as_ref(), &mut index, generation)?;
                }
            } else {
                if index.profiles.len() >= MAX_ACCOUNTS {
                    return Err(OpenAiAccountError::RegistryFull);
                }
                index.profiles.push(entry_from_profile(
                    &profile,
                    fingerprint,
                    OpenAiAccountState::Connected,
                ));
                let generation = index.generation;
                persist_index(self.store.as_ref(), &mut index, generation)?;
            }
            journal.phase = MigrationPhase::Indexed;
            write_blob(
                self.store.as_ref(),
                MIGRATION_PREFIX,
                MAX_JOURNAL_BYTES,
                &journal,
            )?;
        }

        let id = verify_indexed_migration(self.store.as_ref(), &journal)?;
        clear_legacy_openai_oauth_from(self.store.as_ref())?;
        delete_blob(self.store.as_ref(), MIGRATION_PREFIX)?;
        Ok(Some(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::{
        store_chunked_legacy_openai_oauth_for_test, store_legacy_openai_oauth_for_test,
    };
    use std::collections::BTreeMap;

    #[derive(Default)]
    struct FaultPlan {
        mutation: usize,
        fail_at: Option<usize>,
        fail_account: Option<String>,
        failure_fired: bool,
    }

    #[derive(Default)]
    struct MemorySecretStore {
        values: Mutex<BTreeMap<String, String>>,
        fault: Mutex<FaultPlan>,
    }

    impl MemorySecretStore {
        fn arm_mutation_failure(&self, mutation: usize) {
            let mut fault = self.fault.lock().unwrap();
            fault.mutation = 0;
            fault.fail_at = Some(mutation);
            fault.fail_account = None;
            fault.failure_fired = false;
        }

        fn arm_account_mutation_failure(&self, account: String) {
            let mut fault = self.fault.lock().unwrap();
            fault.mutation = 0;
            fault.fail_at = None;
            fault.fail_account = Some(account);
            fault.failure_fired = false;
        }

        fn disarm(&self) {
            let mut fault = self.fault.lock().unwrap();
            fault.mutation = 0;
            fault.fail_at = None;
            fault.fail_account = None;
            fault.failure_fired = false;
        }

        fn mutation_count(&self) -> usize {
            self.fault.lock().unwrap().mutation
        }

        fn failure_fired(&self) -> bool {
            self.fault.lock().unwrap().failure_fired
        }

        fn maybe_fail(&self, account: &str) -> Result<(), SecretStoreError> {
            let mut fault = self.fault.lock().unwrap();
            fault.mutation += 1;
            if fault.fail_at == Some(fault.mutation)
                || fault.fail_account.as_deref() == Some(account)
            {
                fault.fail_at = None;
                fault.fail_account = None;
                fault.failure_fired = true;
                return Err(SecretStoreError::Backend(
                    "injected mutation failure".into(),
                ));
            }
            Ok(())
        }

        fn corrupt(&self, key: &str, value: &str) {
            self.values.lock().unwrap().insert(key.into(), value.into());
        }

        fn keys(&self) -> Vec<String> {
            self.values.lock().unwrap().keys().cloned().collect()
        }

        fn all_text(&self) -> String {
            self.values
                .lock()
                .unwrap()
                .iter()
                .map(|(key, value)| format!("{key}\n{value}"))
                .collect::<Vec<_>>()
                .join("\n")
        }
    }

    impl SecretStore for MemorySecretStore {
        fn get(&self, account: &str) -> Result<String, SecretStoreError> {
            self.values
                .lock()
                .unwrap()
                .get(account)
                .cloned()
                .ok_or(SecretStoreError::Absent)
        }

        fn set(&self, account: &str, value: &str) -> Result<(), SecretStoreError> {
            self.maybe_fail(account)?;
            self.values
                .lock()
                .unwrap()
                .insert(account.into(), value.into());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), SecretStoreError> {
            self.maybe_fail(account)?;
            self.values.lock().unwrap().remove(account);
            Ok(())
        }
    }

    fn registry() -> (Arc<MemorySecretStore>, OpenAiAccountRegistry) {
        let store = Arc::new(MemorySecretStore::default());
        let registry = OpenAiAccountRegistry::with_store(store.clone());
        (store, registry)
    }

    fn tokens(remote_id: &str, marker: &str) -> OpenAiOAuthTokens {
        OpenAiOAuthTokens {
            access_token: format!("access-{marker}"),
            refresh_token: format!("refresh-{marker}"),
            id_token: Some(format!("id-{marker}")),
            expires_at: 1_900_000_000,
            account_id: Some(remote_id.into()),
            email: Some(format!("{marker}@example.com")),
            plan: Some("plus".into()),
            is_fedramp: false,
        }
    }

    #[test]
    fn profile_ids_require_canonical_hyphenated_lowercase_uuids() {
        let id = AccountProfileId::new();
        assert_eq!(AccountProfileId::parse(id.as_str()).unwrap(), id);
        assert!(AccountProfileId::parse(&id.as_str().to_uppercase()).is_err());
        assert!(AccountProfileId::parse("../openai-oauth").is_err());
        assert!(AccountProfileId::parse("550e8400e29b41d4a716446655440000").is_err());
        assert!(serde_json::from_str::<AccountProfileId>("\"../bad\"").is_err());
    }

    #[test]
    fn malformed_remote_identities_are_rejected_before_storage() {
        for remote_id in [
            "",
            " remote-a",
            "remote-a ",
            "remote a",
            "remote\na",
            "remote\u{7f}a",
            "rémote-a",
        ] {
            let (store, registry) = registry();
            assert!(matches!(
                registry.register_account(tokens(remote_id, "bad"), 10),
                Err(OpenAiAccountError::MissingRemoteIdentity)
            ));
            assert!(store.keys().is_empty(), "stored malformed id {remote_id:?}");
        }
        let (store, registry) = registry();
        assert!(matches!(
            registry.register_account(tokens(&"x".repeat(MAX_REMOTE_ID_BYTES + 1), "bad"), 10),
            Err(OpenAiAccountError::MissingRemoteIdentity)
        ));
        assert!(store.keys().is_empty());
    }

    #[test]
    fn registry_round_trips_multiple_accounts_and_deduplicates_remote_identity() {
        let (store, registry) = registry();
        assert!(registry.list_accounts().unwrap().is_empty());

        let first = registry
            .register_account(tokens("remote-a", "alice"), 10)
            .unwrap();
        let second = registry
            .register_account(tokens("remote-b", "bob"), 11)
            .unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(registry.list_accounts().unwrap().len(), 2);

        let updated = registry
            .register_account(tokens("remote-a", "alice-new"), 12)
            .unwrap();
        assert_eq!(updated.id, first.id);
        assert_eq!(registry.list_accounts().unwrap().len(), 2);
        let loaded = registry.load_profile(&first.id).unwrap();
        assert_eq!(loaded.tokens.access_token, "access-alice-new");
        assert_eq!(loaded.credential_generation, 2);
        registry.record_last_used(&first.id, 13).unwrap();
        assert_eq!(
            registry.load_profile(&first.id).unwrap().last_used_at,
            Some(13)
        );

        // The raw remote identity is confined to base64-encoded secret chunks;
        // it never appears in key names, manifests, or the registry index.
        assert!(!store.keys().iter().any(|key| key.contains("remote-a")));
        assert!(!store.all_text().contains("remote-a"));
    }

    #[test]
    fn removal_keeps_tombstone_rejects_active_runs_and_revives_exact_id() {
        let (_store, registry) = registry();
        let first = registry
            .register_account(tokens("remote-a", "alice"), 10)
            .unwrap();
        let second = registry
            .register_account(tokens("remote-b", "bob"), 10)
            .unwrap();

        let lease = registry.acquire_run_lease(&first.id).unwrap();
        assert!(matches!(
            registry.remove_account(&first.id, 20),
            Err(OpenAiAccountError::ActiveRuns)
        ));
        drop(lease);
        registry.remove_account(&first.id, 21).unwrap();
        assert!(matches!(
            registry.load_profile(&first.id),
            Err(OpenAiAccountError::ProfileRemoved)
        ));
        assert_eq!(
            registry
                .list_accounts()
                .unwrap()
                .into_iter()
                .find(|summary| summary.id == first.id)
                .unwrap()
                .state,
            OpenAiAccountState::Removed
        );
        assert_eq!(
            registry
                .load_profile(&second.id)
                .unwrap()
                .tokens
                .account_id
                .as_deref(),
            Some("remote-b")
        );

        assert!(matches!(
            registry.reconnect_account(&first.id, tokens("remote-c", "mallory"), 22),
            Err(OpenAiAccountError::IdentityMismatch)
        ));
        let revived = registry
            .reconnect_account(&first.id, tokens("remote-a", "alice-back"), 23)
            .unwrap();
        assert_eq!(revived.id, first.id);
        assert_eq!(revived.state, OpenAiAccountState::Connected);
        assert_eq!(
            registry
                .load_profile(&first.id)
                .unwrap()
                .credential_generation,
            2
        );
    }

    #[test]
    fn stale_refresh_cannot_overwrite_a_newer_reconnect() {
        let (_store, registry) = registry();
        let summary = registry
            .register_account(tokens("remote-a", "initial"), 10)
            .unwrap();
        let snapshot = registry.load_profile(&summary.id).unwrap();
        assert_eq!(snapshot.credential_generation, 1);

        registry
            .reconnect_account(&summary.id, tokens("remote-a", "reconnect"), 20)
            .unwrap();
        let error = registry
            .store_refreshed_profile(
                &summary.id,
                snapshot.credential_generation,
                tokens("remote-a", "stale-refresh"),
                21,
            )
            .unwrap_err();
        assert!(matches!(error, OpenAiAccountError::CredentialConflict));
        assert_eq!(
            registry
                .load_profile(&summary.id)
                .unwrap()
                .tokens
                .access_token,
            "access-reconnect"
        );
        assert!(matches!(
            registry.mark_reconnect_required(&summary.id, snapshot.credential_generation, 22),
            Err(OpenAiAccountError::CredentialConflict)
        ));
        assert_eq!(
            registry
                .load_profile(&summary.id)
                .unwrap()
                .tokens
                .access_token,
            "access-reconnect"
        );
    }

    #[test]
    fn successful_refresh_increments_generation_and_quarantine_is_exact() {
        let (_store, registry) = registry();
        let summary = registry
            .register_account(tokens("remote-a", "initial"), 10)
            .unwrap();
        let initial = registry.load_profile(&summary.id).unwrap();
        let refreshed = registry
            .store_refreshed_profile(
                &summary.id,
                initial.credential_generation,
                tokens("remote-a", "refresh"),
                11,
            )
            .unwrap();
        assert_eq!(refreshed.credential_generation, 2);
        registry
            .mark_reconnect_required(&summary.id, refreshed.credential_generation, 12)
            .unwrap();
        assert!(matches!(
            registry.load_profile(&summary.id),
            Err(OpenAiAccountError::ReconnectRequired)
        ));
        registry
            .mark_reconnect_required(&summary.id, refreshed.credential_generation, 13)
            .unwrap();
        let revived = registry
            .reconnect_account(&summary.id, tokens("remote-a", "revived"), 14)
            .unwrap();
        assert_eq!(revived.id, summary.id);
        assert_eq!(
            registry
                .load_profile(&summary.id)
                .unwrap()
                .credential_generation,
            3
        );
    }

    #[test]
    fn quarantine_heals_a_committed_refresh_profile_after_its_index_commit_failed() {
        let (store, registry) = registry();
        let summary = registry
            .register_account(tokens("remote-a", "initial"), 10)
            .unwrap();
        let initial = registry.load_profile(&summary.id).unwrap();

        // Fail the authoritative registry-manifest swap by key rather than by a
        // brittle mutation ordinal. The refreshed profile has already committed
        // and passed readback when this exact write is attempted.
        store.arm_account_mutation_failure(manifest_key(REGISTRY_PREFIX));
        assert!(matches!(
            registry.store_refreshed_profile(
                &summary.id,
                initial.credential_generation,
                tokens("remote-a", "rejected-refresh"),
                11,
            ),
            Err(OpenAiAccountError::Storage(SecretStoreError::Backend(_)))
        ));
        assert!(store.failure_fired());
        store.disarm();

        let committed_profile = load_profile_blob(store.as_ref(), &summary.id)
            .unwrap()
            .expect("profile commit must survive the failed index swap");
        assert_eq!(committed_profile.credential_generation, 2);
        assert_eq!(
            committed_profile.tokens.access_token,
            "access-rejected-refresh"
        );
        let stale_index = load_index(store.as_ref()).unwrap();
        let stale_entry = stale_index
            .profiles
            .iter()
            .find(|entry| entry.id == summary.id)
            .unwrap();
        assert_eq!(stale_entry.credential_generation, 1);
        assert_eq!(stale_entry.state, OpenAiAccountState::Connected);

        // A genuinely stale failure cannot quarantine the newer credential.
        assert!(matches!(
            registry.mark_reconnect_required(&summary.id, initial.credential_generation, 12,),
            Err(OpenAiAccountError::CredentialConflict)
        ));
        assert!(load_profile_blob(store.as_ref(), &summary.id)
            .unwrap()
            .is_some());

        // The matching terminal failure heals the lagging index first. Even if
        // blob cleanup then fails, public loads cannot reuse the rejected token.
        store.arm_account_mutation_failure(manifest_key(&profile_prefix(&summary.id)));
        assert!(matches!(
            registry.mark_reconnect_required(
                &summary.id,
                committed_profile.credential_generation,
                13,
            ),
            Err(OpenAiAccountError::Storage(SecretStoreError::Backend(_)))
        ));
        assert!(store.failure_fired());
        store.disarm();

        let quarantined_index = load_index(store.as_ref()).unwrap();
        let quarantined_entry = quarantined_index
            .profiles
            .iter()
            .find(|entry| entry.id == summary.id)
            .unwrap();
        assert_eq!(quarantined_entry.credential_generation, 2);
        assert_eq!(
            quarantined_entry.state,
            OpenAiAccountState::ReconnectRequired
        );
        assert!(matches!(
            registry.load_profile(&summary.id),
            Err(OpenAiAccountError::ReconnectRequired)
        ));
        assert!(load_profile_blob(store.as_ref(), &summary.id)
            .unwrap()
            .is_some());

        // Retrying an already-committed quarantine sweeps credential residue.
        registry
            .mark_reconnect_required(&summary.id, committed_profile.credential_generation, 14)
            .unwrap();
        assert!(load_profile_blob(store.as_ref(), &summary.id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn quarantine_preserves_corrupt_or_wrong_identity_profile_evidence() {
        let (store, corrupt_registry) = registry();
        let summary = corrupt_registry
            .register_account(tokens("remote-a", "initial"), 10)
            .unwrap();
        let profile = corrupt_registry.load_profile(&summary.id).unwrap();
        corrupt_active_blob_chunk(
            store.as_ref(),
            &profile_prefix(&summary.id),
            MAX_PROFILE_BYTES,
        );
        let corrupt_snapshot = store.all_text();
        assert!(matches!(
            corrupt_registry.mark_reconnect_required(
                &summary.id,
                profile.credential_generation,
                11,
            ),
            Err(OpenAiAccountError::Storage(
                SecretStoreError::Corrupt(_) | SecretStoreError::Integrity(_)
            ))
        ));
        assert_eq!(store.all_text(), corrupt_snapshot);

        let (store, registry) = registry();
        let summary = registry
            .register_account(tokens("remote-a", "initial"), 10)
            .unwrap();
        let mut wrong_identity = registry.load_profile(&summary.id).unwrap();
        wrong_identity.tokens = tokens("remote-b", "different-identity");
        write_profile(store.as_ref(), &wrong_identity).unwrap();
        let wrong_identity_snapshot = store.all_text();
        assert!(matches!(
            registry
                .mark_reconnect_required(&summary.id, wrong_identity.credential_generation, 11,),
            Err(OpenAiAccountError::Storage(SecretStoreError::Integrity(_)))
        ));
        assert_eq!(store.all_text(), wrong_identity_snapshot);
    }

    #[test]
    fn interrupted_new_profile_write_keeps_a_reusable_reservation() {
        let (store, registry) = registry();
        // identity key, registry chunk, registry manifest, then profile chunk.
        store.arm_mutation_failure(4);
        assert!(registry
            .register_account(tokens("remote-a", "first"), 10)
            .is_err());
        store.disarm();
        let reserved = registry.list_accounts().unwrap();
        assert_eq!(reserved.len(), 1);
        assert_eq!(reserved[0].state, OpenAiAccountState::Unavailable);
        let reserved_id = reserved[0].id.clone();
        assert!(matches!(
            registry.load_profile(&reserved_id),
            Err(OpenAiAccountError::ReconnectRequired)
        ));

        let connected = registry
            .register_account(tokens("remote-a", "retry"), 11)
            .unwrap();
        assert_eq!(connected.id, reserved_id);
        assert_eq!(connected.state, OpenAiAccountState::Connected);
        assert_eq!(registry.list_accounts().unwrap().len(), 1);
    }

    #[test]
    fn refresh_requires_the_exact_remote_identity() {
        let (_store, registry) = registry();
        let summary = registry
            .register_account(tokens("remote-a", "initial"), 10)
            .unwrap();
        let profile = registry.load_profile(&summary.id).unwrap();
        assert!(matches!(
            registry.store_refreshed_profile(
                &summary.id,
                profile.credential_generation,
                tokens("remote-b", "wrong"),
                11,
            ),
            Err(OpenAiAccountError::IdentityMismatch)
        ));
        let mut missing = tokens("remote-a", "missing");
        missing.account_id = None;
        assert!(matches!(
            registry.store_refreshed_profile(
                &summary.id,
                profile.credential_generation,
                missing,
                11,
            ),
            Err(OpenAiAccountError::MissingRemoteIdentity)
        ));
    }

    #[test]
    fn a_b_commit_preserves_previous_payload_at_each_precommit_failure() {
        #[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
        struct Payload {
            value: String,
        }

        let replacement_value = "replacement".repeat(500);
        let replacement_bytes = serde_json::to_vec(&Payload {
            value: replacement_value.clone(),
        })
        .unwrap();
        let replacement_chunks = B64.encode(&replacement_bytes).len().div_ceil(CHUNK_CHARS);
        // Every chunk write plus the final manifest swap is a distinct
        // pre-commit mutation. Exercise all of them dynamically so growing the
        // fixture cannot silently leave the last chunks or commit point untested.
        for fail_at in 1..=replacement_chunks + 1 {
            let store = MemorySecretStore::default();
            let original = Payload {
                value: "original".repeat(500),
            };
            let replacement = Payload {
                value: replacement_value.clone(),
            };
            write_blob(&store, "test-blob", 32 * 1_024, &original).unwrap();
            store.arm_mutation_failure(fail_at);
            let result = write_blob(&store, "test-blob", 32 * 1_024, &replacement);
            assert!(
                result.is_err(),
                "pre-commit mutation {fail_at} was not exercised"
            );
            store.disarm();
            assert_eq!(
                read_blob::<Payload>(&store, "test-blob", 32 * 1_024)
                    .unwrap()
                    .unwrap(),
                original,
                "failure point {fail_at} changed the committed value"
            );
        }
    }

    #[test]
    fn bounded_blob_rejects_oversize_without_mutating_current_value() {
        let store = MemorySecretStore::default();
        write_blob(&store, "bounded", 128, &"small").unwrap();
        assert!(matches!(
            write_blob(&store, "bounded", 128, &"x".repeat(1_000)),
            Err(SecretStoreError::TooLarge(_))
        ));
        assert_eq!(
            read_blob::<String>(&store, "bounded", 128)
                .unwrap()
                .unwrap(),
            "small"
        );
    }

    #[test]
    fn bounded_blob_rejects_an_oversized_stored_chunk_before_decode() {
        let store = MemorySecretStore::default();
        write_blob(&store, "bounded-read", 128, &"small").unwrap();
        let manifest = read_manifest(&store, "bounded-read", 128).unwrap().unwrap();
        store.corrupt(
            &chunk_key("bounded-read", &manifest.slot, 0),
            &"A".repeat(CHUNK_CHARS + 1),
        );
        assert!(matches!(
            read_blob::<String>(&store, "bounded-read", 128),
            Err(SecretStoreError::Corrupt(_))
        ));
    }

    #[test]
    fn blob_generation_overflow_fails_closed() {
        let store = MemorySecretStore::default();
        write_blob(&store, "generation", 128, &"original").unwrap();
        let mut manifest = read_manifest(&store, "generation", 128).unwrap().unwrap();
        manifest.generation = u64::MAX;
        store
            .set(
                &manifest_key("generation"),
                &serde_json::to_string(&manifest).unwrap(),
            )
            .unwrap();
        assert!(matches!(
            write_blob(&store, "generation", 128, &"replacement"),
            Err(SecretStoreError::Corrupt(_))
        ));
        assert_eq!(
            read_blob::<String>(&store, "generation", 128)
                .unwrap()
                .unwrap(),
            "original"
        );
    }

    #[test]
    fn profile_corruption_fails_closed_instead_of_looking_unavailable() {
        let (store, registry) = registry();
        let summary = registry
            .register_account(tokens("remote-a", "alice"), 10)
            .unwrap();
        let prefix = profile_prefix(&summary.id);
        let manifest = read_manifest(store.as_ref(), &prefix, MAX_PROFILE_BYTES)
            .unwrap()
            .unwrap();
        store.corrupt(&chunk_key(&prefix, &manifest.slot, 0), "not-base64!");
        assert!(matches!(
            registry.list_accounts(),
            Err(OpenAiAccountError::Storage(
                SecretStoreError::Corrupt(_) | SecretStoreError::Integrity(_)
            ))
        ));
    }

    #[test]
    fn missing_identity_key_never_rekeys_an_existing_profile_or_tombstone() {
        for remove_first in [false, true] {
            let (store, registry) = registry();
            let summary = registry
                .register_account(tokens("remote-a", "alice"), 10)
                .unwrap();
            if remove_first {
                registry.remove_account(&summary.id, 11).unwrap();
            }
            store.delete(IDENTITY_HMAC_KEY).unwrap();

            assert!(matches!(
                registry.list_accounts(),
                Err(OpenAiAccountError::Storage(SecretStoreError::Integrity(_)))
            ));
            assert!(registry
                .register_account(tokens("remote-a", "retry"), 12)
                .is_err());
            assert!(matches!(
                store.get(IDENTITY_HMAC_KEY),
                Err(SecretStoreError::Absent)
            ));
        }
    }

    #[test]
    fn repeated_remove_sweeps_credentials_left_by_an_interrupted_reconnect() {
        let (store, registry) = registry();
        let summary = registry
            .register_account(tokens("remote-a", "alice"), 10)
            .unwrap();
        registry.remove_account(&summary.id, 11).unwrap();

        // Simulate reconnect committing the profile A/B blob and crashing before
        // its index update changes the tombstone back to Connected.
        let index = load_index(store.as_ref()).unwrap();
        let entry = index
            .profiles
            .iter()
            .find(|entry| entry.id == summary.id)
            .unwrap();
        let orphan = profile_from_tokens(
            summary.id.clone(),
            None,
            entry.credential_generation,
            tokens("remote-a", "orphan"),
            12,
        )
        .unwrap();
        write_profile(store.as_ref(), &orphan).unwrap();
        let prefix = profile_prefix(&summary.id);
        assert!(store.keys().iter().any(|key| key.starts_with(&prefix)));

        registry.remove_account(&summary.id, 13).unwrap();
        assert!(!store.keys().iter().any(|key| key.starts_with(&prefix)));
    }

    #[test]
    fn corrupt_profile_values_never_appear_in_display_safe_errors() {
        let (store, registry) = registry();
        let summary = registry
            .register_account(tokens("remote-a", "alice"), 10)
            .unwrap();
        write_blob(
            store.as_ref(),
            &profile_prefix(&summary.id),
            MAX_PROFILE_BYTES,
            &serde_json::json!({ "tokens": "TOP_SECRET_SENTINEL" }),
        )
        .unwrap();
        let error = registry.load_profile(&summary.id).unwrap_err();
        assert!(!error.to_string().contains("TOP_SECRET_SENTINEL"));
        assert!(!error.user_message().contains("TOP_SECRET_SENTINEL"));
    }

    #[test]
    fn invalid_or_duplicate_registry_entries_fail_closed() {
        let (store, registry) = registry();
        let summary = registry
            .register_account(tokens("remote-a", "alice"), 10)
            .unwrap();
        let mut index = load_index(store.as_ref()).unwrap();
        let mut duplicate = index.profiles[0].clone();
        duplicate.id = AccountProfileId::new();
        index.profiles.push(duplicate);
        write_blob(store.as_ref(), REGISTRY_PREFIX, MAX_REGISTRY_BYTES, &index).unwrap();
        assert!(matches!(
            registry.load_profile(&summary.id),
            Err(OpenAiAccountError::InvalidRegistry(_))
        ));
    }

    fn corrupt_active_blob_chunk(store: &MemorySecretStore, prefix: &str, max_bytes: usize) {
        let manifest = read_manifest(store, prefix, max_bytes)
            .unwrap()
            .expect("fixture has a committed manifest");
        store.corrupt(
            &chunk_key(prefix, &manifest.slot, 0),
            "corrupted-active-chunk",
        );
    }

    #[test]
    fn duplicate_login_and_reconnect_preserve_a_corrupt_committed_profile() {
        let (store, registry) = registry();
        let summary = registry
            .register_account(tokens("remote-a", "original"), 10)
            .unwrap();
        corrupt_active_blob_chunk(
            store.as_ref(),
            &profile_prefix(&summary.id),
            MAX_PROFILE_BYTES,
        );
        let corrupted_snapshot = store.all_text();

        for result in [
            registry.register_account(tokens("remote-a", "duplicate"), 11),
            registry.reconnect_account(&summary.id, tokens("remote-a", "reconnect"), 12),
        ] {
            assert!(matches!(
                result,
                Err(OpenAiAccountError::Storage(
                    SecretStoreError::Corrupt(_) | SecretStoreError::Integrity(_)
                ))
            ));
            assert_eq!(
                store.all_text(),
                corrupted_snapshot,
                "a replacement attempt must not rewrite corrupt committed bytes"
            );
        }
    }

    #[test]
    fn duplicate_login_and_reconnect_preserve_mismatched_or_rolled_back_profiles() {
        let (store, wrong_registry) = registry();
        let summary = wrong_registry
            .register_account(tokens("remote-a", "original"), 10)
            .unwrap();
        let mut wrong_identity = wrong_registry.load_profile(&summary.id).unwrap();
        wrong_identity.tokens = tokens("remote-b", "wrong-identity");
        write_profile(store.as_ref(), &wrong_identity).unwrap();
        let wrong_identity_snapshot = store.all_text();

        assert!(matches!(
            wrong_registry.list_accounts(),
            Err(OpenAiAccountError::Storage(SecretStoreError::Integrity(_)))
        ));
        assert!(matches!(
            wrong_registry.load_profile(&summary.id),
            Err(OpenAiAccountError::Storage(SecretStoreError::Integrity(_)))
        ));
        assert!(matches!(
            wrong_registry.store_refreshed_profile(
                &summary.id,
                wrong_identity.credential_generation,
                tokens("remote-a", "refresh"),
                11,
            ),
            Err(OpenAiAccountError::Storage(SecretStoreError::Integrity(_)))
        ));
        assert_eq!(store.all_text(), wrong_identity_snapshot);

        for result in [
            wrong_registry.register_account(tokens("remote-a", "duplicate"), 12),
            wrong_registry.reconnect_account(&summary.id, tokens("remote-a", "reconnect"), 13),
        ] {
            assert!(matches!(
                result,
                Err(OpenAiAccountError::Storage(SecretStoreError::Integrity(_)))
            ));
            assert_eq!(store.all_text(), wrong_identity_snapshot);
        }

        let (store, registry) = registry();
        let summary = registry
            .register_account(tokens("remote-a", "generation-one"), 20)
            .unwrap();
        let generation_one = registry.load_profile(&summary.id).unwrap();
        registry
            .reconnect_account(&summary.id, tokens("remote-a", "generation-two"), 21)
            .unwrap();
        write_profile(store.as_ref(), &generation_one).unwrap();
        let rolled_back_snapshot = store.all_text();

        assert!(matches!(
            registry.list_accounts(),
            Err(OpenAiAccountError::Storage(SecretStoreError::Integrity(_)))
        ));
        assert!(matches!(
            registry.load_profile(&summary.id),
            Err(OpenAiAccountError::Storage(SecretStoreError::Integrity(_)))
        ));
        assert!(matches!(
            registry.store_refreshed_profile(
                &summary.id,
                generation_one.credential_generation,
                tokens("remote-a", "refresh"),
                22,
            ),
            Err(OpenAiAccountError::Storage(SecretStoreError::Integrity(_)))
        ));
        assert_eq!(store.all_text(), rolled_back_snapshot);

        for result in [
            registry.register_account(tokens("remote-a", "duplicate"), 23),
            registry.reconnect_account(&summary.id, tokens("remote-a", "reconnect"), 24),
        ] {
            assert!(matches!(
                result,
                Err(OpenAiAccountError::Storage(SecretStoreError::Integrity(_)))
            ));
            assert_eq!(store.all_text(), rolled_back_snapshot);
        }
    }

    #[test]
    fn duplicate_identity_migration_preserves_mismatched_profile_and_legacy_sources() {
        let (store, registry) = registry();
        let summary = registry
            .register_account(tokens("legacy", "original"), 10)
            .unwrap();
        let mut wrong_identity = registry.load_profile(&summary.id).unwrap();
        wrong_identity.tokens = tokens("different-remote", "wrong-identity");
        write_profile(store.as_ref(), &wrong_identity).unwrap();
        store_legacy_openai_oauth_for_test(store.as_ref(), &tokens("legacy", "source")).unwrap();

        for now in [11, 12] {
            assert!(matches!(
                registry.migrate_legacy(now),
                Err(OpenAiAccountError::Storage(SecretStoreError::Integrity(_)))
            ));
            assert_eq!(
                load_profile_blob(store.as_ref(), &summary.id)
                    .unwrap()
                    .unwrap(),
                wrong_identity
            );
            assert!(load_legacy_openai_oauth_from(store.as_ref())
                .unwrap()
                .is_some());
            assert!(read_blob::<MigrationJournal>(
                store.as_ref(),
                MIGRATION_PREFIX,
                MAX_JOURNAL_BYTES
            )
            .unwrap()
            .is_some());
        }
    }

    #[test]
    fn journaled_migration_never_overwrites_a_conflicting_index_identity() {
        let (store, registry) = registry();
        let summary = registry
            .register_account(tokens("remote-a", "indexed"), 10)
            .unwrap();
        let legacy = tokens("remote-b", "legacy");
        store_legacy_openai_oauth_for_test(store.as_ref(), &legacy).unwrap();
        let fingerprint = identity_fingerprint(
            &identity_key(store.as_ref(), false).unwrap(),
            remote_identity(&legacy).unwrap(),
        );
        write_blob(
            store.as_ref(),
            MIGRATION_PREFIX,
            MAX_JOURNAL_BYTES,
            &MigrationJournal {
                schema: SCHEMA_VERSION,
                id: summary.id,
                identity_fingerprint: fingerprint,
                created_at: 11,
                phase: MigrationPhase::Reserved,
            },
        )
        .unwrap();
        let snapshot = store.all_text();

        assert!(matches!(
            registry.migrate_legacy(12),
            Err(OpenAiAccountError::Storage(SecretStoreError::Integrity(_)))
        ));
        assert_eq!(store.all_text(), snapshot);
        assert!(load_legacy_openai_oauth_from(store.as_ref())
            .unwrap()
            .is_some());
    }

    #[test]
    fn legacy_migration_retry_preserves_a_corrupt_journaled_profile_and_legacy_source() {
        let store = Arc::new(MemorySecretStore::default());
        store_legacy_openai_oauth_for_test(store.as_ref(), &tokens("legacy", "legacy")).unwrap();
        store.disarm();
        let registry = OpenAiAccountRegistry::with_store(store.clone());

        // With single-chunk fixtures, mutation six is the first write that
        // advances the already-committed Reserved journal after the profile was
        // durably written. The failed attempt therefore leaves both the source
        // credential and its journaled profile available for a real retry.
        store.arm_mutation_failure(6);
        assert!(registry.migrate_legacy(100).is_err());
        store.disarm();
        let journal: MigrationJournal =
            read_blob(store.as_ref(), MIGRATION_PREFIX, MAX_JOURNAL_BYTES)
                .unwrap()
                .expect("the UUID reservation must survive");
        corrupt_active_blob_chunk(
            store.as_ref(),
            &profile_prefix(&journal.id),
            MAX_PROFILE_BYTES,
        );
        let corrupted_snapshot = store.all_text();

        assert!(matches!(
            registry.migrate_legacy(101),
            Err(OpenAiAccountError::Storage(
                SecretStoreError::Corrupt(_) | SecretStoreError::Integrity(_)
            ))
        ));
        assert_eq!(store.all_text(), corrupted_snapshot);
        assert!(load_legacy_openai_oauth_from(store.as_ref())
            .unwrap()
            .is_some());
    }

    fn indexed_migration_cleanup_fixture() -> (
        Arc<MemorySecretStore>,
        OpenAiAccountRegistry,
        OpenAiAccountSummary,
    ) {
        let (store, registry) = registry();
        let summary = registry
            .register_account(tokens("legacy", "profile"), 10)
            .unwrap();
        store_legacy_openai_oauth_for_test(store.as_ref(), &tokens("legacy", "source")).unwrap();
        let index = load_index(store.as_ref()).unwrap();
        let entry = index
            .profiles
            .iter()
            .find(|entry| entry.id == summary.id)
            .unwrap();
        write_blob(
            store.as_ref(),
            MIGRATION_PREFIX,
            MAX_JOURNAL_BYTES,
            &MigrationJournal {
                schema: SCHEMA_VERSION,
                id: summary.id.clone(),
                identity_fingerprint: entry.identity_fingerprint.clone(),
                created_at: 10,
                phase: MigrationPhase::Indexed,
            },
        )
        .unwrap();
        (store, registry, summary)
    }

    #[test]
    fn indexed_migration_cleanup_never_deletes_legacy_before_profile_verification() {
        let (store, registry, summary) = indexed_migration_cleanup_fixture();
        corrupt_active_blob_chunk(
            store.as_ref(),
            &profile_prefix(&summary.id),
            MAX_PROFILE_BYTES,
        );
        let corrupt_snapshot = store.all_text();
        assert!(matches!(
            registry.migrate_legacy(11),
            Err(OpenAiAccountError::Storage(
                SecretStoreError::Corrupt(_) | SecretStoreError::Integrity(_)
            ))
        ));
        assert_eq!(store.all_text(), corrupt_snapshot);
        assert!(load_legacy_openai_oauth_from(store.as_ref())
            .unwrap()
            .is_some());

        let (store, registry, summary) = indexed_migration_cleanup_fixture();
        delete_blob(store.as_ref(), &profile_prefix(&summary.id)).unwrap();
        let missing_snapshot = store.all_text();
        assert!(matches!(
            registry.migrate_legacy(11),
            Err(OpenAiAccountError::Storage(SecretStoreError::Integrity(_)))
        ));
        assert_eq!(store.all_text(), missing_snapshot);
        assert!(load_legacy_openai_oauth_from(store.as_ref())
            .unwrap()
            .is_some());
    }

    #[test]
    fn legacy_migration_revives_the_established_tombstone_before_cleanup() {
        let (store, registry) = registry();
        let original = registry
            .register_account(tokens("legacy", "original"), 10)
            .unwrap();
        registry.record_last_used(&original.id, 11).unwrap();
        registry.remove_account(&original.id, 12).unwrap();
        assert!(load_profile_blob(store.as_ref(), &original.id)
            .unwrap()
            .is_none());

        let migrated_tokens = tokens("legacy", "migrated");
        store_legacy_openai_oauth_for_test(store.as_ref(), &migrated_tokens).unwrap();
        let migrated_id = registry
            .migrate_legacy(20)
            .unwrap()
            .expect("legacy singleton exists");

        assert_eq!(migrated_id, original.id);
        let summaries = registry.list_accounts().unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, original.id);
        assert_eq!(summaries[0].state, OpenAiAccountState::Connected);
        assert_eq!(summaries[0].created_at, original.created_at);
        assert_eq!(summaries[0].last_used_at, Some(11));
        assert_eq!(
            registry.load_profile(&original.id).unwrap().tokens,
            migrated_tokens
        );
        assert!(load_legacy_openai_oauth_from(store.as_ref())
            .unwrap()
            .is_none());
        assert!(
            read_blob::<MigrationJournal>(store.as_ref(), MIGRATION_PREFIX, MAX_JOURNAL_BYTES)
                .unwrap()
                .is_none()
        );

        let established_prefix = profile_prefix(&original.id);
        assert!(store
            .keys()
            .iter()
            .filter(|key| key.starts_with(PROFILE_PREFIX))
            .all(|key| key.starts_with(&established_prefix)));
    }

    struct ReadFailureStore {
        error: fn() -> SecretStoreError,
    }

    impl SecretStore for ReadFailureStore {
        fn get(&self, _account: &str) -> Result<String, SecretStoreError> {
            Err((self.error)())
        }

        fn set(&self, _account: &str, _value: &str) -> Result<(), SecretStoreError> {
            Err((self.error)())
        }

        fn delete(&self, _account: &str) -> Result<(), SecretStoreError> {
            Err((self.error)())
        }
    }

    #[test]
    fn locked_and_unavailable_secret_stores_fail_closed_without_collapsing_to_absence() {
        for (make_error, expected_kind) in [
            (
                (|| SecretStoreError::Locked) as fn() -> SecretStoreError,
                "locked",
            ),
            (
                (|| SecretStoreError::Unavailable) as fn() -> SecretStoreError,
                "unavailable",
            ),
            (
                (|| SecretStoreError::Io {
                    operation: "read fixture",
                    kind: std::io::ErrorKind::NotConnected,
                }) as fn() -> SecretStoreError,
                "io",
            ),
        ] {
            let registry =
                OpenAiAccountRegistry::with_store(Arc::new(ReadFailureStore { error: make_error }));
            let error = registry
                .list_accounts()
                .expect_err("storage failure must not look like an empty registry");
            match (&error, expected_kind) {
                (OpenAiAccountError::Storage(SecretStoreError::Locked), "locked")
                | (OpenAiAccountError::Storage(SecretStoreError::Unavailable), "unavailable")
                | (OpenAiAccountError::Storage(SecretStoreError::Io { .. }), "io") => {}
                _ => panic!("expected {expected_kind} storage error, got {error:?}"),
            }
            assert_eq!(
                error.user_message(),
                "ChatGPT account storage is unavailable or corrupt. No credentials were changed."
            );
            assert!(!error.user_message().contains("TOP_SECRET"));
        }
    }

    #[test]
    fn every_legacy_migration_mutation_failure_converges_on_the_journaled_uuid() {
        type SeedLegacy = fn(&dyn SecretStore, &OpenAiOAuthTokens) -> Result<(), SecretStoreError>;
        let fixtures: [(&str, SeedLegacy); 2] = [
            ("raw", store_legacy_openai_oauth_for_test),
            ("chunked", store_chunked_legacy_openai_oauth_for_test),
        ];

        for (fixture, seed) in fixtures {
            // Derive the complete write/delete count from an uninterrupted
            // migration. This prevents out-of-range magic failpoints from
            // silently passing when journal, chunking, index, or cleanup changes.
            let control = Arc::new(MemorySecretStore::default());
            seed(control.as_ref(), &tokens("legacy", "control")).unwrap();
            control.disarm();
            OpenAiAccountRegistry::with_store(control.clone())
                .migrate_legacy(99)
                .unwrap();
            let mutation_count = control.mutation_count();
            assert_eq!(
                mutation_count, 272,
                "{fixture} fixture mutation sequence changed; audit every new point"
            );

            let mut best_effort_cleanup_failures = Vec::new();
            for fail_at in 1..=mutation_count {
                let store = Arc::new(MemorySecretStore::default());
                seed(store.as_ref(), &tokens("legacy", "legacy")).unwrap();
                store.disarm();
                let registry = OpenAiAccountRegistry::with_store(store.clone());
                store.arm_mutation_failure(fail_at);
                let first_attempt = registry.migrate_legacy(100);
                assert!(
                    store.failure_fired(),
                    "{fixture} mutation {fail_at}/{mutation_count} was not exercised"
                );
                if first_attempt.is_ok() {
                    // `write_blob` deliberately treats deletion of a superseded
                    // A/B slot as best-effort after the new manifest is committed.
                    // Record those exact nonfatal points instead of mistaking an
                    // out-of-range injection for successful recovery coverage.
                    best_effort_cleanup_failures.push(fail_at);
                }

                let journal_after_failure: Option<MigrationJournal> =
                    read_blob(store.as_ref(), MIGRATION_PREFIX, MAX_JOURNAL_BYTES).unwrap_or(None);
                let wrote_profile = store
                    .keys()
                    .iter()
                    .any(|key| key.starts_with(PROFILE_PREFIX));
                if wrote_profile && first_attempt.is_err() && journal_after_failure.is_none() {
                    // Final journal deletion starts only after the profile is
                    // indexed and the legacy source has been removed. Once its
                    // manifest is gone, the durable index is the UUID anchor.
                    let index = load_index(store.as_ref()).unwrap();
                    assert_eq!(
                        index.profiles.len(),
                        1,
                        "{fixture} mutation {fail_at} lacked both journal and index anchor"
                    );
                    assert!(load_legacy_openai_oauth_from(store.as_ref())
                        .unwrap()
                        .is_none());
                }

                store.disarm();
                let retried = registry.migrate_legacy(101).unwrap();
                let summaries = registry.list_accounts().unwrap();
                assert_eq!(summaries.len(), 1, "{fixture} mutation {fail_at}");
                if let Some(journal) = journal_after_failure {
                    assert_eq!(summaries[0].id, journal.id, "{fixture} mutation {fail_at}");
                }
                if let Some(id) = retried {
                    assert_eq!(id, summaries[0].id);
                }
                assert!(load_legacy_openai_oauth_from(store.as_ref())
                    .unwrap()
                    .is_none());
            }
            assert_eq!(
                best_effort_cleanup_failures,
                [8, 13],
                "only superseded A/B-slot cleanup may be nonfatal for {fixture}"
            );
        }
    }

    #[tokio::test]
    async fn refresh_locks_serialize_one_profile_but_not_different_profiles() {
        let (_store, registry) = registry();
        let a = AccountProfileId::new();
        let b = AccountProfileId::new();

        let a_guard = registry.lock_refresh(&a).await.unwrap();
        let second_a = tokio::time::timeout(
            std::time::Duration::from_millis(25),
            registry.lock_refresh(&a),
        )
        .await;
        assert!(second_a.is_err());
        let b_guard = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            registry.lock_refresh(&b),
        )
        .await
        .unwrap()
        .unwrap();
        drop(b_guard);
        drop(a_guard);
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            registry.lock_refresh(&a),
        )
        .await
        .unwrap()
        .unwrap();
    }

    #[tokio::test]
    async fn browser_login_lock_is_global_across_registry_clones() {
        let (_store, registry) = registry();
        let clone = registry.clone();
        let guard = registry.try_lock_browser_login().unwrap();
        assert!(matches!(
            clone.try_lock_browser_login(),
            Err(OpenAiAccountError::LoginInProgress)
        ));
        drop(guard);
        clone.lock_browser_login().await;
    }
}
