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
export type RemoteCommand = { cmd: "run"; session_id: string; text: string } | { cmd: "cancel"; session_id: string } | { cmd: "permission"; id: string; decision: string } | { cmd: "create_session"; title: string | null };

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
    createdAt: number;
    updatedAt: number;
}

/**
 * A single content block, matching the Anthropic content-block wire format.
 * (Was `crate::llm::Block`.)
 */
export type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Value } | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

/**
 * Events streamed to the frontend. Tagged + camelCased to match `StreamEvent`
 * in `src/types.ts`. `Deserialize` lets Phone Sync decode it on the phone side
 * (it is forwarded verbatim inside `protocol::SyncFrame::Live`).
 * (Was `crate::llm::StreamEvent`.)
 */
export type StreamEvent = { type: "turn_start"; messageId: string } | { type: "text_delta"; text: string } | { type: "tool_use"; id: string; name: string; input: Value } | { type: "tool_result"; id: string; output: string; isError: boolean } | { type: "permission_request"; id: string; tool: string; summary: string; input: Value } | { type: "usage"; inputTokens: number; outputTokens: number } | { type: "turn_end"; stopReason: string } | { type: "error"; message: string };

/**
 * Everything that crosses the encrypted channel, in both directions.
 */
export type SyncFrame = { t: "hello"; device_id: string; cursors: Cursor[] } | { t: "session_list"; sessions: SessionRow[] } | { t: "message_delta"; session_id: string; messages: MessageRow[] } | { t: "live"; session_id: string; event: StreamEvent } | { t: "command"; command: RemoteCommand } | { t: "ack"; session_id: string; seq: number } | { t: "pairing_reject"; reason: string | null };

/**
 * One end\'s high-water mark for a session: \"I already hold every message up to
 * and including `seq`.\" A reconnecting phone sends one per known session so the
 * desktop can reply with only the newer rows (`Db::messages_since`).
 */
export interface Cursor {
    sessionId: string;
    seq: number;
}

/**
 * One persisted message, with its raw append-only `seq` — the flat row Phone
 * Sync replicates (the `MessageDelta` catch-up frame ships these verbatim).
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
}


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
    readonly wasm_bindgen__convert__closures_____invoke__h16decc9546f74ec6: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h16d3652e7206b186: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__he9067c4a56f1bae1: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h75c6535ff146cad0: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__he37016d9acbffb42: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h6515b6a5bd3141dc: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h9475d4745f285939: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h459ccb5a59206e34: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hf2b6b48a937b9ed4: (a: number, b: number) => void;
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
