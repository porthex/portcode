//! Display-safe subscription quota snapshots for the Settings usage panel.
//!
//! Both providers expose account quota data through their subscription backends,
//! but the response shapes are provider-specific and may evolve. This module keeps
//! those shapes behind one small, forward-compatible UI contract. Tokens never
//! leave the Rust core and response bodies are never included in errors.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::secrets::{OAuthTokens, OpenAiOAuthTokens};

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OPENAI_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsageWindow {
    pub id: String,
    pub label: String,
    pub used_percent: f64,
    /// Provider reset value kept as a display-safe string. Anthropic currently
    /// returns RFC 3339 while OpenAI returns unix seconds; the frontend accepts
    /// both without the native core taking a date-parsing dependency.
    pub resets_at: Option<String>,
    pub window_minutes: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsageSnapshot {
    pub provider: String,
    pub plan: Option<String>,
    pub windows: Vec<PlanUsageWindow>,
    pub updated_at: i64,
}

fn number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 100.0))
}

fn reset_value(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn title_case(value: &str) -> String {
    value
        .split(['_', '-'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn claude_window(
    root: &Value,
    key: &str,
    label: &str,
    window_minutes: u64,
) -> Option<PlanUsageWindow> {
    let value = root.get(key)?;
    Some(PlanUsageWindow {
        id: key.to_string(),
        label: label.to_string(),
        used_percent: number(value.get("utilization"))?,
        resets_at: reset_value(value.get("resets_at")),
        window_minutes: Some(window_minutes),
    })
}

fn parse_claude(value: &Value, fallback_plan: Option<&str>, updated_at: i64) -> PlanUsageSnapshot {
    let mut windows = Vec::new();
    if let Some(window) = claude_window(value, "five_hour", "Current session", 5 * 60) {
        windows.push(window);
    }
    if let Some(window) = claude_window(value, "seven_day", "Weekly limit", 7 * 24 * 60) {
        windows.push(window);
    }
    for (key, label) in [
        ("seven_day_opus", "Weekly · Opus"),
        ("seven_day_sonnet", "Weekly · Sonnet"),
    ] {
        if let Some(window) = claude_window(value, key, label, 7 * 24 * 60) {
            windows.push(window);
        }
    }
    PlanUsageSnapshot {
        provider: "anthropic".into(),
        plan: fallback_plan.map(title_case),
        windows,
        updated_at,
    }
}

fn openai_window(value: &Value, id: &str, fallback_label: &str) -> Option<PlanUsageWindow> {
    let window_minutes = value
        .get("limit_window_seconds")
        .or_else(|| value.get("limitWindowSeconds"))
        .and_then(Value::as_u64)
        .map(|seconds| seconds / 60)
        .or_else(|| {
            value
                .get("window_duration_mins")
                .or_else(|| value.get("windowDurationMins"))
                .and_then(Value::as_u64)
        })
        .or_else(|| {
            value
                .get("window_minutes")
                .or_else(|| value.get("windowMinutes"))
                .and_then(Value::as_u64)
        });
    let label = match window_minutes {
        Some(minutes) if minutes <= 6 * 60 => "Current session",
        Some(minutes) if minutes >= 6 * 24 * 60 => "Weekly limit",
        _ => fallback_label,
    };
    Some(PlanUsageWindow {
        id: id.to_string(),
        label: label.to_string(),
        used_percent: number(
            value
                .get("used_percent")
                .or_else(|| value.get("usedPercent")),
        )?,
        resets_at: reset_value(
            value
                .get("reset_at")
                .or_else(|| value.get("resetAt"))
                .or_else(|| value.get("resets_at"))
                .or_else(|| value.get("resetsAt")),
        ),
        window_minutes,
    })
}

fn parse_openai(value: &Value, fallback_plan: Option<&str>, updated_at: i64) -> PlanUsageSnapshot {
    let limits = value
        .get("rate_limit")
        .or_else(|| value.get("rateLimits"))
        .unwrap_or(value);
    let mut windows = Vec::new();
    for (key, camel_key, label) in [
        ("primary_window", "primary", "Primary limit"),
        ("secondary_window", "secondary", "Secondary limit"),
    ] {
        if let Some(window) = limits
            .get(key)
            .or_else(|| limits.get(camel_key))
            .and_then(|value| openai_window(value, key, label))
        {
            windows.push(window);
        }
    }
    let plan = value
        .get("plan_type")
        .or_else(|| value.get("planType"))
        .or_else(|| limits.get("plan_type"))
        .or_else(|| limits.get("planType"))
        .and_then(Value::as_str)
        .or(fallback_plan)
        .map(title_case);
    PlanUsageSnapshot {
        provider: "openai".into(),
        plan,
        windows,
        updated_at,
    }
}

async fn json_response(request: reqwest::RequestBuilder, provider: &str) -> Result<Value, String> {
    tokio::time::timeout(Duration::from_secs(20), async {
        let response = request
            .send()
            .await
            .map_err(|error| format!("{provider} usage request failed: {error}"))?;
        if !response.status().is_success() {
            if provider == "ChatGPT" && response.status() == reqwest::StatusCode::UNAUTHORIZED {
                return Err("ChatGPT usage authentication failed (401).".into());
            }
            return Err(format!(
                "{provider} usage is temporarily unavailable ({}).",
                response.status()
            ));
        }
        response
            .json::<Value>()
            .await
            .map_err(|_| format!("{provider} returned usage data Portcode could not read."))
    })
    .await
    .map_err(|_| format!("{provider} usage request timed out."))?
}

pub fn is_openai_authentication_error(error: &str) -> bool {
    error == "ChatGPT usage authentication failed (401)."
}

pub async fn anthropic(
    http: &reqwest::Client,
    tokens: &OAuthTokens,
) -> Result<PlanUsageSnapshot, String> {
    let value = json_response(
        http.get(CLAUDE_USAGE_URL)
            .header("authorization", format!("Bearer {}", tokens.access_token))
            .header("anthropic-beta", "oauth-2025-04-20"),
        "Claude",
    )
    .await?;
    let snapshot = parse_claude(&value, tokens.plan.as_deref(), crate::oauth::now_secs());
    if snapshot.windows.is_empty() {
        return Err("Claude did not return any plan-usage windows.".into());
    }
    Ok(snapshot)
}

pub async fn openai(
    http: &reqwest::Client,
    tokens: &OpenAiOAuthTokens,
) -> Result<PlanUsageSnapshot, String> {
    let request = crate::openai_oauth::authenticated_request(http.get(OPENAI_USAGE_URL), tokens)?;
    let value = json_response(request, "ChatGPT").await?;
    let snapshot = parse_openai(&value, tokens.plan.as_deref(), crate::oauth::now_secs());
    if snapshot.windows.is_empty() {
        return Err("ChatGPT did not return any plan-usage windows.".into());
    }
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_claude_session_weekly_and_model_windows() {
        let snapshot = parse_claude(
            &json!({
                "five_hour": { "utilization": 14.5, "resets_at": "2026-07-18T18:00:00Z" },
                "seven_day": { "utilization": 61, "resets_at": "2026-07-23T10:00:00Z" },
                "seven_day_opus": { "utilization": 88.25, "resets_at": "2026-07-24T10:00:00Z" }
            }),
            Some("max"),
            123,
        );
        assert_eq!(snapshot.plan.as_deref(), Some("Max"));
        assert_eq!(snapshot.windows.len(), 3);
        assert_eq!(snapshot.windows[0].label, "Current session");
        assert_eq!(snapshot.windows[1].window_minutes, Some(10_080));
        assert_eq!(snapshot.windows[2].used_percent, 88.25);
    }

    #[test]
    fn parses_openai_snake_and_camel_case_windows() {
        let snapshot = parse_openai(
            &json!({
                "plan_type": "plus",
                "rate_limit": {
                    "primary_window": { "used_percent": 25, "limit_window_seconds": 18000, "reset_at": 1784400000 },
                    "secondary": { "usedPercent": 70, "windowDurationMins": 10080, "resetsAt": 1784800000 }
                }
            }),
            None,
            456,
        );
        assert_eq!(snapshot.plan.as_deref(), Some("Plus"));
        assert_eq!(snapshot.windows.len(), 2);
        assert_eq!(snapshot.windows[0].label, "Current session");
        assert_eq!(snapshot.windows[1].label, "Weekly limit");
        assert_eq!(snapshot.windows[1].resets_at.as_deref(), Some("1784800000"));
    }

    #[test]
    fn clamps_provider_percentages_to_a_safe_display_range() {
        let snapshot = parse_claude(
            &json!({
                "five_hour": { "utilization": 140 },
                "seven_day": { "utilization": -5 }
            }),
            Some("pro"),
            1,
        );
        assert_eq!(snapshot.windows[0].used_percent, 100.0);
        assert_eq!(snapshot.windows[1].used_percent, 0.0);
    }

    #[test]
    fn openai_usage_authentication_classifier_is_exact() {
        assert!(is_openai_authentication_error(
            "ChatGPT usage authentication failed (401)."
        ));
        assert!(!is_openai_authentication_error(
            "ChatGPT usage is temporarily unavailable (401 Unauthorized)."
        ));
        assert!(!is_openai_authentication_error(
            "ChatGPT usage authentication failed (401). extra"
        ));
    }
}
