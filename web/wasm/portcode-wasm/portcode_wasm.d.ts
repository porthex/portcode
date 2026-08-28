/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";
/**
 * A command the phone issues to drive the always-on desktop. Each maps onto an
 * existing desktop capability (`run_agent` / `cancel_agent` / `resolve_permission`
 * / `create_session`) — the phone never runs tools or touches the workspace
 * itself.
 */
export type RemoteCommand = { cmd: "run"; session_id: string; text: string } | { cmd: "cancel"; session_id: string } | { cmd: "cancel_agent"; agent_id: string } | { cmd: "permission"; id: string; decision: string } | { cmd: "create_session"; request_id: string; title: string | null } | { cmd: "register_push"; endpoint: string; p256dh: string; auth: string } | { cmd: "fetch_messages"; session_id: string; before_seq: number; limit: number };

/**
 * A session header row. (Was `crate::db::SessionRow`.)
 */
export interface SessionRow {
    id: string;
    title: string;
    /**
     * Current git branch of `workspace`, computed live on each list; None when
     * no workspace/repo or detached HEAD.
     */
    branch?: string | null;
    workspace: string | null;
    /**
     * The per-session model id (per-session-model feature). Optional + serde-default
     * so older rows / wire payloads without it still decode; the call site falls back
     * to the global default model when it is None.
     */
    model?: string | null;
    /**
     * Opaque local ChatGPT account profile pinned to this session. Legacy and
     * non-OpenAI sessions remain unpinned, and older peers can omit the field.
     */
    accountProfileId?: string;
    createdAt: number;
    updatedAt: number;
}

/**
 * A single content block, matching the Anthropic content-block wire format.
 * (Was `crate::llm::Block`.)
 */
export type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Value } | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean } | { type: "reasoning"; model?: string; id?: string; encrypted_content?: string; summary?: Value[] };

/**
 * Bounded, reload-safe diagnostics for a failed root turn. This deliberately
 * contains only operational metadata: never prompts, tool inputs/results,
 * credentials, provider response bodies, or absolute paths.
 */
export interface TurnFailure {
    /**
     * Stable local classification such as `provider_http` or `provider_timeout`.
     */
    code: string;
    /**
     * User-safe, secret-scrubbed summary, bounded by the desktop before storage.
     */
    message: string;
    provider?: string;
    model?: string;
    httpStatus?: number;
    /**
     * Number and serialized byte size of persisted transcript messages supplied
     * to the failing root run. These are diagnostics, not token estimates.
     */
    transcriptMessages?: number;
    transcriptBytes?: number;
}

/**
 * Bounded, wire-safe state distilled from rich Codex app-server parameters.
 * Text, paths, credentials, request bodies, tool output, and reasoning are never
 * represented here; unknown future payload kinds decode to Unknown.
 */
export interface PhoneCodexPlanStep {
    status: string;
}

/**
 * Events streamed to the frontend. Tagged + camelCased to match `StreamEvent`
 * in `src/types.ts`. This is the rich internal desktop event; Phone Sync frames
 * embed the separate projected [`PhoneStreamEvent`] type below.
 * (Was `crate::llm::StreamEvent`.)
 */
export type StreamEvent = { type: "turn_start"; messageId: string; turnId?: string; startedAt?: number } | { type: "turn_phase"; turnId: string; phase: TurnPhase; at: number; revision?: number; status?: TurnStatus; stopReason?: string; agentDurationMs?: number; receiptExpected?: boolean } | { type: "text_delta"; text: string } | { type: "assistant_message_snapshot"; turnId: string; blocks: Block[] } | { type: "tool_use"; id: string; name: string; input: Value } | { type: "tool_result"; id: string; output: string; isError: boolean } | { type: "permission_request"; id: string; tool: string; risk?: PermissionRisk; summary: string; input: Value; diff?: string } | { type: "usage"; inputTokens: number; outputTokens: number } | { type: "turn_end"; stopReason: string; receipt?: TurnReceipt } | { type: "error"; message: string; receipt?: TurnReceipt } | { type: "agent_started"; agentId: string; description: string; parentId?: string; parentThreadId?: string; launchTurnId?: string; model?: string; reasoningEffort?: string; activity?: string } | { type: "agent_progress"; agentId: string; step: number; parentThreadId?: string; launchTurnId?: string; currentTurnId?: string; turnCount?: number } | { type: "agent_finished"; agentId: string; status: string; result?: string; providerStatus?: string; parentThreadId?: string; launchTurnId?: string; currentTurnId?: string; turnCount?: number; activity?: string } | { type: "background_task_started"; id: string; command: string } | { type: "background_task_finished"; id: string; command: string; exitCode: number; output: string } | { type: "codex_event"; sequence: number; method: string; params: Value; requestId?: Value; threadId?: string; turnId?: string; itemId?: string; emittedAtMs: number } | { type: "codex_request"; id: string; method: string; params: Value };

/**
 * Everything that crosses the encrypted channel, in both directions.
 */
export type SyncFrame = { t: "hello"; device_id: string; cursors: Cursor[] } | { t: "session_list"; sessions: PhoneSessionRow[] } | { t: "session_created"; request_id: string; session: PhoneSessionRow } | { t: "command_rejected"; request_id?: string; code?: CommandRejectionCode; message?: string } | { t: "message_delta"; session_id: string; messages: PhoneMessageRow[] } | { t: "message_page"; session_id: string; messages: PhoneMessageRow[]; has_more: boolean } | { t: "live"; session_id: string; event: PhoneStreamEvent } | { t: "command"; command: RemoteCommand } | { t: "ack"; session_id: string; seq: number } | { t: "pairing_reject"; reason: string | null };

/**
 * Git-shaped status used by the immutable, bounded changed-file summary.
 */
export type TurnFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "unmerged";

/**
 * How confidently a receipt can attribute an observed file delta to the turn.
 */
export type TurnChangeCertainty = "exact" | "observed" | "ambiguous" | "unavailable";

/**
 * Immutable terminal summary attached to the assistant bubble both live and
 * after a database reload. Changed files are deliberately bounded; counts and
 * totals describe the complete observed delta when capture succeeded.
 */
export interface TurnReceipt {
    turnId: string;
    /**
     * Opaque local ChatGPT account profile used for this turn. This is never a
     * remote account identifier and is optional so receipts written by older
     * Portcode versions remain readable.
     */
    accountProfileId?: string;
    status: TurnStatus;
    /**
     * Present only for failed turns. Optional for additive compatibility with
     * receipts written by older desktop and phone builds.
     */
    failure?: TurnFailure;
    stopReason?: string;
    startedAt: number;
    completedAt: number;
    /**
     * Monotonic elapsed time for a normally terminalized turn. Omitted when a
     * pending row is recovered after process restart because the crash instant is
     * unknowable and fabricating a near-zero duration would be misleading.
     */
    durationMs?: number;
    /**
     * Agent work duration frozen before optional Git finalization. New clients
     * prefer this over legacy `duration_ms`; old receipts simply omit it.
     */
    agentDurationMs?: number;
    changedFiles: TurnChangedFile[];
    changedFileCount: number;
    additions: number;
    deletions: number;
    filesTruncated: boolean;
    changeState?: TurnChangeState;
    changeCertainty: TurnChangeCertainty;
    backgroundTasksRunning: boolean;
}

/**
 * Non-terminal lifecycle milestones emitted to the local desktop UI. Phone
 * Sync deliberately does not forward this additive event until a peer has
 * negotiated support, because legacy Rust peers reject unknown enum variants.
 */
export type TurnPhase = "provider_started" | "agent_completed";

/**
 * One end's high-water mark for a session: "I already hold every message up to
 * and including `seq`." A reconnecting phone sends one per known session so the
 * desktop can reply with only the newer rows (`Db::messages_since`).
 */
export interface Cursor {
    sessionId: string;
    seq: number;
}

/**
 * One path whose terminal workspace identity differed from the turn baseline.
 */
export interface TurnChangedFile {
    path: string;
    oldPath?: string;
    status: TurnFileStatus;
    additions?: number;
    deletions?: number;
    binary: boolean;
    certainty: TurnChangeCertainty;
}

/**
 * One persisted message, with its raw append-only `seq` — the flat row Phone
 * Sync persistence reads internally. Phone catch-up projects this into the
 * separate [`PhoneMessageRow`] type below.
 * `content` is the typed block list (same shape as [`ChatMessage::content`]).
 * (Was `crate::db::MessageRow`.)
 */
export interface MessageRow {
    id: string;
    sessionId: string;
    seq: number;
    role: string;
    content: Block[];
    createdAt: number;
    /**
     * NULL/omitted on legacy rows. New rows use this to rebuild the same single
     * assistant bubble that live `TurnStart` created.
     */
    turnId?: string;
    /**
     * Attached to the terminal row of a replicated turn. Desktop `UiMessage`
     * carries the same receipt directly on the grouped assistant bubble.
     */
    receipt?: TurnReceipt;
}

/**
 * Public changed-file item. Paths are labels projected and bounded by the
 * desktop; this type cannot carry a receipt's local account attribution.
 */
export interface PhoneTurnChangedFile {
    path: string;
    oldPath?: string;
    status: TurnFileStatus;
    additions?: number;
    deletions?: number;
    binary: boolean;
    certainty: TurnChangeCertainty;
}

/**
 * Public content block replicated to Phone Sync peers. Raw tool payloads are
 * represented by the same legacy fields, but the projector fills `input` with
 * `{}` and uses a static result summary.
 */
export type PhoneBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Value } | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

/**
 * Public live event delivered to Phone Sync peers. Required fields and JSON
 * tags match the legacy `StreamEvent` shape; `Unknown` keeps future public
 * event tags from terminating an older receive loop.
 */
export type PhoneStreamEvent = { type: "turn_start"; messageId: string; turnId?: string; startedAt?: number } | { type: "text_delta"; text: string } | { type: "assistant_message_snapshot"; turnId: string; blocks: PhoneBlock[] } | { type: "tool_use"; id: string; name: string; input: Value } | { type: "tool_result"; id: string; output: string; isError: boolean } | { type: "permission_request"; id: string; tool: string; risk?: PermissionRisk; summary: string; input: Value; diff?: string } | { type: "usage"; inputTokens: number; outputTokens: number } | { type: "turn_end"; stopReason: string; receipt?: PhoneTurnReceipt } | { type: "error"; message: string; receipt?: PhoneTurnReceipt } | { type: "agent_started"; agentId: string; description: string; parentId?: string; parentThreadId?: string; launchTurnId?: string; model?: string; reasoningEffort?: string; activity?: string } | { type: "agent_progress"; agentId: string; step: number; parentThreadId?: string; launchTurnId?: string; currentTurnId?: string; turnCount?: number } | { type: "agent_finished"; agentId: string; status: string; result?: string; providerStatus?: string; parentThreadId?: string; launchTurnId?: string; currentTurnId?: string; turnCount?: number; activity?: string } | { type: "codex_activity"; kind: string; method: string; requestId?: string; threadId?: string; turnId?: string; itemId?: string; sequence?: number; emittedAtMs?: number; redacted?: boolean; truncated?: boolean; redactionReasons?: string[]; truncationReasons?: string[]; originalBytes?: number; retainedBytes?: number; payload?: PhoneCodexActivityPayload } | { type: "background_task_started"; id: string; command: string } | { type: "background_task_finished"; id: string; command: string; exitCode: number; output: string } | { type: "unknown" };

/**
 * Public persisted message row. Its content and receipt are public DTOs, so a
 * raw reasoning block, tool payload, or account profile cannot be embedded.
 */
export interface PhoneMessageRow {
    id: string;
    sessionId: string;
    seq: number;
    role: string;
    content: PhoneBlock[];
    createdAt: number;
    turnId?: string;
    receipt?: PhoneTurnReceipt;
}

/**
 * Public session header. The projector replaces an absolute workspace with a
 * safe label and this schema has no account-profile field at all.
 */
export interface PhoneSessionRow {
    id: string;
    title: string;
    branch?: string | null;
    workspace: string | null;
    model?: string | null;
    createdAt: number;
    updatedAt: number;
}

/**
 * Public terminal turn summary. This preserves the legacy receipt field names
 * while intentionally omitting `accountProfileId`.
 */
export interface PhoneTurnReceipt {
    turnId: string;
    status: TurnStatus;
    stopReason?: string;
    startedAt: number;
    completedAt: number;
    durationMs?: number;
    changedFiles: PhoneTurnChangedFile[];
    changedFileCount: number;
    additions: number;
    deletions: number;
    filesTruncated: boolean;
    changeCertainty: TurnChangeCertainty;
    backgroundTasksRunning: boolean;
}

/**
 * Security classification attached to a permission request.
 *
 * Missing values are legacy `Configurable` requests. Unknown future values
 * decode as `Unknown`, which callers must handle fail-safe (one-shot approval,
 * never a remembered allow).
 */
export type PermissionRisk = "configurable" | "shell" | "dependencyInstall" | "highRiskGit" | "unknown";

/**
 * Stable, non-sensitive reason a desktop rejected a correlated remote command.
 *
 * The phone should use `code` for behavior and may display the accompanying
 * bounded public message. `Unknown` keeps newer desktop codes decodable by an
 * older phone instead of turning an application-level rejection into a protocol
 * failure and reconnect loop.
 */
export type CommandRejectionCode = "open_ai_account_selection_required" | "invalid_desktop_configuration" | "desktop_unavailable" | "invalid_request" | "unknown";

/**
 * Terminal state of one root agent turn. `Interrupted` is persisted when a
 * process dies after the durable turn row was created but before a terminal
 * event could be emitted.
 */
export type TurnStatus = "completed" | "cancelled" | "error" | "interrupted";

/**
 * Whether Git attribution applies and whether a net delta is known. This is
 * orthogonal to [`TurnChangeCertainty`], which only qualifies attribution.
 */
export type TurnChangeState = "not_applicable" | "none" | "changed" | "unknown";

export type PhoneCodexActivityPayload = { type: "plan"; steps: PhoneCodexPlanStep[] } | { type: "diff"; additions: number; deletions: number; files: number } | { type: "tool"; itemType: string; status: string; terminal: boolean } | { type: "terminal"; status: string } | { type: "unknown" };


export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

/**
 * A live Phone Sync session: a paired, end-to-end-encrypted channel to the
 * desktop plus the JS callback inbound frames are delivered to.
 *
 * Created by [`Session::connect`]. Holds the split channel's send half (for
 * [`Session::send_command`]) behind an async mutex shared with the inbound loop,
 * the `on_event` JS callback, and the pairing metadata (`sas`, `peer_public_key`)
 * the UI needs for SAS verification + key pinning.
 */
export class Session {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Dial the desktop named by the scanned QR and run the Noise handshake.
     *
     * `qr` is the JSON [`PairingPayload`] the desktop rendered (public key, nonce,
     * node address, optional relay URL). `reconnect = false` runs the XX first-
     * pairing handshake (binding the QR nonce); `reconnect = true` runs the KK
     * fast-resume handshake against the pinned desktop key (§5.8).
     *
     * Resolves (as a JS Promise) with a [`Session`] whose `sas` getter holds the
     * SAS to show for out-of-band verification and whose `peerPublicKey` getter
     * holds the key to pin. After this, register [`Session::on_event`] to start
     * receiving forwarded frames.
     */
    static connect(qr: string, reconnect: boolean, private_key?: string | null): Promise<Session>;
    /**
     * Tear down the session: drop the send half (which owns the iroh
     * connection/endpoint keep-alive), closing the QUIC stream and ending the recv
     * loop. Idempotent — safe to call on every `visibilitychange` (§5.8).
     */
    disconnect(): void;
    /**
     * Register the inbound-frame callback `(frame: SyncFrame) => void`. The recv
     * loop invokes it once per forwarded [`SyncFrame`], with the frame converted to
     * a native JS object via `serde-wasm-bindgen`. The store wires this to
     * `applyFrame`.
     *
     * The recv loop is started HERE, on the first registration — NOT in `connect`.
     * Starting it earlier would let it read + discard any frame the desktop sends
     * between `connect` resolving and JS wiring up `onEvent`. Parking the receiver
     * until a callback exists means the first frame is the first one delivered. A
     * later re-registration just swaps the callback (the loop reads `on_event` each
     * frame), so it never spawns a second loop.
     */
    onEvent(cb: Function): void;
    /**
     * Decline this session during SAS verification: tell the desktop the user
     * rejected the pairing (so its confirm/reject prompt cancels instead of
     * parking for the full timeout), then tear the connection down.
     *
     * Sends a `PairingReject { reason: None }` over the still-open send half BEFORE
     * dropping it — the desktop's `serve_connection` selects on this frame and
     * drops the connection promptly. A send error is non-fatal (the channel may
     * already be gone); we tear down regardless so the local session is always
     * cleaned up. The store wires this to the "reject" button in the SAS dialog.
     *
     * Takes `&self` (not `&mut self`) — like `send_command`/`disconnect`, the inner
     * state is behind `Rc<RefCell>`/`Rc<AsyncMutex>`, so teardown works through a
     * shared borrow; the returned `Promise` resolves once the reject frame is sent
     * (or fails) and the channel is dropped.
     */
    reject(): Promise<void>;
    /**
     * Push one [`RemoteCommand`] to the desktop. `cmd` is the JS object form of a
     * `RemoteCommand` (`Run`/`Cancel`/`Permission`/`CreateSession`), converted via
     * `serde-wasm-bindgen`. No-op error if the session was already disconnected.
     */
    sendCommand(cmd: any): void;
    /**
     * The desktop's pinned Noise static public key (base64) — persist in IndexedDB
     * after SAS confirmation to enable KK reconnects (§5.8).
     */
    readonly peerPublicKey: string;
    /**
     * The phone's own long-term Noise static PRIVATE key (base64) — persist after
     * SAS confirmation and pass back as the third `connect` arg on reconnect so KK
     * authenticates as the SAME pinned phone (§5.8). NEVER log or expose it
     * elsewhere.
     */
    readonly privateKey: string;
    /**
     * The Short Authentication String to compare out-of-band before trusting the
     * session (§5.10). Stable for the life of the session.
     */
    readonly sas: string;
}

/**
 * One-time wasm init: route Rust panics to the JS console so on-device failures
 * are debuggable in the Safari Web Inspector. Mirrors the Phase 0 spike.
 */
export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_session_free: (a: number, b: number) => void;
    readonly session_connect: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly session_disconnect: (a: number) => void;
    readonly session_onEvent: (a: number, b: any) => void;
    readonly session_peerPublicKey: (a: number) => [number, number];
    readonly session_privateKey: (a: number) => [number, number];
    readonly session_reject: (a: number) => any;
    readonly session_sas: (a: number) => [number, number];
    readonly session_sendCommand: (a: number, b: any) => [number, number];
    readonly start: () => void;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: any) => any;
    readonly intounderlyingbytesource_start: (a: number, b: any) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly intounderlyingsink_abort: (a: number, b: any) => any;
    readonly intounderlyingsink_close: (a: number) => any;
    readonly intounderlyingsink_write: (a: number, b: any) => any;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: any) => any;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h7489660246e8c56f: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h8e4092050f2e1016: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hba15ed50373f0f9e: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__he5717fda343f3e42: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h7e55d1127dc844b4: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h491f643b0bd758f9: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hb31b9f2fd166600f: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__ha6801afd2ff3851e: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h3147e91f33883ca4: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
