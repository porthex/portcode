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
//! are stored under four separate accounts:
//!   * `anthropic`         — a raw Anthropic API key (string).
//!   * `anthropic-oauth`   — subscription OAuth tokens, serialized as JSON.
//!   * `phone-sync-device` — the Noise static keypair, base64+JSON.
//!   * `phone-sync-iroh`   — the iroh node secret key, base64.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::OnceLock;

const ACCOUNT: &str = "anthropic";
const OAUTH_ACCOUNT: &str = "anthropic-oauth";
const DEVICE_ACCOUNT: &str = "phone-sync-device";
const IROH_ACCOUNT: &str = "phone-sync-iroh";

/// Directory for the (non-Windows) file secret store. Populated once by
/// [`init_dir`]; resolved (with a temp fallback) by `secrets_dir`.
static DIR: OnceLock<PathBuf> = OnceLock::new();

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
    use keyring::Entry;

    const SERVICE: &str = "dev.porthex.portcode";

    fn entry(account: &str) -> Result<Entry, String> {
        Entry::new(SERVICE, account).map_err(|e| e.to_string())
    }

    pub fn get(account: &str) -> Option<String> {
        entry(account).ok()?.get_password().ok()
    }

    pub fn set(account: &str, value: &str) -> Result<(), String> {
        entry(account)?
            .set_password(value)
            .map_err(|e| e.to_string())
    }

    pub fn delete(account: &str) -> Result<(), String> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
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
/// or corrupt file reads as empty rather than erroring. Writes go via a
/// temp-sibling + rename so a crash mid-write cannot leave a half-written file.
#[cfg(not(windows))]
mod backend {
    use std::collections::BTreeMap; // deterministic on-disk key order
    use std::path::{Path, PathBuf};

    fn store_path(dir: &Path) -> PathBuf {
        dir.join("secrets.json")
    }

    /// A missing OR corrupt file resolves to an empty map (never errors).
    fn read_map_in(dir: &Path) -> BTreeMap<String, String> {
        match std::fs::read(store_path(dir)) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => BTreeMap::new(),
        }
    }

    /// Write via a temp file + rename so a crash mid-write can't corrupt the store.
    fn write_map_in(dir: &Path, map: &BTreeMap<String, String>) -> Result<(), String> {
        let _ = std::fs::create_dir_all(dir); // safety net; lib.rs already creates it
        let json = serde_json::to_vec(map).map_err(|e| e.to_string())?;
        let path = store_path(dir);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }

    // dir-scoped core (also driven directly by the tests with an isolated dir).
    // `pub(crate)` (not private) so the `#[cfg(test)]` re-exports below are legal
    // (E0364: can't re-export a private item). Already called by get/set/delete
    // in every build, so this widening adds no dead code.
    pub(crate) fn get_in(dir: &Path, account: &str) -> Option<String> {
        read_map_in(dir).get(account).cloned()
    }

    pub(crate) fn set_in(dir: &Path, account: &str, value: &str) -> Result<(), String> {
        let mut map = read_map_in(dir);
        map.insert(account.to_string(), value.to_string());
        write_map_in(dir, &map)
    }

    pub(crate) fn delete_in(dir: &Path, account: &str) -> Result<(), String> {
        let mut map = read_map_in(dir);
        map.remove(account); // idempotent: removing an absent key is fine
        write_map_in(dir, &map) // re-write even if absent (cheap, keeps it simple)
    }

    // Public surface: resolve the dir once, delegate to the dir-scoped core.
    pub fn get(account: &str) -> Option<String> {
        get_in(&super::secrets_dir(), account)
    }

    pub fn set(account: &str, value: &str) -> Result<(), String> {
        set_in(&super::secrets_dir(), account, value)
    }

    pub fn delete(account: &str) -> Result<(), String> {
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

// ── API key ──────────────────────────────────────────────────────────────────

pub fn get_api_key() -> Option<String> {
    backend::get(ACCOUNT)
}

pub fn set_api_key(key: &str) -> Result<(), String> {
    backend::set(ACCOUNT, key)
}

pub fn has_api_key() -> bool {
    get_api_key().is_some()
}

// ── OAuth tokens ─────────────────────────────────────────────────────────────

/// Read the stored OAuth tokens, if any. Returns `None` when nothing is stored
/// or the stored blob fails to parse.
pub fn get_oauth() -> Option<OAuthTokens> {
    let json = backend::get(OAUTH_ACCOUNT)?;
    serde_json::from_str(&json).ok()
}

/// Persist OAuth tokens as JSON in the credential store.
pub fn set_oauth(tokens: &OAuthTokens) -> Result<(), String> {
    let json = serde_json::to_string(tokens).map_err(|e| e.to_string())?;
    backend::set(OAUTH_ACCOUNT, &json)
}

/// Remove the stored OAuth tokens. Idempotent: a missing entry is treated as a
/// successful clear (logging out when not signed in is not an error).
pub fn clear_oauth() -> Result<(), String> {
    backend::delete(OAUTH_ACCOUNT)
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
    let json = serde_json::to_string(&stored).map_err(|e| e.to_string())?;
    backend::set(DEVICE_ACCOUNT, &json)
}

/// Load the device static keypair as `(public, private)` raw bytes, if stored.
pub fn get_device_key() -> Option<(Vec<u8>, Vec<u8>)> {
    let json = backend::get(DEVICE_ACCOUNT)?;
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
    if let Some(b64) = backend::get(IROH_ACCOUNT) {
        if let Ok(bytes) = B64.decode(&b64) {
            if let Ok(arr) = <[u8; 32]>::try_from(bytes.as_slice()) {
                return Ok(iroh::SecretKey::from_bytes(&arr));
            }
        }
        // Corrupt/legacy blob → fall through and regenerate.
    }
    let key = iroh::SecretKey::generate();
    backend::set(IROH_ACCOUNT, &B64.encode(key.to_bytes()))?;
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

// File-backend tests run ONLY where the file backend exists (non-Windows). On
// Windows the file backend is `cfg`'d out, so this module is too — both targets
// compile/test clean. Each test uses its OWN temp dir via the dir-scoped
// internals, sidestepping the process-global `OnceLock<DIR>` once-only foot-gun.
#[cfg(all(test, not(windows)))]
mod file_backend_tests {
    use super::backend;
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
        assert_eq!(backend::test_get_in(&dir, "acct-a"), None);
        backend::test_set_in(&dir, "acct-a", "secret-A").unwrap();
        backend::test_set_in(&dir, "acct-b", "secret-B").unwrap();
        assert_eq!(
            backend::test_get_in(&dir, "acct-a").as_deref(),
            Some("secret-A")
        );
        assert_eq!(
            backend::test_get_in(&dir, "acct-b").as_deref(),
            Some("secret-B")
        );
        backend::test_delete_in(&dir, "acct-a").unwrap();
        assert_eq!(backend::test_get_in(&dir, "acct-a"), None);
        // unaffected sibling
        assert_eq!(
            backend::test_get_in(&dir, "acct-b").as_deref(),
            Some("secret-B")
        );
        // idempotent: deleting an absent / already-deleted key is Ok
        backend::test_delete_in(&dir, "acct-a").unwrap();
        backend::test_delete_in(&dir, "never-existed").unwrap();
    }

    #[test]
    fn corrupt_file_tolerated_as_empty() {
        let dir = fresh_dir("corrupt");
        std::fs::write(dir.join("secrets.json"), b"{ not valid json").unwrap();
        // a corrupt store reads as empty (None), not a panic / not an Err
        assert_eq!(backend::test_get_in(&dir, "acct-a"), None);
        // and a subsequent set overwrites the corrupt file with a valid map
        backend::test_set_in(&dir, "acct-a", "v2").unwrap();
        assert_eq!(backend::test_get_in(&dir, "acct-a").as_deref(), Some("v2"));
    }
}
