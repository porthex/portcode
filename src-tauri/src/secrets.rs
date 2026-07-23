#![allow(dead_code)]

//! Per-target credential storage.
//!
//! On **Windows** secrets are backed by the Windows Credential Manager (via the
//! `keyring` crate); they are never written to disk in plaintext.
//!
//! On **non-Windows targets (Android / Linux)** `keyring` has no working runtime
//! backend, so secrets live in an app-private JSON file (`secrets.json`) inside
//! the OS-sandboxed app-config dir provided by [`init_dir`]. See the `backend`
//! module for the security note on that store.
//!
//! Either way the public API below is identical across targets — only the
//! storage primitive differs, behind the private `backend` module. Credentials
//! are stored under provider-scoped accounts, including chunked `openai-oauth-*`
//! entries that stay below Windows Credential Manager's per-entry size limit:
//!   * `anthropic`         — a raw Anthropic API key (string).
//!   * `anthropic-oauth`   — subscription OAuth tokens, serialized as JSON.
//!   * `openai-oauth-*`    — chunked ChatGPT subscription OAuth credentials.
//!   * `phone-sync-device` — the Noise static keypair, base64+JSON.
//!   * `phone-sync-iroh`   — the iroh node secret key, base64.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::PathBuf;
use std::sync::OnceLock;
use thiserror::Error;

const ACCOUNT: &str = "anthropic";
const OAUTH_ACCOUNT: &str = "anthropic-oauth";
/// Legacy single-entry account, retained for migration and cleanup.
const OPENAI_OAUTH_ACCOUNT: &str = "openai-oauth";
const OPENAI_OAUTH_MANIFEST_ACCOUNT: &str = "openai-oauth-manifest";
const OPENAI_OAUTH_CHUNK_PREFIX: &str = "openai-oauth-chunk";
/// Chunk width used by the removed singleton writer; retained only for bounded,
/// backward-compatible migration reads and their tests.
const OPENAI_OAUTH_CHUNK_CHARS: usize = 1024;
/// Defensive corruption/abuse bound. Real token sets currently need fewer than 16.
const OPENAI_OAUTH_MAX_CHUNKS: usize = 64;
const DEVICE_ACCOUNT: &str = "phone-sync-device";
const IROH_ACCOUNT: &str = "phone-sync-iroh";

/// Directory for the (non-Windows) file secret store. Populated once by
/// [`init_dir`]; resolved (with a temp fallback) by `secrets_dir`.
static DIR: OnceLock<PathBuf> = OnceLock::new();

/// Typed failures from the native secret store.
///
/// `Absent` is deliberately distinct from malformed or unavailable storage.
/// Callers that own migrations or account registries must never interpret a
/// corrupt store as an empty store and silently overwrite recoverable data.
#[derive(Debug, Error)]
pub enum SecretStoreError {
    #[error("secret entry is absent")]
    Absent,
    #[error("secret store is locked or access is denied")]
    Locked,
    #[error("secret store is unavailable")]
    Unavailable,
    #[error("secret store I/O failed during {operation}: {kind:?}")]
    Io {
        operation: &'static str,
        kind: std::io::ErrorKind,
    },
    #[error("secret store data is corrupt: {0}")]
    Corrupt(String),
    #[error("secret store integrity check failed: {0}")]
    Integrity(String),
    #[error("secret payload is too large: {0}")]
    TooLarge(String),
    #[error("secret store changed during an update")]
    Conflict,
    #[error("secret store backend failed: {0}")]
    Backend(String),
}

/// Minimal injectable storage boundary used by the account registry.
///
/// Production delegates to [`SystemSecretStore`]. Unit tests can supply an
/// in-memory/fault-injecting implementation without reaching Credential Manager
/// or a process-global app directory.
pub(crate) trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<String, SecretStoreError>;
    fn set(&self, account: &str, value: &str) -> Result<(), SecretStoreError>;
    fn delete(&self, account: &str) -> Result<(), SecretStoreError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct SystemSecretStore;

impl SecretStore for SystemSecretStore {
    fn get(&self, account: &str) -> Result<String, SecretStoreError> {
        backend::get(account)
    }

    fn set(&self, account: &str, value: &str) -> Result<(), SecretStoreError> {
        backend::set(account, value)
    }

    fn delete(&self, account: &str) -> Result<(), SecretStoreError> {
        backend::delete(account)
    }
}

/// Point the (non-Windows) file secret store at an app-private directory.
///
/// Called once from `lib.rs` `setup()` with the app-config dir (app-private on
/// Android) BEFORE any secret access. On Windows this is a harmless record —
/// the `keyring` backend ignores it. Idempotent: a second call is ignored (the
/// `OnceLock::set` error is deliberately dropped).
pub fn init_dir(dir: PathBuf) {
    let _ = DIR.set(dir);
}

/// Resolve the file-store directory: the dir from [`init_dir`], else a temp
/// fallback so headless tests and any uninitialized path stay safe (never
/// panics). Only the non-Windows file backend reads this.
#[cfg(not(windows))]
fn secrets_dir() -> PathBuf {
    DIR.get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("portcode"))
}

// ── per-target secret backend ────────────────────────────────────────────────
//
// A uniform 3-fn storage primitive — get / set / delete (delete is IDEMPOTENT:
// a missing entry is `Ok`). EXACTLY ONE impl compiles per target (`windows` vs
// `not(windows)` is an exhaustive partition), so no target gets zero or two
// backends. Callers below go through this; the encoding (base64 / serde / JSON)
// is identical on both targets.

/// Windows: wraps `keyring::Entry` exactly as the pre-split module did, so the
/// Windows runtime behavior is byte-identical (Credential Manager, `NoEntry`
/// tolerated on delete).
#[cfg(windows)]
mod backend {
    use super::SecretStoreError;
    use keyring::Entry;

    const SERVICE: &str = "dev.porthex.portcode";

    fn map_keyring_error(error: keyring::Error) -> SecretStoreError {
        match error {
            keyring::Error::NoEntry => SecretStoreError::Absent,
            keyring::Error::NoStorageAccess(_) => SecretStoreError::Locked,
            keyring::Error::PlatformFailure(_) => SecretStoreError::Unavailable,
            keyring::Error::BadEncoding(_) => {
                SecretStoreError::Corrupt("credential value is not valid UTF-8".into())
            }
            keyring::Error::TooLong(_, limit) => SecretStoreError::TooLarge(format!(
                "credential attribute exceeds the platform limit of {limit} characters"
            )),
            keyring::Error::Ambiguous(_) => {
                SecretStoreError::Integrity("multiple credential entries matched".into())
            }
            _ => SecretStoreError::Unavailable,
        }
    }

    fn entry(account: &str) -> Result<Entry, SecretStoreError> {
        Entry::new(SERVICE, account).map_err(map_keyring_error)
    }

    pub fn get(account: &str) -> Result<String, SecretStoreError> {
        match entry(account)?.get_password() {
            Ok(value) => Ok(value),
            Err(keyring::Error::NoEntry) => Err(SecretStoreError::Absent),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    pub fn set(account: &str, value: &str) -> Result<(), SecretStoreError> {
        entry(account)?
            .set_password(value)
            .map_err(map_keyring_error)
    }

    pub fn delete(account: &str) -> Result<(), SecretStoreError> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::io;

        #[test]
        fn keyring_access_and_platform_failures_remain_distinct() {
            assert!(matches!(
                map_keyring_error(keyring::Error::NoStorageAccess(Box::new(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "vault locked"
                )))),
                SecretStoreError::Locked
            ));
            assert!(matches!(
                map_keyring_error(keyring::Error::PlatformFailure(Box::new(io::Error::new(
                    io::ErrorKind::NotConnected,
                    "vault unavailable"
                )))),
                SecretStoreError::Unavailable
            ));
        }
    }
}

/// Non-Windows (Android / Linux): an app-private JSON file store.
///
/// There is no working `keyring` backend on these targets, so secrets live in a
/// single `secrets.json` map under the OS-sandboxed app-config dir. On Android
/// other apps cannot read that dir without root — an acceptable alpha baseline.
/// The hardening path is the hardware-backed Android Keystore via a JNI bridge,
/// which is deferred.
///
/// Each call reads/writes the whole (tiny, infrequently touched) map. A missing
/// file is an empty store; malformed data and I/O failures remain typed errors.
/// Writes are serialized and use a mode-0600 temp sibling, file flush, atomic
/// rename, and best-effort directory flush.
#[cfg(not(windows))]
mod backend {
    use super::SecretStoreError;
    use std::collections::BTreeMap; // deterministic on-disk key order
    use std::fs::{File, OpenOptions};
    use std::io::Write as _;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt as _;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    /// Serializes the complete read-modify-write transaction. Without this,
    /// concurrent writes to different accounts can both read the same map and
    /// the later rename silently drops the earlier update.
    static STORE_COMMIT_LOCK: Mutex<()> = Mutex::new(());

    fn io_error(operation: &'static str, error: std::io::Error) -> SecretStoreError {
        match error.kind() {
            std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::WouldBlock => {
                SecretStoreError::Locked
            }
            kind => SecretStoreError::Io { operation, kind },
        }
    }

    fn store_path(dir: &Path) -> PathBuf {
        dir.join("secrets.json")
    }

    /// A missing file is an empty store. Corruption and other I/O failures are
    /// explicit so callers fail closed instead of replacing recoverable data.
    fn read_map_in(dir: &Path) -> Result<BTreeMap<String, String>, SecretStoreError> {
        match std::fs::read(store_path(dir)) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| SecretStoreError::Corrupt("secret store JSON is invalid".into())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(error) => Err(io_error("read", error)),
        }
    }

    /// Write, flush, and atomically rename a uniquely named sibling. A stale
    /// temp file from a killed process cannot collide with a later writer.
    fn write_map_in(dir: &Path, map: &BTreeMap<String, String>) -> Result<(), SecretStoreError> {
        std::fs::create_dir_all(dir).map_err(|error| io_error("create directory", error))?;
        let json = serde_json::to_vec(map).map_err(|_| {
            SecretStoreError::Corrupt("secret store map is not serializable".into())
        })?;
        let path = store_path(dir);
        let tmp = dir.join(format!(
            ".secrets-{}-{}.tmp",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut file = options
                .open(&tmp)
                .map_err(|error| io_error("open temporary file", error))?;
            file.write_all(&json)
                .map_err(|error| io_error("write temporary file", error))?;
            file.sync_all()
                .map_err(|error| io_error("sync temporary file", error))?;
            drop(file);
            std::fs::rename(&tmp, &path)
                .map_err(|error| io_error("replace secret store", error))?;
            // Best-effort durability for the directory entry. Some mobile file
            // systems reject directory fsync even though the rename succeeded.
            let _ = File::open(dir).and_then(|directory| directory.sync_all());
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result
    }

    // dir-scoped core (also driven directly by the tests with an isolated dir).
    // `pub(crate)` (not private) so the `#[cfg(test)]` re-exports below are legal
    // (E0364: can't re-export a private item). Already called by get/set/delete
    // in every build, so this widening adds no dead code.
    pub(crate) fn get_in(dir: &Path, account: &str) -> Result<String, SecretStoreError> {
        let _guard = STORE_COMMIT_LOCK
            .lock()
            .map_err(|_| SecretStoreError::Unavailable)?;
        read_map_in(dir)?
            .get(account)
            .cloned()
            .ok_or(SecretStoreError::Absent)
    }

    pub(crate) fn set_in(dir: &Path, account: &str, value: &str) -> Result<(), SecretStoreError> {
        let _guard = STORE_COMMIT_LOCK
            .lock()
            .map_err(|_| SecretStoreError::Unavailable)?;
        let mut map = read_map_in(dir)?;
        map.insert(account.to_string(), value.to_string());
        write_map_in(dir, &map)
    }

    pub(crate) fn delete_in(dir: &Path, account: &str) -> Result<(), SecretStoreError> {
        let _guard = STORE_COMMIT_LOCK
            .lock()
            .map_err(|_| SecretStoreError::Unavailable)?;
        let mut map = read_map_in(dir)?;
        map.remove(account); // idempotent: removing an absent key is fine
        write_map_in(dir, &map)
    }

    // Public surface: resolve the dir once, delegate to the dir-scoped core.
    pub fn get(account: &str) -> Result<String, SecretStoreError> {
        get_in(&super::secrets_dir(), account)
    }

    pub fn set(account: &str, value: &str) -> Result<(), SecretStoreError> {
        set_in(&super::secrets_dir(), account, value)
    }

    pub fn delete(account: &str) -> Result<(), SecretStoreError> {
        delete_in(&super::secrets_dir(), account)
    }

    // Test-only re-exports of the dir-scoped core so the sibling test module can
    // drive an isolated dir without touching the process-global `DIR`. Gated by
    // `cfg(test)` + `cfg(not(windows))` so it never widens the runtime API.
    #[cfg(test)]
    pub(crate) use {delete_in as test_delete_in, get_in as test_get_in, set_in as test_set_in};
}

/// Subscription OAuth tokens. `expires_at` is an absolute unix timestamp in
/// **seconds** (not millis) marking when `access_token` stops being valid.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    /// Account email from the OAuth profile (display only). Optional: the token
    /// endpoint doesn't return it, and older stored blobs predate this field.
    #[serde(default)]
    pub email: Option<String>,
    /// Subscription plan tier: `"max"` / `"pro"` (display only).
    #[serde(default)]
    pub plan: Option<String>,
}

impl fmt::Debug for OAuthTokens {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OAuthTokens")
            .field("access_token", &"[REDACTED]")
            .field("refresh_token", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .field("email", &self.email.as_ref().map(|_| "[REDACTED]"))
            .field("plan", &self.plan)
            .finish()
    }
}

/// ChatGPT subscription tokens. Kept separate from Anthropic OAuth so logout
/// and refresh failures can only affect the provider that produced them.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct OpenAiOAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    #[serde(default)]
    pub id_token: Option<String>,
    pub expires_at: i64,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default)]
    pub is_fedramp: bool,
}

impl fmt::Debug for OpenAiOAuthTokens {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenAiOAuthTokens")
            .field("access_token", &"[REDACTED]")
            .field("refresh_token", &"[REDACTED]")
            .field("id_token", &self.id_token.as_ref().map(|_| "[REDACTED]"))
            .field("expires_at", &self.expires_at)
            .field(
                "account_id",
                &self.account_id.as_ref().map(|_| "[REDACTED]"),
            )
            .field("email", &self.email.as_ref().map(|_| "[REDACTED]"))
            .field("plan", &self.plan)
            .field("is_fedramp", &self.is_fedramp)
            .finish()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
struct OpenAiOAuthManifest {
    version: u8,
    slot: String,
    chunks: usize,
}

fn openai_chunk_account(slot: &str, index: usize) -> String {
    format!("{OPENAI_OAUTH_CHUNK_PREFIX}-{slot}-{index}")
}

fn valid_openai_manifest(manifest: &OpenAiOAuthManifest) -> bool {
    manifest.version == 1
        && matches!(manifest.slot.as_str(), "a" | "b")
        && (1..=OPENAI_OAUTH_MAX_CHUNKS).contains(&manifest.chunks)
}

fn read_openai_manifest_from(
    store: &dyn SecretStore,
) -> Result<Option<OpenAiOAuthManifest>, SecretStoreError> {
    let value = match store.get(OPENAI_OAUTH_MANIFEST_ACCOUNT) {
        Ok(value) => value,
        Err(SecretStoreError::Absent) => return Ok(None),
        Err(error) => return Err(error),
    };
    let manifest: OpenAiOAuthManifest = serde_json::from_str(&value)
        .map_err(|_| SecretStoreError::Corrupt("legacy OpenAI manifest is invalid".into()))?;
    if !valid_openai_manifest(&manifest) {
        return Err(SecretStoreError::Corrupt(
            "invalid legacy OpenAI manifest".into(),
        ));
    }
    Ok(Some(manifest))
}

#[cfg(test)]
fn encode_openai_chunks(tokens: &OpenAiOAuthTokens) -> Result<Vec<String>, String> {
    let json = serde_json::to_vec(tokens)
        .map_err(|_| "Could not encode the legacy OpenAI credential.".to_string())?;
    let encoded = B64.encode(json);
    let chunks: Vec<String> = encoded
        .as_bytes()
        .chunks(OPENAI_OAUTH_CHUNK_CHARS)
        .map(|chunk| String::from_utf8(chunk.to_vec()).expect("base64 is ASCII"))
        .collect();
    if chunks.is_empty() || chunks.len() > OPENAI_OAUTH_MAX_CHUNKS {
        return Err("OpenAI credential payload is too large to store securely.".into());
    }
    Ok(chunks)
}

fn decode_openai_chunks(chunks: &[String]) -> Option<OpenAiOAuthTokens> {
    let encoded = chunks.concat();
    let json = B64.decode(encoded).ok()?;
    serde_json::from_slice(&json).ok()
}

fn delete_openai_slot_from(
    store: &dyn SecretStore,
    slot: &str,
    chunks: usize,
) -> Result<(), SecretStoreError> {
    let mut first_error = None;
    for index in 0..chunks.min(OPENAI_OAUTH_MAX_CHUNKS) {
        if let Err(error) = store.delete(&openai_chunk_account(slot, index)) {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn validate_legacy_openai_chunk(
    chunk: &str,
    index: usize,
    chunks: usize,
) -> Result<(), SecretStoreError> {
    let is_final = index + 1 == chunks;
    if chunk.is_empty()
        || chunk.len() > OPENAI_OAUTH_CHUNK_CHARS
        || (!is_final && chunk.len() != OPENAI_OAUTH_CHUNK_CHARS)
        || !chunk.is_ascii()
    {
        return Err(SecretStoreError::Corrupt(
            "legacy OpenAI credential chunk is invalid".into(),
        ));
    }
    Ok(())
}

fn read_openai_tokens_from(
    store: &dyn SecretStore,
) -> Result<Option<OpenAiOAuthTokens>, SecretStoreError> {
    if let Some(manifest) = read_openai_manifest_from(store)? {
        let mut chunks = Vec::with_capacity(manifest.chunks);
        for index in 0..manifest.chunks {
            match store.get(&openai_chunk_account(&manifest.slot, index)) {
                Ok(chunk) => {
                    validate_legacy_openai_chunk(&chunk, index, manifest.chunks)?;
                    chunks.push(chunk);
                }
                Err(SecretStoreError::Absent) => {
                    return Err(SecretStoreError::Integrity(
                        "legacy OpenAI credential chunk is missing".into(),
                    ));
                }
                Err(error) => return Err(error),
            }
        }
        let tokens = decode_openai_chunks(&chunks).ok_or_else(|| {
            SecretStoreError::Corrupt("legacy OpenAI credential payload is invalid".into())
        })?;
        return Ok(Some(tokens));
    }

    // Oldest builds stored the complete token JSON in one entry.
    let json = match store.get(OPENAI_OAUTH_ACCOUNT) {
        Ok(json) => json,
        Err(SecretStoreError::Absent) => return Ok(None),
        Err(error) => return Err(error),
    };
    serde_json::from_str(&json)
        .map(Some)
        .map_err(|_| SecretStoreError::Corrupt("legacy OpenAI credential is invalid".into()))
}

pub(crate) fn load_legacy_openai_oauth_from(
    store: &dyn SecretStore,
) -> Result<Option<OpenAiOAuthTokens>, SecretStoreError> {
    read_openai_tokens_from(store)
}

pub(crate) fn clear_legacy_openai_oauth_from(
    store: &dyn SecretStore,
) -> Result<(), SecretStoreError> {
    let mut first_error = None;
    for result in [
        store.delete(OPENAI_OAUTH_MANIFEST_ACCOUNT),
        store.delete(OPENAI_OAUTH_ACCOUNT),
    ] {
        if let Err(error) = result {
            first_error.get_or_insert(error);
        }
    }
    for slot in ["a", "b"] {
        if let Err(error) = delete_openai_slot_from(store, slot, OPENAI_OAUTH_MAX_CHUNKS) {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

#[cfg(test)]
pub(crate) fn store_legacy_openai_oauth_for_test(
    store: &dyn SecretStore,
    tokens: &OpenAiOAuthTokens,
) -> Result<(), SecretStoreError> {
    let json = serde_json::to_string(tokens)
        .map_err(|_| SecretStoreError::Corrupt("legacy OpenAI credential is invalid".into()))?;
    store.set(OPENAI_OAUTH_ACCOUNT, &json)
}

#[cfg(test)]
pub(crate) fn store_chunked_legacy_openai_oauth_for_test(
    store: &dyn SecretStore,
    tokens: &OpenAiOAuthTokens,
) -> Result<(), SecretStoreError> {
    let chunks = encode_openai_chunks(tokens).map_err(SecretStoreError::TooLarge)?;
    for (index, chunk) in chunks.iter().enumerate() {
        store.set(&openai_chunk_account("a", index), chunk)?;
    }
    let manifest = OpenAiOAuthManifest {
        version: 1,
        slot: "a".into(),
        chunks: chunks.len(),
    };
    let manifest = serde_json::to_string(&manifest)
        .map_err(|_| SecretStoreError::Corrupt("legacy OpenAI manifest is invalid".into()))?;
    store.set(OPENAI_OAUTH_MANIFEST_ACCOUNT, &manifest)
}

/// The credential the agent should authenticate with for a given request.
#[derive(Clone)]
pub enum Credential {
    ApiKey(String),
    OAuth(OAuthTokens),
    OpenAiOAuth(OpenAiOAuthTokens),
}

// ── API key ──────────────────────────────────────────────────────────────────

pub fn get_api_key() -> Option<String> {
    backend::get(ACCOUNT).ok()
}

pub fn set_api_key(key: &str) -> Result<(), String> {
    backend::set(ACCOUNT, key).map_err(|error| error.to_string())
}

pub fn has_api_key() -> bool {
    get_api_key().is_some()
}

// ── OAuth tokens ─────────────────────────────────────────────────────────────

/// Read the stored OAuth tokens, if any. Returns `None` when nothing is stored
/// or the stored blob fails to parse.
pub fn get_oauth() -> Option<OAuthTokens> {
    let json = backend::get(OAUTH_ACCOUNT).ok()?;
    serde_json::from_str(&json).ok()
}

/// Persist OAuth tokens as JSON in the credential store.
pub fn set_oauth(tokens: &OAuthTokens) -> Result<(), String> {
    let json = serde_json::to_string(tokens)
        .map_err(|_| "Could not encode the Anthropic credential.".to_string())?;
    backend::set(OAUTH_ACCOUNT, &json).map_err(|error| error.to_string())
}

/// Remove the stored OAuth tokens. Idempotent: a missing entry is treated as a
/// successful clear (logging out when not signed in is not an error).
pub fn clear_oauth() -> Result<(), String> {
    backend::delete(OAUTH_ACCOUNT).map_err(|error| error.to_string())
}

// ── Phone Sync device identity ───────────────────────────────────────────────

/// The device's long-term Noise static keypair, base64-encoded for the credential
/// store (the store holds strings). The private half must never be written to
/// disk in any other form.
#[derive(Serialize, Deserialize)]
struct StoredDeviceKey {
    public: String,
    private: String,
}

/// Persist the device static keypair (raw bytes) in the credential store.
pub fn set_device_key(public: &[u8], private: &[u8]) -> Result<(), String> {
    let stored = StoredDeviceKey {
        public: B64.encode(public),
        private: B64.encode(private),
    };
    let json = serde_json::to_string(&stored)
        .map_err(|_| "Could not encode the device credential.".to_string())?;
    backend::set(DEVICE_ACCOUNT, &json).map_err(|error| error.to_string())
}

/// Load the device static keypair as `(public, private)` raw bytes, if stored.
pub fn get_device_key() -> Option<(Vec<u8>, Vec<u8>)> {
    let json = backend::get(DEVICE_ACCOUNT).ok()?;
    let stored: StoredDeviceKey = serde_json::from_str(&json).ok()?;
    let public = B64.decode(stored.public).ok()?;
    let private = B64.decode(stored.private).ok()?;
    Some((public, private))
}

// ── Phone Sync iroh node key ─────────────────────────────────────────────────

/// Load the persisted iroh node secret key, generating + storing one on first
/// run. Stored base64 (the store holds strings); the 32 raw bytes round-trip
/// through `SecretKey::{to_bytes, from_bytes}`. Distinct from the Noise static
/// identity (`device_*`): this is the transport/node key.
pub fn get_or_create_iroh_key() -> Result<iroh::SecretKey, String> {
    match backend::get(IROH_ACCOUNT) {
        Ok(b64) => {
            let bytes = B64
                .decode(&b64)
                .map_err(|_| "Stored Phone Sync transport identity is corrupt.".to_string())?;
            let arr = <[u8; 32]>::try_from(bytes.as_slice())
                .map_err(|_| "Stored Phone Sync transport identity is corrupt.".to_string())?;
            return Ok(iroh::SecretKey::from_bytes(&arr));
        }
        Err(SecretStoreError::Absent) => {}
        Err(error) => return Err(error.to_string()),
    }
    let key = iroh::SecretKey::generate();
    backend::set(IROH_ACCOUNT, &B64.encode(key.to_bytes())).map_err(|error| error.to_string())?;
    Ok(key)
}

// ── unified lookup ───────────────────────────────────────────────────────────

/// Pick the credential to authenticate with. OAuth (a subscription sign-in)
/// takes precedence over a raw API key when both are present. Token refresh is
/// handled by the caller (see `agent.rs`).
pub fn load_credential() -> Option<Credential> {
    if let Some(tokens) = get_oauth() {
        return Some(Credential::OAuth(tokens));
    }
    if let Some(key) = get_api_key() {
        return Some(Credential::ApiKey(key));
    }
    None
}

/// Load only the credential owned by `provider`; never send one service's
/// bearer token to another service after a model/provider switch.
pub fn load_credential_for(provider: &str) -> Option<Credential> {
    match provider {
        "anthropic" => load_credential(),
        // OpenAI has no process-global credential after registry migration.
        // Callers must resolve a canonical profile and hold its lifecycle lease.
        "openai" => None,
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_tokens_round_trip_as_json() {
        let t = OAuthTokens {
            access_token: "access-123".into(),
            refresh_token: "refresh-456".into(),
            expires_at: 1_700_000_000,
            email: Some("user@example.com".into()),
            plan: Some("max".into()),
        };
        let json = serde_json::to_string(&t).unwrap();
        let back: OAuthTokens = serde_json::from_str(&json).unwrap();
        assert_eq!(back.access_token, "access-123");
        assert_eq!(back.refresh_token, "refresh-456");
        assert_eq!(back.expires_at, 1_700_000_000);
    }

    #[test]
    fn openai_oauth_tokens_round_trip_with_account_claims() {
        let t = OpenAiOAuthTokens {
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            id_token: Some("id".into()),
            expires_at: 1_700_000_000,
            account_id: Some("acct_123".into()),
            email: Some("user@example.com".into()),
            plan: Some("plus".into()),
            is_fedramp: true,
        };
        let back: OpenAiOAuthTokens =
            serde_json::from_str(&serde_json::to_string(&t).unwrap()).unwrap();
        assert_eq!(back.account_id.as_deref(), Some("acct_123"));
        assert_eq!(back.plan.as_deref(), Some("plus"));
        assert!(back.is_fedramp);
    }

    #[test]
    fn openai_oauth_chunk_encoding_stays_under_windows_limit_and_round_trips() {
        let tokens = OpenAiOAuthTokens {
            access_token: "a".repeat(3_500),
            refresh_token: "r".repeat(2_800),
            id_token: Some("i".repeat(3_200)),
            expires_at: 1_900_000_000,
            account_id: Some("acct_123".into()),
            email: Some("user@example.com".into()),
            plan: Some("plus".into()),
            is_fedramp: false,
        };

        let chunks = encode_openai_chunks(&tokens).unwrap();
        assert!(chunks.len() > 1);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.encode_utf16().count() <= OPENAI_OAUTH_CHUNK_CHARS));

        let decoded = decode_openai_chunks(&chunks).unwrap();
        assert_eq!(decoded.access_token, tokens.access_token);
        assert_eq!(decoded.refresh_token, tokens.refresh_token);
        assert_eq!(decoded.id_token, tokens.id_token);
        assert_eq!(decoded.account_id, tokens.account_id);
        assert_eq!(decoded.email, tokens.email);
        assert_eq!(decoded.expires_at, tokens.expires_at);
    }

    #[test]
    fn openai_oauth_manifest_rejects_untrusted_slots_and_chunk_counts() {
        assert!(valid_openai_manifest(&OpenAiOAuthManifest {
            version: 1,
            slot: "a".into(),
            chunks: 2,
        }));
        assert!(!valid_openai_manifest(&OpenAiOAuthManifest {
            version: 1,
            slot: "../other".into(),
            chunks: 2,
        }));
        assert!(!valid_openai_manifest(&OpenAiOAuthManifest {
            version: 1,
            slot: "b".into(),
            chunks: OPENAI_OAUTH_MAX_CHUNKS + 1,
        }));
    }

    #[test]
    fn legacy_openai_chunks_are_bounded_before_concatenation_or_decode() {
        assert!(validate_legacy_openai_chunk(&"A".repeat(OPENAI_OAUTH_CHUNK_CHARS), 0, 2,).is_ok());
        assert!(validate_legacy_openai_chunk("AAAA", 1, 2).is_ok());
        assert!(
            validate_legacy_openai_chunk(&"A".repeat(OPENAI_OAUTH_CHUNK_CHARS + 1), 0, 1,).is_err()
        );
        assert!(validate_legacy_openai_chunk("short", 0, 2).is_err());
        assert!(validate_legacy_openai_chunk("", 0, 1).is_err());
        assert!(validate_legacy_openai_chunk("non-ascii-é", 0, 1).is_err());
    }

    // Pure encoding test (no keyring I/O — that can't run on headless CI): binary
    // key material survives base64 → JSON → base64 round-trip intact.
    #[test]
    fn device_key_bytes_round_trip_through_base64_json() {
        let public = vec![1u8, 2, 3, 250, 251, 255];
        let private = vec![9u8, 8, 7, 0, 128, 200];
        let stored = StoredDeviceKey {
            public: B64.encode(&public),
            private: B64.encode(&private),
        };
        let json = serde_json::to_string(&stored).unwrap();
        let back: StoredDeviceKey = serde_json::from_str(&json).unwrap();
        assert_eq!(B64.decode(back.public).unwrap(), public);
        assert_eq!(B64.decode(back.private).unwrap(), private);
    }
}

// File-backend tests run ONLY where the file backend exists (non-Windows). On
// Windows the file backend is `cfg`'d out, so this module is too — both targets
// compile/test clean. Each test uses its OWN temp dir via the dir-scoped
// internals, sidestepping the process-global `OnceLock<DIR>` once-only foot-gun.
#[cfg(all(test, not(windows)))]
mod file_backend_tests {
    use super::{backend, SecretStoreError};
    use std::path::PathBuf;

    fn fresh_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "portcode-secrets-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&p); // start clean even across reruns
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn set_get_delete_round_trip_and_idempotent() {
        let dir = fresh_dir("rt");
        assert!(matches!(
            backend::test_get_in(&dir, "acct-a"),
            Err(SecretStoreError::Absent)
        ));
        backend::test_set_in(&dir, "acct-a", "secret-A").unwrap();
        backend::test_set_in(&dir, "acct-b", "secret-B").unwrap();
        assert_eq!(backend::test_get_in(&dir, "acct-a").unwrap(), "secret-A");
        assert_eq!(backend::test_get_in(&dir, "acct-b").unwrap(), "secret-B");
        backend::test_delete_in(&dir, "acct-a").unwrap();
        assert!(matches!(
            backend::test_get_in(&dir, "acct-a"),
            Err(SecretStoreError::Absent)
        ));
        // unaffected sibling
        assert_eq!(backend::test_get_in(&dir, "acct-b").unwrap(), "secret-B");
        // idempotent: deleting an absent / already-deleted key is Ok
        backend::test_delete_in(&dir, "acct-a").unwrap();
        backend::test_delete_in(&dir, "never-existed").unwrap();
    }

    #[test]
    fn corrupt_file_fails_closed_and_is_not_overwritten() {
        let dir = fresh_dir("corrupt");
        std::fs::write(dir.join("secrets.json"), b"{ not valid json").unwrap();
        assert!(matches!(
            backend::test_get_in(&dir, "acct-a"),
            Err(SecretStoreError::Corrupt(_))
        ));
        assert!(matches!(
            backend::test_set_in(&dir, "acct-a", "v2"),
            Err(SecretStoreError::Corrupt(_))
        ));
        assert_eq!(
            std::fs::read(dir.join("secrets.json")).unwrap(),
            b"{ not valid json"
        );
    }

    #[test]
    fn concurrent_updates_do_not_drop_sibling_accounts() {
        let dir = fresh_dir("concurrent");
        let mut threads = Vec::new();
        for index in 0..16 {
            let dir = dir.clone();
            threads.push(std::thread::spawn(move || {
                backend::test_set_in(&dir, &format!("acct-{index}"), &format!("value-{index}"))
                    .unwrap();
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        for index in 0..16 {
            assert_eq!(
                backend::test_get_in(&dir, &format!("acct-{index}")).unwrap(),
                format!("value-{index}")
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn file_store_is_owner_read_write_only() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = fresh_dir("permissions");
        backend::test_set_in(&dir, "acct", "secret").unwrap();
        let mode = std::fs::metadata(dir.join("secrets.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}
