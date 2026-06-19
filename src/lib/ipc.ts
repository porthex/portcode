// IPC bridge. Talks to the Rust core when running under Tauri; otherwise falls
// back to an in-browser mock so the UI is fully runnable via `vite` alone.

import type { DirEntry, Message, Session, Settings, StreamEvent } from "../types";

export const isTauri = (): boolean =>
  typeof window !== "undefined" &&
  // Tauri v2 injects this on the window object.
  "__TAURI_INTERNALS__" in window;

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
 * Send a user message and stream the agent run. Returns an unlisten/cancel
 * handle. Events arrive via `onEvent`.
 */
export async function runAgent(
  sessionId: string,
  text: string,
  onEvent: (e: StreamEvent) => void,
): Promise<{ cancel: () => Promise<void> }> {
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
        docs: [
          { name: "ROADMAP.md", path: "docs/ROADMAP.md", isDir: false },
        ],
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
      };
    },
  };
})();
