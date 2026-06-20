//! Anthropic subscription (Pro/Max) OAuth, using Authorization Code + PKCE with
//! a loopback redirect.
//!
//! The constants and flow below are credited to the **opencode** project (MIT
//! License) and to the official Claude Code CLI (`claude.js`), from which the
//! public client id, endpoints, and scopes were extracted. They are reproduced
//! here so Portcode users can authenticate with an existing Claude subscription
//! instead of a metered API key.

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::secrets::OAuthTokens;

// ── verified constants (opencode MIT + extracted claude.js) ──────────────────

/// Public OAuth client id for the Claude Code application.
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/// Authorization endpoint (user-facing consent page).
const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
/// Token endpoint (code exchange + refresh).
const TOKEN_URL: &str = "https://console.anthropic.com/v1/oauth/token";
/// Space-separated OAuth scopes required for subscription inference.
const SCOPES: &str = "org:create_api_key user:profile user:inference";

/// How long the whole interactive login may take before we give up.
const LOGIN_TIMEOUT_SECS: u64 = 180;
/// Per-connection read budget so a browser pre-connect can't stall the login.
const CONNECTION_READ_SECS: u64 = 10;

const SUCCESS_HTML: &str = "<!doctype html><meta charset=\"utf-8\"><title>Portcode</title>\
<body style=\"font-family:system-ui,sans-serif;text-align:center;padding-top:4rem;color:#1c1c1e\">\
<h2>Signed in to Portcode</h2><p>You can close this tab and return to the app.</p>";
const FAILURE_HTML: &str = "<!doctype html><meta charset=\"utf-8\"><title>Portcode</title>\
<body style=\"font-family:system-ui,sans-serif;text-align:center;padding-top:4rem;color:#1c1c1e\">\
<h2>Sign-in could not be completed</h2><p>You can close this tab and try again from the app.</p>";
const NOT_FOUND_HTML: &str = "<!doctype html><title>Portcode</title><body><p>Not found.</p>";

// ── time ─────────────────────────────────────────────────────────────────────

/// Current unix time in **seconds**. Returns 0 if the system clock predates the
/// unix epoch (which would make every token look already-expired — safe).
pub fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ── PKCE + state ─────────────────────────────────────────────────────────────

/// A PKCE verifier/challenge pair (S256).
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    /// `verifier = base64url(32 random bytes)`,
    /// `challenge = base64url(sha256(verifier))`.
    pub fn generate() -> Self {
        let verifier = base64url(&random_bytes());
        let mut hasher = Sha256::new();
        hasher.update(verifier.as_bytes());
        let challenge = base64url(&hasher.finalize());
        Pkce {
            verifier,
            challenge,
        }
    }
}

/// An anti-CSRF `state` value, independent of the PKCE verifier.
pub fn gen_state() -> String {
    base64url(&random_bytes())
}

fn random_bytes() -> [u8; 32] {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes
}

fn base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

// ── authorize URL ────────────────────────────────────────────────────────────

/// Build the consent-page URL. Query encoding matches the reference JS clients
/// (`URLSearchParams` / form-urlencoded), so spaces in `scope` become `+`.
pub fn build_authorize_url(redirect_uri: &str, challenge: &str, state: &str) -> String {
    let mut url = reqwest::Url::parse(AUTHORIZE_URL).expect("AUTHORIZE_URL is a valid const URL");
    url.query_pairs_mut()
        .append_pair("code", "true")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", SCOPES)
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256");
    url.to_string()
}

// ── token exchange + refresh ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: i64,
}

/// Exchange an authorization `code` (with its PKCE `verifier`) for tokens.
pub async fn exchange_code(
    http: &reqwest::Client,
    code: &str,
    state: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<OAuthTokens, String> {
    let body = json!({
        "grant_type": "authorization_code",
        "code": code,
        "state": state,
        "client_id": CLIENT_ID,
        "redirect_uri": redirect_uri,
        "code_verifier": verifier,
    });
    post_tokens(http, &body, None).await
}

/// Obtain a fresh access token from a `refresh_token`. If the server does not
/// return a new refresh token, the existing one is carried forward.
pub async fn refresh(http: &reqwest::Client, refresh_token: &str) -> Result<OAuthTokens, String> {
    let body = json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CLIENT_ID,
    });
    post_tokens(http, &body, Some(refresh_token)).await
}

/// POST to the token endpoint and map the response into `OAuthTokens`.
/// `fallback_refresh` is reused when the response omits a refresh token.
async fn post_tokens(
    http: &reqwest::Client,
    body: &serde_json::Value,
    fallback_refresh: Option<&str>,
) -> Result<OAuthTokens, String> {
    let resp = http
        .post(TOKEN_URL)
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Token request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        // A failed token response carries an OAuth error object, never our
        // tokens, so it is safe to surface for diagnostics.
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("OAuth token request failed ({status}): {text}"));
    }

    let tr: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Could not parse the OAuth token response: {e}"))?;

    let refresh_token = tr
        .refresh_token
        .or_else(|| fallback_refresh.map(str::to_string))
        .ok_or("OAuth token response did not include a refresh token.")?;

    Ok(OAuthTokens {
        access_token: tr.access_token,
        refresh_token,
        expires_at: now_secs() + tr.expires_in,
    })
}

// ── loopback login ───────────────────────────────────────────────────────────

/// Run the full interactive login: bind a loopback listener, open the system
/// browser to the consent page, wait for the redirect, and exchange the code.
/// The whole flow is bounded by `LOGIN_TIMEOUT_SECS`.
pub async fn run_loopback_login(http: &reqwest::Client) -> Result<OAuthTokens, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Could not start the local sign-in listener: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://localhost:{port}/callback");

    let pkce = Pkce::generate();
    let state = gen_state();
    let url = build_authorize_url(&redirect_uri, &pkce.challenge, &state);

    // Open the consent page with the OS default browser (no in-app webview).
    tauri_plugin_opener::open_url(&url, None::<&str>)
        .map_err(|e| format!("Could not open the browser for sign-in: {e}"))?;

    let code = tokio::time::timeout(
        Duration::from_secs(LOGIN_TIMEOUT_SECS),
        await_callback(&listener, &state),
    )
    .await
    .map_err(|_| "Timed out waiting for the browser sign-in to finish.".to_string())??;

    exchange_code(http, &code, &state, &pkce.verifier, &redirect_uri).await
}

/// Accept connections until the OAuth callback arrives, ignoring speculative
/// browser sockets (pre-connects, favicon probes). Returns the auth code on a
/// state-validated `/callback`, or an error on state mismatch / missing code.
async fn await_callback(listener: &TcpListener, expected_state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("loopback accept failed: {e}"))?;

        let line = match tokio::time::timeout(
            Duration::from_secs(CONNECTION_READ_SECS),
            read_request_line(&mut stream),
        )
        .await
        {
            Ok(Ok(line)) => line,
            _ => continue, // empty/garbled/slow socket — ignore and keep waiting
        };

        let path = line.split_whitespace().nth(1).unwrap_or("");
        if !path.starts_with("/callback") {
            let _ = respond(&mut stream, "404 Not Found", NOT_FOUND_HTML).await;
            continue;
        }

        let (code, state) = parse_callback(path);
        let state_ok = state.as_deref() == Some(expected_state);
        if code.is_some() && state_ok {
            let _ = respond(&mut stream, "200 OK", SUCCESS_HTML).await;
        } else {
            let _ = respond(&mut stream, "400 Bad Request", FAILURE_HTML).await;
        }

        if !state_ok {
            return Err(
                "OAuth state did not match — sign-in aborted to reject a forged callback."
                    .to_string(),
            );
        }
        return code
            .ok_or_else(|| "OAuth callback did not include an authorization code.".to_string());
    }
}

/// Read just the HTTP request line (up to the first CRLF) from a connection.
async fn read_request_line(stream: &mut TcpStream) -> Result<String, String> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("callback read failed: {e}"))?;
        if n == 0 {
            return Err("callback connection closed before sending a request".to_string());
        }
        buf.extend_from_slice(&chunk[..n]);
        let text = String::from_utf8_lossy(&buf);
        if let Some(idx) = text.find("\r\n") {
            return Ok(text[..idx].to_string());
        }
        if buf.len() > 16 * 1024 {
            return Err("callback request line exceeded 16 KiB".to_string());
        }
    }
}

/// Extract `code` and `state` from a request target like `/callback?code=..&state=..`.
fn parse_callback(path: &str) -> (Option<String>, Option<String>) {
    let full = format!("http://localhost{path}");
    let Ok(url) = reqwest::Url::parse(&full) else {
        return (None, None);
    };
    let mut code = None;
    let mut state = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            _ => {}
        }
    }
    (code, state)
}

/// Write a minimal HTTP/1.1 response and close the connection.
async fn respond(stream: &mut TcpStream, status: &str, body: &str) -> std::io::Result<()> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_is_base64url_sha256_of_verifier() {
        let pkce = Pkce::generate();
        let mut hasher = Sha256::new();
        hasher.update(pkce.verifier.as_bytes());
        let expected = URL_SAFE_NO_PAD.encode(hasher.finalize());
        assert_eq!(pkce.challenge, expected);
    }

    #[test]
    fn challenge_matches_rfc7636_appendix_b_vector() {
        // Canonical PKCE S256 test vector from RFC 7636 Appendix B. Proves our
        // sha256 + base64url-nopad pipeline is correct against an external value,
        // not just internally consistent.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let mut hasher = Sha256::new();
        hasher.update(verifier.as_bytes());
        let challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn verifier_state_are_independent_and_43_chars() {
        let pkce = Pkce::generate();
        let state = gen_state();
        // base64url-nopad of 32 bytes is always 43 chars.
        assert_eq!(pkce.verifier.len(), 43);
        assert_eq!(state.len(), 43);
        // Independent randomness: the verifier must not be reused as state.
        assert_ne!(pkce.verifier, state);
    }

    #[test]
    fn authorize_url_contains_required_params() {
        let url = build_authorize_url(
            "http://localhost:1234/callback",
            "the-challenge",
            "the-state",
        );
        assert!(url.starts_with("https://claude.ai/oauth/authorize?"));
        assert!(url.contains("code=true"));
        assert!(url.contains("client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("code_challenge=the-challenge"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=the-state"));
        // redirect_uri is percent-encoded by form-urlencoding.
        assert!(url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A1234%2Fcallback"));
        // scope is present (value starts with the first url-encoded scope).
        assert!(url.contains("scope=org"));
    }

    #[test]
    fn parse_callback_decodes_code_and_state() {
        let (code, state) = parse_callback("/callback?code=abc123&state=xyz789");
        assert_eq!(code.as_deref(), Some("abc123"));
        assert_eq!(state.as_deref(), Some("xyz789"));
    }

    #[test]
    fn parse_callback_handles_missing_params() {
        let (code, state) = parse_callback("/callback");
        assert!(code.is_none());
        assert!(state.is_none());
    }
}
