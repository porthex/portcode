//! Credential storage backed by the Windows Credential Manager (via `keyring`).
//! Secrets are never written to disk in plaintext.
//!
//! Two credential kinds are supported and stored under two separate accounts of
//! the same service:
//!   * `anthropic`        — a raw Anthropic API key (string).
//!   * `anthropic-oauth`  — subscription OAuth tokens, serialized as JSON.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "dev.porthex.portcode";
const ACCOUNT: &str = "anthropic";
const OAUTH_ACCOUNT: &str = "anthropic-oauth";
const DEVICE_ACCOUNT: &str = "phone-sync-device";

/// Subscription OAuth tokens. `expires_at` is an absolute unix timestamp in
/// **seconds** (not millis) marking when `access_token` stops being valid.
#[derive(Serialize, Deserialize, Clone)]
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

/// The credential the agent should authenticate with for a given request.
#[derive(Clone)]
pub enum Credential {
    ApiKey(String),
    OAuth(OAuthTokens),
}

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

fn oauth_entry() -> Result<Entry, String> {
    Entry::new(SERVICE, OAUTH_ACCOUNT).map_err(|e| e.to_string())
}

// ── API key ──────────────────────────────────────────────────────────────────

pub fn get_api_key() -> Option<String> {
    entry().ok()?.get_password().ok()
}

pub fn set_api_key(key: &str) -> Result<(), String> {
    entry()?.set_password(key).map_err(|e| e.to_string())
}

pub fn has_api_key() -> bool {
    get_api_key().is_some()
}

// ── OAuth tokens ─────────────────────────────────────────────────────────────

/// Read the stored OAuth tokens, if any. Returns `None` when nothing is stored
/// or the stored blob fails to parse.
pub fn get_oauth() -> Option<OAuthTokens> {
    let json = oauth_entry().ok()?.get_password().ok()?;
    serde_json::from_str(&json).ok()
}

/// Persist OAuth tokens as JSON in the credential store.
pub fn set_oauth(tokens: &OAuthTokens) -> Result<(), String> {
    let json = serde_json::to_string(tokens).map_err(|e| e.to_string())?;
    oauth_entry()?
        .set_password(&json)
        .map_err(|e| e.to_string())
}

/// Remove the stored OAuth tokens. Idempotent: a missing entry is treated as a
/// successful clear (logging out when not signed in is not an error).
pub fn clear_oauth() -> Result<(), String> {
    match oauth_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ── Phone Sync device identity ───────────────────────────────────────────────

/// The device's long-term Noise static keypair, base64-encoded for the credential
/// store (keyring stores strings). The private half must never be written to disk
/// in any other form.
#[derive(Serialize, Deserialize)]
struct StoredDeviceKey {
    public: String,
    private: String,
}

fn device_entry() -> Result<Entry, String> {
    Entry::new(SERVICE, DEVICE_ACCOUNT).map_err(|e| e.to_string())
}

/// Persist the device static keypair (raw bytes) in the credential store.
pub fn set_device_key(public: &[u8], private: &[u8]) -> Result<(), String> {
    let stored = StoredDeviceKey {
        public: B64.encode(public),
        private: B64.encode(private),
    };
    let json = serde_json::to_string(&stored).map_err(|e| e.to_string())?;
    device_entry()?
        .set_password(&json)
        .map_err(|e| e.to_string())
}

/// Load the device static keypair as `(public, private)` raw bytes, if stored.
pub fn get_device_key() -> Option<(Vec<u8>, Vec<u8>)> {
    let json = device_entry().ok()?.get_password().ok()?;
    let stored: StoredDeviceKey = serde_json::from_str(&json).ok()?;
    let public = B64.decode(stored.public).ok()?;
    let private = B64.decode(stored.private).ok()?;
    Some((public, private))
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
