//! ChatGPT subscription OAuth and the display-safe Codex model catalog.
//! Implements the public-client Authorization Code + PKCE flow used by the
//! official openai/codex CLI without copying its session engine or prompts.

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::Rng as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::oauth::now_secs;
use crate::secrets::OpenAiOAuthTokens;

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CALLBACK_PORTS: [u16; 2] = [1455, 1457];
const SCOPES: &str =
    "openid profile email offline_access api.connectors.read api.connectors.invoke";
const LOGIN_TIMEOUT_SECS: u64 = 180;
const CONNECTION_READ_SECS: u64 = 10;

/// Direct ChatGPT subscription transport is intentionally opt-in for release
/// builds because the backend contract is not a documented third-party API.
/// Debug builds keep it available for self-development. Release builders must
/// set this environment variable while compiling to opt in explicitly.
/// Operators can disable the capability without rebuilding. Any present value
/// other than an explicit false value (`0`, `false`, `no`, or `off`) disables it.
const RUNTIME_DISABLE_ENV: &str = "PORTCODE_DISABLE_OPENAI_SUBSCRIPTION";

pub(crate) const DIRECT_SUBSCRIPTION_DISABLED_MESSAGE: &str =
    "Direct ChatGPT subscription access is disabled in this Portcode build or by runtime policy. Use another configured provider, or ask the build owner to enable the reviewed integration.";

fn explicit_enable(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        ["1", "true", "yes", "on"]
            .iter()
            .any(|enabled| value.trim().eq_ignore_ascii_case(enabled))
    })
}

fn runtime_disable_requested(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        !["0", "false", "no", "off"]
            .iter()
            .any(|disabled| value.trim().eq_ignore_ascii_case(disabled))
    })
}

/// Pure gate logic kept separate so release/debug and override behavior can be
/// unit-tested without mutating this process's environment.
fn direct_subscription_enabled_for(
    debug_build: bool,
    build_enable: Option<&str>,
    runtime_disable: Option<&str>,
) -> bool {
    (debug_build || explicit_enable(build_enable)) && !runtime_disable_requested(runtime_disable)
}

pub(crate) fn direct_subscription_enabled() -> bool {
    let runtime_disable = std::env::var_os(RUNTIME_DISABLE_ENV);
    let runtime_disable = runtime_disable
        .as_ref()
        .map(|value| value.to_string_lossy());
    direct_subscription_enabled_for(
        cfg!(debug_assertions),
        option_env!("PORTCODE_ENABLE_OPENAI_SUBSCRIPTION"),
        runtime_disable.as_deref(),
    )
}

pub(crate) fn ensure_direct_subscription_enabled() -> Result<(), String> {
    if direct_subscription_enabled() {
        Ok(())
    } else {
        Err(DIRECT_SUBSCRIPTION_DISABLED_MESSAGE.into())
    }
}

const SUCCESS_HTML: &str = "<!doctype html><meta charset=\"utf-8\"><title>Portcode</title>\
<body style=\"font-family:system-ui,sans-serif;text-align:center;padding-top:4rem\">\
<h2>Signed in to Portcode</h2><p>You can close this tab and return to the app.</p>";
const FAILURE_HTML: &str = "<!doctype html><meta charset=\"utf-8\"><title>Portcode</title>\
<body style=\"font-family:system-ui,sans-serif;text-align:center;padding-top:4rem\">\
<h2>Sign-in could not be completed</h2><p>Return to Portcode and try again.</p>";

struct Pkce {
    verifier: String,
    challenge: String,
}

impl Pkce {
    fn generate() -> Self {
        let mut bytes = [0_u8; 64];
        rand::rng().fill_bytes(&mut bytes);
        let verifier = URL_SAFE_NO_PAD.encode(bytes);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Self {
            verifier,
            challenge,
        }
    }
}

fn random_state() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn build_authorize_url(redirect_uri: &str, challenge: &str, state: &str) -> String {
    let mut url = reqwest::Url::parse(AUTHORIZE_URL).expect("valid OpenAI authorize URL");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", SCOPES)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("originator", "portcode");
    url.to_string()
}

#[derive(Default, Deserialize)]
struct TokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn claim_string(claims: &Value, key: &str) -> Option<String> {
    claims.get(key)?.as_str().map(str::to_string)
}

fn account_identity_claim(token: Option<&str>) -> Option<String> {
    token.and_then(jwt_claims).and_then(|claims| {
        claims
            .get("https://api.openai.com/auth")
            .and_then(|auth| claim_string(auth, "chatgpt_account_id"))
    })
}

/// Resolve the identity asserted by only the newly returned token material.
/// When both tokens carry the claim they must agree; accepting the ID token's
/// account while sending a bearer token for a different account would break the
/// profile isolation boundary.
fn asserted_token_account_identity(
    id_token: Option<&str>,
    access_token: Option<&str>,
) -> Result<Option<String>, String> {
    let id_identity = account_identity_claim(id_token);
    let access_identity = account_identity_claim(access_token);
    if id_identity.is_some() && access_identity.is_some() && id_identity != access_identity {
        return Err(
            "OpenAI returned conflicting ChatGPT account identities. Reconnect the intended account."
                .into(),
        );
    }
    // The access token is the credential actually sent to ChatGPT. An ID-token-
    // only assertion cannot prove that bearer belongs to the pinned profile.
    Ok(access_identity)
}

fn claim_metadata(
    id_token: Option<&str>,
    access_token: &str,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
    bool,
) {
    let id_claims = id_token.and_then(jwt_claims);
    let access_claims = jwt_claims(access_token);
    let mut account_id = None;
    let mut email = None;
    let mut plan = None;
    // Access-token expiry governs bearer refresh. A retained ID token can be
    // older after refresh, so it must not win merely because it is inspected
    // first for profile metadata.
    let exp = access_claims
        .as_ref()
        .and_then(|claims| claims.get("exp"))
        .and_then(Value::as_i64)
        .or_else(|| {
            id_claims
                .as_ref()
                .and_then(|claims| claims.get("exp"))
                .and_then(Value::as_i64)
        });
    let mut is_fedramp = false;
    for claims in [id_claims, access_claims].into_iter().flatten() {
        let auth = claims.get("https://api.openai.com/auth");
        let profile = claims.get("https://api.openai.com/profile");
        account_id =
            account_id.or_else(|| auth.and_then(|v| claim_string(v, "chatgpt_account_id")));
        email = email
            .or_else(|| claim_string(&claims, "email"))
            .or_else(|| profile.and_then(|v| claim_string(v, "email")));
        plan = plan.or_else(|| auth.and_then(|v| claim_string(v, "chatgpt_plan_type")));
        is_fedramp |= auth
            .and_then(|v| v.get("chatgpt_account_is_fedramp"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
    }
    (account_id, email, plan, exp, is_fedramp)
}

fn validate_asserted_account_identity(
    previous: Option<&OpenAiOAuthTokens>,
    asserted_account_id: Option<&str>,
) -> Result<(), String> {
    let asserted = asserted_account_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            if previous.is_some() {
                "OpenAI token refresh did not assert a ChatGPT account. Reconnect this account in Settings."
            } else {
                "OpenAI sign-in did not identify a ChatGPT account. Please try another account."
            }
            .to_string()
        })?;
    if asserted.len() > 512
        || !asserted.is_ascii()
        || asserted
            .chars()
            .any(|ch| ch.is_ascii_control() || ch.is_ascii_whitespace())
    {
        return Err("OpenAI returned an invalid ChatGPT account identity.".into());
    }
    if let Some(previous) = previous {
        let expected = previous
            .account_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or(
                "The stored ChatGPT credential has no account identity. Reconnect it in Settings.",
            )?;
        if asserted != expected {
            return Err(
                "OpenAI token refresh returned a different ChatGPT account. Reconnect the original account in Settings."
                    .into(),
            );
        }
    }
    Ok(())
}

fn merge_token_response(
    response: TokenResponse,
    previous: Option<&OpenAiOAuthTokens>,
) -> Result<OpenAiOAuthTokens, String> {
    let access_token = response
        .access_token
        .filter(|token| !token.trim().is_empty())
        .ok_or("OpenAI token response did not include an access token.")?;
    let refresh_token = response
        .refresh_token
        .or_else(|| previous.map(|p| p.refresh_token.clone()))
        .ok_or("OpenAI token response did not include a refresh token.")?;
    let id_token = response
        .id_token
        .or_else(|| previous.and_then(|p| p.id_token.clone()));
    let (account_id, email, plan, jwt_exp, is_fedramp) =
        claim_metadata(id_token.as_deref(), &access_token);
    let expires_at = response
        .expires_in
        .map(|seconds| now_secs() + seconds)
        .or(jwt_exp)
        .or_else(|| previous.map(|p| p.expires_at))
        .unwrap_or_else(|| now_secs() + 3600);
    Ok(OpenAiOAuthTokens {
        access_token,
        refresh_token,
        id_token,
        expires_at,
        account_id: account_id.or_else(|| previous.and_then(|p| p.account_id.clone())),
        email: email.or_else(|| previous.and_then(|p| p.email.clone())),
        plan: plan.or_else(|| previous.and_then(|p| p.plan.clone())),
        is_fedramp: is_fedramp || previous.is_some_and(|p| p.is_fedramp),
    })
}

async fn parse_token_response(
    response: reqwest::Response,
    previous: Option<&OpenAiOAuthTokens>,
    require_complete: bool,
) -> Result<OpenAiOAuthTokens, String> {
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("OpenAI OAuth token request failed ({status})."));
    }
    let token_response = response
        .json::<TokenResponse>()
        .await
        .map_err(|e| format!("Could not parse the OpenAI OAuth token response: {e}"))?;
    if require_complete
        && (token_response.id_token.is_none()
            || token_response.access_token.is_none()
            || token_response.refresh_token.is_none())
    {
        return Err("OpenAI sign-in returned an incomplete token set. Please try again.".into());
    }
    let asserted_account_id = asserted_token_account_identity(
        token_response.id_token.as_deref(),
        token_response.access_token.as_deref(),
    )?;
    if require_complete || previous.is_some() {
        validate_asserted_account_identity(previous, asserted_account_id.as_deref())?;
    }
    let tokens = merge_token_response(token_response, previous)?;
    Ok(tokens)
}

/// Apply the complete ChatGPT subscription authentication envelope to a request.
/// Account identity is mandatory: no OpenAI request may silently omit the
/// account header or inherit a different global profile.
pub fn authenticated_request(
    request: reqwest::RequestBuilder,
    tokens: &OpenAiOAuthTokens,
) -> Result<reqwest::RequestBuilder, String> {
    let access_token = tokens.access_token.trim();
    if access_token.is_empty() {
        return Err(
            "The selected ChatGPT account has no access token. Reconnect it in Settings.".into(),
        );
    }
    let account_id = tokens.account_id.as_deref().map(str::trim);
    validate_asserted_account_identity(None, account_id)?;
    let mut request = request
        .header("authorization", format!("Bearer {access_token}"))
        .header("ChatGPT-Account-ID", account_id.expect("validated above"))
        .header("originator", "portcode")
        .header(
            "user-agent",
            concat!("Portcode/", env!("CARGO_PKG_VERSION")),
        );
    if tokens.is_fedramp {
        request = request.header("X-OpenAI-Fedramp", "true");
    }
    Ok(request)
}

async fn exchange_code(
    http: &reqwest::Client,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<OpenAiOAuthTokens, String> {
    // Re-check immediately before the token endpoint so a runtime kill switch
    // applied while the browser was open stops the exchange as well.
    ensure_direct_subscription_enabled()?;
    tokio::time::timeout(Duration::from_secs(30), async {
        let response = http
            .post(TOKEN_URL)
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", redirect_uri),
                ("client_id", CLIENT_ID),
                ("code_verifier", verifier),
            ])
            .send()
            .await
            .map_err(|e| format!("OpenAI token exchange failed: {e}"))?;
        parse_token_response(response, None, true).await
    })
    .await
    .map_err(|_| "OpenAI token exchange timed out.".to_string())?
}

pub async fn refresh(
    http: &reqwest::Client,
    current: &OpenAiOAuthTokens,
) -> Result<OpenAiOAuthTokens, String> {
    ensure_direct_subscription_enabled()?;
    tokio::time::timeout(Duration::from_secs(30), async {
        let response = http
            .post(TOKEN_URL)
            .json(&json!({
                "client_id": CLIENT_ID,
                "grant_type": "refresh_token",
                "refresh_token": current.refresh_token,
            }))
            .send()
            .await
            .map_err(|e| format!("OpenAI token refresh failed: {e}"))?;
        parse_token_response(response, Some(current), false).await
    })
    .await
    .map_err(|_| "OpenAI token refresh timed out.".to_string())?
}

pub fn is_terminal_auth_error(error: &str) -> bool {
    error.contains("(400")
        || error.contains("(401")
        || error.contains("(403")
        || error.contains("invalid_grant")
        || error.contains("refresh_token_expired")
        || error.contains("refresh_token_reused")
        || error.contains("refresh_token_invalidated")
}

/// Whether a failed refresh must quarantine only the selected profile. Besides
/// provider-rejected refresh tokens, any missing/conflicting/different identity
/// assertion is terminal for that profile: retrying it as Connected would repeat
/// the unsafe response forever.
pub fn refresh_failure_requires_reconnect(error: &str) -> bool {
    is_terminal_auth_error(error)
        || error.starts_with("OpenAI token refresh did not assert a ChatGPT account.")
        || error.starts_with("OpenAI returned conflicting ChatGPT account identities.")
        || error.starts_with("OpenAI returned an invalid ChatGPT account identity.")
        || error.starts_with("The stored ChatGPT credential has no account identity.")
        || error.starts_with("OpenAI token refresh returned a different ChatGPT account.")
}

pub async fn run_loopback_login(http: &reqwest::Client) -> Result<OpenAiOAuthTokens, String> {
    ensure_direct_subscription_enabled()?;
    let mut listener = None;
    let mut last_error = None;
    for port in CALLBACK_PORTS {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(bound) => {
                listener = Some((bound, port));
                break;
            }
            Err(error) => last_error = Some(error),
        }
    }
    let (listener, port) = listener.ok_or_else(|| {
        format!(
            "Could not start OpenAI sign-in on localhost ports 1455 or 1457 ({}). Close any other sign-in window and try again.",
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "no callback port was available".into())
        )
    })?;
    let redirect_uri = format!("http://localhost:{port}/auth/callback");
    let pkce = Pkce::generate();
    let state = random_state();
    let url = build_authorize_url(&redirect_uri, &pkce.challenge, &state);
    tauri_plugin_opener::open_url(&url, None::<&str>)
        .map_err(|e| format!("Could not open the browser for OpenAI sign-in: {e}"))?;
    let code = tokio::time::timeout(
        Duration::from_secs(LOGIN_TIMEOUT_SECS),
        await_callback(&listener, &state),
    )
    .await
    .map_err(|_| "Timed out waiting for OpenAI sign-in to finish.".to_string())??;
    exchange_code(http, &code, &pkce.verifier, &redirect_uri).await
}

async fn await_callback(listener: &TcpListener, expected_state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("OpenAI loopback accept failed: {e}"))?;
        let line = match tokio::time::timeout(
            Duration::from_secs(CONNECTION_READ_SECS),
            read_request_line(&mut stream),
        )
        .await
        {
            Ok(Ok(line)) => line,
            _ => continue,
        };
        let path = line.split_whitespace().nth(1).unwrap_or("");
        if !path.starts_with("/auth/callback") {
            respond(&mut stream, "404 Not Found", "Not found")
                .await
                .ok();
            continue;
        }
        let url = reqwest::Url::parse(&format!("http://localhost{path}"))
            .map_err(|_| "OpenAI OAuth callback URL was malformed.".to_string())?;
        let code = url
            .query_pairs()
            .find(|(key, _)| key == "code")
            .map(|(_, value)| value.into_owned());
        let state = url
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.into_owned());
        let oauth_error = url
            .query_pairs()
            .find(|(key, _)| key == "error_description")
            .or_else(|| url.query_pairs().find(|(key, _)| key == "error"))
            .map(|(_, value)| value.into_owned());
        let state_ok = state.as_deref() == Some(expected_state);
        respond(
            &mut stream,
            if code.is_some() && state_ok {
                "200 OK"
            } else {
                "400 Bad Request"
            },
            if code.is_some() && state_ok {
                SUCCESS_HTML
            } else {
                FAILURE_HTML
            },
        )
        .await
        .ok();
        if !state_ok {
            continue;
        }
        if let Some(error) = oauth_error {
            return Err(oauth_callback_error_message(&error));
        }
        return code.ok_or_else(|| "OpenAI callback did not include a code.".into());
    }
}

fn oauth_callback_error_message(error: &str) -> String {
    if error.contains("missing_codex_entitlement") {
        return "This ChatGPT workspace does not have Codex access. Ask the workspace administrator to enable it."
            .into();
    }
    // OAuth callback values are controlled by the provider/browser and may
    // contain account identifiers. Never forward them across IPC.
    "OpenAI sign-in was not completed. Please try again.".into()
}

async fn read_request_line(stream: &mut TcpStream) -> Result<String, String> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        let count = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("OpenAI callback read failed: {e}"))?;
        if count == 0 {
            return Err("OpenAI callback closed before sending a request.".into());
        }
        buffer.extend_from_slice(&chunk[..count]);
        let text = String::from_utf8_lossy(&buffer);
        if let Some(end) = text.find("\r\n") {
            return Ok(text[..end].to_string());
        }
        if buffer.len() > 16 * 1024 {
            return Err("OpenAI callback request exceeded 16 KiB.".into());
        }
    }
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) -> std::io::Result<()> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiModel {
    pub id: String,
    pub label: String,
    pub reasoning_efforts: Vec<String>,
    pub default_reasoning_effort: String,
}

fn display_models(value: &Value) -> Vec<OpenAiModel> {
    let mut rows: Vec<(i64, OpenAiModel)> = value["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|model| model["visibility"].as_str() == Some("list"))
        .filter(|model| model["supported_in_api"].as_bool() == Some(true))
        .filter_map(|model| {
            let id = model["slug"].as_str()?.to_string();
            let efforts: Vec<String> = model["supported_reasoning_levels"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|level| level["effort"].as_str().map(str::to_string))
                .collect();
            let default = model["default_reasoning_level"]
                .as_str()
                .map(str::to_string)
                .or_else(|| {
                    efforts
                        .iter()
                        .find(|effort| effort.as_str() == "medium")
                        .cloned()
                })
                .or_else(|| efforts.first().cloned())
                .unwrap_or_else(|| "medium".into());
            Some((
                model["priority"].as_i64().unwrap_or(i64::MAX),
                OpenAiModel {
                    id: id.clone(),
                    label: model["display_name"].as_str().unwrap_or(&id).to_string(),
                    reasoning_efforts: efforts,
                    default_reasoning_effort: default,
                },
            ))
        })
        .collect();
    rows.sort_by_key(|(priority, _)| *priority);
    rows.into_iter().map(|(_, model)| model).collect()
}

fn model_catalog_status_error(status: reqwest::StatusCode) -> Option<String> {
    if status == reqwest::StatusCode::UNAUTHORIZED {
        Some("OpenAI model catalog authentication failed (401).".into())
    } else if !status.is_success() {
        Some(format!("OpenAI model catalog request failed ({status})."))
    } else {
        None
    }
}

fn require_display_models(value: &Value) -> Result<Vec<OpenAiModel>, String> {
    let rows = display_models(value);
    if rows.is_empty() {
        Err("OpenAI model catalog returned no supported models.".into())
    } else {
        Ok(rows)
    }
}

pub async fn models(
    http: &reqwest::Client,
    tokens: &OpenAiOAuthTokens,
) -> Result<Vec<OpenAiModel>, String> {
    ensure_direct_subscription_enabled()?;
    let url = format!(
        "https://chatgpt.com/backend-api/codex/models?client_version={}",
        env!("CARGO_PKG_VERSION")
    );
    let request = authenticated_request(http.get(url), tokens)?;
    let response = tokio::time::timeout(Duration::from_secs(30), request.send())
        .await
        .map_err(|_| "OpenAI model catalog request timed out.".to_string())?
        .map_err(|_| "Could not reach the OpenAI model catalog.".to_string())?;
    if let Some(error) = model_catalog_status_error(response.status()) {
        return Err(error);
    }
    let value = response
        .json::<Value>()
        .await
        .map_err(|_| "OpenAI model catalog returned invalid data.".to_string())?;
    require_display_models(&value)
}

pub fn is_model_authentication_error(error: &str) -> bool {
    error == "OpenAI model catalog authentication failed (401)."
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn callback_response(address: std::net::SocketAddr, path: &str) -> String {
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream
            .write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    #[test]
    fn authorize_url_has_pkce_state_originator_and_fixed_callback() {
        let redirect = "http://localhost:1455/auth/callback";
        let url =
            reqwest::Url::parse(&build_authorize_url(redirect, "challenge", "state")).unwrap();
        let pairs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs.get("client_id").map(String::as_str), Some(CLIENT_ID));
        assert_eq!(
            pairs.get("redirect_uri").map(String::as_str),
            Some(redirect)
        );
        assert_eq!(
            pairs.get("code_challenge").map(String::as_str),
            Some("challenge")
        );
        assert_eq!(pairs.get("state").map(String::as_str), Some("state"));
        assert_eq!(
            pairs.get("originator").map(String::as_str),
            Some("portcode")
        );
    }

    #[tokio::test]
    async fn mismatched_callback_state_fails_request_but_keeps_listener_alive() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let callback = tokio::spawn(async move { await_callback(&listener, "expected").await });

        let rejected =
            callback_response(address, "/auth/callback?code=forged&state=unexpected").await;
        assert!(rejected.starts_with("HTTP/1.1 400 Bad Request"));
        assert!(rejected.contains(FAILURE_HTML));
        assert!(!callback.is_finished());

        let accepted =
            callback_response(address, "/auth/callback?code=valid-code&state=expected").await;
        assert!(accepted.starts_with("HTTP/1.1 200 OK"));
        assert!(accepted.contains(SUCCESS_HTML));
        let code = tokio::time::timeout(Duration::from_secs(1), callback)
            .await
            .expect("valid callback should complete promptly")
            .expect("callback task should not panic")
            .expect("valid callback should succeed");
        assert_eq!(code, "valid-code");
    }

    #[test]
    fn extracts_namespaced_chatgpt_claims_without_verifying_or_logging_token() {
        let claims = json!({
            "email": "user@example.com",
            "exp": 1_900_000_000_i64,
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acct_1",
                "chatgpt_plan_type": "plus",
                "chatgpt_account_is_fedramp": true
            }
        });
        let token = format!(
            "x.{}.y",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
        );
        let (account, email, plan, exp, is_fedramp) = claim_metadata(None, &token);
        assert_eq!(account.as_deref(), Some("acct_1"));
        assert_eq!(email.as_deref(), Some("user@example.com"));
        assert_eq!(plan.as_deref(), Some("plus"));
        assert_eq!(exp, Some(1_900_000_000));
        assert!(is_fedramp);
    }

    #[test]
    fn access_token_expiry_wins_over_an_older_retained_id_token() {
        let token = |exp: i64| {
            format!(
                "x.{}.y",
                URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({ "exp": exp })).unwrap())
            )
        };
        let id_token = token(100);
        let access_token = token(200);

        let (_, _, _, exp, _) = claim_metadata(Some(&id_token), &access_token);

        assert_eq!(exp, Some(200));
    }

    #[test]
    fn newly_returned_id_and_access_tokens_cannot_assert_different_accounts() {
        let token = |account_id: &str| {
            format!(
                "x.{}.y",
                URL_SAFE_NO_PAD.encode(
                    serde_json::to_vec(&json!({
                        "https://api.openai.com/auth": {
                            "chatgpt_account_id": account_id
                        }
                    }))
                    .unwrap()
                )
            )
        };
        let account_a = token("acct-a");
        let account_b = token("acct-b");

        assert_eq!(
            asserted_token_account_identity(Some(&account_a), Some(&account_a)).unwrap(),
            Some("acct-a".into())
        );
        assert!(asserted_token_account_identity(Some(&account_a), Some(&account_b)).is_err());
        assert_eq!(
            asserted_token_account_identity(None, Some(&account_b)).unwrap(),
            Some("acct-b".into())
        );
        assert_eq!(
            asserted_token_account_identity(Some(&account_a), Some("opaque-access")).unwrap(),
            None
        );
    }

    #[test]
    fn refresh_merge_retains_optional_tokens_and_rotates_supplied_refresh_token() {
        let previous = OpenAiOAuthTokens {
            access_token: "old-access".into(),
            refresh_token: "old-refresh".into(),
            id_token: Some("old-id".into()),
            expires_at: 123,
            account_id: Some("acct".into()),
            email: Some("user@example.com".into()),
            plan: Some("plus".into()),
            is_fedramp: true,
        };
        let merged = merge_token_response(
            TokenResponse {
                access_token: Some("new-access".into()),
                refresh_token: Some("rotated-refresh".into()),
                ..TokenResponse::default()
            },
            Some(&previous),
        )
        .unwrap();
        assert_eq!(merged.access_token, "new-access");
        assert_eq!(merged.refresh_token, "rotated-refresh");
        assert_eq!(merged.id_token.as_deref(), Some("old-id"));
        assert_eq!(merged.account_id.as_deref(), Some("acct"));
        assert!(merged.is_fedramp);
    }

    #[test]
    fn refresh_merge_rejects_missing_or_empty_access_token() {
        let previous = OpenAiOAuthTokens {
            access_token: "old-access".into(),
            refresh_token: "old-refresh".into(),
            id_token: None,
            expires_at: 123,
            account_id: None,
            email: None,
            plan: None,
            is_fedramp: false,
        };
        for access_token in [None, Some(String::new()), Some("  \t".into())] {
            let result = merge_token_response(
                TokenResponse {
                    access_token,
                    ..TokenResponse::default()
                },
                Some(&previous),
            );
            let Err(error) = result else {
                panic!("refresh must not reuse the previous access token");
            };
            assert_eq!(
                error,
                "OpenAI token response did not include an access token."
            );
        }
    }

    #[test]
    fn refresh_identity_must_be_present_and_match_exactly() {
        let previous = OpenAiOAuthTokens {
            access_token: "old-access".into(),
            refresh_token: "old-refresh".into(),
            id_token: None,
            expires_at: 123,
            account_id: Some("acct-a".into()),
            email: None,
            plan: None,
            is_fedramp: false,
        };
        assert!(validate_asserted_account_identity(Some(&previous), Some("acct-a")).is_ok());
        for asserted in [None, Some(""), Some("acct-b")] {
            assert!(validate_asserted_account_identity(Some(&previous), asserted).is_err());
        }
    }

    #[test]
    fn authenticated_request_applies_one_strict_account_envelope() {
        let tokens = OpenAiOAuthTokens {
            access_token: "access-a".into(),
            refresh_token: "refresh-a".into(),
            id_token: None,
            expires_at: 123,
            account_id: Some("acct-a".into()),
            email: None,
            plan: None,
            is_fedramp: true,
        };
        let request = authenticated_request(
            reqwest::Client::new().get("https://example.invalid"),
            &tokens,
        )
        .unwrap()
        .build()
        .unwrap();
        assert_eq!(request.headers()["authorization"], "Bearer access-a");
        assert_eq!(request.headers()["ChatGPT-Account-ID"], "acct-a");
        assert_eq!(request.headers()["originator"], "portcode");
        assert_eq!(request.headers()["X-OpenAI-Fedramp"], "true");

        let mut missing = tokens;
        missing.account_id = None;
        assert!(authenticated_request(
            reqwest::Client::new().get("https://example.invalid"),
            &missing,
        )
        .is_err());
    }

    #[test]
    fn permanent_refresh_errors_are_classified_for_reauthentication() {
        assert!(is_terminal_auth_error("refresh_token_reused"));
        assert!(is_terminal_auth_error("request failed (401 Unauthorized)"));
        assert!(!is_terminal_auth_error("network timed out"));

        for identity_error in [
            "OpenAI token refresh did not assert a ChatGPT account. Reconnect this account in Settings.",
            "OpenAI returned conflicting ChatGPT account identities. Reconnect the intended account.",
            "OpenAI token refresh returned a different ChatGPT account. Reconnect the original account in Settings.",
        ] {
            assert!(refresh_failure_requires_reconnect(identity_error));
        }
        assert!(!refresh_failure_requires_reconnect("network timed out"));
    }

    #[test]
    fn oauth_callback_errors_never_echo_provider_values() {
        let provider_value = "access_denied for secret-account@example.invalid";
        let message = oauth_callback_error_message(provider_value);
        assert_eq!(
            message,
            "OpenAI sign-in was not completed. Please try again."
        );
        assert!(!message.contains("secret-account"));
        assert!(oauth_callback_error_message("missing_codex_entitlement").contains("Codex access"));
    }

    #[test]
    fn direct_subscription_gate_is_debug_on_and_release_opt_in() {
        assert!(direct_subscription_enabled_for(true, None, None));
        assert!(!direct_subscription_enabled_for(false, None, None));
        assert!(direct_subscription_enabled_for(false, Some("1"), None));
        assert!(direct_subscription_enabled_for(false, Some("TRUE"), None));
        assert!(!direct_subscription_enabled_for(false, Some("0"), None));
    }

    #[test]
    fn runtime_disable_always_wins_and_false_values_do_not_disable() {
        assert!(!direct_subscription_enabled_for(true, None, Some("1")));
        assert!(!direct_subscription_enabled_for(
            false,
            Some("yes"),
            Some("maintenance")
        ));
        assert!(direct_subscription_enabled_for(true, None, Some("false")));
        assert!(direct_subscription_enabled_for(
            false,
            Some("on"),
            Some("0")
        ));
    }

    #[test]
    fn model_catalog_filters_hidden_and_unsupported_rows() {
        let rows = display_models(&json!({ "models": [
            { "slug": "good", "display_name": "Good", "visibility": "list",
              "supported_in_api": true, "priority": 1,
              "default_reasoning_level": "high",
              "supported_reasoning_levels": [{"effort":"low"},{"effort":"high"}] },
            { "slug": "hidden", "visibility": "hide", "supported_in_api": true },
            { "slug": "no-api", "visibility": "list", "supported_in_api": false }
        ]}));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "good");
        assert_eq!(rows[0].reasoning_efforts, ["low", "high"]);
    }

    #[test]
    fn model_catalog_failures_never_become_a_valid_fallback_catalog() {
        assert_eq!(
            model_catalog_status_error(reqwest::StatusCode::UNAUTHORIZED).as_deref(),
            Some("OpenAI model catalog authentication failed (401).")
        );
        assert!(
            model_catalog_status_error(reqwest::StatusCode::INTERNAL_SERVER_ERROR)
                .unwrap()
                .contains("500")
        );
        assert_eq!(model_catalog_status_error(reqwest::StatusCode::OK), None);
        for value in [
            json!({}),
            json!({ "models": [] }),
            json!({ "models": [{
                "slug": "hidden",
                "visibility": "hide",
                "supported_in_api": true
            }] }),
        ] {
            assert_eq!(
                require_display_models(&value).unwrap_err(),
                "OpenAI model catalog returned no supported models."
            );
        }
    }
}
