import { useState } from "react";
import { useStore } from "../store/store";
import { MODELS, type ToolPolicy } from "../types";
import * as ipc from "../lib/ipc";

export function SettingsPanel() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const setShowSettings = useStore((s) => s.setShowSettings);

  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState(false);

  const saveKey = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      await ipc.setApiKey(apiKey.trim());
      await updateSettings({ apiKeySet: true });
      setApiKey("");
      setSavedKey(true);
      setTimeout(() => setSavedKey(false), 1800);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => setShowSettings(false)}
    >
      <div
        className="w-[520px] max-w-[92vw] rounded-xl border border-border bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="font-semibold">Settings</h2>
          <button onClick={() => setShowSettings(false)} className="text-muted hover:text-fg">
            ✕
          </button>
        </div>

        <div className="space-y-5 p-5">
          <Field label="Provider">
            <div className="rounded-md border border-border bg-panel-2 px-3 py-2 text-sm text-muted">
              Anthropic (Claude)
            </div>
          </Field>

          <Field label="Model">
            <select
              value={settings.model}
              onChange={(e) => void updateSettings({ model: e.target.value })}
              className="w-full rounded-md border border-border bg-panel-2 px-3 py-2 text-sm outline-none focus:border-accent"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="API key"
            hint={
              settings.apiKeySet
                ? "A key is stored in Windows Credential Manager."
                : "Stored securely in Windows Credential Manager — never on disk in plaintext."
            }
          >
            <div className="flex gap-2">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={settings.apiKeySet ? "••••••••  (replace)" : "sk-ant-…"}
                className="flex-1 rounded-md border border-border bg-panel-2 px-3 py-2 text-sm outline-none focus:border-accent select-text"
              />
              <button
                onClick={() => void saveKey()}
                disabled={saving || !apiKey.trim()}
                className="rounded-md bg-accent px-3 py-2 text-sm text-bg disabled:opacity-30 hover:opacity-90"
              >
                {savedKey ? "Saved" : saving ? "…" : "Save"}
              </button>
            </div>
          </Field>

          <Field
            label="Default tool permission"
            hint="Controls write / edit / shell tools. Read-only tools always run."
          >
            <div className="flex gap-2">
              {(["allow", "ask", "deny"] as ToolPolicy[]).map((p) => (
                <button
                  key={p}
                  onClick={() => void updateSettings({ defaultPolicy: p })}
                  className={`flex-1 rounded-md border px-3 py-2 text-sm capitalize transition-colors ${
                    settings.defaultPolicy === p
                      ? "border-accent bg-accent-dim text-fg"
                      : "border-border bg-panel-2 text-muted hover:text-fg"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </Field>
        </div>

        <div className="flex items-center justify-between border-t border-border px-5 py-3 text-xs text-muted">
          <span>Portcode · Porthex</span>
          <span>{ipc.isTauri() ? "native core" : "preview (browser)"}</span>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium">{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}
