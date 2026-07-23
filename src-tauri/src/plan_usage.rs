//! Display-safe projection of Codex app-server rate-limit snapshots.

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsageWindow {
    pub id: String,
    pub label: String,
    pub used_percent: f64,
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

pub fn from_codex_app_server(value: &Value, updated_at: i64) -> PlanUsageSnapshot {
    let primary = value.get("rateLimits");
    let plan = primary
        .and_then(|limit| limit.get("planType"))
        .and_then(Value::as_str)
        .map(title_case);
    let mut windows = Vec::new();
    if let Some(limits) = value.get("rateLimitsByLimitId").and_then(Value::as_object) {
        for (limit_id, limit) in limits {
            let base_label = limit
                .get("limitName")
                .and_then(Value::as_str)
                .filter(|label| !label.trim().is_empty())
                .unwrap_or_else(|| {
                    if limit_id == "codex" {
                        "Codex"
                    } else {
                        limit_id
                    }
                });
            append_window(
                &mut windows,
                limit_id,
                base_label,
                "primary",
                limit.get("primary"),
            );
            append_window(
                &mut windows,
                limit_id,
                base_label,
                "secondary",
                limit.get("secondary"),
            );
        }
    } else if let Some(limit) = primary {
        let limit_id = limit
            .get("limitId")
            .and_then(Value::as_str)
            .unwrap_or("codex");
        append_window(
            &mut windows,
            limit_id,
            "Codex",
            "primary",
            limit.get("primary"),
        );
        append_window(
            &mut windows,
            limit_id,
            "Codex",
            "secondary",
            limit.get("secondary"),
        );
    }
    PlanUsageSnapshot {
        provider: "openai".to_string(),
        plan,
        windows,
        updated_at,
    }
}

fn append_window(
    windows: &mut Vec<PlanUsageWindow>,
    limit_id: &str,
    base_label: &str,
    kind: &str,
    value: Option<&Value>,
) {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return;
    };
    let Some(used_percent) = value.get("usedPercent").and_then(Value::as_f64) else {
        return;
    };
    windows.push(PlanUsageWindow {
        id: format!("{limit_id}-{kind}"),
        label: if kind == "primary" {
            base_label.to_string()
        } else {
            format!("{base_label} secondary")
        },
        used_percent: used_percent.clamp(0.0, 100.0),
        resets_at: value.get("resetsAt").and_then(display_scalar),
        window_minutes: value.get("windowDurationMins").and_then(Value::as_u64),
    });
}

fn display_scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(value) if !value.trim().is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn projects_all_codex_limit_windows_without_credentials() {
        let snapshot = from_codex_app_server(
            &json!({
                "rateLimits": { "planType": "pro" },
                "rateLimitsByLimitId": {
                    "codex": {
                        "limitName": null,
                        "primary": { "usedPercent": 69, "windowDurationMins": 10080, "resetsAt": 1785258143 },
                        "secondary": null
                    },
                    "codex_fast": {
                        "limitName": "Fast model",
                        "primary": { "usedPercent": 12.5, "windowDurationMins": 300, "resetsAt": 1785000000 }
                    }
                }
            }),
            123,
        );
        assert_eq!(snapshot.provider, "openai");
        assert_eq!(snapshot.plan.as_deref(), Some("Pro"));
        assert_eq!(snapshot.windows.len(), 2);
        assert_eq!(snapshot.windows[0].label, "Codex");
        assert_eq!(snapshot.windows[0].used_percent, 69.0);
        assert_eq!(snapshot.windows[1].label, "Fast model");
        assert_eq!(snapshot.updated_at, 123);
    }

    #[test]
    fn malformed_or_future_windows_are_ignored_safely() {
        let snapshot = from_codex_app_server(
            &json!({"rateLimitsByLimitId":{"future":{"primary":{"newField":true}}}}),
            1,
        );
        assert!(snapshot.windows.is_empty());
        assert_eq!(snapshot.plan, None);
    }
}
