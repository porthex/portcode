// IPC bridge. Talks to the Rust core when running under Tauri; otherwise falls
// back to an in-browser mock so the UI is fully runnable via `vite` alone.

import type {
  ConnectInfo,
  DirEntry,
  Message,
  OAuthStatus,
  PairingPayload,
  PairingRequest,
  PhoneSyncStatus,
  RemoteCommand,
  Session,
  Settings,
  StreamEvent,
  SyncFrame,
} from "../types";
import {
  webOnPhoneSyncDisconnected,
  webOnPhoneSyncFrame,
  webPhoneSyncConnect,
  webPhoneSyncDisconnect,
  webPhoneSyncReject,
  webPhoneSyncSendCommand,
} from "./webSession";

export const isTauri = (): boolean =>
  typeof window !== "undefined" &&
  // Tauri v2 injects this on the window object.
  "__TAURI_INTERNALS__" in window;

// Web-client mode. The Vercel-hosted PWA (the iOS web client) turns this on at
// startup via {@link setWebClientMode} after injecting the WASM-backed transport
// connector (see `webSession`/iroh-in-browser). When on, the Phone Sync CLIENT
// calls — connect / send / disconnect / frame + disconnect subscriptions — route
// through the real `webSession` transport instead of the inert browser mock.
//
// Off by default, so the desktop preview (`vite` alone) keeps using the mock and
// every existing call site is unchanged. `isTauri()` always takes precedence: a
// native build uses the Tauri bridge regardless of this flag.
let webClientEnabled = false;

/** Enable/disable web-client mode (called once by the PWA entry). */
export function setWebClientMode(on: boolean): void {
  webClientEnabled = on;
}

/** True when the PWA web-client mode flag is on (set by the PWA entry). Unlike
 *  {@link webClientActive} this does NOT factor in Tauri — it is the raw flag, so
 *  the React tree can ask "are we the web client?" to gate web-only UI (the iOS
 *  install gate) without coupling to the transport-routing predicate. */
export function isWebClientMode(): boolean {
  return webClientEnabled;
}

/** True only when we should route Phone Sync client calls to the WASM transport:
 *  web-client mode is on AND we're not under Tauri. */
const webClientActive = (): boolean => webClientEnabled && !isTauri();

type Unlisten = () => void;

/** Lazily import the Tauri API only when actually running under Tauri. */
async function tauri() {
  const core = await import("@tauri-apps/api/core");
  const event = await import("@tauri-apps/api/event");
  return { core, event };
}

// ── Commands ────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<Settings> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<Settings>("get_settings");
  }
  return mock.getSettings();
}

export async function saveSettings(s: Partial<Settings>): Promise<Settings> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<Settings>("save_settings", { settings: s });
  }
  return mock.saveSettings(s);
}

export async function setApiKey(key: string): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("set_api_key", { key });
    return;
  }
  return mock.setApiKey(key);
}

// ── Subscription OAuth (Claude Pro/Max) ───────────────────────────────────────

export async function startOauthLogin(): Promise<OAuthStatus> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<OAuthStatus>("start_oauth_login");
  }
  return mock.startOauthLogin();
}

export async function oauthStatus(): Promise<OAuthStatus> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<OAuthStatus>("oauth_status");
  }
  return mock.oauthStatus();
}

export async function oauthLogout(): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("oauth_logout");
    return;
  }
  return mock.oauthLogout();
}

// ── Phone Sync ────────────────────────────────────────────────────────────────

export async function phoneSyncStatus(): Promise<PhoneSyncStatus> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<PhoneSyncStatus>("phone_sync_status");
  }
  return mock.phoneSyncStatus();
}

export async function phoneSyncBeginPairing(): Promise<PairingPayload> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<PairingPayload>("phone_sync_begin_pairing");
  }
  return mock.phoneSyncBeginPairing();
}

export async function phoneSyncUnpair(publicKey: string): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("phone_sync_unpair", { publicKey });
    return;
  }
  return mock.phoneSyncUnpair(publicKey);
}

/** Subscribe to the desktop-side "a new phone wants to pair" event. The handler
 *  receives the request id + the SAS to compare; the desktop user confirms or
 *  rejects via {@link confirmPairing} / {@link rejectPairing}. Returns an unlisten
 *  handle. Desktop-only event; in the browser mock it never fires. */
export async function onPhoneSyncPairingRequest(
  cb: (req: PairingRequest) => void,
): Promise<Unlisten> {
  if (isTauri()) {
    const { event } = await tauri();
    return event.listen<PairingRequest>("phone-sync://pairing-request", (ev) => cb(ev.payload));
  }
  return mock.onPhoneSyncPairingRequest(cb);
}

/** Confirm a pending new-device pairing (the desktop user compared the SAS and
 *  accepted). Persists the device as trusted and lets the connection proceed. */
export async function confirmPairing(requestId: string): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("confirm_pairing", { requestId });
    return;
  }
  return mock.confirmPairing(requestId);
}

/** Reject a pending new-device pairing (SAS mismatch or declined). Drops the
 *  connection without serving it. */
export async function rejectPairing(requestId: string): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("reject_pairing", { requestId });
    return;
  }
  return mock.rejectPairing(requestId);
}

// ── Phone Sync — mobile CLIENT (the phone drives a paired desktop) ─────────────

/** Dial + pair with a desktop from its scanned QR payload (JSON). Returns the SAS
 *  to compare out-of-band plus the pinned desktop key. `reconnect` selects the
 *  handshake prologue: `false` (a first pairing) binds the QR nonce; `true` (a
 *  remembered-desktop reconnect) binds an empty prologue to match the desktop's
 *  closed pairing window. */
export async function phoneSyncConnect(qr: string, reconnect = false): Promise<ConnectInfo> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<ConnectInfo>("phone_sync_connect", { qr, reconnect });
  }
  if (webClientActive()) return webPhoneSyncConnect(qr, reconnect);
  return mock.phoneSyncConnect(qr, reconnect);
}

/** Send one command to the live desktop session. */
export async function phoneSyncSendCommand(command: RemoteCommand): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("phone_sync_send_command", { command });
    return;
  }
  if (webClientActive()) return webPhoneSyncSendCommand(command);
  return mock.phoneSyncSendCommand(command);
}

/** Tear down the live desktop session. Idempotent. */
export async function phoneSyncDisconnect(): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("phone_sync_disconnect");
    return;
  }
  if (webClientActive()) return webPhoneSyncDisconnect();
  return mock.phoneSyncDisconnect();
}

/**
 * Decline the pairing from the phone: send a `pairing_reject` frame to the desktop
 * (so it learns the SAS was rejected, not merely that the link dropped), then tear
 * the session down. Idempotent.
 *
 * In web-client mode this routes to the wasm transport's `reject` (the carrier of
 * the new `pairing_reject` frame). On native (Tauri) the reject-frame protocol is a
 * web/wasm concern, so we fall back to the existing `phone_sync_disconnect` command,
 * which safely closes the channel.
 */
export async function phoneSyncReject(): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("phone_sync_disconnect");
    return;
  }
  if (webClientActive()) return webPhoneSyncReject();
  return mock.phoneSyncDisconnect();
}

/** Subscribe to frames forwarded from the paired desktop (live events + catch-up).
 *  Returns an unlisten handle. */
export async function onPhoneSyncFrame(cb: (frame: SyncFrame) => void): Promise<Unlisten> {
  if (isTauri()) {
    const { event } = await tauri();
    return event.listen<SyncFrame>("phone-sync://frame", (ev) => cb(ev.payload));
  }
  if (webClientActive()) return webOnPhoneSyncFrame(cb);
  return mock.onPhoneSyncFrame(cb);
}

/** Subscribe to the "session dropped unexpectedly" signal from the native client
 *  (the desktop closed the channel, or the network dropped). Returns an unlisten
 *  handle. */
export async function onPhoneSyncDisconnected(cb: () => void): Promise<Unlisten> {
  if (isTauri()) {
    const { event } = await tauri();
    return event.listen("phone-sync://disconnected", () => cb());
  }
  if (webClientActive()) return webOnPhoneSyncDisconnected(cb);
  return mock.onPhoneSyncDisconnected(cb);
}

export async function resolvePermission(id: string, decision: "allow" | "deny"): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("resolve_permission", { id, decision });
    return;
  }
  return mock.resolvePermission(id, decision);
}

// ── sessions / history ────────────────────────────────────────────────────────

export async function listSessions(): Promise<Session[]> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<Session[]>("list_sessions");
  }
  return [];
}

export async function createSession(
  id: string,
  title?: string,
  workspace?: string | null,
): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("create_session", { id, title, workspace });
  }
}

export async function renameSession(id: string, title: string): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("rename_session", { id, title });
  }
}

export async function deleteSession(id: string): Promise<void> {
  if (isTauri()) {
    const { core } = await tauri();
    await core.invoke("delete_session", { id });
  }
}

export async function getMessages(sessionId: string): Promise<Message[]> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<Message[]>("get_messages", { sessionId });
  }
  return [];
}

// ── workspace / files ─────────────────────────────────────────────────────────

export async function listDir(sub?: string): Promise<DirEntry[]> {
  if (isTauri()) {
    const { core } = await tauri();
    return core.invoke<DirEntry[]>("list_dir", { sub });
  }
  return mock.listDir(sub);
}

/** Open a native folder picker. Returns the chosen absolute path, or null. */
export async function openFolder(): Promise<string | null> {
  if (isTauri()) {
    const dialog = await import("@tauri-apps/plugin-dialog");
    const res = await dialog.open({ directory: true, multiple: false });
    return typeof res === "string" ? res : null;
  }
  return "C:/dev/porthex/portcode"; // preview mock
}

/**
 * A handle to a single running agent turn.
 *
 * `dispose()` stops listening for this turn's events WITHOUT cancelling the run —
 * call it the instant a turn reaches a terminal state (turn_end/error) so the
 * per-turn listener can't leak. A leaked listener keeps folding the NEXT turn's
 * deltas into this turn's message (the "second reply edits the first" bug).
 *
 * `cancel()` additionally tells the Rust core to abort an in-flight turn, then
 * stops listening — used by Stop and the client-side idle watchdog.
 */
export interface AgentRunHandle {
  cancel: () => Promise<void>;
  dispose: () => void;
}

/**
 * Send a user message and stream the agent run. Returns a handle to stop the run
 * (`cancel`) or just stop listening on a normal end (`dispose`). Events arrive
 * via `onEvent`.
 */
export async function runAgent(
  sessionId: string,
  text: string,
  onEvent: (e: StreamEvent) => void,
): Promise<AgentRunHandle> {
  if (isTauri()) {
    const { core, event } = await tauri();
    const channel = `agent://${sessionId}`;
    const unlisten: Unlisten = await event.listen<StreamEvent>(channel, (ev) =>
      onEvent(ev.payload),
    );
    await core.invoke("run_agent", { sessionId, text });
    return {
      cancel: async () => {
        await core.invoke("cancel_agent", { sessionId });
        unlisten();
      },
      dispose: unlisten,
    };
  }
  return mock.runAgent(sessionId, text, onEvent);
}

// ── Browser mock ──────────────────────────────────────────────────────────────
// A deterministic fake agent so the UI is alive without the Rust core.

const mock = (() => {
  let settings: Settings = {
    provider: "anthropic",
    model: "claude-opus-4-8",
    apiKeySet: false,
    defaultPolicy: "ask",
    workspace: null,
    typingAnimation: true,
  };

  // Fake subscription-auth state so the sign-in UX is testable without Tauri.
  let oauth: OAuthStatus = { signedIn: false, expiresAt: null, account: null, tier: null };

  // Fake phone sync state: a stable mock identity + no paired phones by default.
  let phoneSyncState: PhoneSyncStatus = {
    devicePublicKey: "MOCK_DEVICE_PUBLIC_KEY_BASE64==",
    paired: [],
  };

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const resolvers = new Map<string, (d: "allow" | "deny") => void>();

  return {
    async getSettings() {
      return { ...settings };
    },
    async saveSettings(s: Partial<Settings>) {
      settings = { ...settings, ...s };
      return { ...settings };
    },
    async setApiKey(_key: string) {
      settings.apiKeySet = true;
    },
    async startOauthLogin() {
      // Simulate a completed sign-in: subscription valid for ~8h.
      oauth = {
        signedIn: true,
        expiresAt: Math.floor(Date.now() / 1000) + 8 * 60 * 60,
        account: "preview@claude.local",
        tier: "Claude Max",
      };
      return { ...oauth };
    },
    async oauthStatus() {
      return { ...oauth };
    },
    async oauthLogout() {
      oauth = { signedIn: false, expiresAt: null, account: null, tier: null };
    },
    async phoneSyncStatus() {
      return { ...phoneSyncState, paired: [...phoneSyncState.paired] };
    },
    async phoneSyncBeginPairing(): Promise<PairingPayload> {
      return {
        version: 1,
        publicKey: phoneSyncState.devicePublicKey,
        nonce: "MOCK_NONCE_BASE64==",
        // Mirrors the real desktop payload: an opaque iroh node address the phone
        // would dial. Shaped like iroh's EndpointAddr serialization.
        nodeAddr: { id: "mock-endpoint-id", addrs: [] },
      };
    },
    async phoneSyncUnpair(publicKey: string) {
      phoneSyncState = {
        ...phoneSyncState,
        paired: phoneSyncState.paired.filter((d) => d.publicKey !== publicKey),
      };
    },
    // Desktop pairing-confirm surface — inert in the preview (no real phone dials
    // in, so the pairing-request event never fires and confirm/reject are no-ops).
    async onPhoneSyncPairingRequest(_cb: (req: PairingRequest) => void): Promise<Unlisten> {
      return () => {};
    },
    async confirmPairing(_requestId: string) {
      // no-op: the preview has no pending pairing to confirm.
    },
    async rejectPairing(_requestId: string) {
      // no-op: the preview has no pending pairing to reject.
    },
    // Mobile remote client — no real desktop in the browser preview, so connect
    // returns a deterministic SAS and the frame stream is inert. `reconnect` is
    // accepted for signature parity but unused in the preview.
    async phoneSyncConnect(_qr: string, _reconnect = false): Promise<ConnectInfo> {
      return { sas: "MOCK-SAS-1234", peerPublicKey: "MOCK_DESKTOP_KEY_BASE64==" };
    },
    async phoneSyncSendCommand(_command: RemoteCommand) {
      // no-op: the preview has no paired desktop to receive commands.
    },
    async phoneSyncDisconnect() {
      // no-op: nothing to tear down in the preview.
    },
    async onPhoneSyncFrame(_cb: (frame: SyncFrame) => void): Promise<Unlisten> {
      return () => {}; // inert subscription; the preview never emits frames.
    },
    async onPhoneSyncDisconnected(_cb: () => void): Promise<Unlisten> {
      return () => {}; // inert: the preview never drops a (nonexistent) session.
    },
    async resolvePermission(id: string, decision: "allow" | "deny") {
      resolvers.get(id)?.(decision);
      resolvers.delete(id);
    },
    async listDir(sub?: string) {
      const tree: Record<string, { name: string; path: string; isDir: boolean }[]> = {
        "": [
          { name: "src", path: "src", isDir: true },
          { name: "src-tauri", path: "src-tauri", isDir: true },
          { name: "docs", path: "docs", isDir: true },
          { name: "README.md", path: "README.md", isDir: false },
          { name: "package.json", path: "package.json", isDir: false },
        ],
        src: [
          { name: "components", path: "src/components", isDir: true },
          { name: "App.tsx", path: "src/App.tsx", isDir: false },
          { name: "main.tsx", path: "src/main.tsx", isDir: false },
        ],
        "src/components": [
          { name: "Chat.tsx", path: "src/components/Chat.tsx", isDir: false },
          { name: "Sidebar.tsx", path: "src/components/Sidebar.tsx", isDir: false },
        ],
        "src-tauri": [
          { name: "src", path: "src-tauri/src", isDir: true },
          { name: "Cargo.toml", path: "src-tauri/Cargo.toml", isDir: false },
        ],
        docs: [{ name: "ROADMAP.md", path: "docs/ROADMAP.md", isDir: false }],
      };
      return tree[sub ?? ""] ?? [];
    },
    async runAgent(_sessionId: string, text: string, onEvent: (e: StreamEvent) => void) {
      let cancelled = false;
      (async () => {
        await delay(120);
        if (cancelled) return;
        onEvent({ type: "turn_start", messageId: crypto.randomUUID() });

        const reply =
          "Running in **preview mode** (browser, no Rust core yet).\n\n" +
          "Once the Tauri core is running, this turn streams from Claude and " +
          "runs tools. You said:\n\n> " +
          text +
          "\n\nLet me read a file and then write one:";

        for (const chunk of reply.match(/.{1,3}/gs) ?? []) {
          if (cancelled) return;
          onEvent({ type: "text_delta", text: chunk });
          await delay(6);
        }

        // read-only tool — runs immediately
        await delay(200);
        if (cancelled) return;
        const readId = crypto.randomUUID();
        onEvent({ type: "tool_use", id: readId, name: "fs_read", input: { path: "src/App.tsx" } });
        await delay(350);
        onEvent({
          type: "tool_result",
          id: readId,
          output: "// (preview) file contents would appear here",
          isError: false,
        });

        // mutating tool — goes through the permission gate
        await delay(250);
        if (cancelled) return;
        const writeId = crypto.randomUUID();
        const decision = settings.defaultPolicy;
        let approved = decision !== "deny";
        if (decision === "ask") {
          const permId = crypto.randomUUID();
          onEvent({
            type: "permission_request",
            id: permId,
            tool: "fs_edit",
            summary: "src/App.tsx",
            input: { path: "src/App.tsx", old_string: "return x;", new_string: "return x + 1;" },
          });
          approved = await new Promise<boolean>((resolve) => {
            resolvers.set(permId, (d) => resolve(d === "allow"));
          }).then((v) => v);
        }
        if (cancelled) return;
        onEvent({ type: "tool_use", id: writeId, name: "fs_edit", input: { path: "src/App.tsx" } });
        await delay(250);
        onEvent({
          type: "tool_result",
          id: writeId,
          output: approved
            ? "Edited src/App.tsx (1 replacement(s))\n\n@@ -8,5 +8,5 @@\n function compute() {\n   const x = 1;\n-  return x;\n+  return x + 1;\n }\n"
            : "Denied: the user did not approve this action.",
          isError: !approved,
        });

        await delay(120);
        onEvent({ type: "usage", inputTokens: 1840, outputTokens: 720 });
        onEvent({ type: "turn_end", stopReason: "end_turn" });
      })();

      return {
        cancel: async () => {
          cancelled = true;
          resolvers.forEach((r) => r("deny"));
          resolvers.clear();
        },
        // Stop delivering this turn's events without the cancel/deny side effects.
        dispose: () => {
          cancelled = true;
        },
      };
    },
  };
})();
