//! Credential storage backed by the Windows Credential Manager (via `keyring`).
//! Secrets are never written to disk in plaintext.
//!
//! Two credential kinds are supported and stored under two separate accounts of
//! the same service:
//!   * `anthropic`        — a raw Anthropic API key (string).
//!   * `anthropic-oauth`  — subscription OAuth tokens, serialized as JSON.

use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "dev.porthex.portcode";
const ACCOUNT: &str = "anthropic";
const OAUTH_ACCOUNT: &str = "anthropic-oauth";

/// Subscription OAuth tokens. `expires_at` is an absolute unix timestamp in
/// **seconds** (not millis) marking when `access_token` stops being valid.
#[derive(Serialize, Deserialize, Clone)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
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
        };
        let json = serde_json::to_string(&t).unwrap();
        let back: OAuthTokens = serde_json::from_str(&json).unwrap();
        assert_eq!(back.access_token, "access-123");
        assert_eq!(back.refresh_token, "refresh-456");
        assert_eq!(back.expires_at, 1_700_000_000);
    }
}
