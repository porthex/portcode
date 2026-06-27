import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useStore } from "../store/store";
import {
  DANGER_MODES,
  MODELS,
  type PairingPayload,
  type PairingRequest,
  type PermissionMode,
  type Rule,
  type ToolPolicy,
} from "../types";
import * as ipc from "../lib/ipc";

export function SettingsPanel() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const settingsError = useStore((s) => s.settingsError);
  const pairingError = useStore((s) => s.pairingError);
  const oauthStatus = useStore((s) => s.oauthStatus);
  const oauthError = useStore((s) => s.oauthError);
  const loginWithClaude = useStore((s) => s.loginWithClaude);
  const logoutClaude = useStore((s) => s.logoutClaude);

  const ambientRain = useStore((s) => s.ambientRain);
  const scanlines = useStore((s) => s.scanlines);
  const uiScale = useStore((s) => s.uiScale);
  const setAmbientRain = useStore((s) => s.setAmbientRain);
  const setScanlines = useStore((s) => s.setScanlines);
  const setUiScale = useStore((s) => s.setUiScale);
  const crashReporting = useStore((s) => s.crashReporting);
  const setCrashReporting = useStore((s) => s.setCrashReporting);

  const phoneSync = useStore((s) => s.phoneSync);
  const pairingPayload = useStore((s) => s.pairingPayload);
  const beginPairing = useStore((s) => s.beginPairing);
  const unpair = useStore((s) => s.unpair);
  const clearPairing = useStore((s) => s.clearPairing);
  const pairingRequest = useStore((s) => s.pairingRequest);
  const confirmPairingRequest = useStore((s) => s.confirmPairingRequest);
  const rejectPairingRequest = useStore((s) => s.rejectPairingRequest);
  // On the phone (remote client) the agent — its model, key, sign-in, tool policy —
  // and the desktop's "show a QR to pair" flow all live on the DESKTOP, so those
  // sections are hidden here (several of their commands are desktop-only).
  const remoteMode = useStore((s) => s.remoteMode);

  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const saveBtnRef = useRef<HTMLButtonElement | null>(null);

  const signedIn = !!oauthStatus?.signedIn;

  // Close on Escape, mirroring CommandPalette/PermissionPrompt's keyboard affordance.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowSettings(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setShowSettings]);

  // Move focus into the dialog on open and restore it to the opener on close, so a
  // keyboard user isn't left on a background control behind the scrim.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const modal = modalRef.current;
    const first = modal?.querySelector<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    );
    (first ?? modal)?.focus();
    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  // Clear the "Saved" toast timer on unmount so it can't update state after close.
  useEffect(() => {
    return () => {
      if (savedTimer.current !== null) clearTimeout(savedTimer.current);
    };
  }, []);

  // Replay the one-shot pc-flash on the SAME Save node when a save succeeds —
  // restart the CSS animation by toggling the class across a forced reflow rather
  // than remounting via a React key, which would drop focus out of the focus trap.
  useEffect(() => {
    if (!savedKey) return;
    replayFlash(saveBtnRef.current);
  }, [savedKey]);

  // Trap Tab within the dialog: query focusable descendants live (sections toggle
  // `hidden` in remoteMode), skip hidden ones, and wrap at the first/last element.
  const onModalKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab") return;
    const modal = modalRef.current;
    if (!modal) return;
    const focusable = Array.from(
      modal.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null);
    if (focusable.length === 0) return;
    const firstEl = focusable[0];
    const lastEl = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === firstEl || !active || !focusable.includes(active)) {
        e.preventDefault();
        lastEl.focus();
      }
    } else if (active === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  };

  const saveKey = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      setKeyError(null);
      await ipc.setApiKey(apiKey.trim());
      // Persist the apiKeySet flag directly (not via updateSettings, which swallows
      // a reject into settingsError and resolves anyway) so a save failure hits this
      // catch — "Saved" is never shown and the typed value is kept for retry.
      const next = await ipc.saveSettings({ apiKeySet: true });
      useStore.setState({ settings: next });
      setApiKey("");
      setSavedKey(true);
      if (savedTimer.current !== null) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedKey(false), 1800);
    } catch (err) {
      // Surface the failure and keep the typed value so the user can retry.
      setKeyError(err instanceof Error ? err.message : String(err));
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
      className="pc-overlay items-start justify-center z-[58] p-6"
      onClick={() => setShowSettings(false)}
    >
      <div
        className="pc-modal my-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pc-settings-title"
        tabIndex={-1}
        ref={modalRef}
        onKeyDown={onModalKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
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
            <span
              id="pc-settings-title"
              className="font-display font-semibold text-[16px] tracking-[1px]"
            >
              SETTINGS
            </span>
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
          <section className={remoteMode ? "hidden" : undefined}>
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
                <label
                  htmlFor="pc-settings-model"
                  className="mb-1.5 block text-[12.5px] font-medium text-fg"
                >
                  Default model (new sessions)
                </label>
                <select
                  id="pc-settings-model"
                  value={settings.model}
                  onChange={(e) => void updateSettings({ model: e.target.value })}
                  className="pc-select w-full rounded-lg border border-border bg-panel-2 px-3 py-2.5 text-[12.5px] text-fg outline-none"
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
                {/* settingsError is shared by the model select and the permission
                    policy buttons; surface it next to its higher control here. */}
                {settingsError && (
                  <p className="mt-1.5 text-[11px] text-danger" role="alert">
                    Couldn't save settings: {settingsError}
                  </p>
                )}
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
                  <p className="mt-1.5 text-[11px] text-danger" role="alert">
                    Sign-in failed: {oauthError}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="pc-settings-apikey"
                  className="mb-1.5 block text-[12.5px] font-medium text-fg"
                >
                  API key
                </label>
                <div className="flex gap-2">
                  <input
                    id="pc-settings-apikey"
                    type="password"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      // Clear a stale "Couldn't save key" as the user corrects it.
                      if (keyError) setKeyError(null);
                    }}
                    placeholder={settings.apiKeySet ? "••••••••  (replace)" : "sk-ant-…"}
                    className="flex-1 rounded-lg border border-border bg-panel-2 px-3 py-2.5 font-mono text-[12.5px] text-muted outline-none transition-colors focus:border-accent/50 select-text"
                  />
                  <button
                    ref={saveBtnRef}
                    onClick={() => void saveKey()}
                    disabled={saving || !apiKey.trim()}
                    className="pc-btn-accent px-4 py-2.5 text-[12.5px] disabled:opacity-30"
                  >
                    {saveLabel}
                  </button>
                </div>
                {keyError && (
                  <p className="mt-1.5 text-[11px] text-danger" role="alert">
                    Couldn't save key: {keyError}
                  </p>
                )}
                <span role="status" aria-live="polite" className="sr-only">
                  {savedKey ? "API key saved" : ""}
                </span>
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
          <PermissionSettings />

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
              <ScaleRow value={uiScale} onSelect={setUiScale} />
            </div>
          </section>

          {/* PRIVACY */}
          <section>
            <div className="pc-eyebrow pc-eyebrow--violet">PRIVACY</div>
            <div>
              <ToggleRow
                label="Crash & performance reports"
                hint="Send anonymous, scrubbed crash + basic performance reports — never your prompts, code, files, or keys. Off by default."
                on={crashReporting === true}
                onToggle={() => setCrashReporting(crashReporting !== true)}
              />
            </div>
          </section>

          {/* PHONE SYNC */}
          <section className={remoteMode ? "hidden" : undefined}>
            <div className="pc-eyebrow">PHONE SYNC</div>
            <div className="flex flex-col gap-3.5">
              {phoneSync && (
                <div>
                  <label className="mb-1.5 block text-[12.5px] font-medium text-fg">
                    This device
                  </label>
                  <div className="rounded-lg border border-border bg-panel-2 px-3 py-2.5 font-mono text-[11.5px] text-muted select-text">
                    {truncateKey(phoneSync.devicePublicKey)}
                  </div>
                </div>
              )}

              {phoneSync && phoneSync.paired.length > 0 && (
                <div>
                  <label className="mb-1.5 block text-[12.5px] font-medium text-fg">
                    Paired phones
                  </label>
                  <div className="flex flex-col gap-1.5">
                    {phoneSync.paired.map((device) => (
                      <div
                        key={device.publicKey}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border bg-panel-2 px-3 py-2"
                      >
                        <div className="min-w-0 text-[12.5px]">
                          <div className="flex items-center gap-1.5">
                            <span className="pc-dot pc-dot--success" />
                            <span className="min-w-0 truncate text-fg">{device.name}</span>
                          </div>
                          <div className="mt-0.5 font-mono text-[11px] text-muted">
                            {truncateKey(device.publicKey)}
                          </div>
                        </div>
                        <button
                          onClick={() => void unpair(device.publicKey)}
                          className="shrink-0 rounded-lg border border-border bg-panel px-3 py-2 text-[12.5px] text-muted hover:text-danger"
                          aria-label={`Unpair ${device.name}`}
                        >
                          Unpair
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Device-trust gate: a phone completed the handshake and is waiting
                  for this desktop user to compare its SAS and confirm. Until the
                  user confirms, the phone is served NOTHING. */}
              {pairingRequest && (
                <PairingConfirm
                  request={pairingRequest}
                  onConfirm={() => void confirmPairingRequest()}
                  onReject={() => void rejectPairingRequest()}
                />
              )}

              {pairingPayload ? (
                <PairingCode payload={pairingPayload} onDone={clearPairing} />
              ) : (
                <button
                  onClick={() => void beginPairing()}
                  className="pc-btn-accent w-full px-3 py-2.5 text-[12.5px]"
                >
                  Pair a phone
                </button>
              )}
              {pairingError && (
                <p className="mt-1.5 text-[11px] text-danger" role="alert">
                  Pairing failed: {pairingError}
                </p>
              )}
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

/** Restart the one-shot pc-flash on a persistent node: drop the class, force a
 *  reflow so the browser registers the removal, then re-add it. Replays the CSS
 *  animation without remounting (which would yank focus out of the focus trap). */
function replayFlash(node: HTMLElement | null) {
  if (!node) return;
  node.classList.remove("pc-flash");
  void node.offsetWidth; // force reflow so the re-added class restarts the animation
  node.classList.add("pc-flash");
}

/** Show only the first 8 and last 4 chars of a base64 key to keep the UI compact. */
function truncateKey(key: string): string {
  if (key.length <= 16) return key;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function formatExpiry(expiresAt: number): string {
  // expiresAt is a unix timestamp in seconds.
  return new Date(expiresAt * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** The device-trust confirmation prompt: a phone completed the Noise handshake
 *  inside an open pairing window and is awaiting this desktop user's approval. The
 *  user compares this SAS with the one shown on the phone; only on Confirm is the
 *  phone persisted as trusted and served the command surface. This is the gate that
 *  closes the "handshake == authorized" hole — without it, the phone gets nothing. */
function PairingConfirm({
  request,
  onConfirm,
  onReject,
}: {
  request: PairingRequest;
  onConfirm: () => void;
  onReject: () => void;
}) {
  // Land focus on the SAS, NOT the affirmative Confirm — a queued/habitual Enter
  // must not approve a device before the user actually compares codes (mirrors the
  // phone-side VerifyPanel in RemotePairing).
  const sasRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    sasRef.current?.focus();
  }, []);

  return (
    <div
      className="rounded-xl border border-accent/40 bg-panel-2 p-4 shadow-[0_0_24px_rgba(255,46,126,0.16)]"
      role="group"
      aria-label="Confirm new phone pairing"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="pc-dot pc-dot--cyan" />
        <span className="font-mono text-[11px] uppercase tracking-[1.5px] text-accent-2">
          New phone pairing
        </span>
      </div>
      <p className="mb-3 text-[12px] leading-[1.5] text-muted">
        A phone is trying to pair. Compare this code with the one on the phone — they must match
        before you allow it to control this desktop.
      </p>
      <div
        ref={sasRef}
        tabIndex={-1}
        aria-label={`Pairing verification code: ${request.sas}`}
        className="rounded-lg border border-accent/40 bg-panel px-4 py-4 text-center outline-none"
      >
        <div className="select-text break-all font-mono text-[22px] font-bold leading-tight tracking-[3px] text-accent-2">
          {request.sas}
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button onClick={onConfirm} className="pc-btn-accent flex-1 px-3 py-2.5 text-[12.5px]">
          Codes match — Allow
        </button>
        <button
          onClick={onReject}
          className="flex-1 rounded-lg border border-border bg-panel px-3 py-2.5 text-[12.5px] text-muted transition-colors hover:border-danger/50 hover:text-danger"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

/** The desktop pairing affordance: the live PairingPayload rendered as a scannable
 *  QR (the phone scans it) with a copyable text fallback for manual entry. The QR
 *  encodes the exact JSON `phone_sync_connect` parses, so a scan dials directly. */
function PairingCode({ payload, onDone }: { payload: PairingPayload; onDone: () => void }) {
  const json = JSON.stringify(payload);
  const [copied, setCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyBtnRef = useRef<HTMLButtonElement | null>(null);

  // Clear the "Copied ✓" reset timer on unmount. PairingCode is dismissed (Done)
  // well within the 1.5s window, so an uncleared timer would setState after unmount.
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    },
    [],
  );

  // Replay the one-shot pc-flash on the SAME Copy node when a copy succeeds,
  // restarting the CSS animation without remounting (which would drop focus).
  useEffect(() => {
    if (!copied) return;
    replayFlash(copyBtnRef.current);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (no permission / older webview); the raw text
      // below is always selectable as a fallback.
    }
  };

  return (
    <div>
      <label className="mb-1.5 block text-[12.5px] font-medium text-fg">Pairing code</label>
      <p className="mb-3 text-[11px] leading-[1.5] text-faint">
        On your phone, open Portcode and tap <span className="text-muted">Scan QR</span>, then point
        the camera at this code.
      </p>

      <div className="flex flex-col items-center gap-3">
        {/* Dark-on-white: cameras read high-contrast QRs most reliably, regardless
            of the app's dark theme. */}
        <div
          className="rounded-xl border border-accent/40 bg-white p-3 shadow-[0_0_24px_rgba(255,46,126,0.18)]"
          data-testid="pairing-qr"
        >
          <QRCodeSVG
            value={json}
            size={256}
            level="M"
            marginSize={4}
            bgColor="#ffffff"
            fgColor="#0a0a12"
            title="Portcode pairing QR code"
          />
        </div>

        <div className="flex w-full items-center gap-2">
          <button
            ref={copyBtnRef}
            onClick={() => void copy()}
            className="flex-1 rounded-lg border border-border bg-panel-2 px-3 py-2 text-[12.5px] text-fg transition-colors hover:border-accent/50"
          >
            {copied ? "Copied ✓" : "Copy code"}
          </button>
          <button
            onClick={onDone}
            className="flex-1 rounded-lg border border-border bg-panel px-3 py-2 text-[12.5px] text-muted hover:text-fg"
          >
            Done
          </button>
        </div>
        <span role="status" aria-live="polite" className="sr-only">
          {copied ? "Pairing code copied" : ""}
        </span>

        <button
          onClick={() => setShowRaw((v) => !v)}
          className="self-start text-[11px] text-faint underline-offset-2 hover:text-muted hover:underline"
          aria-expanded={showRaw}
        >
          {showRaw ? "Hide pairing code" : "Can’t scan? Show pairing code"}
        </button>
        {showRaw && (
          <div className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2.5 font-mono text-[10.5px] leading-[1.5] text-accent-2 select-text break-all">
            {json}
          </div>
        )}
      </div>
    </div>
  );
}

/** The selectable interface-scale presets (a frontend-only `document.zoom`).
 *  Kept small + named so the picker reads as discrete steps, not a free slider. */
const UI_SCALES: { value: number; label: string }[] = [
  { value: 0.9, label: "Compact" },
  { value: 1, label: "Default" },
  { value: 1.1, label: "Comfortable" },
  { value: 1.25, label: "Large" },
];

/** Interface-scale row: a segmented set of preset buttons wired to the store's
 *  uiScale/setUiScale. The active option is indicated with aria-pressed (not by
 *  colour alone) so it's conveyed to assistive tech and high-contrast users. */
function ScaleRow({ value, onSelect }: { value: number; onSelect: (n: number) => void }) {
  return (
    <div className="flex flex-col gap-2 py-1.5">
      <div>
        <div className="text-[12.5px] font-medium text-fg">Interface scale</div>
        <div className="text-[11px] text-faint mt-0.5">
          Resize the whole interface for comfort or density.
        </div>
      </div>
      <div role="group" aria-label="Interface scale" className="flex gap-2">
        {UI_SCALES.map((s) => {
          const active = value === s.value;
          return (
            <button
              key={s.value}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(s.value)}
              className={`flex-1 rounded-lg border px-2 py-2 text-[12px] transition-colors ${
                active
                  ? "border-accent-2/50 bg-accent-2/10 text-accent-2"
                  : "border-border bg-panel-2 text-muted hover:border-accent-2/40"
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const PERM_TOOLS = ["fs_read", "list", "glob", "grep", "fs_write", "fs_edit", "shell", "*"];

const MODE_INFO: Record<PermissionMode, { label: string; hint: string }> = {
  default: { label: "Default", hint: "Use the policy below (ask / allow / deny)." },
  acceptEdits: {
    label: "Accept edits",
    hint: "Auto-allow file writes & edits; still ask for shell.",
  },
  plan: { label: "Plan", hint: "Read-only — deny every mutating tool." },
  auto: { label: "Auto", hint: "Auto-allow EVERY mutating tool, including shell." },
  bypass: { label: "Bypass", hint: "Skip the permission gate entirely." },
};
const MODE_ORDER: PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "bypass"];

/**
 * The permission mode + per-tool/command rule editor. auto/bypass require an
 * explicit danger acknowledgment to engage, and an over-broad allow rule (any
 * tool, or shell with no command prefix) is flagged loudly — the UI guardrails
 * the security review of the gate flagged as the layer that must enforce them.
 */
function PermissionSettings() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  // Permission config is a desktop-side setting; on the phone the section is
  // hidden (the phone observes the active mode via the HUD but doesn't edit it).
  const remoteMode = useStore((s) => s.remoteMode);
  const mode = settings.permissionMode;
  const rules = settings.rules;

  const [confirmMode, setConfirmMode] = useState<PermissionMode | null>(null);
  const [ruleTool, setRuleTool] = useState("shell");
  const [ruleCommand, setRuleCommand] = useState("");
  const [ruleDecision, setRuleDecision] = useState<ToolPolicy>("ask");

  const pickMode = (m: PermissionMode) => {
    if (DANGER_MODES.includes(m)) {
      setConfirmMode(m); // require an explicit acknowledgment before engaging
    } else {
      setConfirmMode(null);
      void updateSettings({ permissionMode: m });
    }
  };

  // An allow rule that matches everything (any tool, or shell with no command
  // prefix) is the footgun the gate security review flagged — warn loudly.
  const overBroadAllow =
    ruleDecision === "allow" &&
    (ruleTool === "*" || (ruleTool === "shell" && ruleCommand.trim() === ""));

  const addRule = () => {
    const command = ruleTool === "shell" && ruleCommand.trim() ? ruleCommand : undefined;
    const rule: Rule = command
      ? { tool: ruleTool, command, decision: ruleDecision }
      : { tool: ruleTool, decision: ruleDecision };
    if (
      rules.some(
        (r) => r.tool === rule.tool && r.command === rule.command && r.decision === rule.decision,
      )
    ) {
      return; // exact duplicate — no-op
    }
    void updateSettings({ rules: [...rules, rule] });
    setRuleCommand("");
  };

  const removeRule = (i: number) =>
    void updateSettings({ rules: rules.filter((_, idx) => idx !== i) });

  return (
    <section className={remoteMode ? "hidden" : undefined}>
      <div className="pc-eyebrow pc-eyebrow--amber">PERMISSIONS</div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {MODE_ORDER.map((m) => {
          const danger = DANGER_MODES.includes(m);
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => pickMode(m)}
              title={MODE_INFO[m].hint}
              aria-pressed={active}
              className={`rounded-lg border px-2 py-2 text-[11.5px] capitalize transition-colors ${
                active
                  ? danger
                    ? "border-danger/60 bg-danger/10 text-danger"
                    : "border-accent-2/50 bg-accent-2/10 text-accent-2"
                  : `border-border bg-panel-2 hover:border-accent-2/40 ${
                      danger ? "text-danger/80" : "text-muted"
                    }`
              }`}
            >
              {danger ? "⚠ " : ""}
              {MODE_INFO[m].label}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] text-faint">{MODE_INFO[mode].hint}</p>

      {confirmMode && (
        <div
          role="alert"
          className="mt-2 rounded-lg border border-danger/50 bg-danger/10 p-2.5 text-[11.5px] text-danger"
        >
          <p>
            ⚠ <strong className="capitalize">{MODE_INFO[confirmMode].label}</strong> lets the agent
            run mutating tools — including shell commands — without asking. Only enable it if you
            trust the task.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                void updateSettings({ permissionMode: confirmMode });
                setConfirmMode(null);
              }}
              className="rounded border border-danger/60 bg-danger/15 px-2.5 py-1 capitalize text-danger"
            >
              Enable {MODE_INFO[confirmMode].label}
            </button>
            <button
              type="button"
              onClick={() => setConfirmMode(null)}
              className="rounded border border-border bg-panel-2 px-2.5 py-1 text-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-3">
        <div className="mb-1 text-[11px] text-faint">
          Default-mode policy (used when the mode is Default)
        </div>
        <div className="flex gap-2">
          {(["allow", "ask", "deny"] as ToolPolicy[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => void updateSettings({ defaultPolicy: p })}
              className={`flex-1 rounded-lg border px-3 py-2 text-[12.5px] capitalize transition-colors ${
                settings.defaultPolicy === p
                  ? "border-accent-2/50 bg-accent-2/10 text-accent-2"
                  : "border-border bg-panel-2 text-muted hover:border-accent-2/40"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3">
        <div className="mb-1 text-[11px] text-faint">
          Rules — first match wins, evaluated before the mode default
        </div>
        {rules.length === 0 ? (
          <p className="text-[11px] text-faint">
            No rules yet. The mode above applies to every tool.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rules.map((r, i) => (
              <li
                key={`${r.tool}|${r.command ?? ""}|${r.decision}`}
                className="flex items-center justify-between gap-2 rounded border border-border bg-panel-2 px-2 py-1 text-[11.5px]"
              >
                <span className="min-w-0 truncate font-mono">
                  <span className="text-fg">{r.tool}</span>
                  {r.command ? <span className="text-muted"> “{r.command}”</span> : null}{" "}
                  <span
                    className={
                      r.decision === "allow"
                        ? "text-accent-2"
                        : r.decision === "deny"
                          ? "text-danger"
                          : "text-warn"
                    }
                  >
                    → {r.decision}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => removeRule(i)}
                  aria-label={`Remove rule ${i + 1}`}
                  className="shrink-0 px-1 text-muted hover:text-danger"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            aria-label="Rule tool"
            value={ruleTool}
            onChange={(e) => setRuleTool(e.target.value)}
            className="rounded border border-border bg-panel-2 px-2 py-1 text-[11.5px] text-fg"
          >
            {PERM_TOOLS.map((t) => (
              <option key={t} value={t}>
                {t === "*" ? "any tool (*)" : t}
              </option>
            ))}
          </select>
          {ruleTool === "shell" && (
            <input
              aria-label="Command prefix"
              value={ruleCommand}
              onChange={(e) => setRuleCommand(e.target.value)}
              placeholder="command prefix (e.g. git )"
              className="min-w-0 flex-1 rounded border border-border bg-panel-2 px-2 py-1 text-[11.5px] text-fg"
            />
          )}
          <select
            aria-label="Rule decision"
            value={ruleDecision}
            onChange={(e) => setRuleDecision(e.target.value as ToolPolicy)}
            className="rounded border border-border bg-panel-2 px-2 py-1 text-[11.5px] text-fg"
          >
            {(["allow", "ask", "deny"] as ToolPolicy[]).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={addRule}
            className="rounded border border-accent-2/50 bg-accent-2/10 px-2.5 py-1 text-[11.5px] text-accent-2"
          >
            Add rule
          </button>
        </div>
        {overBroadAllow && (
          <p role="alert" className="mt-1.5 text-[11px] text-danger">
            ⚠ This allow rule matches {ruleTool === "*" ? "every tool" : "every shell command"} —
            anything chained after a trusted prefix runs without asking. Prefer a specific tool and
            command prefix.
          </p>
        )}
        <p className="mt-1.5 text-[11px] text-faint">
          A command prefix is a literal match — “git ” also matches “git x; rm -rf y”. It’s a
          convenience, not a guarantee.
        </p>
      </div>
    </section>
  );
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
