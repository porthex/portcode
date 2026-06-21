import { create } from "zustand";
import type {
  ContentBlock,
  Message,
  MessageRow,
  OAuthStatus,
  PairingPayload,
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
  streaming: boolean;
  showSettings: boolean;
  showFiles: boolean;
  showSidebar: boolean; // mobile: the session-list drawer (overlay) is open
  showPalette: boolean;
  ambientRain: boolean; // decorative neon-rain backdrop (off by default)
  scanlines: boolean; // CRT scanline overlay (off by default)
  draft: string;
  cancel: (() => Promise<void>) | null;
  pendingPermission: PendingPermission | null;

  // ── Mobile remote client (this device is the phone driving a paired desktop) ──
  remoteMode: boolean; // render the remote-client shell (pairing → remote session) instead of the desktop layout
  remoteConnected: boolean; // a live desktop session is established
  remoteVerified: boolean; // the user confirmed the SAS matches; gates entry to the remote session
  remoteSas: string | null; // short-auth-string to compare out-of-band; null when not connected
  remoteError: string | null; // last connect failure, surfaced in the connect UI
  remoteUnlisten: (() => void) | null; // tears down the frame subscription (private; mirrors `cancel`)
  remoteDropped: boolean; // the live session ended unexpectedly — the UI offers a reconnect
  lastPairingQr: string | null; // last successful pairing payload, kept for one-tap reconnect

  init: () => Promise<void>;
  toggleFiles: () => void;
  toggleSidebar: () => void;
  setShowSidebar: (v: boolean) => void;
  setDraft: (v: string) => void;
  appendDraft: (v: string) => void;
  openWorkspace: () => Promise<void>;
  newSession: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  stop: () => Promise<void>;
  setShowSettings: (v: boolean) => void;
  setShowPalette: (v: boolean) => void;
  setAmbientRain: (v: boolean) => void;
  setScanlines: (v: boolean) => void;
  updateSettings: (s: Partial<Settings>) => Promise<void>;
  refreshOAuthStatus: () => Promise<void>;
  loginWithClaude: () => Promise<void>;
  logoutClaude: () => Promise<void>;
  refreshPhoneSync: () => Promise<void>;
  beginPairing: () => Promise<void>;
  unpair: (publicKey: string) => Promise<void>;
  clearPairing: () => void;
  resolvePermission: (decision: "allow" | "deny", always?: boolean) => Promise<void>;
  setRemoteMode: (v: boolean) => void;
  confirmRemoteSas: () => void;
  applyFrame: (frame: SyncFrame) => void;
  connectRemote: (qr: string, verified?: boolean) => Promise<void>;
  sendRemoteCommand: (command: RemoteCommand) => Promise<void>;
  disconnectRemote: () => Promise<void>;
  reconnectRemote: () => Promise<void>;
}

const now = () => Date.now();

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

function makeSession(): Session {
  const t = now();
  return {
    id: uid(),
    title: "New chat",
    workspace: null,
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
  streaming: false,
  showSettings: false,
  showFiles: false,
  showSidebar: false,
  showPalette: false,
  ambientRain: readPref("pc.ambientRain"),
  scanlines: readPref("pc.scanlines"),
  draft: "",
  cancel: null,
  pendingPermission: null,
  // Default into remote mode on a phone; desktop/preview start in the normal
  // layout and can opt in via setRemoteMode (e.g. the command palette) for testing.
  remoteMode: isMobilePlatform(),
  remoteConnected: false,
  remoteVerified: false,
  remoteSas: null,
  remoteError: null,
  remoteUnlisten: null,
  remoteDropped: false,
  // Remembered across launches so the phone can reconnect without re-scanning the
  // QR (Android frequently kills backgrounded apps). Public payload — no secret.
  lastPairingQr: readStr("pc.lastPairingQr"),

  async init() {
    // Fetch settings, subscription status, and phone sync status together.
    // The oauth and phoneSync calls are kept resilient so an unwired/older
    // core can't block startup.
    const [settings, oauthStatus, phoneSync] = await Promise.all([
      ipc.getSettings(),
      ipc.oauthStatus().catch(() => null),
      ipc.phoneSyncStatus().catch(() => null),
    ]);
    const sessions = await ipc.listSessions();
    if (sessions.length === 0) {
      const s = makeSession();
      await ipc.createSession(s.id, s.title, s.workspace);
      set({
        settings,
        oauthStatus,
        phoneSync,
        sessions: [s],
        activeId: s.id,
        messages: { [s.id]: [] },
      });
      return;
    }
    const activeId = sessions[0].id;
    const msgs = await ipc.getMessages(activeId);
    set({ settings, oauthStatus, phoneSync, sessions, activeId, messages: { [activeId]: msgs } });
  },

  async newSession() {
    const s = makeSession();
    await ipc.createSession(s.id, s.title, s.workspace);
    set((st) => ({
      sessions: [s, ...st.sessions],
      activeId: s.id,
      messages: { ...st.messages, [s.id]: [] },
      showSidebar: false, // close the mobile drawer on navigation
    }));
  },

  async selectSession(id) {
    if (get().streaming) return;
    set({ activeId: id, showSidebar: false }); // close the mobile drawer on navigation
    if (!get().messages[id]) {
      const msgs = await ipc.getMessages(id);
      set((st) => ({ messages: { ...st.messages, [id]: msgs } }));
    }
  },

  async deleteSession(id) {
    if (get().streaming) return;
    await ipc.deleteSession(id);
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
      const msgs = await ipc.getMessages(aid);
      set((st) => ({ messages: { ...st.messages, [aid]: msgs } }));
    }
  },

  async send(text) {
    const { activeId, streaming } = get();
    if (!activeId || streaming || !text.trim()) return;

    // Remote mode: this device is the phone driving a paired desktop. Forward the
    // turn as a `run` command instead of running the local agent — the desktop is
    // authoritative and its reply streams back as live frames (which build the
    // assistant message). sendRemoteCommand already appends the optimistic user
    // message, so we neither pre-create messages nor flip `streaming` here.
    if (get().remoteConnected) {
      await get().sendRemoteCommand({ cmd: "run", session_id: activeId, text });
      return;
    }

    const userMsg: Message = {
      id: uid(),
      role: "user",
      blocks: [{ kind: "text", text }],
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
              title: msgs.length === 0 ? deriveTitle(text) : s.title,
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

    const onEvent = (e: StreamEvent) => {
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
          set({ streaming: false, cancel: null, pendingPermission: null });
          break;
        case "turn_end":
          set({ streaming: false, cancel: null, pendingPermission: null });
          break;
      }
    };

    try {
      const handle = await ipc.runAgent(activeId, text, onEvent);
      set({ cancel: handle.cancel });
    } catch (err) {
      onEvent({ type: "error", message: String(err) });
    }
  },

  async stop() {
    // Remote mode: the turn runs on the desktop, so stop it with a Cancel command
    // over the link (there is no local `cancel` handle on the phone).
    if (get().remoteConnected) {
      const activeId = get().activeId;
      if (activeId) await get().sendRemoteCommand({ cmd: "cancel", session_id: activeId });
      set({ streaming: false, pendingPermission: null });
      return;
    }
    const c = get().cancel;
    if (c) await c();
    set({ streaming: false, cancel: null, pendingPermission: null });
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

    if (always && decision === "allow") {
      await get().updateSettings({ defaultPolicy: "allow" });
    }
    // A superseding request may have replaced the prompt while we awaited
    // (or between render and click); only resolve the request we captured so a
    // stale click can't clear/answer a newer one.
    const current = get().pendingPermission;
    if (current && current.id !== id) return;
    set({ pendingPermission: null });
    await ipc.resolvePermission(id, decision);
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
    const dir = await ipc.openFolder();
    if (dir) await get().updateSettings({ workspace: dir });
  },

  async updateSettings(s) {
    const next = await ipc.saveSettings(s);
    set({ settings: next });
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
    const pairingPayload = await ipc.phoneSyncBeginPairing();
    set({ pairingPayload });
  },

  async unpair(publicKey) {
    await ipc.phoneSyncUnpair(publicKey);
    await get().refreshPhoneSync();
  },

  clearPairing() {
    set({ pairingPayload: null });
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
    // Clean reconnect: tear down any prior subscriptions before dialing so a second
    // connect can never leave two live listeners feeding the store.
    const prev = get().remoteUnlisten;
    if (prev) prev();
    // A fresh dial is unverified until the user compares the new SAS.
    set({ remoteUnlisten: null, remoteError: null, remoteVerified: false });
    let unlistenFrame: (() => void) | null = null;
    let unlistenDrop: (() => void) | null = null;
    try {
      const info = await ipc.phoneSyncConnect(qr);
      // Subscribe only after a successful dial; route every frame through
      // get().applyFrame so the latest action closure folds against live state.
      unlistenFrame = await ipc.onPhoneSyncFrame((f) => get().applyFrame(f));
      // Detect an UNEXPECTED drop (desktop closed the channel / network dropped) so
      // the UI can leave the dead session and offer a reconnect. A user-initiated
      // disconnect tears this listener down first, so it can't misfire as a drop.
      unlistenDrop = await ipc.onPhoneSyncDisconnected(() => {
        set({ remoteConnected: false, remoteVerified: false, remoteDropped: true });
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
    await ipc.phoneSyncSendCommand(command);
  },

  async disconnectRemote() {
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
// `cancel` (that handle belongs to a local desktop run); it does set/clear
// `streaming` + `pendingPermission` so the phone UI stays honest.
function applyRemoteEvent(set: RemoteSetter, sessionId: string, e: StreamEvent): void {
  switch (e.type) {
    case "turn_start":
      set((st) => {
        const msgs = st.messages[sessionId] ?? [];
        const assistant: Message = {
          id: e.messageId,
          role: "assistant",
          blocks: [],
          createdAt: now(),
        };
        return {
          streaming: true,
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
      set(() => ({
        pendingPermission: { id: e.id, tool: e.tool, summary: e.summary, input: e.input },
      }));
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
      set((st) => ({
        messages: patchLast(st.messages, sessionId, (b) =>
          appendText(b, `\n\n**Error:** ${e.message}`),
        ),
        streaming: false,
        pendingPermission: null,
      }));
      break;
    case "turn_end":
      set(() => ({ streaming: false, pendingPermission: null }));
      break;
  }
}
