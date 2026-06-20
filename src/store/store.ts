import { create } from "zustand";
import type {
  ContentBlock,
  Message,
  OAuthStatus,
  PendingPermission,
  Session,
  Settings,
  StreamEvent,
  Usage,
} from "../types";
import { DEFAULT_SETTINGS } from "../types";
import * as ipc from "../lib/ipc";

interface AppState {
  sessions: Session[];
  activeId: string | null;
  messages: Record<string, Message[]>; // sessionId -> messages
  usage: Record<string, Usage>; // sessionId -> cumulative token usage
  settings: Settings;
  oauthStatus: OAuthStatus | null; // Claude subscription sign-in state
  oauthError: string | null; // last sign-in/out failure, surfaced in Settings
  streaming: boolean;
  showSettings: boolean;
  showFiles: boolean;
  showPalette: boolean;
  draft: string;
  cancel: (() => Promise<void>) | null;
  pendingPermission: PendingPermission | null;

  init: () => Promise<void>;
  toggleFiles: () => void;
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
  updateSettings: (s: Partial<Settings>) => Promise<void>;
  refreshOAuthStatus: () => Promise<void>;
  loginWithClaude: () => Promise<void>;
  logoutClaude: () => Promise<void>;
  resolvePermission: (decision: "allow" | "deny", always?: boolean) => Promise<void>;
}

const now = () => Date.now();
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
  streaming: false,
  showSettings: false,
  showFiles: false,
  showPalette: false,
  draft: "",
  cancel: null,
  pendingPermission: null,

  async init() {
    // Fetch settings and subscription status together. The oauth call is kept
    // resilient so an unwired/older core can't block startup.
    const [settings, oauthStatus] = await Promise.all([
      ipc.getSettings(),
      ipc.oauthStatus().catch(() => null),
    ]);
    const sessions = await ipc.listSessions();
    if (sessions.length === 0) {
      const s = makeSession();
      await ipc.createSession(s.id, s.title, s.workspace);
      set({ settings, oauthStatus, sessions: [s], activeId: s.id, messages: { [s.id]: [] } });
      return;
    }
    const activeId = sessions[0].id;
    const msgs = await ipc.getMessages(activeId);
    set({ settings, oauthStatus, sessions, activeId, messages: { [activeId]: msgs } });
  },

  async newSession() {
    const s = makeSession();
    await ipc.createSession(s.id, s.title, s.workspace);
    set((st) => ({
      sessions: [s, ...st.sessions],
      activeId: s.id,
      messages: { ...st.messages, [s.id]: [] },
    }));
  },

  async selectSession(id) {
    if (get().streaming) return;
    set({ activeId: id });
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
    const c = get().cancel;
    if (c) await c();
    set({ streaming: false, cancel: null, pendingPermission: null });
  },

  async resolvePermission(decision, always) {
    const p = get().pendingPermission;
    if (!p) return;
    if (always && decision === "allow") {
      await get().updateSettings({ defaultPolicy: "allow" });
    }
    set({ pendingPermission: null });
    await ipc.resolvePermission(p.id, decision);
  },

  setShowSettings(v) {
    set({ showSettings: v });
  },

  setShowPalette(v) {
    set({ showPalette: v });
  },

  toggleFiles() {
    set((st) => ({ showFiles: !st.showFiles }));
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
      set({ oauthStatus: { signedIn: false, expiresAt: null, account: null } });
    } catch (err) {
      set({ oauthError: errMessage(err) });
    }
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
