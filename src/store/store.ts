import { create } from "zustand";
import type {
  ContentBlock,
  Message,
  MessageRow,
  OAuthStatus,
  PairingPayload,
  PairingRequest,
  PendingPermission,
  PhoneSyncStatus,
  RemoteCommand,
  Session,
  Settings,
  StreamEvent,
  SyncFrame,
  Usage,
} from "../types";
import { DEFAULT_SETTINGS } from "../types";
import * as ipc from "../lib/ipc";
import { isMobilePlatform } from "../lib/platform";

interface AppState {
  sessions: Session[];
  activeId: string | null;
  messages: Record<string, Message[]>; // sessionId -> messages
  usage: Record<string, Usage>; // sessionId -> cumulative token usage
  settings: Settings;
  oauthStatus: OAuthStatus | null; // Claude subscription sign-in state
  oauthError: string | null; // last sign-in/out failure, surfaced in Settings
  phoneSync: PhoneSyncStatus | null; // phone sync device identity + paired devices
  pairingPayload: PairingPayload | null; // in-progress pairing code to display
  pairingError: string | null; // last begin-pairing/unpair failure, surfaced in Settings
  // Desktop-side device-trust gate: a phone completed the handshake inside an open
  // pairing window and is awaiting the desktop user's SAS confirmation. Null when
  // no request is outstanding; surfaced in the Settings pairing UI.
  pairingRequest: PairingRequest | null;
  pairingRequestUnlisten: (() => void) | null; // tears down the pairing-request subscription
  creatingSession: boolean; // a newSession() create is in flight (re-entry guard)
  streaming: boolean;
  showSettings: boolean;
  showFiles: boolean;
  showSidebar: boolean; // mobile: the session-list drawer (overlay) is open
  showPalette: boolean;
  ambientRain: boolean; // decorative neon-rain backdrop (off by default)
  scanlines: boolean; // CRT scanline overlay (off by default)
  crashReporting: boolean | null; // opt-in crash/error reporting; null = not yet asked (show first-run prompt)
  draft: string;
  cancel: (() => Promise<void>) | null;
  pendingPermission: PendingPermission | null;

  // ── Error surfacing ─────────────────────────────────────────────────────────
  initError: string | null; // startup (init) failure — Chat shows an error/retry panel
  loadErrors: Record<string, boolean>; // sessionId -> a getMessages load failed; Chat offers retry
  settingsError: string | null; // last saveSettings failure, surfaced in Settings
  workspaceError: string | null; // last openWorkspace (picker/save) failure, surfaced in FileExplorer

  // ── Mobile remote client (this device is the phone driving a paired desktop) ──
  remoteMode: boolean; // render the remote-client shell (pairing → remote session) instead of the desktop layout
  remoteConnected: boolean; // a live desktop session is established
  remoteVerified: boolean; // the user confirmed the SAS matches; gates entry to the remote session
  remoteSas: string | null; // short-auth-string to compare out-of-band; null when not connected
  remoteError: string | null; // last connect failure, surfaced in the connect UI
  remoteUnlisten: (() => void) | null; // tears down the frame subscription (private; mirrors `cancel`)
  remoteDropped: boolean; // the live session ended unexpectedly — the UI offers a reconnect
  remoteConnecting: boolean; // a connectRemote dial is in flight (private re-entry guard)
  lastPairingQr: string | null; // last successful pairing payload, kept for one-tap reconnect
  remoteChatOpen: boolean; // remote: a session is open (chat view) vs. the sessions list
  online: boolean; // the device has network — remote needs it to reach the desktop

  init: () => Promise<void>;
  retryInit: () => Promise<void>;
  retryLoad: (id: string) => Promise<void>;
  toggleFiles: () => void;
  toggleSidebar: () => void;
  setShowSidebar: (v: boolean) => void;
  setDraft: (v: string) => void;
  appendDraft: (v: string) => void;
  openWorkspace: () => Promise<void>;
  newSession: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  setSessionModel: (model: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  stop: () => Promise<void>;
  setShowSettings: (v: boolean) => void;
  setShowPalette: (v: boolean) => void;
  setAmbientRain: (v: boolean) => void;
  setScanlines: (v: boolean) => void;
  setCrashReporting: (v: boolean) => void;
  updateSettings: (s: Partial<Settings>) => Promise<void>;
  refreshOAuthStatus: () => Promise<void>;
  loginWithClaude: () => Promise<void>;
  logoutClaude: () => Promise<void>;
  refreshPhoneSync: () => Promise<void>;
  beginPairing: () => Promise<void>;
  unpair: (publicKey: string) => Promise<void>;
  clearPairing: () => void;
  listenForPairingRequests: () => Promise<void>;
  confirmPairingRequest: () => Promise<void>;
  rejectPairingRequest: () => Promise<void>;
  resolvePermission: (decision: "allow" | "deny", always?: boolean) => Promise<void>;
  setRemoteMode: (v: boolean) => void;
  confirmRemoteSas: () => void;
  applyFrame: (frame: SyncFrame) => void;
  connectRemote: (qr: string, verified?: boolean) => Promise<void>;
  sendRemoteCommand: (command: RemoteCommand) => Promise<void>;
  disconnectRemote: () => Promise<void>;
  reconnectRemote: () => Promise<void>;
  openRemoteSession: (id: string) => Promise<void>;
  closeRemoteSession: () => void;
  forgetRemotePairing: () => void;
  setOnline: (v: boolean) => void;
}

const now = () => Date.now();

// A turn must always reach a terminal state. If the backend hangs or dies without
// emitting turn_end/error, this client-side watchdog force-ends the turn once the
// run has been idle this long, so `streaming` can never get stuck true (which would
// otherwise silently no-op every later send). Kept above the backend's own idle
// timeout so the backend's specific error wins in the normal stalled-network case.
const TURN_IDLE_TIMEOUT_MS = 150_000;

// Remote-turn idle watchdog (symmetric with the local one in send()). In remote
// mode the turn runs on the desktop and only a desktop-originated live frame can
// clear `streaming`; if the channel stays alive but the desktop's agent dies/hangs
// without emitting turn_end/error (no drop, the send resolved), the phone is stuck
// with a disabled composer forever. This module-scoped handle drives a force-end on
// idle. Module-scoped (not closure-scoped like the local watchdog) so the remote
// frame handler, drop listener, stop(), and disconnect can all reset/clear it.
let remoteWatchdog: ReturnType<typeof setInterval> | null = null;
let remoteLastActivity = 0;

const clearRemoteWatchdog = (): void => {
  if (remoteWatchdog !== null) {
    clearInterval(remoteWatchdog);
    remoteWatchdog = null;
  }
};

// Frontend-only UI preferences (decorative overlays). Cosmetic client state,
// not the Rust core's Settings — persisted in localStorage so they work the
// same in preview and native without an IPC round-trip.
const readPref = (k: string): boolean => {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
};
const writePref = (k: string, v: boolean): void => {
  try {
    localStorage.setItem(k, v ? "1" : "0");
  } catch {
    /* storage disabled / over quota — ignore */
  }
};

// Tri-state pref: null when never set (e.g. crash-reporting consent not yet
// asked), otherwise the stored boolean. Lets a first-run prompt distinguish
// "declined" from "not yet decided".
const readTriPref = (k: string): boolean | null => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
};

// String prefs (e.g. the remembered pairing payload — public connection info, not
// a secret). Same best-effort localStorage discipline as the boolean prefs.
const readStr = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const writeStr = (k: string, v: string | null): void => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage disabled / over quota — ignore */
  }
};

const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

function makeSession(model: string): Session {
  const t = now();
  return {
    id: uid(),
    title: "New chat",
    workspace: null,
    model,
    createdAt: t,
    updatedAt: t,
  };
}

export const useStore = create<AppState>((set, get) => ({
  sessions: [],
  activeId: null,
  messages: {},
  usage: {},
  settings: DEFAULT_SETTINGS,
  oauthStatus: null,
  oauthError: null,
  phoneSync: null,
  pairingPayload: null,
  pairingError: null,
  pairingRequest: null,
  pairingRequestUnlisten: null,
  creatingSession: false,
  streaming: false,
  showSettings: false,
  showFiles: false,
  showSidebar: false,
  showPalette: false,
  ambientRain: readPref("pc.ambientRain"),
  scanlines: readPref("pc.scanlines"),
  crashReporting: readTriPref("pc.crashReporting"),
  draft: "",
  cancel: null,
  pendingPermission: null,
  initError: null,
  loadErrors: {},
  settingsError: null,
  workspaceError: null,
  // Default into remote mode on a phone; desktop/preview start in the normal
  // layout and can opt in via setRemoteMode (e.g. the command palette) for testing.
  remoteMode: isMobilePlatform(),
  remoteConnected: false,
  remoteVerified: false,
  remoteSas: null,
  remoteError: null,
  remoteUnlisten: null,
  remoteDropped: false,
  remoteConnecting: false,
  // Remembered across launches so the phone can reconnect without re-scanning the
  // QR (Android frequently kills backgrounded apps). Public payload — no secret.
  lastPairingQr: readStr("pc.lastPairingQr"),
  // After SAS verification the remote lands on the sessions LIST; opening a session
  // flips this true (chat view). Reset on every disconnect/drop/fresh-dial.
  remoteChatOpen: false,
  // Network presence. Seeded from the browser; App keeps it live via online/offline
  // events. Remote mode shows the offline screen when this is false.
  online: typeof navigator !== "undefined" && "onLine" in navigator ? navigator.onLine : true,

  async init() {
    // The phone/remote client has no local sessions DB or settings — its session
    // and message state arrive authoritatively from the desktop's frames — and the
    // desktop-only Tauri commands below would reject on a real mobile build, leaving
    // a stale initError that paints a spurious "Couldn't start Portcode" panel over
    // the connected remote session. So init() is a no-op there (mirrors newSession).
    if (get().remoteMode) {
      set({ initError: null });
      return;
    }
    // Desktop is the SYNC SERVER: subscribe to inbound pairing-confirm requests so
    // the device-trust gate's prompt can surface in Settings. Fire-and-forget (the
    // listener install is resilient and the mock is inert), kept off the load-
    // bearing startup path below.
    void get().listenForPairingRequests();
    // Fetch settings, subscription status, and phone sync status together.
    // The oauth and phoneSync calls are kept resilient so an unwired/older
    // core can't block startup. The load-bearing calls (getSettings/listSessions/
    // createSession/getMessages) are guarded so a failed startup surfaces an
    // error+retry panel instead of a permanently blank welcome shell.
    try {
      const [settings, oauthStatus, phoneSync] = await Promise.all([
        ipc.getSettings(),
        ipc.oauthStatus().catch(() => null),
        ipc.phoneSyncStatus().catch(() => null),
      ]);
      const loaded = await ipc.listSessions();
      if (loaded.length === 0) {
        const s = makeSession(settings.model);
        await ipc.createSession(s.id, s.title, s.workspace, s.model);
        set({
          settings,
          oauthStatus,
          phoneSync,
          sessions: [s],
          activeId: s.id,
          messages: { [s.id]: [] },
          initError: null,
        });
        return;
      }
      // Old DB rows predate per-session model (null/absent) — coalesce to the
      // last-used default so Session.model stays a non-null string.
      const sessions = loaded.map((row) => ({ ...row, model: row.model ?? settings.model }));
      const activeId = sessions[0].id;
      const msgs = await ipc.getMessages(activeId);
      set({
        settings,
        oauthStatus,
        phoneSync,
        sessions,
        activeId,
        messages: { [activeId]: msgs },
        initError: null,
      });
    } catch (err) {
      set({ initError: errMessage(err) });
    }
  },

  async retryInit() {
    set({ initError: null });
    await get().init();
  },

  async retryLoad(id) {
    try {
      const msgs = await ipc.getMessages(id);
      set((st) => ({
        messages: { ...st.messages, [id]: msgs },
        loadErrors: { ...st.loadErrors, [id]: false },
      }));
    } catch {
      set((st) => ({ loadErrors: { ...st.loadErrors, [id]: true } }));
    }
  },

  async newSession() {
    // Don't strand a live turn: switching activeId mid-stream would leave the old
    // session's run folding events into a session the user can no longer see while
    // the new one shows a disabled composer. Mirrors selectSession/deleteSession.
    // Re-entry guard (mirrors connectRemote's remoteConnecting): createSession is
    // async, so two fast clicks would both pass the streaming check and each create
    // a distinct empty session. The synchronous set() below makes the second
    // same-tick call bail, so only one create runs.
    if (get().streaming || get().creatingSession) return;
    set({ creatingSession: true });
    // Remote mode: the agent-side `create_session` command is desktop-only (the
    // local Tauri invoke isn't registered on the phone and would reject as an
    // unhandled rejection). Route through the link instead and let the desktop's
    // authoritative `session_list` frame reconcile + activate the new session,
    // rather than optimistically inserting a phantom local one the desktop never
    // knows about (and that send() couldn't run a turn in).
    if (get().remoteConnected) {
      try {
        await get().sendRemoteCommand({ cmd: "create_session" });
      } finally {
        set({ creatingSession: false, showSidebar: false });
      }
      return;
    }
    try {
      const s = makeSession(get().settings.model);
      await ipc.createSession(s.id, s.title, s.workspace, s.model);
      set((st) => ({
        sessions: [s, ...st.sessions],
        activeId: s.id,
        messages: { ...st.messages, [s.id]: [] },
        showSidebar: false, // close the mobile drawer on navigation
      }));
    } catch (err) {
      // A failed create (locked DB / core not ready) must surface instead of being a
      // swallowed unhandled rejection — callers use bare `onClick={newSession}` /
      // `void newSession()`. Reuse initError so Chat's existing error/retry panel shows it.
      set({ initError: errMessage(err) });
    } finally {
      set({ creatingSession: false });
    }
  },

  async selectSession(id) {
    if (get().streaming) return;
    set({ activeId: id, showSidebar: false }); // close the mobile drawer on navigation
    if (!get().messages[id]) {
      // Guard the load: a getMessages reject must not leave messages[id] undefined
      // (the welcome EmptyState would then win for a session with real history).
      try {
        const msgs = await ipc.getMessages(id);
        set((st) => ({
          messages: { ...st.messages, [id]: msgs },
          loadErrors: { ...st.loadErrors, [id]: false },
        }));
      } catch {
        set((st) => ({ loadErrors: { ...st.loadErrors, [id]: true } }));
      }
    }
  },

  async deleteSession(id) {
    if (get().streaming) return;
    try {
      await ipc.deleteSession(id);
    } catch (err) {
      // A failed delete (locked DB / core not ready) must surface instead of being a
      // swallowed unhandled rejection — caller is a bare onClick={() => deleteSession(s.id)}.
      // Reuse initError so Chat's existing error/retry panel shows it; leave the list untouched.
      set({ initError: errMessage(err) });
      return;
    }
    set((st) => {
      const sessions = st.sessions.filter((s) => s.id !== id);
      const messages = { ...st.messages };
      delete messages[id];
      const activeId = st.activeId === id ? (sessions[0]?.id ?? null) : st.activeId;
      return { sessions, messages, activeId };
    });
    if (get().sessions.length === 0) {
      await get().newSession();
      return;
    }
    const aid = get().activeId;
    if (aid && !get().messages[aid]) {
      try {
        const msgs = await ipc.getMessages(aid);
        set((st) => ({
          messages: { ...st.messages, [aid]: msgs },
          loadErrors: { ...st.loadErrors, [aid]: false },
        }));
      } catch {
        set((st) => ({ loadErrors: { ...st.loadErrors, [aid]: true } }));
      }
    }
  },

  async setSessionModel(model) {
    // Point the active session at the chosen model, then mirror it into
    // settings.model so it becomes the "last used / default for new sessions".
    const activeId = get().activeId;
    if (activeId) {
      set((st) => ({
        sessions: st.sessions.map((s) => (s.id === activeId ? { ...s, model } : s)),
      }));
    }
    await get().updateSettings({ model });
  },

  async send(text) {
    const { activeId, streaming } = get();
    if (!activeId || streaming || !text.trim()) return;

    // Trim once so the stored user bubble and the forwarded command match the
    // derived (trimmed) title — a padded draft otherwise renders odd blank lines.
    const body = text.trim();

    // Remote mode: this device is the phone driving a paired desktop. Forward the
    // turn as a `run` command instead of running the local agent — the desktop is
    // authoritative and its reply streams back as live frames (which build the
    // assistant message). sendRemoteCommand already appends the optimistic user
    // message, so we don't pre-create messages. We DO flip `streaming` optimistically
    // (rather than waiting for the desktop's turn_start frame) to close the
    // double-submit window: the round-trip can be slow or dropped, and an enabled
    // composer would let a second Enter fire a duplicate `run`. Every terminal/drop
    // path (turn_end/error, the drop listener, the send catch, disconnectRemote)
    // already clears streaming:false, so the composer can't get stranded.
    if (get().remoteConnected) {
      set({ streaming: true });
      // Remote idle watchdog (symmetric with the local one below). The desktop is
      // authoritative, but if its agent dies/hangs without ever emitting
      // turn_end/error AND the channel stays up (no drop fires), nothing would clear
      // `streaming` and the composer would be stranded. Arm a timer that force-ends a
      // silent remote turn; every live frame for the active session resets it (see
      // applyFrame), and every terminal/teardown path clears it (turn_end/error in
      // applyRemoteEvent, the drop listener, the send-command catch, stop(),
      // disconnectRemote).
      clearRemoteWatchdog();
      remoteLastActivity = now();
      remoteWatchdog = setInterval(() => {
        // The turn already ended or was stopped elsewhere — just clean up.
        if (!get().streaming) {
          clearRemoteWatchdog();
          return;
        }
        if (now() - remoteLastActivity < TURN_IDLE_TIMEOUT_MS) return;
        // No live frame for the whole idle window → treat the desktop as hung and
        // recover, so the composer can't stay disabled forever.
        clearRemoteWatchdog();
        const sid = get().activeId;
        set((st) => ({
          streaming: false,
          pendingPermission: null,
          messages:
            sid !== null
              ? patchLast(st.messages, sid, (b) =>
                  appendText(b, "\n\n**The desktop stopped responding (timed out).**"),
                )
              : st.messages,
        }));
      }, 1000);
      await get().sendRemoteCommand({ cmd: "run", session_id: activeId, text: body });
      return;
    }

    const userMsg: Message = {
      id: uid(),
      role: "user",
      blocks: [{ kind: "text", text: body }],
      createdAt: now(),
    };
    const assistant: Message = {
      id: uid(),
      role: "assistant",
      blocks: [],
      createdAt: now(),
    };

    set((st) => {
      const msgs = st.messages[activeId] ?? [];
      const sessions = st.sessions.map((s) =>
        s.id === activeId
          ? {
              ...s,
              updatedAt: now(),
              title: msgs.length === 0 ? deriveTitle(body) : s.title,
            }
          : s,
      );
      return {
        sessions,
        streaming: true,
        messages: {
          ...st.messages,
          [activeId]: [...msgs, userMsg, assistant],
        },
      };
    });

    const apply = (fn: (blocks: ContentBlock[]) => ContentBlock[]) =>
      set((st) => {
        const msgs = st.messages[activeId] ?? [];
        const updated = msgs.map((m) =>
          m.id === assistant.id ? { ...m, blocks: fn(m.blocks) } : m,
        );
        return { messages: { ...st.messages, [activeId]: updated } };
      });

    // A turn must ALWAYS reach a terminal state. The Rust core emits turn_end/error,
    // but if it ever hangs or dies silently nothing would clear `streaming` — and
    // since send() no-ops while streaming, that would brick every future message.
    // So we (a) tear the per-turn event listener down the instant a turn ends — a
    // leaked listener folds the NEXT turn's deltas into this message — and (b) run a
    // client-side watchdog that force-ends a silent turn so the app always recovers.
    let run: Awaited<ReturnType<typeof ipc.runAgent>> | null = null;
    let settled = false;
    let lastActivity = now();
    let watchdog: ReturnType<typeof setInterval> | null = null;

    // Stop the watchdog + the per-turn listener exactly once. `cancelBackend` also
    // aborts a still-running turn on the core (watchdog timeout); a normal terminal
    // event only needs to stop listening (no spurious cancel_agent).
    const settle = (cancelBackend: boolean) => {
      if (settled) return;
      settled = true;
      if (watchdog !== null) {
        clearInterval(watchdog);
        watchdog = null;
      }
      if (cancelBackend) void run?.cancel();
      else run?.dispose();
    };

    const onEvent = (e: StreamEvent) => {
      lastActivity = now();
      switch (e.type) {
        case "text_delta":
          apply((blocks) => appendText(blocks, e.text));
          break;
        case "tool_use":
          apply((blocks) => [
            ...blocks,
            { kind: "tool_use", id: e.id, name: e.name, input: e.input },
          ]);
          break;
        case "tool_result":
          apply((blocks) => [
            ...blocks,
            {
              kind: "tool_result",
              toolUseId: e.id,
              output: e.output,
              isError: e.isError,
            },
          ]);
          break;
        case "permission_request":
          set({
            pendingPermission: {
              id: e.id,
              tool: e.tool,
              summary: e.summary,
              input: e.input,
            },
          });
          break;
        case "usage":
          set((st) => {
            const cur = st.usage[activeId] ?? { input: 0, output: 0 };
            return {
              usage: {
                ...st.usage,
                [activeId]: {
                  input: cur.input + e.inputTokens,
                  output: cur.output + e.outputTokens,
                },
              },
            };
          });
          break;
        case "error":
          apply((blocks) => appendText(blocks, `\n\n**Error:** ${e.message}`));
          settle(false);
          set({ streaming: false, cancel: null, pendingPermission: null });
          break;
        case "turn_end":
          settle(false);
          set({ streaming: false, cancel: null, pendingPermission: null });
          break;
      }
    };

    watchdog = setInterval(() => {
      // The turn already ended or was stopped elsewhere (e.g. Stop) — just clean up.
      if (settled || !get().streaming) {
        settle(false);
        return;
      }
      // No event for the whole idle window → treat the turn as hung and recover, so
      // the composer can't stay disabled forever.
      if (now() - lastActivity < TURN_IDLE_TIMEOUT_MS) return;
      settle(true);
      onEvent({
        type: "error",
        message: "The agent stopped responding (timed out). Please try again.",
      });
    }, 1000);

    try {
      // Per-session model (PR #30): fall back to the global default for older rows.
      const session = get().sessions.find((s) => s.id === activeId);
      const model = session?.model ?? get().settings.model;
      const handle = await ipc.runAgent(activeId, body, model, onEvent);
      run = handle;
      if (settled) {
        // A terminal event (or the watchdog) settled the turn before the handle
        // resolved. settle() already ran with run===null (a no-op), so the now-resolved
        // handle still needs its listener torn down. The terminal event already issued
        // any backend cancel it needed, so just dispose — no spurious cancel_agent.
        handle.dispose();
      } else if (!get().streaming) {
        // The turn isn't settled, but streaming already flipped false — the user
        // pressed Stop DURING the await window, when the cancel handle was still null
        // so stop() couldn't abort the backend. Honor that Stop authoritatively now:
        // settle(true) cancels the still-pending backend turn (cancel_agent) AND
        // disposes the listener, so no further deltas can fold in and no stale Stop is
        // re-armed.
        settle(true);
      } else {
        // Stop aborts the run AND clears this turn's watchdog (owned by this closure).
        set({
          cancel: async () => {
            settle(false);
            await handle.cancel();
          },
        });
      }
    } catch (err) {
      onEvent({ type: "error", message: String(err) });
    }
  },

  async stop() {
    // Remote mode: the turn runs on the desktop, so stop it with a Cancel command
    // over the link (there is no local `cancel` handle on the phone).
    if (get().remoteConnected) {
      clearRemoteWatchdog(); // the turn is over — stop the idle watchdog
      const activeId = get().activeId;
      if (activeId) await get().sendRemoteCommand({ cmd: "cancel", session_id: activeId });
      set({ streaming: false, pendingPermission: null });
      return;
    }
    const c = get().cancel;
    try {
      if (c) await c();
    } catch {
      /* the cancel_agent IPC failed; recover the UI anyway so the composer isn't stuck */
    } finally {
      set({ streaming: false, cancel: null, pendingPermission: null });
    }
  },

  async resolvePermission(decision, always) {
    const p = get().pendingPermission;
    if (!p) return;
    const id = p.id;

    // Remote mode: the permission gate belongs to the desktop's agent run, so
    // answer it as a Permission command over the link — the local
    // `resolve_permission` is desktop-only and not registered on the phone. The
    // "always" policy is a desktop-side setting the phone can't change through
    // this command, so it's ignored on the remote path. The same stale-click
    // guard applies (don't answer a request a newer one superseded).
    if (get().remoteConnected) {
      const current = get().pendingPermission;
      if (current && current.id !== id) return;
      set({ pendingPermission: null });
      await get().sendRemoteCommand({ cmd: "permission", id, decision });
      return;
    }

    // A superseding request may have replaced the prompt while we awaited
    // (or between render and click); only resolve the request we captured so a
    // stale click can't clear/answer a newer one.
    const current = get().pendingPermission;
    if (current && current.id !== id) return;
    // Answer the backend gate FIRST (and clear the banner), so a later
    // best-effort policy save can't strand the prompt or leave the gate
    // unanswered if updateSettings rejects.
    set({ pendingPermission: null });
    await ipc.resolvePermission(id, decision);
    if (always && decision === "allow") {
      await get().updateSettings({ defaultPolicy: "allow" });
    }
  },

  setShowSettings(v) {
    set({ showSettings: v });
  },

  setShowPalette(v) {
    set({ showPalette: v });
  },

  setAmbientRain(v) {
    writePref("pc.ambientRain", v);
    set({ ambientRain: v });
  },

  setScanlines(v) {
    writePref("pc.scanlines", v);
    set({ scanlines: v });
  },

  // Persist the consent choice; the frontend SDK init/shutdown is driven by an
  // effect in App watching `crashReporting`, so the store stays free of any
  // telemetry-SDK import (keeps it pure + its tests lightweight). We ALSO mirror
  // the choice to the Rust host (best-effort: swallow errors so the mobile build —
  // where the command isn't registered — and DSN-less dev builds don't throw).
  setCrashReporting(v) {
    writePref("pc.crashReporting", v);
    set({ crashReporting: v });
    void ipc.setTelemetryConsent(v).catch(() => {});
  },

  toggleFiles() {
    set((st) => ({ showFiles: !st.showFiles }));
  },

  toggleSidebar() {
    set((st) => ({ showSidebar: !st.showSidebar }));
  },

  setShowSidebar(v) {
    set({ showSidebar: v });
  },

  setDraft(v) {
    set({ draft: v });
  },

  appendDraft(v) {
    set((st) => {
      const sep = st.draft && !st.draft.endsWith(" ") ? " " : "";
      return { draft: st.draft + sep + v + " " };
    });
  },

  async openWorkspace() {
    // Guard the picker + save: a dialog/save reject must surface in the explorer
    // instead of being a silent unhandled rejection (all callers use `void`).
    // Persist directly (not via updateSettings, which swallows into settingsError)
    // so a save failure lands in workspaceError, the explorer's own surface.
    set({ workspaceError: null });
    try {
      const dir = await ipc.openFolder();
      if (dir) {
        const next = await ipc.saveSettings({ workspace: dir });
        set({ settings: next });
      }
    } catch (err) {
      set({ workspaceError: errMessage(err) });
    }
  },

  async updateSettings(s) {
    // Fail loudly: a saveSettings reject must surface (so the controlled UI doesn't
    // silently snap back to the old value) instead of being a swallowed rejection.
    set({ settingsError: null });
    try {
      const next = await ipc.saveSettings(s);
      set({ settings: next });
    } catch (err) {
      set({ settingsError: errMessage(err) });
    }
  },

  async refreshOAuthStatus() {
    try {
      const oauthStatus = await ipc.oauthStatus();
      set({ oauthStatus });
    } catch {
      // Transient / core not ready — keep whatever we last knew.
    }
  },

  async loginWithClaude() {
    set({ oauthError: null });
    try {
      const oauthStatus = await ipc.startOauthLogin();
      set({ oauthStatus });
    } catch (err) {
      set({ oauthError: errMessage(err) });
    }
  },

  async logoutClaude() {
    set({ oauthError: null });
    try {
      await ipc.oauthLogout();
      set({ oauthStatus: { signedIn: false, expiresAt: null, account: null, tier: null } });
    } catch (err) {
      set({ oauthError: errMessage(err) });
    }
  },

  async refreshPhoneSync() {
    try {
      const phoneSync = await ipc.phoneSyncStatus();
      set({ phoneSync });
    } catch {
      // Transient / core not ready — keep whatever we last knew.
    }
  },

  async beginPairing() {
    // Fail loudly: phoneSyncBeginPairing is fallible (lock poison / identity / begin)
    // and the Settings UI calls this via `void`, so a swallowed rejection would leave
    // the user stranded with no QR and no feedback. Surface it via pairingError.
    set({ pairingError: null });
    try {
      const pairingPayload = await ipc.phoneSyncBeginPairing();
      set({ pairingPayload });
    } catch (err) {
      set({ pairingError: errMessage(err) });
    }
  },

  async unpair(publicKey) {
    set({ pairingError: null });
    try {
      await ipc.phoneSyncUnpair(publicKey);
      await get().refreshPhoneSync();
    } catch (err) {
      set({ pairingError: errMessage(err) });
    }
  },

  clearPairing() {
    set({ pairingPayload: null });
  },

  // Subscribe to the desktop-side "a new phone wants to pair" event so the
  // Settings pairing UI can surface the SAS + Confirm/Reject. Idempotent: tears
  // down any prior subscription first so a re-open never double-registers. The
  // browser mock's listener is inert (it never fires), so this is a safe no-op
  // there too.
  async listenForPairingRequests() {
    const prev = get().pairingRequestUnlisten;
    if (prev) prev();
    set({ pairingRequestUnlisten: null });
    try {
      const unlisten = await ipc.onPhoneSyncPairingRequest((req) => {
        set({ pairingRequest: req });
      });
      set({ pairingRequestUnlisten: unlisten });
    } catch {
      // Core not ready / event unsupported — leave the gate UI dormant.
    }
  },

  async confirmPairingRequest() {
    const req = get().pairingRequest;
    if (!req) return;
    // Clear the prompt up front so a double-click can't fire two confirms; surface
    // a failure via pairingError and refresh the (now-trusted) device list.
    set({ pairingRequest: null, pairingError: null });
    try {
      await ipc.confirmPairing(req.requestId);
      await get().refreshPhoneSync();
    } catch (err) {
      set({ pairingError: errMessage(err) });
    }
  },

  async rejectPairingRequest() {
    const req = get().pairingRequest;
    if (!req) return;
    set({ pairingRequest: null, pairingError: null });
    try {
      await ipc.rejectPairing(req.requestId);
    } catch (err) {
      set({ pairingError: errMessage(err) });
    }
  },

  // ── Mobile remote client ──────────────────────────────────────────────────
  setRemoteMode(v) {
    set({ remoteMode: v });
  },

  // The user confirmed the SAS matches the desktop's — open the remote session.
  confirmRemoteSas() {
    set({ remoteVerified: true });
  },

  applyFrame(frame) {
    switch (frame.t) {
      case "session_list":
        set((st) => {
          // Keep activeId sane: keep the current one if it still exists, else
          // point at the first reported session (or null).
          const ids = frame.sessions.map((s) => s.id);
          const activeId =
            st.activeId && ids.includes(st.activeId)
              ? st.activeId
              : (frame.sessions[0]?.id ?? null);
          return { sessions: frame.sessions, activeId };
        });
        break;
      case "message_delta":
        set((st) => ({
          // Catch-up is authoritative for this session: REPLACE its message list.
          // This is what reconciles any optimistic user message we appended.
          messages: { ...st.messages, [frame.session_id]: frame.messages.map(rowToMessage) },
          activeId: st.activeId ?? frame.session_id,
        }));
        break;
      case "live":
        // Keep the remote idle watchdog alive: any live frame for the active session
        // is proof the desktop is still talking, so reset its last-activity clock.
        if (frame.session_id === get().activeId) remoteLastActivity = now();
        applyRemoteEvent(set, frame.session_id, frame.event);
        break;
      // command / ack / hello are phone-originated or not actionable inbound.
      case "command":
      case "ack":
      case "hello":
        break;
    }
  },

  async connectRemote(qr, verified = false) {
    // Re-entry guard: two interleaved dials (e.g. Reconnect + Scan/Connect) would
    // each register a fresh onPhoneSyncFrame listener across the awaits below,
    // orphaning one subscription that keeps double-feeding applyFrame. Serialize so
    // only one dial runs at a time.
    if (get().remoteConnecting) return;
    set({ remoteConnecting: true });
    // Clean reconnect: tear down any prior subscriptions before dialing so a second
    // connect can never leave two live listeners feeding the store.
    const prev = get().remoteUnlisten;
    if (prev) prev();
    // A fresh dial is unverified until the user compares the new SAS.
    // Reset connection AND turn state. A fresh dial / reconnect must never inherit a
    // stale `streaming`/`pendingPermission` from a turn the previous session left
    // mid-flight — a drop can't deliver the `turn_end` that would have cleared them,
    // so without this a reconnect lands in a disabled composer + a dead permission
    // prompt. If the desktop turn is genuinely still live, its catch-up/live frames
    // re-establish `streaming` after the dial.
    set({
      remoteUnlisten: null,
      remoteError: null,
      remoteVerified: false,
      remoteChatOpen: false,
      streaming: false,
      pendingPermission: null,
    });
    let unlistenFrame: (() => void) | null = null;
    let unlistenDrop: (() => void) | null = null;
    try {
      // `verified` doubles as the reconnect flag: a pre-verified dial is a
      // remembered-desktop reconnect, which binds an empty handshake prologue to
      // match the desktop's closed pairing window. A fresh (unverified) dial is a
      // first pairing and binds the QR nonce.
      const info = await ipc.phoneSyncConnect(qr, verified);
      // A disconnectRemote that landed mid-dial cleared remoteConnecting as an abort
      // sentinel. Honor it: bail BEFORE registering the frame/drop listeners (so no
      // orphaned subscription is ever created) and tear down the native session the
      // dial just opened, otherwise connectRemote's success set() would silently
      // override the user's explicit disconnect and resurrect a connection they ended.
      // (unlistenFrame/unlistenDrop are still null here — they're only created below —
      // so there is nothing to unsubscribe, just the native channel to close.)
      if (!get().remoteConnecting) {
        await ipc.phoneSyncDisconnect().catch(() => {});
        return;
      }
      // Subscribe only after a successful dial; route every frame through
      // get().applyFrame so the latest action closure folds against live state.
      unlistenFrame = await ipc.onPhoneSyncFrame((f) => get().applyFrame(f));
      // Detect an UNEXPECTED drop (desktop closed the channel / network dropped) so
      // the UI can leave the dead session and offer a reconnect. A user-initiated
      // disconnect tears this listener down first, so it can't misfire as a drop.
      unlistenDrop = await ipc.onPhoneSyncDisconnected(() => {
        // The turn is dead when the channel drops — clear turn state too, not just
        // connection flags, so neither the interim nor the reconnected session is
        // stuck on a stale `streaming`/`pendingPermission`.
        clearRemoteWatchdog();
        set({
          remoteConnected: false,
          remoteVerified: false,
          remoteDropped: true,
          remoteChatOpen: false,
          streaming: false,
          pendingPermission: null,
        });
      });
      // Remember the desktop across launches (public payload — no secret).
      writeStr("pc.lastPairingQr", qr);
      set({
        remoteConnected: true,
        // A pin-matched reconnect is pre-verified (the native pin check
        // re-authenticated the same desktop key); a first dial never is.
        remoteVerified: verified,
        remoteSas: info.sas,
        remoteError: null,
        remoteDropped: false,
        lastPairingQr: qr,
        remoteUnlisten: () => {
          unlistenFrame?.();
          unlistenDrop?.();
        },
      });
    } catch (err) {
      // A listener may have registered before a later step threw (e.g. the dial
      // succeeded but onPhoneSyncDisconnected rejected). Tear down any partial
      // subscription AND the native session so nothing leaks. phoneSyncDisconnect
      // is idempotent — a no-op when the dial itself failed.
      unlistenDrop?.();
      unlistenFrame?.();
      await ipc.phoneSyncDisconnect().catch(() => {});
      set({
        remoteConnected: false,
        remoteSas: null,
        remoteUnlisten: null,
        remoteError: errMessage(err),
      });
    } finally {
      // Release the re-entry lock whether the dial succeeded or failed, so a later
      // connect can proceed.
      set({ remoteConnecting: false });
    }
  },

  async sendRemoteCommand(command) {
    // Optimistic echo for `run`: show the user's message immediately. The
    // desktop's authoritative message_delta catch-up later REPLACES this
    // session's list, reconciling the optimistic row (no duplicate). Other
    // commands have nothing to echo locally.
    if (command.cmd === "run") {
      const { session_id, text } = command;
      const userMsg: Message = {
        id: uid(),
        role: "user",
        blocks: [{ kind: "text", text }],
        createdAt: now(),
      };
      set((st) => ({
        messages: {
          ...st.messages,
          [session_id]: [...(st.messages[session_id] ?? []), userMsg],
        },
      }));
    }
    // The channel often drops between frames (Android kills backgrounded apps).
    // Callers swallow the rejection (`void send`/`stop`), so a dropped link would
    // silently strand the optimistic message. Handle it here: annotate the message
    // and surface the existing reconnect UI via remoteDropped.
    try {
      await ipc.phoneSyncSendCommand(command);
    } catch {
      if (command.cmd === "run") {
        const sid = command.session_id;
        set((st) => ({
          messages: patchLast(st.messages, sid, (b) =>
            appendText(b, "\n\n**Couldn't reach your desktop — the link may have dropped.**"),
          ),
        }));
      }
      clearRemoteWatchdog(); // the turn can't proceed on a dropped link
      set({ remoteDropped: true, streaming: false });
    }
  },

  async disconnectRemote() {
    clearRemoteWatchdog(); // user-initiated teardown — the turn is over
    const unlisten = get().remoteUnlisten;
    // Flip the connection flags FIRST, before the async teardown. `remoteConnected`
    // is the routing source of truth for send/stop/resolvePermission, so clearing it
    // up front guarantees no command is dispatched onto the closing channel while
    // `phoneSyncDisconnect` is in flight.
    // User-initiated, so also clear the dropped flag and forget the pairing — the
    // reconnect prompt is for an unexpected drop, not an intentional teardown.
    set({
      remoteConnected: false,
      remoteVerified: false,
      remoteSas: null,
      remoteDropped: false,
      lastPairingQr: null,
      remoteUnlisten: null,
      // Doubles as an abort sentinel for an in-flight connectRemote dial: a dial that
      // resolves after this re-reads remoteConnecting, sees false, and bails before
      // registering its frame/drop listeners (instead of overriding this disconnect
      // and leaking the about-to-register subscriptions onto a torn-down channel).
      // connectRemote's own finally clears this in steady state, so this is a no-op
      // when no dial is in flight.
      remoteConnecting: false,
      remoteChatOpen: false,
      streaming: false, // the turn is over — don't strand a stuck composer
      pendingPermission: null,
    });
    writeStr("pc.lastPairingQr", null); // forget the remembered desktop too
    if (unlisten) unlisten();
    await ipc.phoneSyncDisconnect();
  },

  async reconnectRemote() {
    const qr = get().lastPairingQr;
    if (!qr) return;
    set({ remoteDropped: false });
    // Re-dial the remembered desktop, PRE-VERIFIED: the native pin check
    // re-authenticates the same static key the user already trusted at first
    // pairing, so no fresh SAS comparison is needed.
    await get().connectRemote(qr, true);
  },

  // Open a session from the remote sessions list — switch to it, then reveal the
  // chat view. selectSession is the single source of truth for activeId + lazy
  // message load (and is a no-op mid-stream); opening the chat is unconditional so
  // tapping the already-active running session still enters it.
  async openRemoteSession(id) {
    await get().selectSession(id);
    set({ remoteChatOpen: true });
  },

  // Back out of the chat view to the remote sessions list. The connection stays
  // live — this is pure in-app navigation, not a disconnect.
  closeRemoteSession() {
    set({ remoteChatOpen: false });
  },

  // Forget the remembered desktop and clear the dropped flag so the UI falls back
  // to the fresh pairing screen ("Pair a different desktop" from the drop screen).
  // The channel is already down here, so there's nothing to tear down.
  forgetRemotePairing() {
    writeStr("pc.lastPairingQr", null);
    set({ lastPairingQr: null, remoteDropped: false });
  },

  // Network presence, driven by the browser's online/offline events (see App).
  // Remote mode shows the offline screen while this is false.
  setOnline(v) {
    set({ online: v });
  },
}));

function appendText(blocks: ContentBlock[], text: string): ContentBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === "text") {
    return [...blocks.slice(0, -1), { kind: "text", text: last.text + text }];
  }
  return [...blocks, { kind: "text", text }];
}

function deriveTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 42 ? t.slice(0, 42) + "…" : t || "New chat";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Convert a desktop catch-up row (MessageRow: carries sessionId + seq) to the
// in-memory Message shape the UI renders.
function rowToMessage(r: MessageRow): Message {
  return { id: r.id, role: r.role, blocks: r.content, createdAt: r.createdAt };
}

// Apply fn to the LAST message of a session, immutably. No-op when the session
// has no messages yet — the guard for a stray delta arriving before turn_start.
function patchLast(
  messages: Record<string, Message[]>,
  sessionId: string,
  fn: (blocks: ContentBlock[]) => ContentBlock[],
): Record<string, Message[]> {
  const msgs = messages[sessionId];
  if (!msgs || msgs.length === 0) return messages;
  const i = msgs.length - 1;
  const last = msgs[i];
  const updated = [...msgs];
  updated[i] = { ...last, blocks: fn(last.blocks) };
  return { ...messages, [sessionId]: updated };
}

type RemoteSetter = (fn: (st: AppState) => Partial<AppState>) => void;

// Fold one live StreamEvent (forwarded from the paired desktop) into store state
// for `sessionId`. Mirrors `send`'s local onEvent, but the phone BUILDS the
// assistant message from turn_start rather than pre-creating it. Does NOT touch
// `cancel` (that handle belongs to a local desktop run).
//
// Per-session message patching is always applied (a background session must still
// build its history). But the GLOBAL UI flags — `streaming` and `pendingPermission`
// — drive the visible composer/HUD and the permission gate, so they are only
// touched when the frame's session is the one on screen. Otherwise a background
// session's turn would flip the visible composer or pop a permission prompt the
// user has no context for (and would answer blind).
function applyRemoteEvent(set: RemoteSetter, sessionId: string, e: StreamEvent): void {
  switch (e.type) {
    case "turn_start":
      set((st) => {
        const isActive = st.activeId === sessionId;
        const msgs = st.messages[sessionId] ?? [];
        const assistant: Message = {
          id: e.messageId,
          role: "assistant",
          blocks: [],
          createdAt: now(),
        };
        return {
          // Only flip the visible streaming indicator for the active session.
          ...(isActive ? { streaming: true } : {}),
          messages: { ...st.messages, [sessionId]: [...msgs, assistant] },
        };
      });
      break;
    case "text_delta":
      set((st) => ({
        messages: patchLast(st.messages, sessionId, (b) => appendText(b, e.text)),
      }));
      break;
    case "tool_use":
      set((st) => ({
        messages: patchLast(st.messages, sessionId, (b) => [
          ...b,
          { kind: "tool_use", id: e.id, name: e.name, input: e.input },
        ]),
      }));
      break;
    case "tool_result":
      set((st) => ({
        messages: patchLast(st.messages, sessionId, (b) => [
          ...b,
          { kind: "tool_result", toolUseId: e.id, output: e.output, isError: e.isError },
        ]),
      }));
      break;
    case "permission_request":
      set((st) =>
        st.activeId === sessionId
          ? { pendingPermission: { id: e.id, tool: e.tool, summary: e.summary, input: e.input } }
          : {},
      );
      break;
    case "usage":
      set((st) => {
        const cur = st.usage[sessionId] ?? { input: 0, output: 0 };
        return {
          usage: {
            ...st.usage,
            [sessionId]: {
              input: cur.input + e.inputTokens,
              output: cur.output + e.outputTokens,
            },
          },
        };
      });
      break;
    case "error":
      // A terminal frame for the active session ends the turn — stop the remote idle
      // watchdog (it self-clears on its next tick once streaming is false, but clear
      // it eagerly so it can't fire a spurious timeout in the meantime).
      if (useStore.getState().activeId === sessionId) clearRemoteWatchdog();
      set((st) => ({
        messages: patchLast(st.messages, sessionId, (b) =>
          appendText(b, `\n\n**Error:** ${e.message}`),
        ),
        // Only clear the visible turn flags when this is the active session.
        ...(st.activeId === sessionId ? { streaming: false, pendingPermission: null } : {}),
      }));
      break;
    case "turn_end":
      if (useStore.getState().activeId === sessionId) clearRemoteWatchdog();
      set((st) => (st.activeId === sessionId ? { streaming: false, pendingPermission: null } : {}));
      break;
  }
}
