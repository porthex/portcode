//! API key storage backed by the Windows Credential Manager (via `keyring`).
//! Keys are never written to disk in plaintext.

use keyring::Entry;

const SERVICE: &str = "dev.porthex.portcode";
const ACCOUNT: &str = "anthropic";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

pub fn get_api_key() -> Option<String> {
    entry().ok()?.get_password().ok()
}

pub fn set_api_key(key: &str) -> Result<(), String> {
    entry()?.set_password(key).map_err(|e| e.to_string())
}

pub fn has_api_key() -> bool {
    get_api_key().is_some()
}
