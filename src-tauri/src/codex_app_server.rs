//! Supervised JSONL transport for the official Codex app-server.
//!
//! The transport deliberately keeps protocol payloads as [`serde_json::Value`].
//! Codex app-server evolves independently from Portcode, and forwarding raw
//! notifications/requests prevents a newly-added activity type from being lost
//! merely because this client has not generated fresh Rust protocol types yet.

use std::{
    collections::{HashMap, HashSet},
    env,
    ffi::OsString,
    fmt, fs,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Weak,
    },
    time::Duration,
};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::ChildStdin,
    sync::{broadcast, oneshot, watch, Mutex},
};

use crate::process_env::hidden_command;

/// Portcode's currently tested Codex CLI/app-server protocol release.
pub const PINNED_CODEX_CLI_VERSION: CodexCliVersion = CodexCliVersion::new(0, 145, 0);

/// Exclusive upper bound for the currently supported experimental protocol.
///
/// App-server is still experimental in the 0.x CLI line, so a new minor may
/// contain breaking wire changes. Patch releases in the tested minor are
/// accepted, but a newer minor must be reviewed before this bound is raised.
pub const MAX_CODEX_CLI_VERSION_EXCLUSIVE: CodexCliVersion = CodexCliVersion::new(0, 146, 0);

const PORTCODE_CODEX_PATH_ENV: &str = "PORTCODE_CODEX_PATH";
const CODEX_INSTALL_DIR_ENV: &str = "CODEX_INSTALL_DIR";
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_BROADCAST_CAPACITY: usize = 1_024;
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub type Result<T> = std::result::Result<T, CodexAppServerError>;

/// A parsed `codex-cli` semantic version.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCliVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl CodexCliVersion {
    pub const fn new(major: u64, minor: u64, patch: u64) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }
}

impl fmt::Display for CodexCliVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// Parse output such as `codex-cli 0.145.0` without adding a semver dependency.
pub fn parse_codex_cli_version(output: &str) -> Result<CodexCliVersion> {
    output
        .split_whitespace()
        .find_map(parse_version_token)
        .ok_or_else(|| {
            CodexAppServerError::VersionProbe(
                "Codex returned an unrecognized version string".to_owned(),
            )
        })
}

fn parse_version_token(token: &str) -> Option<CodexCliVersion> {
    let token = token
        .trim_matches(|character: char| matches!(character, ',' | ';' | '(' | ')' | '[' | ']'));
    let token = token.strip_prefix('v').unwrap_or(token);
    let core = token.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(CodexCliVersion::new(major, minor, patch))
}

/// Enforce the app-server protocol range that this client was tested against.
pub fn validate_codex_cli_version(version: CodexCliVersion) -> Result<()> {
    if version < PINNED_CODEX_CLI_VERSION || version >= MAX_CODEX_CLI_VERSION_EXCLUSIVE {
        return Err(CodexAppServerError::UnsupportedVersion {
            found: version,
            minimum: PINNED_CODEX_CLI_VERSION,
            maximum_exclusive: MAX_CODEX_CLI_VERSION_EXCLUSIVE,
        });
    }
    Ok(())
}

#[derive(Clone, Debug, thiserror::Error)]
pub enum CodexAppServerError {
    #[error("no compatible Codex CLI was found ({0})")]
    Discovery(String),
    #[error("failed to inspect the Codex CLI version: {0}")]
    VersionProbe(String),
    #[error("Codex CLI {found} is unsupported; expected >= {minimum} and < {maximum_exclusive}")]
    UnsupportedVersion {
        found: CodexCliVersion,
        minimum: CodexCliVersion,
        maximum_exclusive: CodexCliVersion,
    },
    #[error("failed to start Codex app-server: {0}")]
    Spawn(String),
    #[error("Codex app-server I/O failed: {0}")]
    Io(String),
    #[error("Codex app-server protocol failed: {0}")]
    Protocol(String),
    #[error("Codex app-server request failed ({code}): {message}")]
    Rpc {
        code: i64,
        message: String,
        data: Option<Value>,
    },
    #[error("Codex app-server stopped: {0}")]
    Exited(String),
    #[error("Codex app-server timed out during {operation}")]
    Timeout { operation: &'static str },
    #[error("Codex app-server request channel closed")]
    RequestChannelClosed,
    #[error("the Codex server request belongs to an expired process generation")]
    StaleServerRequest,
    #[error("Codex app-server request identifiers are exhausted")]
    RequestIdExhausted,
}

impl CodexAppServerError {
    fn invalidates_connection(&self) -> bool {
        !matches!(self, Self::Rpc { .. } | Self::StaleServerRequest)
    }
}

/// Where a discovered Codex executable came from.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexCliSource {
    /// Explicit test/development override. When present, it is authoritative.
    PortcodeOverride,
    /// Executable shipped in the application's Tauri resource package.
    BundledResource,
    /// Executable installed by OpenAI's official standalone installer.
    OfficialStandalone,
    /// `codex` resolved by the operating system's `PATH` search.
    Path,
}

impl fmt::Display for CodexCliSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let label = match self {
            Self::PortcodeOverride => "PORTCODE_CODEX_PATH",
            Self::BundledResource => "bundled resource",
            Self::OfficialStandalone => "official standalone install",
            Self::Path => "PATH",
        };
        formatter.write_str(label)
    }
}

/// How the selected OpenAI executable is launched.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexExecutableKind {
    /// `codex-app-server-package-<target>` entrypoint. It is already the server.
    DedicatedAppServer,
    /// Standalone `codex` CLI. It must receive the `app-server` subcommand.
    FullCli,
}

/// A discovery candidate. Candidates are ordered by precedence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexExecutableCandidate {
    pub path: PathBuf,
    pub source: CodexCliSource,
    pub kind: CodexExecutableKind,
    pub package_root: Option<PathBuf>,
    /// Trusted package metadata for a dedicated bundled entrypoint.
    pub declared_version: Option<CodexCliVersion>,
}

/// The executable selected after a successful version probe.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedCodexExecutable {
    pub path: PathBuf,
    pub source: CodexCliSource,
    pub kind: CodexExecutableKind,
    pub package_root: Option<PathBuf>,
    pub version: CodexCliVersion,
}

/// Options for the supervised app-server process.
#[derive(Clone, Debug)]
pub struct CodexAppServerOptions {
    /// Tauri's resolved resource directory. Bundled CLI candidates beneath this
    /// directory are tried before machine-wide standalone installations.
    pub resource_dir: Option<PathBuf>,
    pub request_timeout: Duration,
    pub startup_timeout: Duration,
    pub version_probe_timeout: Duration,
    /// Maximum time to wait for the supervised child to acknowledge termination.
    /// App exit and updater relaunch must never hang on a stuck child process.
    pub shutdown_timeout: Duration,
    pub broadcast_capacity: usize,
    pub client_name: String,
    pub client_title: String,
    pub client_version: String,
}

impl Default for CodexAppServerOptions {
    fn default() -> Self {
        Self {
            resource_dir: None,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            startup_timeout: DEFAULT_STARTUP_TIMEOUT,
            version_probe_timeout: DEFAULT_VERSION_PROBE_TIMEOUT,
            shutdown_timeout: DEFAULT_SHUTDOWN_TIMEOUT,
            broadcast_capacity: DEFAULT_BROADCAST_CAPACITY,
            client_name: "portcode".to_owned(),
            client_title: "Portcode".to_owned(),
            client_version: env!("CARGO_PKG_VERSION").to_owned(),
        }
    }
}

/// Every server-to-client protocol message, preserved as raw JSON values.
#[derive(Clone, Debug, PartialEq)]
pub enum Incoming {
    Notification {
        generation: u64,
        method: String,
        params: Value,
        /// Complete original frame, including fields unknown to this client.
        raw: Value,
    },
    ServerRequest {
        generation: u64,
        /// The exact JSON request id must be echoed in the response.
        id: Value,
        method: String,
        params: Value,
        /// Complete original frame, including fields unknown to this client.
        raw: Value,
    },
    /// Local supervisor lifecycle signal. This is not an app-server protocol
    /// frame; consumers use the generation to retire only work owned by the
    /// process that actually stopped.
    TransportClosed { generation: u64, reason: String },
}

/// Non-mutating runtime status. Calling [`CodexAppServer::status`] never starts
/// the CLI; the first request or version query does that lazily.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerStatus {
    pub running: bool,
    pub generation: Option<u64>,
    pub executable: Option<PathBuf>,
    pub source: Option<CodexCliSource>,
    pub executable_kind: Option<CodexExecutableKind>,
    pub package_root: Option<PathBuf>,
    pub version: Option<CodexCliVersion>,
}

/// Cloneable supervisor and JSONL request client for one Codex app-server.
#[derive(Clone)]
pub struct CodexAppServer {
    inner: Arc<Inner>,
}

struct Inner {
    options: CodexAppServerOptions,
    state: Mutex<RuntimeState>,
    pending: Mutex<HashMap<u64, PendingRequest>>,
    incoming: broadcast::Sender<Incoming>,
    closed: AtomicBool,
    shutdown_signal: watch::Sender<bool>,
    next_request_id: AtomicU64,
    next_generation: AtomicU64,
}

#[derive(Default)]
struct RuntimeState {
    running: Option<RunningState>,
}

struct RunningState {
    connection: Connection,
    shutdown: Option<oneshot::Sender<Option<oneshot::Sender<()>>>>,
}

#[derive(Clone)]
struct Connection {
    generation: u64,
    stdin: Arc<Mutex<ChildStdin>>,
    executable: ResolvedCodexExecutable,
}

struct PendingRequest {
    generation: u64,
    responder: oneshot::Sender<Result<Value>>,
}

impl CodexAppServer {
    pub fn new(options: CodexAppServerOptions) -> Self {
        let capacity = options.broadcast_capacity.max(1);
        let (incoming, _) = broadcast::channel(capacity);
        let (shutdown_signal, _) = watch::channel(false);
        Self {
            inner: Arc::new(Inner {
                options,
                state: Mutex::new(RuntimeState::default()),
                pending: Mutex::new(HashMap::new()),
                incoming,
                closed: AtomicBool::new(false),
                shutdown_signal,
                next_request_id: AtomicU64::new(1),
                next_generation: AtomicU64::new(1),
            }),
        }
    }

    /// Subscribe before starting a turn so no notification is missed.
    pub fn subscribe(&self) -> broadcast::Receiver<Incoming> {
        self.inner.incoming.subscribe()
    }

    /// Return current state without spawning or probing anything.
    pub async fn status(&self) -> CodexAppServerStatus {
        let state = self.inner.state.lock().await;
        let Some(running) = state.running.as_ref() else {
            return CodexAppServerStatus {
                running: false,
                generation: None,
                executable: None,
                source: None,
                executable_kind: None,
                package_root: None,
                version: None,
            };
        };
        CodexAppServerStatus {
            running: true,
            generation: Some(running.connection.generation),
            executable: Some(running.connection.executable.path.clone()),
            source: Some(running.connection.executable.source),
            executable_kind: Some(running.connection.executable.kind),
            package_root: running.connection.executable.package_root.clone(),
            version: Some(running.connection.executable.version),
        }
    }

    /// Lazily start and initialize app-server, then return its validated version.
    pub async fn version(&self) -> Result<CodexCliVersion> {
        Ok(self.ensure_running().await?.executable.version)
    }

    /// Send a client request using the default bounded response timeout.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.request_with_timeout(method, params, self.inner.options.request_timeout)
            .await
    }

    /// Send a client request with an explicit timeout.
    pub async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        if method.trim().is_empty() {
            return Err(CodexAppServerError::Protocol(
                "request method cannot be empty".to_owned(),
            ));
        }
        let connection = self.ensure_running().await?;
        let response = tokio::time::timeout(
            timeout,
            self.inner.send_request_on(&connection, method, params),
        )
        .await;

        let result = match response {
            Ok(result) => result,
            Err(_) => Err(CodexAppServerError::Timeout {
                operation: "request",
            }),
        };
        if let Err(error) = &result {
            if error.invalidates_connection() {
                self.inner
                    .connection_lost(connection.generation, error.clone())
                    .await;
            }
        }
        result
    }

    /// Reply to a server-initiated request with its exact JSON id.
    pub async fn send_response_result(
        &self,
        generation: u64,
        id: Value,
        result: Value,
    ) -> Result<()> {
        self.send_server_response(generation, json!({ "id": id, "result": result }))
            .await
    }

    /// Reply to a server-initiated request with a JSON-RPC error object.
    pub async fn send_response_error(
        &self,
        generation: u64,
        id: Value,
        code: i64,
        message: impl Into<String>,
        data: Option<Value>,
    ) -> Result<()> {
        let mut error = Map::new();
        error.insert("code".to_owned(), Value::from(code));
        error.insert("message".to_owned(), Value::String(message.into()));
        if let Some(data) = data {
            error.insert("data".to_owned(), data);
        }
        self.send_server_response(
            generation,
            json!({ "id": id, "error": Value::Object(error) }),
        )
        .await
    }

    /// Convenience wrapper for `account/read`.
    pub async fn account_read(&self, refresh_token: bool) -> Result<Value> {
        self.request("account/read", json!({ "refreshToken": refresh_token }))
            .await
    }

    /// Convenience wrapper for one page of `model/list`.
    pub async fn model_list(
        &self,
        cursor: Option<&str>,
        limit: Option<u32>,
        include_hidden: Option<bool>,
    ) -> Result<Value> {
        let mut params = Map::new();
        if let Some(cursor) = cursor {
            params.insert("cursor".to_owned(), Value::String(cursor.to_owned()));
        }
        if let Some(limit) = limit {
            params.insert("limit".to_owned(), Value::from(limit));
        }
        if let Some(include_hidden) = include_hidden {
            params.insert("includeHidden".to_owned(), Value::Bool(include_hidden));
        }
        self.request("model/list", Value::Object(params)).await
    }

    /// Permanently close this supervisor, stop the current generation, and reject
    /// outstanding and future requests. A new engine must construct a new server.
    pub async fn shutdown(&self) {
        self.inner.closed.store(true, Ordering::Release);
        self.inner.shutdown_signal.send_replace(true);
        let running = self.inner.state.lock().await.running.take();
        if let Some(mut running) = running {
            self.inner
                .fail_pending_generation(
                    running.connection.generation,
                    CodexAppServerError::Exited("client shutdown".to_owned()),
                )
                .await;
            if let Some(shutdown) = running.shutdown.take() {
                let _ = request_child_shutdown(shutdown, self.inner.options.shutdown_timeout).await;
            }
        }
    }

    async fn send_server_response(&self, generation: u64, response: Value) -> Result<()> {
        let connection = {
            let state = self.inner.state.lock().await;
            let Some(running) = state.running.as_ref() else {
                return Err(CodexAppServerError::StaleServerRequest);
            };
            if running.connection.generation != generation {
                return Err(CodexAppServerError::StaleServerRequest);
            }
            running.connection.clone()
        };

        let result = tokio::time::timeout(
            self.inner.options.request_timeout,
            write_json_line(&connection.stdin, &response),
        )
        .await
        .map_err(|_| CodexAppServerError::Timeout {
            operation: "server-request response",
        })?;
        if let Err(error) = &result {
            self.inner
                .connection_lost(connection.generation, error.clone())
                .await;
        }
        result
    }

    async fn ensure_running(&self) -> Result<Connection> {
        let mut shutdown_signal = self.inner.shutdown_signal.subscribe();
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(CodexAppServerError::Exited("client shutdown".to_owned()));
        }
        // Holding this Tokio mutex across initialization serializes concurrent
        // first-use calls. Reader/waiter tasks use separate locks to resolve the
        // initialize response, so the handshake cannot deadlock.
        let mut state = self.inner.state.lock().await;
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(CodexAppServerError::Exited("client shutdown".to_owned()));
        }
        if let Some(running) = state.running.as_ref() {
            return Ok(running.connection.clone());
        }

        let executable = tokio::select! {
            changed = shutdown_signal.changed() => match changed {
                Ok(()) => Err(CodexAppServerError::Exited("client shutdown".to_owned())),
                Err(_) => Err(CodexAppServerError::Exited("shutdown signal closed".to_owned())),
            },
            resolved = resolve_codex_executable(
                self.inner.options.resource_dir.as_deref(),
                self.inner.options.version_probe_timeout,
            ) => resolved,
        }?;
        let generation = next_monotonic(&self.inner.next_generation)?;
        let spawned = spawn_app_server(executable, generation)?;
        let connection = spawned.connection.clone();

        self.inner.start_io_tasks(
            generation,
            spawned.child,
            spawned.stdout,
            spawned.stderr,
            spawned.shutdown_rx,
        );
        state.running = Some(RunningState {
            connection: connection.clone(),
            shutdown: Some(spawned.shutdown_tx),
        });

        let initialize = tokio::select! {
            changed = shutdown_signal.changed() => match changed {
                Ok(()) => Err(CodexAppServerError::Exited("client shutdown".to_owned())),
                Err(_) => Err(CodexAppServerError::Exited("shutdown signal closed".to_owned())),
            },
            result = tokio::time::timeout(
                self.inner.options.startup_timeout,
                self.inner.send_request_on(
                    &connection,
                    "initialize",
                    initialize_params(&self.inner.options),
                ),
            ) => result
                .map_err(|_| CodexAppServerError::Timeout { operation: "initialize" })
                .and_then(|result| result),
        };

        let initialized_frame = json!({ "method": "initialized" });
        let startup = match initialize {
            Ok(_) => tokio::select! {
                changed = shutdown_signal.changed() => match changed {
                    Ok(()) => Err(CodexAppServerError::Exited("client shutdown".to_owned())),
                    Err(_) => Err(CodexAppServerError::Exited("shutdown signal closed".to_owned())),
                },
                result = tokio::time::timeout(
                    self.inner.options.startup_timeout,
                    write_json_line(&connection.stdin, &initialized_frame),
                ) => result
                    .map_err(|_| CodexAppServerError::Timeout {
                        operation: "initialized notification",
                    })
                    .and_then(|result| result),
            },
            Err(error) => Err(error),
        };

        if let Err(error) = startup {
            let mut running = state.running.take();
            drop(state);
            self.inner
                .fail_pending_generation(generation, error.clone())
                .await;
            if let Some(shutdown) = running.as_mut().and_then(|running| running.shutdown.take()) {
                let _ = request_child_shutdown(shutdown, self.inner.options.shutdown_timeout).await;
            }
            return Err(error);
        }

        Ok(connection)
    }
}

impl Inner {
    async fn send_request_on(
        &self,
        connection: &Connection,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        let id = next_monotonic(&self.next_request_id)?;
        let (responder, response) = oneshot::channel();
        self.pending.lock().await.insert(
            id,
            PendingRequest {
                generation: connection.generation,
                responder,
            },
        );

        // Close can race between ensure_running and pending insertion. Checking after
        // insertion covers both orderings: shutdown either fails this pending entry,
        // or this branch removes it before any transport write.
        if self.closed.load(Ordering::Acquire) {
            self.pending.lock().await.remove(&id);
            return Err(CodexAppServerError::Exited("client shutdown".to_owned()));
        }

        let frame = json!({ "method": method, "id": id, "params": params });
        if let Err(error) = write_json_line(&connection.stdin, &frame).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }

        response
            .await
            .map_err(|_| CodexAppServerError::RequestChannelClosed)?
    }

    fn start_io_tasks(
        self: &Arc<Self>,
        generation: u64,
        mut child: tokio::process::Child,
        stdout: tokio::process::ChildStdout,
        stderr: tokio::process::ChildStderr,
        mut shutdown: oneshot::Receiver<Option<oneshot::Sender<()>>>,
    ) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            read_stdout(weak, generation, stdout).await;
        });

        // Stderr is deliberately isolated from the JSONL protocol and drained
        // without logging or retaining it: diagnostics can contain prompts,
        // paths, environment values, or upstream error bodies.
        tokio::spawn(async move {
            drain_stderr(stderr).await;
        });

        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let reason = tokio::select! {
                status = child.wait() => match status {
                    Ok(status) => format_exit_status(status),
                    Err(_) => "could not read exit status".to_owned(),
                },
                completion = &mut shutdown => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    if let Ok(Some(completion)) = completion {
                        let _ = completion.send(());
                    }
                    "stopped by client".to_owned()
                }
            };
            if let Some(inner) = weak.upgrade() {
                inner
                    .connection_lost(generation, CodexAppServerError::Exited(reason))
                    .await;
            }
        });
    }

    async fn handle_frame(&self, generation: u64, frame: ParsedFrame) {
        match frame {
            ParsedFrame::Response { id, result } => {
                let pending = self.pending.lock().await.remove(&id);
                if let Some(pending) = pending {
                    if pending.generation == generation {
                        let _ = pending.responder.send(result);
                    } else {
                        // This can only be a stale frame from a terminated
                        // generation. Restore the live request if one ever
                        // shares the id (ids are monotonic, so normally none).
                        self.pending.lock().await.insert(id, pending);
                    }
                }
            }
            ParsedFrame::Incoming(incoming) => {
                let incoming = incoming.with_generation(generation);
                let _ = self.incoming.send(incoming);
            }
        }
    }

    async fn connection_lost(&self, generation: u64, error: CodexAppServerError) {
        let shutdown = {
            let mut state = self.state.lock().await;
            let Some(running) = state.running.as_ref() else {
                return;
            };
            if running.connection.generation != generation {
                return;
            }
            state
                .running
                .take()
                .and_then(|mut running| running.shutdown.take())
        };
        let closed = transport_closed_event(generation, &error);
        self.fail_pending_generation(generation, error).await;
        if let Some(shutdown) = shutdown {
            let _ = shutdown.send(None);
        }
        let _ = self.incoming.send(closed);
    }

    async fn fail_pending_generation(&self, generation: u64, error: CodexAppServerError) {
        let responders = {
            let mut pending = self.pending.lock().await;
            let ids = pending
                .iter()
                .filter_map(|(id, request)| (request.generation == generation).then_some(*id))
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| pending.remove(&id).map(|request| request.responder))
                .collect::<Vec<_>>()
        };
        for responder in responders {
            let _ = responder.send(Err(error.clone()));
        }
    }
}

fn transport_closed_event(generation: u64, error: &CodexAppServerError) -> Incoming {
    Incoming::TransportClosed {
        generation,
        reason: error.to_string(),
    }
}

fn initialize_params(options: &CodexAppServerOptions) -> Value {
    json!({
        "clientInfo": {
            "name": options.client_name,
            "title": options.client_title,
            "version": options.client_version,
        },
        "capabilities": {
            "experimentalApi": true,
        },
    })
}

fn next_monotonic(counter: &AtomicU64) -> Result<u64> {
    let id = counter
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            if current == u64::MAX {
                None
            } else {
                Some(current + 1)
            }
        })
        .map_err(|_| CodexAppServerError::RequestIdExhausted)?;
    Ok(id)
}

struct SpawnedAppServer {
    connection: Connection,
    shutdown_tx: oneshot::Sender<Option<oneshot::Sender<()>>>,
    shutdown_rx: oneshot::Receiver<Option<oneshot::Sender<()>>>,
    child: tokio::process::Child,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
}

/// Ask the child-owner task to kill and reap the process, then wait only for the
/// configured bound. Returning `false` means the task disappeared or the bound
/// elapsed; callers may continue app exit/relaunch rather than hanging forever.
async fn request_child_shutdown(
    shutdown: oneshot::Sender<Option<oneshot::Sender<()>>>,
    timeout: Duration,
) -> bool {
    let (complete, completed) = oneshot::channel();
    if shutdown.send(Some(complete)).is_err() {
        return false;
    }
    tokio::time::timeout(timeout, completed)
        .await
        .is_ok_and(|result| result.is_ok())
}

fn spawn_app_server(
    executable: ResolvedCodexExecutable,
    generation: u64,
) -> Result<SpawnedAppServer> {
    let mut command = hidden_command(&executable.path);
    command.args(app_server_arguments(executable.kind));
    if let Some(package_root) = executable.package_root.as_ref() {
        command.current_dir(package_root);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| CodexAppServerError::Spawn("process launch failed".to_owned()))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| CodexAppServerError::Spawn("stdin pipe was unavailable".to_owned()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CodexAppServerError::Spawn("stdout pipe was unavailable".to_owned()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| CodexAppServerError::Spawn("stderr pipe was unavailable".to_owned()))?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    Ok(SpawnedAppServer {
        connection: Connection {
            generation,
            stdin: Arc::new(Mutex::new(stdin)),
            executable,
        },
        shutdown_tx,
        shutdown_rx,
        child,
        stdout,
        stderr,
    })
}

fn app_server_arguments(kind: CodexExecutableKind) -> &'static [&'static str] {
    match kind {
        CodexExecutableKind::DedicatedAppServer => &[],
        CodexExecutableKind::FullCli => &["app-server"],
    }
}

async fn write_json_line(stdin: &Mutex<ChildStdin>, value: &Value) -> Result<()> {
    let encoded = encode_json_line(value)?;
    let mut stdin = stdin.lock().await;
    stdin
        .write_all(&encoded)
        .await
        .map_err(|_| CodexAppServerError::Io("could not write protocol frame".to_owned()))?;
    stdin
        .flush()
        .await
        .map_err(|_| CodexAppServerError::Io("could not flush protocol frame".to_owned()))
}

fn encode_json_line(value: &Value) -> Result<Vec<u8>> {
    let mut encoded = serde_json::to_vec(value)
        .map_err(|_| CodexAppServerError::Protocol("could not encode JSON frame".to_owned()))?;
    encoded.push(b'\n');
    Ok(encoded)
}

async fn read_stdout(inner: Weak<Inner>, generation: u64, stdout: tokio::process::ChildStdout) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = match reader.read_until(b'\n', &mut line).await {
            Ok(read) => read,
            Err(_) => {
                if let Some(inner) = inner.upgrade() {
                    inner
                        .connection_lost(
                            generation,
                            CodexAppServerError::Io("could not read a protocol frame".to_owned()),
                        )
                        .await;
                }
                return;
            }
        };
        if read == 0 {
            if let Some(inner) = inner.upgrade() {
                inner
                    .connection_lost(
                        generation,
                        CodexAppServerError::Exited("stdout closed".to_owned()),
                    )
                    .await;
            }
            return;
        }
        if line.len() > MAX_FRAME_BYTES {
            if let Some(inner) = inner.upgrade() {
                inner
                    .connection_lost(
                        generation,
                        CodexAppServerError::Protocol("protocol frame exceeded limit".to_owned()),
                    )
                    .await;
            }
            return;
        }
        while matches!(line.last(), Some(b'\n' | b'\r')) {
            line.pop();
        }
        if line.is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_slice(&line) {
            Ok(value) => value,
            Err(_) => {
                if let Some(inner) = inner.upgrade() {
                    inner
                        .connection_lost(
                            generation,
                            CodexAppServerError::Protocol("received malformed JSON".to_owned()),
                        )
                        .await;
                }
                return;
            }
        };
        let frame = match classify_frame(value) {
            Ok(frame) => frame,
            Err(error) => {
                if let Some(inner) = inner.upgrade() {
                    inner.connection_lost(generation, error).await;
                }
                return;
            }
        };
        let Some(inner) = inner.upgrade() else {
            return;
        };
        inner.handle_frame(generation, frame).await;
    }
}

async fn drain_stderr(mut stderr: tokio::process::ChildStderr) {
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

fn format_exit_status(status: std::process::ExitStatus) -> String {
    status.code().map_or_else(
        || "terminated by signal".to_owned(),
        |code| format!("exit code {code}"),
    )
}

enum ParsedFrame {
    Response { id: u64, result: Result<Value> },
    Incoming(UnscopedIncoming),
}

enum UnscopedIncoming {
    Notification {
        method: String,
        params: Value,
        raw: Value,
    },
    ServerRequest {
        id: Value,
        method: String,
        params: Value,
        raw: Value,
    },
}

impl UnscopedIncoming {
    fn with_generation(self, generation: u64) -> Incoming {
        match self {
            Self::Notification {
                method,
                params,
                raw,
            } => Incoming::Notification {
                generation,
                method,
                params,
                raw,
            },
            Self::ServerRequest {
                id,
                method,
                params,
                raw,
            } => Incoming::ServerRequest {
                generation,
                id,
                method,
                params,
                raw,
            },
        }
    }
}

fn classify_frame(value: Value) -> Result<ParsedFrame> {
    let object = value.as_object().ok_or_else(|| {
        CodexAppServerError::Protocol("protocol frame was not an object".to_owned())
    })?;

    if let Some(method) = object.get("method") {
        let method = method.as_str().ok_or_else(|| {
            CodexAppServerError::Protocol("protocol method was not a string".to_owned())
        })?;
        let params = object.get("params").cloned().unwrap_or(Value::Null);
        return if let Some(id) = object.get("id") {
            Ok(ParsedFrame::Incoming(UnscopedIncoming::ServerRequest {
                id: id.clone(),
                method: method.to_owned(),
                params,
                raw: value,
            }))
        } else {
            Ok(ParsedFrame::Incoming(UnscopedIncoming::Notification {
                method: method.to_owned(),
                params,
                raw: value,
            }))
        };
    }

    let id = object.get("id").and_then(Value::as_u64).ok_or_else(|| {
        CodexAppServerError::Protocol(
            "response frame did not contain a numeric request id".to_owned(),
        )
    })?;
    let result = if let Some(error) = object.get("error") {
        Err(parse_rpc_error(error))
    } else {
        Ok(object.get("result").cloned().unwrap_or(Value::Null))
    };
    Ok(ParsedFrame::Response { id, result })
}

fn parse_rpc_error(value: &Value) -> CodexAppServerError {
    let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("unknown app-server error")
        .to_owned();
    let data = value.get("data").cloned();
    CodexAppServerError::Rpc {
        code,
        message,
        data,
    }
}

/// Return executable candidates in the same precedence order used by startup.
///
/// `PORTCODE_CODEX_PATH` is an authoritative development override. Otherwise,
/// an official dedicated app-server package under `codex-runtime/` comes first,
/// followed by OpenAI's standalone full CLI install and finally `PATH`.
pub fn codex_executable_candidates(resource_dir: Option<&Path>) -> Vec<CodexExecutableCandidate> {
    codex_executable_candidates_from(resource_dir, &DiscoveryEnvironment::capture())
}

#[derive(Default)]
struct DiscoveryEnvironment {
    portcode_override: Option<OsString>,
    codex_install_dir: Option<OsString>,
    #[cfg(windows)]
    local_app_data: Option<OsString>,
    #[cfg(not(windows))]
    home: Option<OsString>,
}

impl DiscoveryEnvironment {
    fn capture() -> Self {
        Self {
            portcode_override: env::var_os(PORTCODE_CODEX_PATH_ENV),
            codex_install_dir: env::var_os(CODEX_INSTALL_DIR_ENV),
            #[cfg(windows)]
            local_app_data: env::var_os("LOCALAPPDATA"),
            #[cfg(not(windows))]
            home: env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")),
        }
    }
}

fn codex_executable_candidates_from(
    resource_dir: Option<&Path>,
    environment: &DiscoveryEnvironment,
) -> Vec<CodexExecutableCandidate> {
    if let Some(path) = environment.portcode_override.as_ref() {
        return vec![CodexExecutableCandidate {
            path: PathBuf::from(path),
            source: CodexCliSource::PortcodeOverride,
            kind: CodexExecutableKind::FullCli,
            package_root: None,
            declared_version: None,
        }];
    }

    let cli_executable = codex_cli_executable_name();
    let mut candidates = Vec::new();
    if let Some(resource_dir) = resource_dir {
        add_bundled_package_candidates(&mut candidates, resource_dir);
    }

    if let Some(install_dir) = environment.codex_install_dir.as_ref() {
        let install_dir = PathBuf::from(install_dir);
        push_full_cli_candidate(
            &mut candidates,
            install_dir.join(cli_executable),
            CodexCliSource::OfficialStandalone,
        );
        push_full_cli_candidate(
            &mut candidates,
            install_dir.join("bin").join(cli_executable),
            CodexCliSource::OfficialStandalone,
        );
    }

    #[cfg(windows)]
    if let Some(local_app_data) = environment.local_app_data.as_ref() {
        push_full_cli_candidate(
            &mut candidates,
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("OpenAI")
                .join("Codex")
                .join("bin")
                .join(cli_executable),
            CodexCliSource::OfficialStandalone,
        );
    }

    #[cfg(not(windows))]
    if let Some(home) = environment.home.as_ref() {
        push_full_cli_candidate(
            &mut candidates,
            PathBuf::from(home)
                .join(".local")
                .join("bin")
                .join(cli_executable),
            CodexCliSource::OfficialStandalone,
        );
    }

    #[cfg(not(windows))]
    for directory in ["/usr/local/bin", "/opt/homebrew/bin"] {
        push_full_cli_candidate(
            &mut candidates,
            PathBuf::from(directory).join(cli_executable),
            CodexCliSource::OfficialStandalone,
        );
    }

    push_full_cli_candidate(
        &mut candidates,
        PathBuf::from(cli_executable),
        CodexCliSource::Path,
    );
    deduplicate_candidates(candidates)
}

fn add_bundled_package_candidates(
    candidates: &mut Vec<CodexExecutableCandidate>,
    resource_dir: &Path,
) {
    let runtime = resource_dir.join("codex-runtime");
    let target_runtime = runtime.join(platform_target_triple());

    // The package manifest is authoritative for both the release version and
    // its relative entrypoint. Production preserves the canonical package root
    // directly at `codex-runtime`; the target subdirectory is only a dev-tree
    // compatibility fallback.
    for package_root in [&runtime, &target_runtime] {
        if let Some(candidate) = read_package_candidate(package_root) {
            candidates.push(candidate);
        }
    }

    // Canonical package layout fallback. A package without readable version
    // metadata still has to prove its version via `--version` before use.
    for package_root in [&runtime, &target_runtime] {
        push_dedicated_candidate(
            candidates,
            package_root
                .join("bin")
                .join(codex_app_server_executable_name()),
            None,
        );
    }
}

fn read_package_candidate(package_root: &Path) -> Option<CodexExecutableCandidate> {
    let bytes = fs::read(package_root.join("codex-package.json")).ok()?;
    let manifest: Value = serde_json::from_slice(&bytes).ok()?;
    package_candidate_from_manifest(package_root, &manifest).ok()
}

fn package_candidate_from_manifest(
    package_root: &Path,
    manifest: &Value,
) -> Result<CodexExecutableCandidate> {
    if manifest.get("layoutVersion").and_then(Value::as_u64) != Some(1) {
        return Err(CodexAppServerError::Protocol(
            "unsupported Codex package layout".to_owned(),
        ));
    }
    if manifest.get("variant").and_then(Value::as_str) != Some("codex-app-server") {
        return Err(CodexAppServerError::Protocol(
            "Codex package has the wrong variant".to_owned(),
        ));
    }
    if manifest.get("target").and_then(Value::as_str) != Some(platform_target_triple()) {
        return Err(CodexAppServerError::Protocol(
            "Codex package target does not match this device".to_owned(),
        ));
    }
    let entrypoint = manifest
        .get("entrypoint")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CodexAppServerError::Protocol("Codex package manifest has no entrypoint".to_owned())
        })?;
    let entrypoint = safe_package_entrypoint(package_root, Path::new(entrypoint))?;
    if entrypoint.file_name().and_then(|name| name.to_str())
        != Some(codex_app_server_executable_name())
    {
        return Err(CodexAppServerError::Protocol(
            "Codex package entrypoint has an unexpected filename".to_owned(),
        ));
    }
    // Validate every path-bearing field even though the app-server resolves
    // these adjacent helpers itself. This keeps malformed package metadata from
    // redefining anything outside the signed resource root.
    for field in ["resourcesDir", "pathDir"] {
        let relative = manifest.get(field).and_then(Value::as_str).ok_or_else(|| {
            CodexAppServerError::Protocol(format!("Codex package manifest has no {field}"))
        })?;
        let _ = safe_package_entrypoint(package_root, Path::new(relative))?;
    }
    let version = manifest
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CodexAppServerError::Protocol("Codex package manifest has no version".to_owned())
        })
        .and_then(parse_codex_cli_version)?;

    Ok(CodexExecutableCandidate {
        path: entrypoint,
        source: CodexCliSource::BundledResource,
        kind: CodexExecutableKind::DedicatedAppServer,
        package_root: Some(package_root.to_owned()),
        declared_version: Some(version),
    })
}

fn safe_package_entrypoint(package_root: &Path, entrypoint: &Path) -> Result<PathBuf> {
    if entrypoint.is_absolute()
        || entrypoint
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(CodexAppServerError::Protocol(
            "Codex package entrypoint escaped its resource directory".to_owned(),
        ));
    }
    Ok(package_root.join(entrypoint))
}

fn push_dedicated_candidate(
    candidates: &mut Vec<CodexExecutableCandidate>,
    path: PathBuf,
    declared_version: Option<CodexCliVersion>,
) {
    let package_root = path.parent().and_then(Path::parent).map(Path::to_owned);
    candidates.push(CodexExecutableCandidate {
        path,
        source: CodexCliSource::BundledResource,
        kind: CodexExecutableKind::DedicatedAppServer,
        package_root,
        declared_version,
    });
}

fn push_full_cli_candidate(
    candidates: &mut Vec<CodexExecutableCandidate>,
    path: PathBuf,
    source: CodexCliSource,
) {
    candidates.push(CodexExecutableCandidate {
        path,
        source,
        kind: CodexExecutableKind::FullCli,
        package_root: None,
        declared_version: None,
    });
}

fn deduplicate_candidates(
    candidates: Vec<CodexExecutableCandidate>,
) -> Vec<CodexExecutableCandidate> {
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| {
            let key = if cfg!(windows) {
                candidate.path.to_string_lossy().to_lowercase()
            } else {
                candidate.path.to_string_lossy().into_owned()
            };
            seen.insert(key)
        })
        .collect()
}

fn codex_cli_executable_name() -> &'static str {
    if cfg!(windows) {
        "codex.exe"
    } else {
        "codex"
    }
}

fn codex_app_server_executable_name() -> &'static str {
    if cfg!(windows) {
        "codex-app-server.exe"
    } else {
        "codex-app-server"
    }
}

fn platform_target_triple() -> &'static str {
    match (env::consts::OS, env::consts::ARCH) {
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        ("windows", "aarch64") => "aarch64-pc-windows-msvc",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("linux", "x86_64") => "x86_64-unknown-linux-musl",
        ("linux", "aarch64") => "aarch64-unknown-linux-musl",
        _ => "unknown",
    }
}

async fn resolve_codex_executable(
    resource_dir: Option<&Path>,
    probe_timeout: Duration,
) -> Result<ResolvedCodexExecutable> {
    let candidates = codex_executable_candidates(resource_dir);
    let authoritative_override = candidates
        .first()
        .is_some_and(|candidate| candidate.source == CodexCliSource::PortcodeOverride);
    let mut rejected = Vec::new();

    for candidate in candidates {
        if candidate.source != CodexCliSource::Path && !candidate.path.is_file() {
            rejected.push(format!("{} missing", candidate.source));
            continue;
        }
        match candidate_version(&candidate, probe_timeout).await {
            Ok(version) => {
                return Ok(ResolvedCodexExecutable {
                    path: candidate.path,
                    source: candidate.source,
                    kind: candidate.kind,
                    package_root: candidate.package_root,
                    version,
                });
            }
            Err(error) => rejected.push(format!("{}: {error}", candidate.source)),
        }
        if authoritative_override {
            break;
        }
    }

    let detail = if rejected.is_empty() {
        "no candidates".to_owned()
    } else {
        rejected.join("; ")
    };
    Err(CodexAppServerError::Discovery(detail))
}

async fn candidate_version(
    candidate: &CodexExecutableCandidate,
    probe_timeout: Duration,
) -> Result<CodexCliVersion> {
    // Dedicated package entrypoints are not required to implement the full
    // CLI's `--version` surface. Their signed package metadata supplies the
    // release version. Full CLIs are always probed at runtime.
    if candidate.kind == CodexExecutableKind::DedicatedAppServer {
        if let Some(version) = candidate.declared_version {
            validate_codex_cli_version(version)?;
            return Ok(version);
        }
    }

    let version = probe_codex_cli_version(&candidate.path, probe_timeout).await?;
    validate_codex_cli_version(version)?;
    if let Some(declared) = candidate.declared_version {
        if version != declared {
            return Err(CodexAppServerError::VersionProbe(
                "package metadata did not match its executable".to_owned(),
            ));
        }
    }
    Ok(version)
}

async fn probe_codex_cli_version(path: &Path, timeout: Duration) -> Result<CodexCliVersion> {
    let mut command = hidden_command(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| CodexAppServerError::Timeout {
            operation: "version probe",
        })?
        .map_err(|_| CodexAppServerError::VersionProbe("process launch failed".to_owned()))?;
    if !output.status.success() {
        return Err(CodexAppServerError::VersionProbe(
            "version command failed".to_owned(),
        ));
    }
    parse_codex_cli_version(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_validates_the_pinned_minor_only() {
        assert_eq!(
            parse_codex_cli_version("codex-cli 0.145.0\n").unwrap(),
            CodexCliVersion::new(0, 145, 0)
        );
        assert_eq!(
            parse_codex_cli_version("codex-cli v0.145.7-beta.1").unwrap(),
            CodexCliVersion::new(0, 145, 7)
        );
        assert!(validate_codex_cli_version(CodexCliVersion::new(0, 145, 0)).is_ok());
        assert!(validate_codex_cli_version(CodexCliVersion::new(0, 145, 99)).is_ok());
        assert!(matches!(
            validate_codex_cli_version(CodexCliVersion::new(0, 144, 99)),
            Err(CodexAppServerError::UnsupportedVersion { .. })
        ));
        assert!(matches!(
            validate_codex_cli_version(CodexCliVersion::new(0, 146, 0)),
            Err(CodexAppServerError::UnsupportedVersion { .. })
        ));
        assert!(parse_codex_cli_version("not-a-version").is_err());
    }

    #[test]
    fn jsonl_framing_is_one_line_and_omits_jsonrpc_header() {
        let frame = json!({
            "method": "turn/start",
            "id": 7,
            "params": { "input": [{ "type": "text", "text": "one\ntwo" }] },
        });
        let encoded = encode_json_line(&frame).unwrap();
        assert_eq!(encoded.last(), Some(&b'\n'));
        assert_eq!(encoded.iter().filter(|byte| **byte == b'\n').count(), 1);
        let decoded: Value = serde_json::from_slice(&encoded[..encoded.len() - 1]).unwrap();
        assert_eq!(decoded, frame);
        assert!(decoded.get("jsonrpc").is_none());
    }

    #[test]
    fn classifies_notifications_and_preserves_raw_params() {
        let params = json!({ "item": { "type": "subAgentActivity", "unknown": [1, 2, 3] } });
        let frame = classify_frame(json!({
            "method": "item/started",
            "params": params,
        }))
        .unwrap();
        let ParsedFrame::Incoming(UnscopedIncoming::Notification {
            method,
            params: actual,
            raw,
        }) = frame
        else {
            panic!("expected notification");
        };
        assert_eq!(method, "item/started");
        assert_eq!(actual, params);
        assert_eq!(raw["method"], "item/started");
    }

    #[test]
    fn classifies_server_requests_with_the_exact_json_id() {
        let frame = classify_frame(json!({
            "method": "item/commandExecution/requestApproval",
            "id": "approval/abc",
            "params": { "command": "cargo test" },
        }))
        .unwrap();
        let ParsedFrame::Incoming(UnscopedIncoming::ServerRequest {
            id,
            method,
            params,
            raw,
        }) = frame
        else {
            panic!("expected server request");
        };
        assert_eq!(id, Value::String("approval/abc".to_owned()));
        assert_eq!(method, "item/commandExecution/requestApproval");
        assert_eq!(params["command"], "cargo test");
        assert_eq!(raw["id"], "approval/abc");
    }

    #[test]
    fn classifies_success_and_error_responses() {
        let success = classify_frame(json!({ "id": 9, "result": { "ok": true } })).unwrap();
        let ParsedFrame::Response { id, result } = success else {
            panic!("expected response");
        };
        assert_eq!(id, 9);
        assert_eq!(result.unwrap(), json!({ "ok": true }));

        let failure = classify_frame(json!({
            "id": 10,
            "error": { "code": -32602, "message": "bad params", "data": { "field": "cwd" } },
        }))
        .unwrap();
        let ParsedFrame::Response { id, result } = failure else {
            panic!("expected response");
        };
        assert_eq!(id, 10);
        assert!(matches!(
            result,
            Err(CodexAppServerError::Rpc {
                code: -32602,
                data: Some(_),
                ..
            })
        ));
    }

    #[test]
    fn explicit_override_is_authoritative() {
        let environment = DiscoveryEnvironment {
            portcode_override: Some(OsString::from("D:/dev/codex.exe")),
            codex_install_dir: Some(OsString::from("D:/official")),
            #[cfg(windows)]
            local_app_data: Some(OsString::from("D:/local")),
            #[cfg(not(windows))]
            home: None,
        };
        let candidates =
            codex_executable_candidates_from(Some(Path::new("D:/resources")), &environment);
        assert_eq!(
            candidates,
            vec![CodexExecutableCandidate {
                path: PathBuf::from("D:/dev/codex.exe"),
                source: CodexCliSource::PortcodeOverride,
                kind: CodexExecutableKind::FullCli,
                package_root: None,
                declared_version: None,
            }]
        );
    }

    #[test]
    fn bundled_candidates_precede_official_and_path_fallbacks() {
        let environment = DiscoveryEnvironment {
            portcode_override: None,
            codex_install_dir: Some(OsString::from("D:/official")),
            #[cfg(windows)]
            local_app_data: Some(OsString::from("D:/local")),
            #[cfg(not(windows))]
            home: Some(OsString::from("D:/home")),
        };
        let candidates =
            codex_executable_candidates_from(Some(Path::new("D:/resources")), &environment);
        assert_eq!(
            candidates.first().unwrap().source,
            CodexCliSource::BundledResource
        );
        let official = candidates
            .iter()
            .position(|candidate| candidate.source == CodexCliSource::OfficialStandalone)
            .unwrap();
        let path = candidates
            .iter()
            .position(|candidate| candidate.source == CodexCliSource::Path)
            .unwrap();
        assert!(official > 0);
        assert!(path > official);
    }

    #[test]
    fn package_manifest_selects_a_safe_dedicated_entrypoint() {
        let relative_entrypoint = format!("bin/{}", codex_app_server_executable_name());
        let candidate = package_candidate_from_manifest(
            Path::new("D:/resources/codex-runtime"),
            &json!({
                "layoutVersion": 1,
                "version": "0.145.0",
                "target": platform_target_triple(),
                "variant": "codex-app-server",
                "entrypoint": relative_entrypoint,
                "resourcesDir": "codex-resources",
                "pathDir": "codex-path",
            }),
        )
        .unwrap();
        assert_eq!(
            candidate.path,
            PathBuf::from("D:/resources/codex-runtime/bin")
                .join(codex_app_server_executable_name())
        );
        assert_eq!(candidate.kind, CodexExecutableKind::DedicatedAppServer);
        assert_eq!(
            candidate.package_root,
            Some(PathBuf::from("D:/resources/codex-runtime"))
        );
        assert_eq!(candidate.declared_version, Some(PINNED_CODEX_CLI_VERSION));

        assert!(package_candidate_from_manifest(
            Path::new("D:/resources/codex-runtime"),
            &json!({
                "layoutVersion": 1,
                "version": "0.145.0",
                "target": platform_target_triple(),
                "variant": "codex-app-server",
                "entrypoint": "../codex-app-server",
                "resourcesDir": "codex-resources",
                "pathDir": "codex-path",
            }),
        )
        .is_err());
    }

    #[test]
    fn dedicated_binary_is_spawned_directly_but_full_cli_uses_subcommand() {
        assert!(app_server_arguments(CodexExecutableKind::DedicatedAppServer).is_empty());
        assert_eq!(
            app_server_arguments(CodexExecutableKind::FullCli),
            &["app-server"]
        );
    }

    #[test]
    fn initialization_enables_the_extended_codex_event_surface() {
        let params = initialize_params(&CodexAppServerOptions::default());
        assert_eq!(params["clientInfo"]["name"], "portcode");
        assert_eq!(params["capabilities"]["experimentalApi"], true);
    }

    #[test]
    fn monotonic_counter_never_wraps() {
        let counter = AtomicU64::new(u64::MAX - 1);
        assert_eq!(next_monotonic(&counter).unwrap(), u64::MAX - 1);
        assert!(matches!(
            next_monotonic(&counter),
            Err(CodexAppServerError::RequestIdExhausted)
        ));
    }

    #[test]
    fn unexpected_transport_close_keeps_its_process_generation() {
        assert_eq!(
            transport_closed_event(7, &CodexAppServerError::Exited("stdout closed".to_string())),
            Incoming::TransportClosed {
                generation: 7,
                reason: "Codex app-server stopped: stdout closed".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn shutdown_permanently_rejects_every_future_request_source() {
        let server = CodexAppServer::new(Default::default());
        server.shutdown().await;

        assert!(matches!(
            server.request("account/read", json!({})).await,
            Err(CodexAppServerError::Exited(reason)) if reason == "client shutdown"
        ));
        assert!(matches!(
            server.version().await,
            Err(CodexAppServerError::Exited(reason)) if reason == "client shutdown"
        ));
        assert!(!server.status().await.running);
    }

    #[tokio::test]
    async fn child_shutdown_waits_for_the_reap_acknowledgement() {
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<Option<oneshot::Sender<()>>>();
        let child = tokio::spawn(async move {
            let completion = shutdown_rx.await.unwrap().unwrap();
            completion.send(()).unwrap();
        });

        assert!(request_child_shutdown(shutdown_tx, Duration::from_secs(1)).await);
        child.await.unwrap();
    }

    #[tokio::test]
    async fn child_shutdown_timeout_is_bounded() {
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<Option<oneshot::Sender<()>>>();
        let child = tokio::spawn(async move {
            let _completion = shutdown_rx.await.unwrap().unwrap();
            std::future::pending::<()>().await;
        });

        assert!(!request_child_shutdown(shutdown_tx, Duration::ZERO).await);
        child.abort();
    }
}
