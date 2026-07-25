use base64::Engine;
use serde::{
    de::{self, SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs::{self, File};
use std::io::{Cursor, Read};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(crate) const MAX_ATTACHMENT_COUNT: usize = 10;
pub(crate) const MAX_ATTACHMENT_CANDIDATE_COUNT: usize = 50;
pub(crate) const MAX_ATTACHMENT_ISSUE_COUNT: usize = 20;
pub(crate) const MAX_ATTACHMENT_CANDIDATE_PATH_BYTES: usize = 4 * 1024;
pub(crate) const MAX_ATTACHMENT_CANDIDATE_REQUEST_BYTES: usize = 64 * 1024;
pub(crate) const MAX_ATTACHMENT_FILE_BYTES: u64 = 20 * 1024 * 1024;
pub(crate) const MAX_ATTACHMENT_TOTAL_BYTES: u64 = 50 * 1024 * 1024;
pub(crate) const MAX_ATTACHMENT_DISPLAY_NAME_BYTES: usize = 240 * 4;
pub(crate) const MAX_AGENT_TEXT_BYTES: usize = 1024 * 1024;
const MAX_ATTACHMENT_DISPLAY_NAME_REQUEST_BYTES: usize = 16 * 1024;
const MAX_ATTACHMENT_ISSUE_NAME_CHARS: usize = 160;
const MAX_INLINE_THUMBNAIL_BYTES: usize = 1024 * 1024;
const MAX_ATTACHMENT_IMAGE_DIMENSION: u32 = 16_384;
const MAX_ATTACHMENT_IMAGE_PIXELS: u64 = 40_000_000;

#[derive(Debug)]
pub(crate) struct BoundedString<const MAX_BYTES: usize>(String);

impl<const MAX_BYTES: usize> BoundedString<MAX_BYTES> {
    pub(crate) fn into_inner(self) -> String {
        self.0
    }
}

struct BoundedStringVisitor<const MAX_BYTES: usize>;

impl<'de, const MAX_BYTES: usize> Visitor<'de> for BoundedStringVisitor<MAX_BYTES> {
    type Value = BoundedString<MAX_BYTES>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "a string no larger than {MAX_BYTES} bytes")
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        if value.len() > MAX_BYTES {
            return Err(E::custom("string exceeded the request byte limit"));
        }
        Ok(BoundedString(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        if value.len() > MAX_BYTES {
            return Err(E::custom("string exceeded the request byte limit"));
        }
        Ok(BoundedString(value))
    }
}

impl<'de, const MAX_BYTES: usize> Deserialize<'de> for BoundedString<MAX_BYTES> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_string(BoundedStringVisitor)
    }
}

#[derive(Debug)]
pub(crate) struct BoundedStrings<
    const MAX_COUNT: usize,
    const MAX_ITEM_BYTES: usize,
    const MAX_TOTAL_BYTES: usize,
>(Vec<String>);

impl<const MAX_COUNT: usize, const MAX_ITEM_BYTES: usize, const MAX_TOTAL_BYTES: usize>
    BoundedStrings<MAX_COUNT, MAX_ITEM_BYTES, MAX_TOTAL_BYTES>
{
    pub(crate) fn into_inner(self) -> Vec<String> {
        self.0
    }
}

struct BoundedStringsVisitor<
    const MAX_COUNT: usize,
    const MAX_ITEM_BYTES: usize,
    const MAX_TOTAL_BYTES: usize,
>(PhantomData<()>);

impl<'de, const MAX_COUNT: usize, const MAX_ITEM_BYTES: usize, const MAX_TOTAL_BYTES: usize>
    Visitor<'de> for BoundedStringsVisitor<MAX_COUNT, MAX_ITEM_BYTES, MAX_TOTAL_BYTES>
{
    type Value = BoundedStrings<MAX_COUNT, MAX_ITEM_BYTES, MAX_TOTAL_BYTES>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "at most {MAX_COUNT} bounded strings")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        if sequence.size_hint().is_some_and(|size| size > MAX_COUNT) {
            return Err(de::Error::custom("too many strings in request"));
        }
        let mut values =
            Vec::with_capacity(sequence.size_hint().unwrap_or_default().min(MAX_COUNT));
        let mut total_bytes = 0_usize;
        while let Some(BoundedString(value)) =
            sequence.next_element::<BoundedString<MAX_ITEM_BYTES>>()?
        {
            if values.len() >= MAX_COUNT {
                return Err(de::Error::custom("too many strings in request"));
            }
            total_bytes = total_bytes.saturating_add(value.len());
            if total_bytes > MAX_TOTAL_BYTES {
                return Err(de::Error::custom(
                    "string request exceeded the aggregate byte limit",
                ));
            }
            values.push(value);
        }
        Ok(BoundedStrings(values))
    }
}

impl<'de, const MAX_COUNT: usize, const MAX_ITEM_BYTES: usize, const MAX_TOTAL_BYTES: usize>
    Deserialize<'de> for BoundedStrings<MAX_COUNT, MAX_ITEM_BYTES, MAX_TOTAL_BYTES>
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_seq(BoundedStringsVisitor(PhantomData))
    }
}

pub(crate) type AttachmentPathArgs = BoundedStrings<
    MAX_ATTACHMENT_CANDIDATE_COUNT,
    MAX_ATTACHMENT_CANDIDATE_PATH_BYTES,
    MAX_ATTACHMENT_CANDIDATE_REQUEST_BYTES,
>;
pub(crate) type AttachmentDisplayNameArgs = BoundedStrings<
    MAX_ATTACHMENT_COUNT,
    MAX_ATTACHMENT_DISPLAY_NAME_BYTES,
    MAX_ATTACHMENT_DISPLAY_NAME_REQUEST_BYTES,
>;
pub(crate) type AgentTextArg = BoundedString<MAX_AGENT_TEXT_BYTES>;

static ATTACHMENT_VALIDATION_PERMITS: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(2)));
const ATTACHMENT_VALIDATION_QUEUE_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) async fn acquire_attachment_validation_permit(
) -> Result<OwnedSemaphorePermit, &'static str> {
    acquire_attachment_validation_permit_with_timeout(ATTACHMENT_VALIDATION_QUEUE_TIMEOUT).await
}

async fn acquire_attachment_validation_permit_with_timeout(
    timeout: Duration,
) -> Result<OwnedSemaphorePermit, &'static str> {
    tokio::time::timeout(
        timeout,
        ATTACHMENT_VALIDATION_PERMITS.clone().acquire_owned(),
    )
    .await
    .map_err(|_| "Attachment validation is busy. Try again.")?
    .map_err(|_| "Attachment validation is unavailable.")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AttachmentKind {
    Text,
    Image,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentDescriptor {
    pub path: PathBuf,
    pub name: String,
    pub kind: AttachmentKind,
    pub media_type: String,
    pub size: u64,
    pub thumbnail_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentIssue {
    pub name: String,
    pub message: String,
}

#[derive(Debug, Clone)]
enum AttachmentContent {
    Text(String),
    Image(Vec<u8>),
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedAttachment {
    pub descriptor: AttachmentDescriptor,
    content: AttachmentContent,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct PreparedAttachmentSet {
    pub attachments: Vec<PreparedAttachment>,
    pub issues: Vec<AttachmentIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentValidationResult {
    pub attachments: Vec<AttachmentDescriptor>,
    pub errors: Vec<AttachmentIssue>,
}

#[derive(Debug)]
pub(crate) struct PreparedTurn {
    pub display_text: String,
    pub input: Vec<Value>,
    attachment_snapshot: Option<Arc<tempfile::TempDir>>,
}

impl PreparedTurn {
    pub(crate) fn attachment_snapshot(&self) -> Option<Arc<tempfile::TempDir>> {
        self.attachment_snapshot.clone()
    }
}

impl PreparedAttachmentSet {
    pub(crate) fn validation_result(&self) -> AttachmentValidationResult {
        AttachmentValidationResult {
            attachments: self
                .attachments
                .iter()
                .map(|attachment| attachment.descriptor.clone())
                .collect(),
            errors: self.issues.clone(),
        }
    }
}

pub(crate) fn prepare_attachment_paths(paths: &[PathBuf]) -> PreparedAttachmentSet {
    let mut prepared = PreparedAttachmentSet::default();
    let mut seen = HashSet::new();
    let mut aggregate_size = 0_u64;
    let skipped_candidate_count = paths.len().saturating_sub(MAX_ATTACHMENT_CANDIDATE_COUNT);
    let mut candidate_request_bytes = 0_usize;
    let mut admitted_candidate_count = 0_usize;
    let mut candidate_request_too_large = false;

    for requested_path in paths.iter().take(MAX_ATTACHMENT_CANDIDATE_COUNT) {
        let path_bytes = requested_path.as_os_str().to_string_lossy().len();
        if path_bytes > MAX_ATTACHMENT_CANDIDATE_PATH_BYTES
            || candidate_request_bytes.saturating_add(path_bytes)
                > MAX_ATTACHMENT_CANDIDATE_REQUEST_BYTES
        {
            candidate_request_too_large = true;
            break;
        }
        candidate_request_bytes = candidate_request_bytes.saturating_add(path_bytes);
        admitted_candidate_count += 1;
    }

    for requested_path in paths.iter().take(admitted_candidate_count) {
        let requested_name = safe_file_name(requested_path);
        let canonical = match fs::canonicalize(requested_path) {
            Ok(path) => path,
            Err(_) => {
                prepared.issues.push(issue(
                    requested_name,
                    "This file could not be read. Check that it still exists and try again.",
                ));
                continue;
            }
        };
        if !seen.insert(canonical.clone()) {
            continue;
        }

        let name = safe_file_name(&canonical);
        let path_metadata = match fs::metadata(&canonical) {
            Ok(metadata) => metadata,
            Err(_) => {
                prepared.issues.push(issue(
                    name,
                    "This file could not be read. Check its permissions and try again.",
                ));
                continue;
            }
        };
        if !path_metadata.is_file() {
            prepared.issues.push(issue(
                name,
                "Only regular files can be attached; folders and special files are not supported.",
            ));
            continue;
        }
        let file = match File::open(&canonical) {
            Ok(file) => file,
            Err(_) => {
                prepared.issues.push(issue(
                    name,
                    "This file could not be read. Check its permissions and try again.",
                ));
                continue;
            }
        };
        let metadata = match file.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                prepared.issues.push(issue(
                    name,
                    "This file could not be read. Check its permissions and try again.",
                ));
                continue;
            }
        };
        if !metadata.is_file() {
            prepared.issues.push(issue(
                name,
                "Only regular files can be attached; folders and special files are not supported.",
            ));
            continue;
        }
        if prepared.attachments.len() >= MAX_ATTACHMENT_COUNT {
            prepared
                .issues
                .push(issue(name, "You can attach up to 10 files to one message."));
            continue;
        }
        if metadata.len() > MAX_ATTACHMENT_FILE_BYTES {
            prepared.issues.push(issue(
                name,
                "This file is larger than the 20 MiB per-file limit.",
            ));
            continue;
        }
        if aggregate_size.saturating_add(metadata.len()) > MAX_ATTACHMENT_TOTAL_BYTES {
            prepared.issues.push(issue(
                name,
                "These files would exceed the 50 MiB total attachment limit.",
            ));
            continue;
        }

        let Some(file_type) = supported_type(&canonical) else {
            prepared.issues.push(issue(
                name,
                "This file type is not supported. Attach UTF-8 text/code or PNG, JPEG, GIF, or WebP images.",
            ));
            continue;
        };
        let remaining_total = MAX_ATTACHMENT_TOTAL_BYTES.saturating_sub(aggregate_size);
        let read_limit = MAX_ATTACHMENT_FILE_BYTES
            .min(remaining_total)
            .saturating_add(1);
        let mut bytes = Vec::with_capacity(metadata.len().min(read_limit) as usize);
        let mut bounded_reader = file.take(read_limit);
        if bounded_reader.read_to_end(&mut bytes).is_err() {
            prepared.issues.push(issue(
                name,
                "This file could not be read. Check its permissions and try again.",
            ));
            continue;
        }
        let actual_size = bytes.len() as u64;
        if actual_size > MAX_ATTACHMENT_FILE_BYTES {
            prepared.issues.push(issue(
                name,
                "This file is larger than the 20 MiB per-file limit.",
            ));
            continue;
        }
        if actual_size > remaining_total {
            prepared.issues.push(issue(
                name,
                "These files would exceed the 50 MiB total attachment limit.",
            ));
            continue;
        }

        let (kind, media_type, thumbnail_url, content) = match file_type {
            SupportedType::Text(media_type) => {
                let text = match String::from_utf8(bytes) {
                    Ok(text) => text,
                    Err(_) => {
                        prepared.issues.push(issue(
                            name,
                            "This text/code file is not valid UTF-8 and cannot be attached safely.",
                        ));
                        continue;
                    }
                };
                (
                    AttachmentKind::Text,
                    media_type,
                    None,
                    AttachmentContent::Text(text),
                )
            }
            SupportedType::Image(media_type, signature) => {
                if let Err(validation_error) = validate_image_decode(signature, &bytes) {
                    let message = if validation_error == ImageValidationError::ResourceLimit {
                        "This image has too many pixels to decode safely. Resize it and try again."
                    } else {
                        match signature {
                            ImageSignature::Png => "This image is not a valid PNG file.",
                            ImageSignature::Jpeg => "This image is not a valid JPEG file.",
                            ImageSignature::Gif => "This image is not a valid GIF file.",
                            ImageSignature::Webp => "This image is not a valid WebP file.",
                        }
                    };
                    prepared.issues.push(issue(name, message));
                    continue;
                }
                let thumbnail_url = (bytes.len() <= MAX_INLINE_THUMBNAIL_BYTES).then(|| {
                    format!(
                        "data:{media_type};base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(&bytes)
                    )
                });
                (
                    AttachmentKind::Image,
                    media_type,
                    thumbnail_url,
                    AttachmentContent::Image(bytes),
                )
            }
        };

        aggregate_size = aggregate_size.saturating_add(actual_size);
        prepared.attachments.push(PreparedAttachment {
            descriptor: AttachmentDescriptor {
                path: canonical,
                name,
                kind,
                media_type: media_type.to_owned(),
                size: actual_size,
                thumbnail_url,
            },
            content,
        });
    }

    if candidate_request_too_large {
        prepared
            .issues
            .truncate(MAX_ATTACHMENT_ISSUE_COUNT.saturating_sub(1));
        prepared.issues.push(AttachmentIssue {
            name: "Selected files".to_owned(),
            message: "The selected file paths are too large to validate safely. Choose fewer files or shorter locations and try again.".to_owned(),
        });
    } else if skipped_candidate_count > 0 {
        prepared
            .issues
            .truncate(MAX_ATTACHMENT_ISSUE_COUNT.saturating_sub(1));
        prepared.issues.push(AttachmentIssue {
            name: "Additional files".to_owned(),
            message: format!(
                "There were too many candidate files. Only the first {MAX_ATTACHMENT_CANDIDATE_COUNT} were checked; {skipped_candidate_count} additional candidates were skipped."
            ),
        });
    } else {
        prepared.issues.truncate(MAX_ATTACHMENT_ISSUE_COUNT);
    }

    prepared
}

/// Build the exact v2 turn/start.input union pinned by codex-runtime.lock.json
/// (Codex 0.145.0). Text attachments are explicit filename-delimited text inputs;
/// images use the app-server localImage path input variant.
#[cfg(test)]
pub(crate) fn build_turn_input(text: &str, attachments: &[PreparedAttachment]) -> Vec<Value> {
    let labels = attachment_summary_labels(attachments);
    build_turn_input_with_labels(text, attachments, &labels)
}

fn build_turn_input_with_labels(
    text: &str,
    attachments: &[PreparedAttachment],
    labels: &[String],
) -> Vec<Value> {
    let mut input = Vec::with_capacity(attachments.len().saturating_add(1));
    let text = text.trim();
    if !text.is_empty() {
        input.push(json!({ "type": "text", "text": text }));
    }
    for (attachment, label) in attachments.iter().zip(labels) {
        match &attachment.content {
            AttachmentContent::Text(content) => input.push(json!({
                "type": "text",
                "text": format!(
                    "----- BEGIN ATTACHMENT: {} -----\n{}\n----- END ATTACHMENT: {} -----",
                    label, content, label
                ),
            })),
            AttachmentContent::Image(_) => input.push(json!({
                "type": "localImage",
                "path": attachment.descriptor.path,
            })),
        }
    }
    input
}

fn attachment_summary_labels(attachments: &[PreparedAttachment]) -> Vec<String> {
    let mut counts = HashMap::<&str, usize>::new();
    let reserved = attachments
        .iter()
        .map(|attachment| attachment.descriptor.name.as_str())
        .collect::<HashSet<_>>();
    for attachment in attachments {
        *counts
            .entry(attachment.descriptor.name.as_str())
            .or_default() += 1;
    }

    let mut generated = HashSet::<String>::new();
    let mut next_id = 1_usize;
    attachments
        .iter()
        .map(|attachment| {
            let name = attachment.descriptor.name.as_str();
            if counts.get(name).copied().unwrap_or_default() < 2 {
                return name.to_owned();
            }
            loop {
                let label = format!("{name} <attachment {next_id}>");
                next_id += 1;
                if !reserved.contains(label.as_str()) && generated.insert(label.clone()) {
                    break label;
                }
            }
        })
        .collect()
}

fn submitted_attachment_labels(
    attachments: &[PreparedAttachment],
    submitted_display_names: &[String],
) -> Result<Vec<String>, String> {
    if submitted_display_names.is_empty() {
        return Ok(attachment_summary_labels(attachments));
    }
    if submitted_display_names.len() != attachments.len() {
        return Err("Attachment display identities did not match the submitted files.".to_owned());
    }

    let mut seen = HashSet::new();
    for (attachment, label) in attachments.iter().zip(submitted_display_names) {
        let base = attachment.descriptor.name.as_str();
        let valid_qualified_label = label
            .strip_prefix(base)
            .and_then(|suffix| suffix.strip_prefix(" <attachment "))
            .and_then(|suffix| suffix.strip_suffix('>'))
            .is_some_and(|ordinal| {
                !ordinal.is_empty()
                    && ordinal.bytes().all(|byte| byte.is_ascii_digit())
                    && ordinal.parse::<usize>().is_ok_and(|value| value > 0)
            });
        if label.is_empty()
            || label.chars().count() > 240
            || label.chars().any(char::is_control)
            || (label != base && !valid_qualified_label)
            || !seen.insert(label.as_str())
        {
            return Err("Attachment display identities were invalid.".to_owned());
        }
    }
    Ok(submitted_display_names.to_vec())
}

pub(crate) fn prepare_turn(text: &str, paths: &[PathBuf]) -> Result<PreparedTurn, String> {
    prepare_turn_with_display_names(text, paths, &[])
}

pub(crate) fn prepare_turn_with_display_names(
    text: &str,
    paths: &[PathBuf],
    submitted_display_names: &[String],
) -> Result<PreparedTurn, String> {
    let mut prepared = prepare_attachment_paths(paths);
    if !prepared.issues.is_empty() {
        return Err(prepared
            .issues
            .iter()
            .map(|issue| format!("{}: {}", issue.name, issue.message))
            .collect::<Vec<_>>()
            .join(" "));
    }

    let has_images = prepared
        .attachments
        .iter()
        .any(|attachment| matches!(attachment.content, AttachmentContent::Image(_)));
    let attachment_snapshot = if has_images {
        let snapshot = tempfile::tempdir()
            .map_err(|_| "Could not create a private image snapshot for this turn.".to_owned())?;
        let mut image_index = 0_usize;
        for attachment in &mut prepared.attachments {
            let AttachmentContent::Image(bytes) = &mut attachment.content else {
                continue;
            };
            let extension = match attachment.descriptor.media_type.as_str() {
                "image/png" => "png",
                "image/jpeg" => "jpg",
                "image/gif" => "gif",
                "image/webp" => "webp",
                _ => return Err("Unsupported image type reached snapshot creation.".to_owned()),
            };
            let snapshot_path = snapshot
                .path()
                .join(format!("image-{image_index}.{extension}"));
            fs::write(&snapshot_path, bytes.as_slice()).map_err(|_| {
                "Could not create a private image snapshot for this turn.".to_owned()
            })?;
            attachment.descriptor.path = snapshot_path;
            bytes.clear();
            bytes.shrink_to_fit();
            image_index += 1;
        }
        Some(Arc::new(snapshot))
    } else {
        None
    };

    let attachment_labels =
        submitted_attachment_labels(&prepared.attachments, submitted_display_names)?;
    let input = build_turn_input_with_labels(text, &prepared.attachments, &attachment_labels);
    if input.is_empty() {
        return Err("Enter a message or attach at least one supported file before sending.".into());
    }
    let text = text.trim();
    let attachment_names = attachment_labels.join(", ");
    let display_text = match (text.is_empty(), attachment_names.is_empty()) {
        (false, true) => text.to_owned(),
        (false, false) => format!("{text}\n\nAttached: {attachment_names}"),
        (true, false) => format!("Attached: {attachment_names}"),
        (true, true) => unreachable!("empty input was rejected above"),
    };
    Ok(PreparedTurn {
        display_text,
        input,
        attachment_snapshot,
    })
}

fn issue(name: String, message: &str) -> AttachmentIssue {
    AttachmentIssue {
        name,
        message: message.to_owned(),
    }
}

fn safe_file_name(path: &Path) -> String {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(|name| {
            name.chars()
                .map(|character| {
                    if character.is_control() {
                        '�'
                    } else {
                        character
                    }
                })
                .collect()
        })
        .unwrap_or_else(|| "Selected file".to_owned());
    truncate_with_ellipsis(&name, MAX_ATTACHMENT_ISSUE_NAME_CHARS)
}

fn truncate_with_ellipsis(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_owned();
    }
    let mut truncated = value
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    truncated.push('…');
    truncated
}

#[derive(Clone, Copy)]
enum ImageSignature {
    Png,
    Jpeg,
    Gif,
    Webp,
}

enum SupportedType {
    Text(&'static str),
    Image(&'static str, ImageSignature),
}

fn supported_type(path: &Path) -> Option<SupportedType> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("png") => Some(SupportedType::Image("image/png", ImageSignature::Png)),
        Some("jpg" | "jpeg") => Some(SupportedType::Image("image/jpeg", ImageSignature::Jpeg)),
        Some("gif") => Some(SupportedType::Image("image/gif", ImageSignature::Gif)),
        Some("webp") => Some(SupportedType::Image("image/webp", ImageSignature::Webp)),
        Some("rs") => Some(SupportedType::Text("text/x-rust")),
        Some("ts" | "tsx") => Some(SupportedType::Text("text/typescript")),
        Some("js" | "jsx" | "mjs" | "cjs") => Some(SupportedType::Text("text/javascript")),
        Some("py") => Some(SupportedType::Text("text/x-python")),
        Some("go") => Some(SupportedType::Text("text/x-go")),
        Some("java") => Some(SupportedType::Text("text/x-java")),
        Some("kt" | "kts") => Some(SupportedType::Text("text/x-kotlin")),
        Some("swift") => Some(SupportedType::Text("text/x-swift")),
        Some("c" | "h" | "cc" | "cpp" | "cxx" | "hpp") => Some(SupportedType::Text("text/x-c")),
        Some("cs") => Some(SupportedType::Text("text/x-csharp")),
        Some("rb") => Some(SupportedType::Text("text/x-ruby")),
        Some("php") => Some(SupportedType::Text("text/x-php")),
        Some("sh" | "bash" | "zsh" | "fish") => Some(SupportedType::Text("text/x-shellscript")),
        Some("ps1") => Some(SupportedType::Text("text/x-powershell")),
        Some("bat" | "cmd") => Some(SupportedType::Text("text/x-batch")),
        Some("sql") => Some(SupportedType::Text("application/sql")),
        Some("graphql" | "gql") => Some(SupportedType::Text("application/graphql")),
        Some("json" | "jsonl") => Some(SupportedType::Text("application/json")),
        Some("yaml" | "yml") => Some(SupportedType::Text("application/yaml")),
        Some("toml") => Some(SupportedType::Text("application/toml")),
        Some("xml") => Some(SupportedType::Text("application/xml")),
        Some("html" | "htm") => Some(SupportedType::Text("text/html")),
        Some("css" | "scss" | "sass" | "less") => Some(SupportedType::Text("text/css")),
        Some("csv") => Some(SupportedType::Text("text/csv")),
        Some("tsv") => Some(SupportedType::Text("text/tab-separated-values")),
        Some("md" | "markdown") => Some(SupportedType::Text("text/markdown")),
        Some("txt" | "rst" | "log" | "ini" | "cfg" | "conf" | "env" | "proto") => {
            Some(SupportedType::Text("text/plain"))
        }
        None if known_extensionless_text_file(path) => Some(SupportedType::Text("text/plain")),
        _ => None,
    }
}

fn known_extensionless_text_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        name.as_str(),
        "dockerfile"
            | "makefile"
            | "license"
            | "readme"
            | ".gitignore"
            | ".dockerignore"
            | ".editorconfig"
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ImageValidationError {
    Invalid,
    ResourceLimit,
}

fn image_dimensions_are_safe(width: u32, height: u32) -> bool {
    width <= MAX_ATTACHMENT_IMAGE_DIMENSION
        && height <= MAX_ATTACHMENT_IMAGE_DIMENSION
        && u64::from(width).saturating_mul(u64::from(height)) <= MAX_ATTACHMENT_IMAGE_PIXELS
}

fn validate_image_decode(
    signature: ImageSignature,
    bytes: &[u8],
) -> Result<(), ImageValidationError> {
    if !signature_matches(signature, bytes) {
        return Err(ImageValidationError::Invalid);
    }
    let format = match signature {
        ImageSignature::Png => image::ImageFormat::Png,
        ImageSignature::Jpeg => image::ImageFormat::Jpeg,
        ImageSignature::Gif => image::ImageFormat::Gif,
        ImageSignature::Webp => image::ImageFormat::WebP,
    };
    let (width, height) = image::ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| ImageValidationError::Invalid)?;
    if !image_dimensions_are_safe(width, height) {
        return Err(ImageValidationError::ResourceLimit);
    }
    image::load_from_memory_with_format(bytes, format)
        .map(|_| ())
        .map_err(|_| ImageValidationError::Invalid)
}

fn signature_matches(signature: ImageSignature, bytes: &[u8]) -> bool {
    match signature {
        ImageSignature::Png => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        ImageSignature::Jpeg => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        ImageSignature::Gif => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        ImageSignature::Webp => {
            bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use std::fs;
    use tempfile::tempdir;

    fn write_file(path: &std::path::Path, size: usize, byte: u8) {
        fs::write(path, vec![byte; size]).unwrap();
    }

    #[tokio::test]
    async fn bounds_concurrent_attachment_validation_workers() {
        let first = acquire_attachment_validation_permit().await.unwrap();
        let second = acquire_attachment_validation_permit().await.unwrap();
        assert!(
            acquire_attachment_validation_permit_with_timeout(Duration::from_millis(20))
                .await
                .is_err()
        );
        drop(first);
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(100),
            acquire_attachment_validation_permit(),
        )
        .await
        .is_ok());
        drop(second);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_a_fifo_without_blocking_on_open() {
        use std::process::Command;
        use std::sync::mpsc;

        let dir = tempdir().unwrap();
        let path = dir.path().join("blocked.txt");
        let status = Command::new("mkfifo")
            .arg(&path)
            .status()
            .expect("Linux test environment must provide mkfifo");
        assert!(status.success());

        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let result = prepare_attachment_paths(&[path]);
            let _ = sender.send(result);
        });
        let result = receiver
            .recv_timeout(Duration::from_millis(500))
            .expect("FIFO validation must reject before File::open can block");

        assert!(result.attachments.is_empty());
        assert!(result
            .issues
            .iter()
            .any(|issue| issue.message.contains("regular files")));
    }

    #[test]
    fn rejects_oversized_ipc_arguments_during_deserialization() {
        let too_many_paths = vec!["a"; MAX_ATTACHMENT_CANDIDATE_COUNT + 1];
        assert!(serde_json::from_value::<AttachmentPathArgs>(json!(too_many_paths)).is_err());
        assert!(serde_json::from_value::<AttachmentPathArgs>(json!([
            "a".repeat(MAX_ATTACHMENT_CANDIDATE_PATH_BYTES + 1)
        ]))
        .is_err());
        assert!(serde_json::from_value::<AttachmentDisplayNameArgs>(json!([
            "a".repeat(MAX_ATTACHMENT_DISPLAY_NAME_BYTES + 1)
        ]))
        .is_err());
        assert!(serde_json::from_value::<AgentTextArg>(
            json!("a".repeat(MAX_AGENT_TEXT_BYTES + 1))
        )
        .is_err());
    }

    #[test]
    fn validates_supported_text_and_builds_filename_delimited_turn_input() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("example.rs");
        fs::write(&path, "fn main() {}\n").unwrap();

        let prepared = prepare_attachment_paths(std::slice::from_ref(&path));
        assert!(prepared.issues.is_empty());
        assert_eq!(prepared.attachments.len(), 1);
        let descriptor = &prepared.attachments[0].descriptor;
        assert_eq!(descriptor.name, "example.rs");
        assert_eq!(descriptor.kind, AttachmentKind::Text);
        assert_eq!(descriptor.media_type, "text/x-rust");
        assert_eq!(descriptor.size, 13);
        assert_eq!(descriptor.path, fs::canonicalize(path).unwrap());

        let input = build_turn_input("Review this", &prepared.attachments);
        assert_eq!(
            input[0],
            serde_json::json!({"type": "text", "text": "Review this"})
        );
        assert_eq!(input[1]["type"], "text");
        let attached_text = input[1]["text"].as_str().unwrap();
        assert!(attached_text.contains("BEGIN ATTACHMENT: example.rs"));
        assert!(attached_text.contains("fn main() {}"));
        assert!(attached_text.contains("END ATTACHMENT: example.rs"));
    }

    #[test]
    fn rejects_image_dimensions_that_exceed_the_decoded_pixel_budget() {
        assert!(image_dimensions_are_safe(8_000, 5_000));
        assert!(!image_dimensions_are_safe(8_001, 5_000));
        assert!(!image_dimensions_are_safe(20_000, 1));
    }

    #[test]
    fn rejects_signature_only_malformed_images_without_losing_valid_siblings() {
        let dir = tempdir().unwrap();
        let valid = dir.path().join("valid.txt");
        let malformed = dir.path().join("malformed.png");
        fs::write(&valid, "keep me").unwrap();
        fs::write(&malformed, b"\x89PNG\r\n\x1a\n\0\0\0\0").unwrap();

        let prepared = prepare_attachment_paths(&[valid, malformed]);

        assert_eq!(prepared.attachments.len(), 1);
        assert_eq!(prepared.attachments[0].descriptor.name, "valid.txt");
        assert!(prepared
            .issues
            .iter()
            .any(|issue| { issue.name == "malformed.png" && issue.message.contains("valid PNG") }));
    }

    #[test]
    fn emits_the_pinned_codex_local_image_shape_and_safe_thumbnail() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("pixel.png");
        let png = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .unwrap();
        fs::write(&path, &png).unwrap();

        let prepared = prepare_attachment_paths(std::slice::from_ref(&path));
        assert!(prepared.issues.is_empty());
        let descriptor = &prepared.attachments[0].descriptor;
        assert_eq!(descriptor.kind, AttachmentKind::Image);
        assert_eq!(descriptor.media_type, "image/png");
        assert!(descriptor
            .thumbnail_url
            .as_deref()
            .unwrap()
            .starts_with("data:image/png;base64,"));

        let input = build_turn_input("", &prepared.attachments);
        assert_eq!(
            input,
            vec![serde_json::json!({
                "type": "localImage",
                "path": fs::canonicalize(path).unwrap(),
            })]
        );
    }

    #[test]
    fn prepare_turn_snapshot_can_be_retained_by_the_active_turn_after_dispatch() {
        let dir = tempdir().unwrap();
        let original = dir.path().join("mutable.png");
        let png = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .unwrap();
        fs::write(&original, &png).unwrap();

        let turn = prepare_turn("", std::slice::from_ref(&original)).unwrap();
        let snapshot = PathBuf::from(turn.input[0]["path"].as_str().unwrap());
        assert_ne!(snapshot, fs::canonicalize(&original).unwrap());

        fs::write(&original, b"different private bytes").unwrap();
        assert_eq!(fs::read(&snapshot).unwrap(), png);

        let active_turn_snapshot = turn.attachment_snapshot();
        drop(turn);
        assert_eq!(fs::read(&snapshot).unwrap(), png);

        drop(active_turn_snapshot);
        assert!(!snapshot.exists());
    }

    #[test]
    fn canonicalizes_deduplicates_and_preserves_first_visible_order() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first.txt");
        let second = dir.path().join("second.md");
        fs::write(&first, "first").unwrap();
        fs::write(&second, "second").unwrap();

        let prepared = prepare_attachment_paths(&[second.clone(), first.clone(), second]);
        assert!(prepared.issues.is_empty());
        assert_eq!(
            prepared
                .attachments
                .iter()
                .map(|item| item.descriptor.name.as_str())
                .collect::<Vec<_>>(),
            vec!["second.md", "first.txt"]
        );
    }

    #[test]
    fn accepts_exact_count_file_and_aggregate_boundaries() {
        let dir = tempdir().unwrap();
        let mut paths = Vec::new();
        for index in 0..10 {
            let path = dir.path().join(format!("small-{index}.txt"));
            fs::write(&path, "ok").unwrap();
            paths.push(path);
        }
        let count = prepare_attachment_paths(&paths);
        assert_eq!(count.attachments.len(), MAX_ATTACHMENT_COUNT);
        assert!(count.issues.is_empty());

        let exact_file = dir.path().join("exact.txt");
        write_file(&exact_file, MAX_ATTACHMENT_FILE_BYTES as usize, b'a');
        let file = prepare_attachment_paths(&[exact_file]);
        assert_eq!(file.attachments.len(), 1);
        assert!(file.issues.is_empty());

        let twenty_a = dir.path().join("twenty-a.txt");
        let twenty_b = dir.path().join("twenty-b.txt");
        let ten = dir.path().join("ten.txt");
        write_file(&twenty_a, MAX_ATTACHMENT_FILE_BYTES as usize, b'a');
        write_file(&twenty_b, MAX_ATTACHMENT_FILE_BYTES as usize, b'b');
        write_file(
            &ten,
            (MAX_ATTACHMENT_TOTAL_BYTES - (2 * MAX_ATTACHMENT_FILE_BYTES)) as usize,
            b'c',
        );
        let aggregate = prepare_attachment_paths(&[twenty_a, twenty_b, ten]);
        assert_eq!(aggregate.attachments.len(), 3);
        assert!(aggregate.issues.is_empty());
        assert_eq!(
            aggregate
                .attachments
                .iter()
                .map(|item| item.descriptor.size)
                .sum::<u64>(),
            MAX_ATTACHMENT_TOTAL_BYTES
        );
    }

    #[test]
    fn rejects_over_count_file_and_aggregate_boundaries_without_losing_valid_files() {
        let dir = tempdir().unwrap();
        let mut count_paths = Vec::new();
        for index in 0..11 {
            let path = dir.path().join(format!("count-{index}.txt"));
            fs::write(&path, "ok").unwrap();
            count_paths.push(path);
        }
        let count = prepare_attachment_paths(&count_paths);
        assert_eq!(count.attachments.len(), MAX_ATTACHMENT_COUNT);
        assert_eq!(count.issues.len(), 1);
        assert!(count.issues[0].message.contains("10 files"));

        let valid = dir.path().join("valid.txt");
        let oversized = dir.path().join("oversized.txt");
        fs::write(&valid, "keep me").unwrap();
        write_file(
            &oversized,
            MAX_ATTACHMENT_FILE_BYTES.saturating_add(1) as usize,
            b'x',
        );
        let file = prepare_attachment_paths(&[valid, oversized]);
        assert_eq!(file.attachments.len(), 1);
        assert_eq!(file.attachments[0].descriptor.name, "valid.txt");
        assert!(file
            .issues
            .iter()
            .any(|issue| issue.message.contains("20 MiB")));

        let twenty_a = dir.path().join("aggregate-a.txt");
        let twenty_b = dir.path().join("aggregate-b.txt");
        let over_ten = dir.path().join("aggregate-over.txt");
        write_file(&twenty_a, MAX_ATTACHMENT_FILE_BYTES as usize, b'a');
        write_file(&twenty_b, MAX_ATTACHMENT_FILE_BYTES as usize, b'b');
        write_file(
            &over_ten,
            (MAX_ATTACHMENT_TOTAL_BYTES - (2 * MAX_ATTACHMENT_FILE_BYTES) + 1) as usize,
            b'c',
        );
        let aggregate = prepare_attachment_paths(&[twenty_a, twenty_b, over_ten]);
        assert_eq!(aggregate.attachments.len(), 2);
        assert!(aggregate
            .issues
            .iter()
            .any(|issue| issue.message.contains("50 MiB")));
    }

    #[test]
    fn bounds_candidate_request_and_serialized_diagnostics_before_filesystem_work() {
        let oversized_name = format!("{}.txt", "x".repeat(10_000));
        let paths = (0..MAX_ATTACHMENT_CANDIDATE_COUNT)
            .map(|index| PathBuf::from(format!("{index:02}-{oversized_name}")))
            .collect::<Vec<_>>();

        let first = prepare_attachment_paths(&paths);
        let second = prepare_attachment_paths(&paths);

        assert!(first.attachments.is_empty());
        assert_eq!(first.issues.len(), 1);
        assert_eq!(first.issues, second.issues);
        assert_eq!(first.issues[0].name, "Selected files");
        assert!(first.issues[0].message.contains("too large"));
        assert!(!first.issues[0].message.contains(&"x".repeat(100)));
        assert!(
            serde_json::to_vec(&first.validation_result())
                .unwrap()
                .len()
                <= 1024
        );
    }

    #[test]
    fn bounds_raw_candidate_work_and_diagnostics_without_losing_valid_predecessors() {
        let dir = tempdir().unwrap();
        let valid = dir.path().join("valid.txt");
        fs::write(&valid, "keep me").unwrap();

        let mut paths = vec![valid];
        for index in 0..250 {
            paths.push(dir.path().join(format!("missing-{index:03}.txt")));
        }

        let prepared = prepare_attachment_paths(&paths);

        assert_eq!(prepared.attachments.len(), 1);
        assert_eq!(prepared.attachments[0].descriptor.name, "valid.txt");
        assert!(prepared.issues.len() <= 20);
        assert_eq!(
            prepared
                .issues
                .iter()
                .filter(|issue| issue.message.contains("too many candidate files"))
                .count(),
            1
        );
        assert!(!prepared
            .issues
            .iter()
            .any(|issue| issue.name == "missing-249.txt"));
    }

    #[test]
    fn enforces_the_exact_candidate_boundary_before_filesystem_admission() {
        let dir = tempdir().unwrap();
        let first_fifty = (0..MAX_ATTACHMENT_CANDIDATE_COUNT)
            .map(|index| dir.path().join(format!("missing-{index:02}.txt")))
            .collect::<Vec<_>>();

        let exact = prepare_attachment_paths(&first_fifty);
        assert!(exact.attachments.is_empty());
        assert_eq!(exact.issues.len(), MAX_ATTACHMENT_ISSUE_COUNT);
        assert!(!exact
            .issues
            .iter()
            .any(|issue| issue.message.contains("too many candidate files")));

        let sentinel = dir.path().join("sentinel-at-51.txt");
        fs::write(&sentinel, "must not be inspected").unwrap();
        let mut over_boundary = first_fifty;
        over_boundary.push(sentinel);

        let overflow = prepare_attachment_paths(&over_boundary);
        assert!(overflow.attachments.is_empty());
        assert_eq!(overflow.issues.len(), MAX_ATTACHMENT_ISSUE_COUNT);
        assert_eq!(
            overflow
                .issues
                .iter()
                .filter(|issue| issue.message.contains("too many candidate files"))
                .count(),
            1
        );
        assert!(overflow
            .issues
            .iter()
            .all(|issue| issue.name != "sentinel-at-51.txt"));
    }

    #[test]
    fn rejects_directories_unsupported_formats_invalid_utf8_and_unreadable_paths() {
        let dir = tempdir().unwrap();
        let unsupported = dir.path().join("archive.zip");
        let invalid_utf8 = dir.path().join("invalid.txt");
        let missing = dir.path().join("missing.txt");
        fs::write(&unsupported, b"PK\x03\x04").unwrap();
        fs::write(&invalid_utf8, [0xff, 0xfe]).unwrap();

        let prepared = prepare_attachment_paths(&[
            dir.path().to_path_buf(),
            unsupported,
            invalid_utf8,
            missing,
        ]);
        assert!(prepared.attachments.is_empty());
        assert_eq!(prepared.issues.len(), 4);
        let messages = prepared
            .issues
            .iter()
            .map(|issue| issue.message.as_str())
            .collect::<Vec<_>>();
        assert!(messages
            .iter()
            .any(|message| message.contains("regular files")));
        assert!(messages
            .iter()
            .any(|message| message.contains("not supported")));
        assert!(messages.iter().any(|message| message.contains("UTF-8")));
        assert!(messages
            .iter()
            .any(|message| message.contains("could not be read")));
        assert!(prepared.issues.iter().all(|issue| !issue
            .message
            .contains(dir.path().to_string_lossy().as_ref())));
    }

    #[test]
    fn accepts_attachment_only_turns_and_keeps_transcript_text_display_safe() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("notes.txt");
        fs::write(&path, "synthetic attachment body").unwrap();

        let turn = prepare_turn("   ", &[path]).unwrap();
        assert_eq!(turn.display_text, "Attached: notes.txt");
        assert_eq!(turn.input.len(), 1);
        assert_eq!(turn.input[0]["type"], "text");
        assert!(turn.input[0]["text"]
            .as_str()
            .unwrap()
            .contains("synthetic attachment body"));
    }

    #[test]
    fn disambiguates_duplicate_basenames_in_authoritative_display_text() {
        let dir = tempdir().unwrap();
        let alpha = dir.path().join("alpha");
        let beta = dir.path().join("beta");
        fs::create_dir_all(&alpha).unwrap();
        fs::create_dir_all(&beta).unwrap();
        let first = alpha.join("index.ts");
        let second = beta.join("index.ts");
        fs::write(&first, "first").unwrap();
        fs::write(&second, "second").unwrap();

        let turn = prepare_turn("", &[first, second]).unwrap();

        assert_eq!(
            turn.display_text,
            "Attached: index.ts <attachment 1>, index.ts <attachment 2>"
        );
        assert!(turn.input[0]["text"]
            .as_str()
            .unwrap()
            .contains("BEGIN ATTACHMENT: index.ts <attachment 1>"));
        assert!(turn.input[1]["text"]
            .as_str()
            .unwrap()
            .contains("BEGIN ATTACHMENT: index.ts <attachment 2>"));
    }

    #[test]
    fn preserves_submitted_display_identity_in_authoritative_display_text() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("index.ts");
        fs::write(&path, "survivor").unwrap();

        let turn =
            prepare_turn_with_display_names("", &[path], &["index.ts <attachment 2>".to_owned()])
                .unwrap();

        assert_eq!(turn.display_text, "Attached: index.ts <attachment 2>");
    }

    #[test]
    fn rejects_submitted_display_identity_that_is_not_derived_from_the_file_name() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("secret.txt");
        fs::write(&path, "sensitive").unwrap();

        let error =
            prepare_turn_with_display_names("", &[path], &["harmless.txt".to_owned()]).unwrap_err();

        assert!(error.contains("display identities"));
    }

    #[test]
    fn rejects_empty_or_invalidated_turns_before_native_acceptance() {
        let empty = prepare_turn("  ", &[]).unwrap_err();
        assert!(empty.contains("message or attach"));

        let dir = tempdir().unwrap();
        let missing = dir.path().join("gone.txt");
        let invalid = prepare_turn("Keep this draft", &[missing]).unwrap_err();
        assert!(invalid.contains("gone.txt"));
        assert!(invalid.contains("could not be read"));
        assert!(!invalid.contains(dir.path().to_string_lossy().as_ref()));
    }
}
