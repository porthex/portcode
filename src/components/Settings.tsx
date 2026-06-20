import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/store";
import { MODELS, type ToolPolicy } from "../types";
import * as ipc from "../lib/ipc";

export function SettingsPanel() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const oauthStatus = useStore((s) => s.oauthStatus);
  const oauthError = useStore((s) => s.oauthError);
  const loginWithClaude = useStore((s) => s.loginWithClaude);
  const logoutClaude = useStore((s) => s.logoutClaude);

  const ambientRain = useStore((s) => s.ambientRain);
  const scanlines = useStore((s) => s.scanlines);
  const setAmbientRain = useStore((s) => s.setAmbientRain);
  const setScanlines = useStore((s) => s.setScanlines);

  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const signedIn = !!oauthStatus?.signedIn;

  // Close on Escape, mirroring CommandPalette/PermissionPrompt's keyboard affordance.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowSettings(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setShowSettings]);

  // Clear the "Saved" toast timer on unmount so it can't update state after close.
  useEffect(() => {
    return () => {
      if (savedTimer.current !== null) clearTimeout(savedTimer.current);
    };
  }, []);

  const saveKey = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      await ipc.setApiKey(apiKey.trim());
      await updateSettings({ apiKeySet: true });
      setApiKey("");
      setSavedKey(true);
      if (savedTimer.current !== null) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedKey(false), 1800);
    } finally {
      setSaving(false);
    }
  };

  const signIn = async () => {
    setSigningIn(true);
    try {
      await loginWithClaude();
    } finally {
      setSigningIn(false);
    }
  };

  const saveLabel = savedKey ? "Saved" : saving ? "…" : settings.apiKeySet ? "Replace" : "Save";

  return (
    <div
      className="pc-overlay items-center justify-center z-[58] p-6"
      onClick={() => setShowSettings(false)}
    >
      <div className="pc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pc-sweep pc-sweep--accent" />

        {/* HEADER */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2.5">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-accent-2"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span className="font-display font-semibold text-[16px] tracking-[1px]">SETTINGS</span>
          </div>
          <button
            onClick={() => setShowSettings(false)}
            className="flex h-7 w-7 items-center justify-center rounded-[7px] border border-border-2 text-muted transition-colors hover:border-accent/50 hover:text-accent"
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>

        {/* BODY */}
        <div className="flex flex-col gap-6 p-5 max-h-[72vh] overflow-y-auto">
          {/* CONNECTION */}
          <section>
            <div className="pc-eyebrow">CONNECTION</div>
            <div className="flex flex-col gap-3.5">
              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium text-fg">Provider</label>
                <div className="flex items-center gap-2 rounded-lg border border-border bg-panel-2 px-3 py-2.5 text-[12.5px] text-muted">
                  <span className="pc-dot pc-dot--success" />
                  Anthropic (Claude)
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium text-fg">
                  Default model (new sessions)
                </label>
                <select
                  value={settings.model}
                  onChange={(e) => void updateSettings({ model: e.target.value })}
                  className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2.5 text-[12.5px] text-fg outline-none"
                >
                  {MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-[11px] text-faint">
                  Used as the starting model for new chats. Change a chat&apos;s model from its
                  composer.
                </p>
              </div>

              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium text-fg">
                  Subscription (Claude Pro/Max)
                </label>
                {signedIn ? (
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-panel-2 px-3 py-2.5">
                    <div className="min-w-0 text-[12.5px]">
                      <div className="flex items-center gap-1.5">
                        <span className="pc-dot pc-dot--success" />
                        <span className="min-w-0 truncate text-fg">
                          Signed in{oauthStatus?.account ? ` as ${oauthStatus.account}` : ""}
                        </span>
                        {oauthStatus?.tier && (
                          <span
                            title={oauthStatus.tier}
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider shadow-sm ${
                              /max/i.test(oauthStatus.tier)
                                ? "bg-gradient-to-r from-amber-300 to-amber-500 text-black"
                                : "bg-gradient-to-r from-violet-400 to-indigo-500 text-white"
                            }`}
                          >
                            {oauthStatus.tier.replace(/^Claude\s+/, "")}
                          </span>
                        )}
                      </div>
                      {oauthStatus?.expiresAt != null && (
                        <div className="mt-0.5 text-[11px] text-muted">
                          Access expires {formatExpiry(oauthStatus.expiresAt)}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => void logoutClaude()}
                      className="shrink-0 rounded-lg border border-border bg-panel px-3 py-2 text-[12.5px] text-muted hover:text-fg"
                    >
                      Log out
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => void signIn()}
                    disabled={signingIn}
                    className="pc-btn-accent w-full px-3 py-2.5 text-[12.5px] disabled:opacity-30"
                  >
                    {signingIn ? "Signing in…" : "Sign in with Claude"}
                  </button>
                )}
                {oauthError && (
                  <p className="mt-1.5 text-[11px] text-danger">Sign-in failed: {oauthError}</p>
                )}
              </div>

              <div>
                <label className="mb-1.5 block text-[12.5px] font-medium text-fg">API key</label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={settings.apiKeySet ? "••••••••  (replace)" : "sk-ant-…"}
                    className="flex-1 rounded-lg border border-border bg-panel-2 px-3 py-2.5 font-mono text-[12.5px] text-muted outline-none select-text"
                  />
                  <button
                    onClick={() => void saveKey()}
                    disabled={saving || !apiKey.trim()}
                    className="pc-btn-accent px-4 py-2.5 text-[12.5px] disabled:opacity-30"
                  >
                    {saveLabel}
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-faint">
                  {signedIn
                    ? "Signed in with Claude — Portcode uses your subscription; an API key is optional."
                    : settings.apiKeySet
                      ? "A key is stored in Windows Credential Manager."
                      : "Stored securely in Windows Credential Manager — never on disk in plaintext."}
                </p>
              </div>
            </div>
          </section>

          {/* PERMISSIONS */}
          <section>
            <div className="pc-eyebrow pc-eyebrow--amber">PERMISSIONS</div>
            <div className="flex gap-2">
              {(["allow", "ask", "deny"] as ToolPolicy[]).map((p) => (
                <button
                  key={p}
                  onClick={() => void updateSettings({ defaultPolicy: p })}
                  className={`flex-1 rounded-lg border px-3 py-2.5 text-[12.5px] capitalize transition-colors ${
                    settings.defaultPolicy === p
                      ? "border-accent-2/50 bg-accent-2/10 text-accent-2"
                      : "border-border bg-panel-2 text-muted hover:border-accent-2/40"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-faint">
              Controls write / edit / shell tools. Read-only tools always run.
            </p>
          </section>

          {/* APPEARANCE */}
          <section>
            <div className="pc-eyebrow pc-eyebrow--violet">APPEARANCE</div>
            <div>
              <ToggleRow
                label="Typing animation"
                hint="Reveal replies with a terminal-style typing effect."
                on={settings.typingAnimation}
                onToggle={() => void updateSettings({ typingAnimation: !settings.typingAnimation })}
              />
              <ToggleRow
                label="Neon rain"
                hint="Ambient cyberpunk backdrop behind the app. Decorative only."
                on={ambientRain}
                onToggle={() => setAmbientRain(!ambientRain)}
              />
              <ToggleRow
                label="Scanlines"
                hint="CRT-style scanline overlay and vignette."
                on={scanlines}
                onToggle={() => setScanlines(!scanlines)}
              />
            </div>
          </section>
        </div>

        {/* FOOTER */}
        <div className="flex items-center justify-between border-t border-border px-5 py-3 font-mono text-[10.5px] text-faint">
          <span className="text-muted">PORTCODE · PORTHEX</span>
          <span className="text-warn">{ipc.isTauri() ? "NATIVE CORE" : "PREVIEW (BROWSER)"}</span>
        </div>
      </div>
    </div>
  );
}

function formatExpiry(expiresAt: number): string {
  // expiresAt is a unix timestamp in seconds.
  return new Date(expiresAt * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function ToggleRow({
  label,
  hint,
  on,
  onToggle,
}: {
  label: string;
  hint: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div>
        <div className="text-[12.5px] font-medium text-fg">{label}</div>
        <div className="text-[11px] text-faint mt-0.5">{hint}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onToggle}
        className="pc-switch"
      >
        <span className="pc-switch__knob" />
      </button>
    </div>
  );
}
