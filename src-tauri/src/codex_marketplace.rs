//! Display-safe projection of the Codex app-server marketplace/plugin surface.
//!
//! Portcode is a presentation/control client: `plugin/list` and `plugin/read`
//! are the sole catalog/detail sources, and every management action goes
//! through a typed, allowlisted native command. This module owns the strict
//! Rust-to-React boundary: unknown, private, local-path, and credential
//! fields are dropped here, install policy semantics fail closed, and only
//! `https:` URLs survive projection.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::scrub::redact_secrets_bounded;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMarketplaceCatalogView {
    pub marketplaces: Vec<CodexMarketplaceView>,
    pub load_errors: Vec<CodexMarketplaceLoadErrorView>,
    pub featured_plugin_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMarketplaceView {
    pub name: String,
    pub display_name: Option<String>,
    pub plugins: Vec<CodexPluginSummaryView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMarketplaceLoadErrorView {
    pub source_label: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexPluginInstallPolicy {
    Available,
    NotAvailable,
    InstalledByDefault,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexPluginAuthPolicy {
    OnInstall,
    OnUse,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexPluginAvailability {
    Available,
    DisabledByAdmin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPluginSummaryView {
    pub id: String,
    pub name: String,
    pub display_name: Option<String>,
    pub short_description: Option<String>,
    pub developer_name: Option<String>,
    pub category: Option<String>,
    pub version: Option<String>,
    pub local_version: Option<String>,
    pub installed: bool,
    pub enabled: bool,
    pub install_policy: CodexPluginInstallPolicy,
    pub auth_policy: CodexPluginAuthPolicy,
    pub availability: CodexPluginAvailability,
    pub must_show_installation_interstitial: bool,
    pub installable: bool,
    pub keywords: Vec<String>,
    pub website_url: Option<String>,
    pub logo_url: Option<String>,
    pub logo_url_dark: Option<String>,
    pub screenshot_urls: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPluginDetailView {
    pub marketplace_name: String,
    pub summary: CodexPluginSummaryView,
    pub share_url: Option<String>,
    pub description: Option<String>,
    pub skills: Vec<CodexPluginSkillView>,
    pub hooks: Vec<CodexPluginHookView>,
    pub apps: Vec<CodexPluginAppView>,
    pub mcp_servers: Vec<String>,
    pub scheduled_tasks: Option<Vec<CodexScheduledTaskView>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPluginSkillView {
    pub name: String,
    pub description: Option<String>,
    pub short_description: Option<String>,
    pub display_name: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPluginHookView {
    pub key: String,
    pub event_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPluginAppView {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub category: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexScheduledTaskView {
    pub key: String,
    pub name: String,
    pub prompt: String,
    pub schedule: CodexScheduledTaskScheduleView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CodexScheduledTaskScheduleView {
    #[serde(rename_all = "camelCase")]
    Hourly {
        interval_hours: u32,
        days: Option<Vec<String>>,
    },
    Daily {
        time: String,
    },
    Weekdays {
        time: String,
    },
    #[serde(rename_all = "camelCase")]
    Weekly {
        days: Vec<String>,
        time: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMarketplaceAddView {
    pub marketplace_name: String,
    pub already_added: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMarketplaceRemoveView {
    pub marketplace_name: String,
    pub removed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMarketplaceUpgradeErrorView {
    pub marketplace_name: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMarketplaceUpgradeView {
    pub selected_marketplaces: Vec<String>,
    pub upgraded_count: usize,
    pub errors: Vec<CodexMarketplaceUpgradeErrorView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPluginInstallView {
    pub auth_policy: CodexPluginAuthPolicy,
    pub apps_needing_auth: Vec<CodexPluginAppView>,
}

#[derive(Debug, Clone)]
struct PluginRoute {
    marketplace_path: Option<String>,
    marketplace_name: String,
    plugin_name: String,
    installable: bool,
}

#[derive(Debug, Clone, Default)]
pub struct CodexMarketplaceRoutes {
    plugins: HashMap<(String, String), PluginRoute>,
}

impl CodexMarketplaceRoutes {
    pub fn read_params(&self, marketplace: &str, plugin: &str) -> Result<Value, String> {
        let route = self.route(marketplace, plugin)?;
        Ok(route_params(route))
    }

    pub fn install_params(
        &self,
        marketplace: &str,
        plugin: &str,
        disclosure_confirmed: bool,
    ) -> Result<Value, String> {
        let route = self.route(marketplace, plugin)?;
        if !route.installable {
            return Err("Codex policy does not allow this plugin to be installed".to_owned());
        }
        if !disclosure_confirmed {
            return Err("installation disclosure must be confirmed".to_owned());
        }
        Ok(route_params(route))
    }

    fn route(&self, marketplace: &str, plugin: &str) -> Result<&PluginRoute, String> {
        let marketplace = required_text(marketplace, "marketplace")?;
        let plugin = required_text(plugin, "plugin")?;
        self.plugins
            .get(&(marketplace, plugin))
            .ok_or_else(|| "plugin is not present in the current Codex catalog".to_owned())
    }
}

fn route_params(route: &PluginRoute) -> Value {
    let mut params = Map::new();
    if let Some(path) = &route.marketplace_path {
        params.insert("marketplacePath".to_owned(), Value::String(path.clone()));
    } else {
        params.insert(
            "remoteMarketplaceName".to_owned(),
            Value::String(route.marketplace_name.clone()),
        );
    }
    params.insert(
        "pluginName".to_owned(),
        Value::String(route.plugin_name.clone()),
    );
    Value::Object(params)
}

pub fn project_catalog(
    response: &Value,
) -> Result<(CodexMarketplaceCatalogView, CodexMarketplaceRoutes), String> {
    let root = object(response, "plugin/list response")?;
    let mut routes = CodexMarketplaceRoutes::default();
    let mut marketplaces = Vec::new();

    for marketplace in array_field(root, "marketplaces") {
        let Some(marketplace) = marketplace.as_object() else {
            continue;
        };
        let Ok(name) = required_public_identifier(marketplace, "name") else {
            continue;
        };
        let path = optional_field(marketplace, "path");
        let display_name = marketplace
            .get("interface")
            .and_then(Value::as_object)
            .and_then(|value| optional_display_field(value, "displayName"));
        let mut plugins = Vec::new();
        for plugin in array_field(marketplace, "plugins") {
            let Some(plugin_obj) = plugin.as_object() else {
                continue;
            };
            let Ok(summary) = project_plugin_summary(plugin_obj) else {
                continue;
            };
            let native_plugin_name = if path.is_none() {
                optional_field(plugin_obj, "remotePluginId").unwrap_or_else(|| summary.name.clone())
            } else {
                summary.name.clone()
            };
            routes.plugins.insert(
                (name.clone(), summary.name.clone()),
                PluginRoute {
                    marketplace_path: path.clone(),
                    marketplace_name: name.clone(),
                    plugin_name: native_plugin_name,
                    installable: summary.installable,
                },
            );
            plugins.push(summary);
        }
        marketplaces.push(CodexMarketplaceView {
            name,
            display_name,
            plugins,
        });
    }

    let load_errors = array_field(root, "marketplaceLoadErrors")
        .iter()
        .filter_map(|value| {
            let value = value.as_object()?;
            optional_field(value, "marketplacePath")?;
            let message = display_safe_provider_error(
                &optional_field(value, "message")?,
                "Codex could not load this marketplace source.",
            );
            Some(CodexMarketplaceLoadErrorView {
                source_label: "Marketplace source".to_owned(),
                message,
            })
        })
        .collect();
    let featured_plugin_ids = display_string_array(root.get("featuredPluginIds"));

    Ok((
        CodexMarketplaceCatalogView {
            marketplaces,
            load_errors,
            featured_plugin_ids,
        },
        routes,
    ))
}

pub fn project_plugin_detail(response: &Value) -> Result<CodexPluginDetailView, String> {
    let root = object(response, "plugin/read response")?;
    let plugin = root
        .get("plugin")
        .and_then(Value::as_object)
        .ok_or_else(|| "plugin/read response omitted plugin".to_owned())?;
    let marketplace_name = required_public_identifier(plugin, "marketplaceName")?;
    let summary_obj = plugin
        .get("summary")
        .and_then(Value::as_object)
        .ok_or_else(|| "plugin/read response omitted summary".to_owned())?;
    let summary = project_plugin_summary(summary_obj)?;

    let skills = array_field(plugin, "skills")
        .iter()
        .filter_map(project_skill)
        .collect();
    let hooks = array_field(plugin, "hooks")
        .iter()
        .filter_map(project_hook)
        .collect();
    let apps = array_field(plugin, "apps")
        .iter()
        .filter_map(project_app)
        .collect();
    let scheduled_tasks = match plugin.get("scheduledTasks") {
        None | Some(Value::Null) => None,
        Some(Value::Array(tasks)) => Some(tasks.iter().filter_map(project_task).collect()),
        Some(_) => None,
    };

    Ok(CodexPluginDetailView {
        marketplace_name,
        summary,
        share_url: optional_https(plugin, "shareUrl"),
        description: optional_display_field(plugin, "description"),
        skills,
        hooks,
        apps,
        mcp_servers: display_string_array(plugin.get("mcpServers")),
        scheduled_tasks,
    })
}

pub fn add_params(source: &str, ref_name: Option<&str>) -> Result<Value, String> {
    let source = required_text(source, "marketplace source")?;
    if !is_public_https(&source) {
        return Err("marketplace source must be a public HTTPS URL without credentials".to_owned());
    }
    let mut params = Map::new();
    params.insert("source".to_owned(), Value::String(source));
    if let Some(ref_name) = ref_name {
        let ref_name = required_text(ref_name, "Git reference")?;
        if contains_sensitive_source_material(&ref_name) {
            return Err("Git reference must not contain credentials".to_owned());
        }
        params.insert("refName".to_owned(), Value::String(ref_name));
    }
    Ok(Value::Object(params))
}

pub fn remove_params(marketplace_name: &str) -> Result<Value, String> {
    Ok(json!({ "marketplaceName": required_text(marketplace_name, "marketplace")? }))
}

pub fn upgrade_params(marketplace_name: Option<&str>) -> Result<Value, String> {
    match marketplace_name {
        Some(name) => Ok(json!({ "marketplaceName": required_text(name, "marketplace")? })),
        None => Ok(json!({})),
    }
}

pub fn uninstall_params(plugin_id: &str, removal_confirmed: bool) -> Result<Value, String> {
    if !removal_confirmed {
        return Err("plugin removal must be confirmed".to_owned());
    }
    Ok(json!({ "pluginId": required_text(plugin_id, "plugin id")? }))
}

pub fn project_marketplace_add(response: &Value) -> Result<CodexMarketplaceAddView, String> {
    let value = object(response, "marketplace/add response")?;
    Ok(CodexMarketplaceAddView {
        marketplace_name: required_display_field(value, "marketplaceName")?,
        already_added: value
            .get("alreadyAdded")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

pub fn project_marketplace_remove(response: &Value) -> Result<CodexMarketplaceRemoveView, String> {
    let value = object(response, "marketplace/remove response")?;
    let removed = value
        .get("removed")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            value
                .get("installedRoot")
                .is_some_and(|root| !root.is_null())
        });
    Ok(CodexMarketplaceRemoveView {
        marketplace_name: required_display_field(value, "marketplaceName")?,
        removed,
    })
}

pub fn project_marketplace_upgrade(
    response: &Value,
) -> Result<CodexMarketplaceUpgradeView, String> {
    let value = object(response, "marketplace/upgrade response")?;
    let errors = array_field(value, "errors")
        .iter()
        .filter_map(|error| {
            let error = error.as_object()?;
            Some(CodexMarketplaceUpgradeErrorView {
                marketplace_name: required_display_field(error, "marketplaceName").ok()?,
                message: display_safe_provider_error(
                    &required_field(error, "message").ok()?,
                    "Codex could not refresh this marketplace source.",
                ),
            })
        })
        .collect();
    Ok(CodexMarketplaceUpgradeView {
        selected_marketplaces: display_string_array(value.get("selectedMarketplaces")),
        upgraded_count: array_field(value, "upgradedRoots").len(),
        errors,
    })
}

pub fn project_plugin_install(response: &Value) -> Result<CodexPluginInstallView, String> {
    let value = object(response, "plugin/install response")?;
    Ok(CodexPluginInstallView {
        auth_policy: parse_auth_policy(value.get("authPolicy")),
        apps_needing_auth: array_field(value, "appsNeedingAuth")
            .iter()
            .filter_map(project_app)
            .collect(),
    })
}

fn project_plugin_summary(value: &Map<String, Value>) -> Result<CodexPluginSummaryView, String> {
    let install_policy = parse_install_policy(value.get("installPolicy"));
    let availability = parse_availability(value.get("availability"));
    let installed_state = value.get("installed").and_then(Value::as_bool);
    let authoritative_state_complete =
        installed_state.is_some() && value.get("availability").and_then(Value::as_str).is_some();
    let installed = installed_state.unwrap_or(false);
    let interface = value.get("interface").and_then(Value::as_object);
    let must_show_installation_interstitial = value
        .get("mustShowInstallationInterstitial")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let installable = authoritative_state_complete
        && !installed
        && install_policy == CodexPluginInstallPolicy::Available
        && availability == CodexPluginAvailability::Available;

    Ok(CodexPluginSummaryView {
        id: required_public_identifier(value, "id")?,
        name: required_public_identifier(value, "name")?,
        display_name: interface.and_then(|item| optional_display_field(item, "displayName")),
        short_description: interface
            .and_then(|item| optional_display_field(item, "shortDescription")),
        developer_name: interface.and_then(|item| optional_display_field(item, "developerName")),
        category: interface.and_then(|item| optional_display_field(item, "category")),
        version: optional_display_field(value, "version"),
        local_version: optional_display_field(value, "localVersion"),
        installed,
        enabled: value
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        install_policy,
        auth_policy: parse_auth_policy(value.get("authPolicy")),
        availability,
        must_show_installation_interstitial,
        installable,
        keywords: display_string_array(value.get("keywords")),
        website_url: interface.and_then(|item| optional_https(item, "websiteUrl")),
        logo_url: interface.and_then(|item| optional_https(item, "logoUrl")),
        logo_url_dark: interface.and_then(|item| optional_https(item, "logoUrlDark")),
        screenshot_urls: interface
            .map(|item| {
                string_array(item.get("screenshotUrls"))
                    .into_iter()
                    .filter(|url| is_public_https(url))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

fn display_safe_provider_error(message: &str, fallback: &str) -> String {
    let normalized = message.to_ascii_lowercase();
    if normalized.contains("parse") || normalized.contains("invalid json") {
        "Marketplace metadata could not be parsed.".to_owned()
    } else if normalized.contains("network")
        || normalized.contains("offline")
        || normalized.contains("unreachable")
        || normalized.contains("timed out")
    {
        "Marketplace source could not be reached.".to_owned()
    } else if normalized.contains("authentication")
        || normalized.contains("unauthorized")
        || normalized.contains("forbidden")
    {
        "Marketplace source requires authentication.".to_owned()
    } else {
        fallback.to_owned()
    }
}

fn project_skill(value: &Value) -> Option<CodexPluginSkillView> {
    let value = value.as_object()?;
    Some(CodexPluginSkillView {
        name: required_display_field(value, "name").ok()?,
        description: optional_display_field(value, "description"),
        short_description: optional_display_field(value, "shortDescription"),
        display_name: value
            .get("interface")
            .and_then(Value::as_object)
            .and_then(|interface| optional_display_field(interface, "displayName")),
        enabled: value
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn project_hook(value: &Value) -> Option<CodexPluginHookView> {
    let value = value.as_object()?;
    Some(CodexPluginHookView {
        key: required_display_field(value, "key").ok()?,
        event_name: required_display_field(value, "eventName").ok()?,
    })
}

fn project_app(value: &Value) -> Option<CodexPluginAppView> {
    let value = value.as_object()?;
    Some(CodexPluginAppView {
        id: required_display_field(value, "id").ok()?,
        name: required_display_field(value, "name").ok()?,
        description: optional_display_field(value, "description"),
        category: optional_display_field(value, "category"),
    })
}

fn project_task(value: &Value) -> Option<CodexScheduledTaskView> {
    let value = value.as_object()?;
    Some(CodexScheduledTaskView {
        key: required_display_field(value, "key").ok()?,
        name: required_display_field(value, "name").ok()?,
        prompt: required_display_field(value, "prompt").ok()?,
        schedule: project_schedule(value.get("schedule")?)?,
    })
}

fn project_schedule(value: &Value) -> Option<CodexScheduledTaskScheduleView> {
    let value = value.as_object()?;
    match value.get("type")?.as_str()? {
        "hourly" => {
            let interval_hours = value.get("intervalHours")?.as_u64()?;
            let interval_hours = u32::try_from(interval_hours).ok()?;
            if interval_hours == 0 {
                return None;
            }
            let days = match value.get("days") {
                None | Some(Value::Null) => None,
                Some(days) => Some(canonical_days(days)),
            };
            Some(CodexScheduledTaskScheduleView::Hourly {
                interval_hours,
                days,
            })
        }
        "daily" => Some(CodexScheduledTaskScheduleView::Daily {
            time: valid_time(value.get("time")?.as_str()?)?,
        }),
        "weekdays" => Some(CodexScheduledTaskScheduleView::Weekdays {
            time: valid_time(value.get("time")?.as_str()?)?,
        }),
        "weekly" => Some(CodexScheduledTaskScheduleView::Weekly {
            days: canonical_days(value.get("days")?),
            time: valid_time(value.get("time")?.as_str()?)?,
        }),
        _ => None,
    }
}

fn canonical_days(value: &Value) -> Vec<String> {
    const DAYS: [&str; 7] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
    let supplied: HashSet<&str> = value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    DAYS.into_iter()
        .filter(|day| supplied.contains(day))
        .map(str::to_owned)
        .collect()
}

fn valid_time(value: &str) -> Option<String> {
    let (hour, minute) = value.split_once(':')?;
    if hour.len() != 2 || minute.len() != 2 {
        return None;
    }
    let hour: u8 = hour.parse().ok()?;
    let minute: u8 = minute.parse().ok()?;
    (hour < 24 && minute < 60).then(|| value.to_owned())
}

fn parse_install_policy(value: Option<&Value>) -> CodexPluginInstallPolicy {
    match value.and_then(Value::as_str) {
        Some("AVAILABLE") => CodexPluginInstallPolicy::Available,
        Some("INSTALLED_BY_DEFAULT") => CodexPluginInstallPolicy::InstalledByDefault,
        _ => CodexPluginInstallPolicy::NotAvailable,
    }
}

fn parse_auth_policy(value: Option<&Value>) -> CodexPluginAuthPolicy {
    match value.and_then(Value::as_str) {
        Some("ON_INSTALL") => CodexPluginAuthPolicy::OnInstall,
        Some("ON_USE") => CodexPluginAuthPolicy::OnUse,
        _ => CodexPluginAuthPolicy::Unknown,
    }
}

fn parse_availability(value: Option<&Value>) -> CodexPluginAvailability {
    match value.and_then(Value::as_str) {
        Some("AVAILABLE" | "ENABLED") => CodexPluginAvailability::Available,
        _ => CodexPluginAvailability::DisabledByAdmin,
    }
}

fn optional_https(value: &Map<String, Value>, field: &str) -> Option<String> {
    optional_field(value, field).filter(|url| is_public_https(url))
}

fn is_public_https(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || contains_sensitive_source_material(value)
    {
        return false;
    }
    const SENSITIVE_QUERY_KEYS: &[&str] = &[
        "access_token",
        "authorization",
        "client_secret",
        "code",
        "credential",
        "key",
        "password",
        "refresh_token",
        "secret",
        "sig",
        "signature",
        "token",
        "x-amz-credential",
        "x-amz-signature",
    ];
    if url.query_pairs().any(|(key, _)| {
        let key = key.to_ascii_lowercase();
        SENSITIVE_QUERY_KEYS.contains(&key.as_ref())
    }) {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            let [first, second, third, _] = ip.octets();
            !(ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_broadcast()
                || first == 0
                || (first == 100 && (64..=127).contains(&second))
                || (first == 192 && second == 0)
                || (first == 192 && second == 0 && third == 2)
                || (first == 198 && (second == 18 || second == 19))
                || (first == 198 && second == 51 && third == 100)
                || (first == 203 && second == 0 && third == 113)
                || first >= 240)
        }
        Ok(IpAddr::V6(ip)) => {
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.segments()[0] == 0x2001 && ip.segments()[1] == 0x0db8)
        }
        Err(_) => {
            host.contains('.')
                && host != "localhost"
                && !host.ends_with(".localhost")
                && !host.ends_with(".local")
                && !host.ends_with(".internal")
                && !host.ends_with(".invalid")
                && !host.ends_with(".test")
        }
    }
}

fn percent_decode_round(value: &str) -> String {
    fn hex(value: u8) -> Option<u8> {
        match value {
            b'0'..=b'9' => Some(value - b'0'),
            b'a'..=b'f' => Some(value - b'a' + 10),
            b'A'..=b'F' => Some(value - b'A' + 10),
            _ => None,
        }
    }

    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                decoded.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn contains_sensitive_source_material(value: &str) -> bool {
    let mut normalized = value.to_ascii_lowercase();
    for _ in 0..3 {
        let decoded = percent_decode_round(&normalized);
        if decoded == normalized {
            break;
        }
        normalized = decoded;
    }
    static SENSITIVE: OnceLock<Regex> = OnceLock::new();
    let sensitive = SENSITIVE.get_or_init(|| {
        Regex::new(
            r"(?i)(^|[^a-z0-9])(?:access[_-]?token|auth(?:orization)?|bearer|client[_-]?secret|credential|password|refresh[_-]?token|secret|signature|token|api[_-]?key|private[_-]?key|session[_-]?key|ssh[_-]?key)([^a-z0-9]|$)|\b(?:sk-|ghp_|github_pat_)[a-z0-9_-]{6,}",
        )
        .expect("marketplace source credential detector must compile")
    });
    sensitive.is_match(&normalized) || redact_secrets_bounded(value, 4096) != value
}

fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{label} must be an object"))
}

fn required_text(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("{label} must not be blank"))
    } else if value.len() > 4096 {
        Err(format!("{label} is too long"))
    } else {
        Ok(value.to_owned())
    }
}

fn required_field(value: &Map<String, Value>, field: &str) -> Result<String, String> {
    let raw = value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing {field}"))?;
    required_text(raw, field)
}

fn marketplace_display_redactors() -> &'static [Regex] {
    static REDACTORS: OnceLock<Vec<Regex>> = OnceLock::new();
    REDACTORS.get_or_init(|| {
        vec![
            Regex::new(
                r"(?i)\b(?:access[_-]?token|refresh[_-]?token|token|client[_-]?secret|secret|password|credential|authorization|auth|api[_-]?key)\s*[:=]\s*[^\s,;]+",
            )
            .expect("marketplace credential redactor must compile"),
            Regex::new(r"(?i)\b[A-Z]:[\\/][^\s,;]+")
                .expect("marketplace Windows path redactor must compile"),
            Regex::new(
                r"(?i)(^|[\s=:(])\\\\[^\s,;]+",
            )
            .expect("marketplace UNC path redactor must compile"),
            Regex::new(
                r"(?i)(^|[\s=:(])/(?:[a-z0-9._~-]+/)+[a-z0-9._~-]+",
            )
            .expect("marketplace absolute path redactor must compile"),
        ]
    })
}

fn display_safe_text(value: &str) -> String {
    let mut out = redact_secrets_bounded(value.trim(), 4096);
    out = marketplace_display_redactors()[0]
        .replace_all(&out, "[redacted-credential]")
        .into_owned();
    out = marketplace_display_redactors()[1]
        .replace_all(&out, "[redacted-path]")
        .into_owned();
    out = marketplace_display_redactors()[2]
        .replace_all(&out, "${1}[redacted-path]")
        .into_owned();
    marketplace_display_redactors()[3]
        .replace_all(&out, "${1}[redacted-path]")
        .into_owned()
}

fn required_display_field(value: &Map<String, Value>, field: &str) -> Result<String, String> {
    let raw = required_field(value, field)?;
    let safe = display_safe_text(&raw);
    required_text(&safe, field)
}

fn required_public_identifier(value: &Map<String, Value>, field: &str) -> Result<String, String> {
    let raw = required_field(value, field)?;
    if display_safe_text(&raw) != raw {
        return Err(format!("{field} contains private material"));
    }
    Ok(raw)
}

fn optional_field(value: &Map<String, Value>, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(4096).collect())
}

fn optional_display_field(value: &Map<String, Value>, field: &str) -> Option<String> {
    optional_field(value, field)
        .map(|value| display_safe_text(&value))
        .filter(|value| !value.is_empty())
}

fn array_field<'a>(value: &'a Map<String, Value>, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .take(2000)
        .map(|value| value.chars().take(4096).collect())
        .collect()
}

fn display_string_array(value: Option<&Value>) -> Vec<String> {
    string_array(value)
        .into_iter()
        .map(|value| display_safe_text(&value))
        .filter(|value| !value.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn catalog_fixture() -> Value {
        json!({
            "marketplaces": [
                {
                    "name": "local-market",
                    "path": "C:\\Users\\secret\\marketplaces\\local-market",
                    "interface": { "displayName": "Local Market", "internalToken": "sk-live-123" },
                    "plugins": [
                        {
                            "id": "plugin.notes",
                            "name": "notes",
                            "remotePluginId": "rp-1",
                            "version": "1.2.0",
                            "localVersion": "1.1.0",
                            "installed": false,
                            "enabled": false,
                            "installPolicy": "AVAILABLE",
                            "authPolicy": "ON_USE",
                            "availability": "AVAILABLE",
                            "mustShowInstallationInterstitial": true,
                            "keywords": ["notes", "productivity"],
                            "shareContext": {
                                "remotePluginId": "rp-1",
                                "creatorAccountUserId": "user-9",
                                "shareUrl": "https://chatgpt.com/plugins/rp-1"
                            },
                            "source": { "type": "local", "path": "C:\\Users\\secret\\plugins\\notes" },
                            "interface": {
                                "displayName": "Notes",
                                "shortDescription": "Take notes",
                                "developerName": "Preview Co",
                                "category": "productivity",
                                "websiteUrl": "https://example.com/notes",
                                "logoUrl": "http://cleartext.example.com/logo.png",
                                "logoUrlDark": "https://example.com/logo-dark.png",
                                "composerIcon": "C:\\Users\\secret\\icon.png",
                                "screenshots": ["C:\\Users\\secret\\shot.png"],
                                "screenshotUrls": [
                                    "https://example.com/shot.png",
                                    "http://cleartext.example.com/shot.png"
                                ]
                            },
                            "unknownFutureField": { "nested": true }
                        },
                        {
                            "id": "plugin.locked",
                            "name": "locked",
                            "installed": false,
                            "enabled": false,
                            "installPolicy": "AVAILABLE",
                            "authPolicy": "ON_INSTALL",
                            "availability": "DISABLED_BY_ADMIN"
                        }
                    ]
                },
                {
                    "name": "remote-catalog",
                    "path": null,
                    "plugins": [
                        {
                            "id": "plugin.remote",
                            "name": "remote-plugin",
                            "remotePluginId": "remote-native-id",
                            "installed": false,
                            "enabled": false,
                            "installPolicy": "AVAILABLE",
                            "authPolicy": "ON_USE",
                            "availability": "ENABLED",
                            "mustShowInstallationInterstitial": false
                        }
                    ]
                }
            ],
            "marketplaceLoadErrors": [
                { "marketplacePath": "C:\\Users\\secret\\broken\\marketplace.json", "message": "parse error" }
            ],
            "featuredPluginIds": ["plugin.notes"]
        })
    }

    fn detail_fixture() -> Value {
        json!({ "plugin": {
            "marketplaceName": "local-market",
            "marketplacePath": "C:\\Users\\secret\\marketplaces\\local-market",
            "summary": {
                "id": "plugin.notes",
                "name": "notes",
                "installed": true,
                "enabled": true,
                "installPolicy": "AVAILABLE",
                "authPolicy": "ON_USE",
                "availability": "AVAILABLE",
                "mustShowInstallationInterstitial": false
            },
            "shareUrl": "https://chatgpt.com/plugins/rp-1",
            "description": "Notes plugin",
            "skills": [{
                "name": "note",
                "description": "Take a note",
                "shortDescription": "Note",
                "interface": { "displayName": "Note taker" },
                "path": "C:\\Users\\secret\\skills\\note",
                "enabled": true
            }],
            "hooks": [{ "key": "hook-1", "eventName": "PreToolUse" }],
            "apps": [{
                "id": "app-1",
                "name": "Notes App",
                "description": "Sync notes",
                "installUrl": "https://auth.example.com/install?token=abc",
                "category": "productivity"
            }],
            "appTemplates": [{ "templateId": "t1", "name": "T" }],
            "mcpServers": ["notes-mcp"],
            "scheduledTasks": [
                {
                    "key": "digest",
                    "name": "Daily digest",
                    "prompt": "Summarize my notes",
                    "schedule": { "type": "daily", "time": "07:30" }
                },
                {
                    "key": "weekly",
                    "name": "Weekly report",
                    "prompt": "Report",
                    "schedule": { "type": "weekly", "days": ["FR", "MO", "MO"], "time": "09:00" }
                },
                {
                    "key": "hourly",
                    "name": "Hourly check",
                    "prompt": "Check",
                    "schedule": { "type": "hourly", "intervalHours": 2, "days": ["SU", "SA"] }
                },
                {
                    "key": "weekdays",
                    "name": "Standup",
                    "prompt": "Prep standup",
                    "schedule": { "type": "weekdays", "time": "08:45" }
                },
                {
                    "key": "future",
                    "name": "Future cadence",
                    "prompt": "??",
                    "schedule": { "type": "lunar", "phase": "full" }
                }
            ]
        }})
    }

    #[test]
    fn catalog_projection_is_display_safe_and_fail_open() {
        let (view, _) = project_catalog(&catalog_fixture()).unwrap();
        assert_eq!(view.marketplaces.len(), 2);

        let market = &view.marketplaces[0];
        assert_eq!(market.name, "local-market");
        assert_eq!(market.display_name.as_deref(), Some("Local Market"));

        let notes = &market.plugins[0];
        assert_eq!(notes.id, "plugin.notes");
        assert_eq!(notes.name, "notes");
        assert_eq!(notes.display_name.as_deref(), Some("Notes"));
        assert_eq!(notes.version.as_deref(), Some("1.2.0"));
        assert_eq!(notes.local_version.as_deref(), Some("1.1.0"));
        assert_eq!(
            notes.website_url.as_deref(),
            Some("https://example.com/notes")
        );
        assert_eq!(notes.logo_url, None); // http:// never crosses the boundary
        assert_eq!(
            notes.logo_url_dark.as_deref(),
            Some("https://example.com/logo-dark.png")
        );
        assert_eq!(notes.screenshot_urls, vec!["https://example.com/shot.png"]);
        assert!(notes.installable);
        assert!(notes.must_show_installation_interstitial);

        let locked = &market.plugins[1];
        assert_eq!(
            locked.availability,
            CodexPluginAvailability::DisabledByAdmin
        );
        assert!(!locked.installable);
        // A missing interstitial flag fails closed to "must show".
        assert!(locked.must_show_installation_interstitial);

        let remote = &view.marketplaces[1].plugins[0];
        // Upstream sends the "ENABLED" alias for available remote plugins.
        assert_eq!(remote.availability, CodexPluginAvailability::Available);
        // Preserve Codex's display hint; Portcode's native route still requires
        // confirmation for every installation.
        assert!(!remote.must_show_installation_interstitial);

        // The degraded source stays visible without exposing its local path.
        assert_eq!(view.load_errors.len(), 1);
        assert_eq!(view.load_errors[0].source_label, "Marketplace source");
        assert_eq!(
            view.load_errors[0].message,
            "Marketplace metadata could not be parsed."
        );
        assert_eq!(view.featured_plugin_ids, vec!["plugin.notes"]);

        let encoded = serde_json::to_value(&view).unwrap().to_string();
        assert!(!encoded.contains("secret"), "local paths leaked: {encoded}");
        assert!(!encoded.contains("sk-live-123"));
        assert!(!encoded.contains("creatorAccountUserId"));
        assert!(!encoded.contains("shareContext"));
        assert!(!encoded.contains("remote-native-id"));
        assert!(!encoded.contains("unknownFutureField"));
        assert!(!encoded.contains("cleartext"));
    }

    #[test]
    fn provider_error_messages_cannot_cross_the_display_boundary_verbatim() {
        let mut catalog = catalog_fixture();
        catalog["marketplaceLoadErrors"][0]["message"] =
            json!("failed at C:\\Users\\secret\\marketplace.json?access_token=sk-live-123");
        let (view, _) = project_catalog(&catalog).unwrap();
        assert_eq!(
            view.load_errors[0].message,
            "Codex could not load this marketplace source."
        );

        let upgrade = project_marketplace_upgrade(&json!({
            "selectedMarketplaces": ["team"],
            "upgradedRoots": [],
            "errors": [{
                "marketplaceName": "team",
                "message": "request used bearer secret-token from C:\\private"
            }]
        }))
        .unwrap();
        assert_eq!(
            upgrade.errors[0].message,
            "Codex could not refresh this marketplace source."
        );

        let encoded = format!(
            "{}{}",
            serde_json::to_string(&view).unwrap(),
            serde_json::to_string(&upgrade).unwrap()
        );
        for forbidden in ["secret", "token", "C:\\\\", "private"] {
            assert!(
                !encoded.contains(forbidden),
                "provider data leaked: {encoded}"
            );
        }
    }

    #[test]
    fn unknown_policy_values_fail_closed() {
        let value = json!({ "marketplaces": [{ "name": "m", "plugins": [{
            "id": "p",
            "name": "p",
            "installPolicy": "SOMETHING_NEW",
            "availability": "SOMETHING_ELSE",
            "mustShowInstallationInterstitial": "yes"
        }]}]});
        let (view, _) = project_catalog(&value).unwrap();
        let plugin = &view.marketplaces[0].plugins[0];
        assert_eq!(
            plugin.install_policy,
            CodexPluginInstallPolicy::NotAvailable
        );
        assert_eq!(
            plugin.availability,
            CodexPluginAvailability::DisabledByAdmin
        );
        assert!(plugin.must_show_installation_interstitial);
        assert!(!plugin.installable);
    }

    #[test]
    fn missing_or_malformed_authoritative_state_cannot_be_installed() {
        let value = json!({ "marketplaces": [{ "name": "m", "plugins": [
            {
                "id": "missing-installed",
                "name": "missing-installed",
                "installPolicy": "AVAILABLE",
                "availability": "AVAILABLE"
            },
            {
                "id": "missing-availability",
                "name": "missing-availability",
                "installed": false,
                "installPolicy": "AVAILABLE"
            },
            {
                "id": "wrong-installed",
                "name": "wrong-installed",
                "installed": "false",
                "installPolicy": "AVAILABLE",
                "availability": "AVAILABLE"
            }
        ]}]});
        let (view, routes) = project_catalog(&value).unwrap();

        for plugin in &view.marketplaces[0].plugins {
            assert!(!plugin.installable, "{} failed open", plugin.name);
            assert!(routes.install_params("m", &plugin.name, true).is_err());
        }
    }

    #[test]
    fn install_gate_fails_closed_and_builds_typed_params() {
        let (_, routes) = project_catalog(&catalog_fixture()).unwrap();

        assert!(routes
            .install_params("missing", "notes", true)
            .unwrap_err()
            .contains("catalog"));
        assert!(routes
            .install_params("local-market", "missing", true)
            .unwrap_err()
            .contains("catalog"));
        assert!(routes
            .install_params("local-market", "locked", true)
            .unwrap_err()
            .contains("policy"));
        assert!(routes
            .install_params("local-market", "notes", false)
            .unwrap_err()
            .contains("disclosure"));

        let params = routes
            .install_params("local-market", "notes", true)
            .unwrap();
        assert_eq!(
            params["marketplacePath"],
            "C:\\Users\\secret\\marketplaces\\local-market"
        );
        assert_eq!(params["pluginName"], "notes");
        assert!(params.get("remoteMarketplaceName").is_none());

        // Portcode always requires explicit user confirmation, even when Codex
        // does not require its own provider interstitial.
        assert!(routes
            .install_params("remote-catalog", "remote-plugin", false)
            .unwrap_err()
            .contains("disclosure"));
        let remote = routes
            .install_params("remote-catalog", "remote-plugin", true)
            .unwrap();
        assert_eq!(remote["remoteMarketplaceName"], "remote-catalog");
        assert_eq!(remote["pluginName"], "remote-native-id");
        assert!(remote.get("marketplacePath").is_none());
    }

    #[test]
    fn read_params_require_a_loaded_catalog_row() {
        let (_, routes) = project_catalog(&catalog_fixture()).unwrap();
        assert!(routes.read_params("missing", "notes").is_err());
        assert!(routes.read_params("local-market", "missing").is_err());

        let params = routes.read_params("local-market", "notes").unwrap();
        assert_eq!(
            params["marketplacePath"],
            "C:\\Users\\secret\\marketplaces\\local-market"
        );
        assert_eq!(params["pluginName"], "notes");

        // Admin-disabled plugins stay readable (the detail view shows why the
        // install action is blocked); only installation is gated.
        assert!(routes.read_params("local-market", "locked").is_ok());

        let remote = routes
            .read_params("remote-catalog", "remote-plugin")
            .unwrap();
        assert_eq!(remote["remoteMarketplaceName"], "remote-catalog");
        assert_eq!(remote["pluginName"], "remote-native-id");
        assert!(remote.get("marketplacePath").is_none());
    }

    #[test]
    fn marketplace_sources_must_be_public_https_urls() {
        let params = add_params(" https://example.com/repo.git ", None).unwrap();
        assert_eq!(params["source"], "https://example.com/repo.git");
        assert!(params.get("refName").is_none());

        let with_ref = add_params("https://example.com/repo.git", Some("main")).unwrap();
        assert_eq!(with_ref["refName"], "main");
        assert!(add_params(
            "https://example.com/tokenizer-plugin.git",
            Some("feature/tokenizer")
        )
        .is_ok());

        for bad in [
            "http://example.com/repo.git",
            "file:///C:/marketplace",
            "ssh://git@example.com/repo.git",
            "git@example.com:org/repo.git",
            "https://user:pw@example.com/repo.git",
            "https://",
            "https://localhost/mp",
            "https://intranet/mp",
            "https://metadata.google.internal/mp",
            "https://127.0.0.1/mp",
            "https://100.64.0.1/mp",
            "https://192.0.2.1/mp",
            "https://[::1]/mp",
            "https://[fe80::1]/mp",
            "https://example.com/repo.git?access_token=secret",
            "https://example.com/access_token/sk-live-123/repo.git",
            "https://example.com/repo.git#access_token=sk-live-123",
            "https://example.com/repo.git?auth=sk-live-123",
            "https://example.com/auth/planted-value/repo.git",
            "https://example.com/bearer/planted-value/repo.git",
            "https://example.com/%61ccess_%74oken/planted-value/repo.git",
            "javascript:alert(1)",
            "C:\\local\\path",
            "",
            "   ",
        ] {
            assert!(add_params(bad, None).is_err(), "{bad:?} must be rejected");
        }

        for bad_ref in [
            "access_token=sk-live-123",
            "secret/sk-live-123",
            "feature/auth/planted-value",
            "feature/bearer/planted-value",
            "feature/%61ccess_%74oken/planted-value",
        ] {
            assert!(
                add_params("https://example.com/repo.git", Some(bad_ref)).is_err(),
                "{bad_ref:?} must be rejected"
            );
        }
    }

    #[test]
    fn plugin_detail_keeps_known_fields_and_drops_private_ones() {
        let detail = project_plugin_detail(&detail_fixture()).unwrap();
        assert_eq!(detail.marketplace_name, "local-market");
        assert_eq!(
            detail.share_url.as_deref(),
            Some("https://chatgpt.com/plugins/rp-1")
        );
        assert_eq!(detail.description.as_deref(), Some("Notes plugin"));
        assert_eq!(detail.summary.id, "plugin.notes");
        assert!(detail.summary.installed);

        assert_eq!(detail.skills.len(), 1);
        assert_eq!(detail.skills[0].name, "note");
        assert_eq!(detail.skills[0].display_name.as_deref(), Some("Note taker"));
        assert_eq!(detail.hooks.len(), 1);
        assert_eq!(detail.hooks[0].event_name, "PreToolUse");
        assert_eq!(detail.apps.len(), 1);
        assert_eq!(detail.apps[0].name, "Notes App");
        assert_eq!(detail.mcp_servers, vec!["notes-mcp"]);

        let encoded = serde_json::to_value(&detail).unwrap().to_string();
        assert!(!encoded.contains("secret"), "local paths leaked: {encoded}");
        assert!(!encoded.contains("token=abc"), "app install URL leaked");
    }

    #[test]
    fn allowlisted_display_strings_scrub_credentials_and_filesystem_paths() {
        let detail = project_plugin_detail(&json!({ "plugin": {
            "marketplaceName": "team",
            "summary": {
                "id": "p",
                "name": "p",
                "installed": true,
                "enabled": true,
                "installPolicy": "AVAILABLE",
                "authPolicy": "ON_USE",
                "availability": "AVAILABLE",
                "interface": {
                    "shortDescription": "Authorization: Bearer planted-secret at C:\\Users\\Alice\\private"
                }
            },
            "description": "token=planted-secret /home/alice/private /workspace/alice/private/file path=/mnt/c/Users/Alice/private \\\\server\\share\\Alice\\private",
            "scheduledTasks": [{
                "key": "t",
                "name": "C:\\Users\\Alice\\task",
                "prompt": "Use bearer planted-secret",
                "schedule": {"type":"daily","time":"09:00"}
            }]
        }}))
        .unwrap();
        let encoded = serde_json::to_string(&detail).unwrap();

        for forbidden in [
            "planted-secret",
            "Alice",
            "/home/alice",
            "/workspace/alice",
            "/mnt/c/Users",
            "server\\\\share",
            "C:\\\\Users",
        ] {
            assert!(
                !encoded.contains(forbidden),
                "public detail leaked {forbidden}: {encoded}"
            );
        }
        assert!(encoded.contains("redacted"));

        let (catalog, _) = project_catalog(&json!({
            "marketplaces": [],
            "marketplaceLoadErrors": [{
                "marketplacePath": "C:\\Users\\Alice\\secret-source",
                "message": "failed"
            }]
        }))
        .unwrap();
        let encoded = serde_json::to_string(&catalog).unwrap();
        assert!(!encoded.contains("Alice"));
        assert!(!encoded.contains("secret-source"));
    }

    #[test]
    fn scheduled_tasks_project_deterministic_schedules() {
        let detail = project_plugin_detail(&detail_fixture()).unwrap();
        let tasks = detail.scheduled_tasks.as_ref().unwrap();
        // The unknown "lunar" cadence is dropped without losing the rest.
        assert_eq!(tasks.len(), 4);
        assert_eq!(tasks[0].key, "digest");
        assert_eq!(tasks[0].prompt, "Summarize my notes");
        assert_eq!(
            tasks[0].schedule,
            CodexScheduledTaskScheduleView::Daily {
                time: "07:30".to_owned()
            }
        );
        // Weekday lists deduplicate and render in canonical Mo..Su order.
        assert_eq!(
            tasks[1].schedule,
            CodexScheduledTaskScheduleView::Weekly {
                days: vec!["MO".to_owned(), "FR".to_owned()],
                time: "09:00".to_owned()
            }
        );
        assert_eq!(
            tasks[2].schedule,
            CodexScheduledTaskScheduleView::Hourly {
                interval_hours: 2,
                days: Some(vec!["SA".to_owned(), "SU".to_owned()])
            }
        );
        assert_eq!(
            tasks[3].schedule,
            CodexScheduledTaskScheduleView::Weekdays {
                time: "08:45".to_owned()
            }
        );
    }

    #[test]
    fn scheduled_task_availability_distinguishes_null_and_empty() {
        let null_detail = project_plugin_detail(&json!({ "plugin": {
            "marketplaceName": "m",
            "summary": { "id": "p", "name": "p" },
            "scheduledTasks": null
        }}))
        .unwrap();
        assert!(null_detail.scheduled_tasks.is_none());

        let empty_detail = project_plugin_detail(&json!({ "plugin": {
            "marketplaceName": "m",
            "summary": { "id": "p", "name": "p" },
            "scheduledTasks": []
        }}))
        .unwrap();
        assert_eq!(empty_detail.scheduled_tasks.as_deref(), Some(&[][..]));
    }

    #[test]
    fn management_action_projections_drop_local_roots() {
        let add = project_marketplace_add(&json!({
            "marketplaceName": "team",
            "installedRoot": "C:\\Users\\secret\\mp",
            "alreadyAdded": false
        }))
        .unwrap();
        assert_eq!(add.marketplace_name, "team");
        assert!(!add.already_added);
        assert!(!serde_json::to_value(&add)
            .unwrap()
            .to_string()
            .contains("secret"));

        let removed = project_marketplace_remove(&json!({
            "marketplaceName": "team",
            "installedRoot": "C:\\Users\\secret\\mp"
        }))
        .unwrap();
        assert_eq!(removed.marketplace_name, "team");
        assert!(removed.removed);
        assert!(!serde_json::to_value(&removed)
            .unwrap()
            .to_string()
            .contains("secret"));

        let noop = project_marketplace_remove(&json!({
            "marketplaceName": "team",
            "installedRoot": null
        }))
        .unwrap();
        assert!(!noop.removed);

        let upgrade = project_marketplace_upgrade(&json!({
            "selectedMarketplaces": ["team", "other"],
            "upgradedRoots": ["C:\\Users\\secret\\a", "C:\\Users\\secret\\b"],
            "errors": [{ "marketplaceName": "other", "message": "network unreachable" }]
        }))
        .unwrap();
        assert_eq!(upgrade.selected_marketplaces, vec!["team", "other"]);
        assert_eq!(upgrade.upgraded_count, 2);
        assert_eq!(upgrade.errors.len(), 1);
        assert_eq!(upgrade.errors[0].marketplace_name, "other");
        assert_eq!(
            upgrade.errors[0].message,
            "Marketplace source could not be reached."
        );
        assert!(!serde_json::to_value(&upgrade)
            .unwrap()
            .to_string()
            .contains("secret"));
    }

    #[test]
    fn install_response_surfaces_auth_needs_without_credentials() {
        let install = project_plugin_install(&json!({
            "authPolicy": "ON_INSTALL",
            "appsNeedingAuth": [{
                "id": "app-1",
                "name": "Notes",
                "description": null,
                "installUrl": "https://auth.example.com/?code=shh",
                "category": null,
                "oauthClientSecret": "shh2"
            }]
        }))
        .unwrap();
        assert_eq!(install.auth_policy, CodexPluginAuthPolicy::OnInstall);
        assert_eq!(install.apps_needing_auth.len(), 1);
        assert_eq!(install.apps_needing_auth[0].id, "app-1");
        let encoded = serde_json::to_value(&install).unwrap().to_string();
        assert!(
            !encoded.contains("shh"),
            "credential material leaked: {encoded}"
        );

        let on_use = project_plugin_install(&json!({
            "authPolicy": "ON_USE",
            "appsNeedingAuth": []
        }))
        .unwrap();
        assert_eq!(on_use.auth_policy, CodexPluginAuthPolicy::OnUse);
        assert!(on_use.apps_needing_auth.is_empty());
    }

    #[test]
    fn identifier_params_reject_blank_input() {
        assert!(uninstall_params("  ", true).is_err());
        assert!(uninstall_params("plugin.notes", false).is_err());
        assert_eq!(
            uninstall_params(" plugin.notes ", true).unwrap()["pluginId"],
            "plugin.notes"
        );

        assert!(remove_params("").is_err());
        assert_eq!(remove_params("team").unwrap()["marketplaceName"], "team");

        assert!(upgrade_params(Some("  ")).is_err());
        assert_eq!(
            upgrade_params(Some("team")).unwrap()["marketplaceName"],
            "team"
        );
        assert_eq!(upgrade_params(None).unwrap(), json!({}));
    }

    #[test]
    fn view_enums_serialize_camel_case_for_the_frontend() {
        assert_eq!(
            serde_json::to_value(CodexPluginInstallPolicy::NotAvailable).unwrap(),
            json!("notAvailable")
        );
        assert_eq!(
            serde_json::to_value(CodexPluginInstallPolicy::InstalledByDefault).unwrap(),
            json!("installedByDefault")
        );
        assert_eq!(
            serde_json::to_value(CodexPluginAvailability::DisabledByAdmin).unwrap(),
            json!("disabledByAdmin")
        );
        assert_eq!(
            serde_json::to_value(CodexPluginAuthPolicy::OnInstall).unwrap(),
            json!("onInstall")
        );
        assert_eq!(
            serde_json::to_value(CodexScheduledTaskScheduleView::Hourly {
                interval_hours: 2,
                days: None
            })
            .unwrap(),
            json!({ "type": "hourly", "intervalHours": 2, "days": null })
        );
    }
}
