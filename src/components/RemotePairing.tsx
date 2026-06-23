import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store/store";
import { isScannerAvailable, scanQrPayload, cancelScan } from "../lib/scanner";

// The remote-mode pairing flow, in the Neon-Noir mobile design language
// (design_handoff_mobile_remote). Two full-screen states:
//
//   1. PAIR    — a camera viewport (corner brackets + sweeping scan line) is the
//                primary affordance on the phone; tapping it opens the native
//                scanner. A pasted QR payload is the fallback on every host.
//   2. SAFETY  — once connected, the SAS is shown large for an out-of-band
//                comparison (anti-MITM). Confirm hands off to the sessions list;
//                Cancel tears the connection down.
//
// The phone holds no keys and never touches files — it pairs, confirms the safety
// code, then drives a desktop session. Wired entirely to the real store/socket
// layer (connectRemote / confirmRemoteSas / disconnectRemote / reconnectRemote).
export function RemotePairing() {
  const connectRemote = useStore((s) => s.connectRemote);
  const remoteConnected = useStore((s) => s.remoteConnected);

  const [qr, setQr] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  // Dial a payload. connectRemote never throws — it folds failures into
  // store.remoteError, which the pair panel surfaces inline. On success it flips
  // remoteConnected and this screen swaps to the SAFETY state.
  const connectWith = async (payload: string) => {
    const v = payload.trim();
    if (!v || connecting) return;
    setConnecting(true);
    try {
      await connectRemote(v);
    } finally {
      setConnecting(false);
    }
  };

  const connect = () => connectWith(qr);

  // Scan the desktop's QR with the camera, then dial the decoded payload. The
  // payload also lands in the field so a failed dial can be retried/edited.
  const onScan = async () => {
    if (scanning || connecting) return;
    setScanError(null);
    setScanning(true);
    const outcome = await scanQrPayload();
    setScanning(false);
    if (outcome.ok) {
      setQr(outcome.value);
      await connectWith(outcome.value);
    } else if (outcome.reason === "denied") {
      setScanError(
        "Camera access was denied. Enable it in your phone's settings, or paste the code below.",
      );
    } else if (outcome.reason === "error") {
      setScanError(outcome.message || "Couldn’t start the camera. Paste the code below instead.");
    }
    // "cancelled" / "unavailable": the user backed out — nothing to surface.
  };

  const onCancelScan = async () => {
    await cancelScan();
    setScanning(false);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-bg text-fg">
      {remoteConnected ? (
        <SafetyPanel />
      ) : (
        <PairPanel
          qr={qr}
          setQr={setQr}
          connect={connect}
          connecting={connecting}
          onScan={onScan}
          scanning={scanning}
          scanError={scanError}
        />
      )}

      {/* The camera preview renders behind a transparented webview; this overlay
          (outside the hidden app shell, via a body portal) is the only painted UI. */}
      {scanning &&
        createPortal(<ScanOverlay onCancel={() => void onCancelScan()} />, document.body)}
    </div>
  );
}

/** State 1 — PAIR. Camera viewport (scan) + paste-code fallback, then dial. */
function PairPanel({
  qr,
  setQr,
  connect,
  connecting,
  onScan,
  scanning,
  scanError,
}: {
  qr: string;
  setQr: (v: string) => void;
  connect: () => void | Promise<void>;
  connecting: boolean;
  onScan: () => void | Promise<void>;
  scanning: boolean;
  scanError: string | null;
}) {
  const error = useStore((s) => s.remoteError);
  const canScan = isScannerAvailable();
  const canReconnect = useStore((s) => s.lastPairingQr !== null);
  const reconnectRemote = useStore((s) => s.reconnectRemote);
  const [reconnecting, setReconnecting] = useState(false);
  const [pasteError, setPasteError] = useState(false);

  // Place initial focus on the primary action: the camera viewport on the phone,
  // otherwise the paste field — so the panel is operable from the keyboard without
  // a hunt. Runs once on mount; the guards just avoid focusing a disabled control
  // if the panel happens to mount mid-flight.
  const scanRef = useRef<HTMLButtonElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (canScan && !(scanning || connecting)) scanRef.current?.focus();
    else if (!connecting) pasteRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onReconnect = async () => {
    if (reconnecting) return;
    setReconnecting(true);
    try {
      await reconnectRemote();
    } finally {
      setReconnecting(false);
    }
  };

  // PASTE chip — pull the payload straight from the clipboard. Best-effort: where
  // the Clipboard API is unavailable or denied we flag it so the user pastes by hand.
  const onPaste = async () => {
    setPasteError(false);
    try {
      const text = await navigator.clipboard?.readText();
      if (text) {
        setQr(text);
        pasteRef.current?.focus();
      } else {
        setPasteError(true);
      }
    } catch {
      setPasteError(true);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col px-[22px] pb-6 pt-[18px]">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <p className="font-mono text-[10px] tracking-[3px] text-accent-2 [text-shadow:0_0_8px_rgba(33,230,255,.4)]">
          ◧ REMOTE MODE
        </p>
        <h1 className="mb-1.5 mt-[9px] font-display text-[27px] font-bold leading-[1.12] tracking-[0.4px] text-fg">
          Pair a phone
        </h1>
        <p className="text-[13px] leading-[1.5] text-muted">
          On your desktop, open{" "}
          <span className="font-mono text-fg/90">
            Settings <span className="text-faint">→</span> Phone Sync{" "}
            <span className="text-faint">→</span> Pair a phone
          </span>
          {canScan ? ", then scan the QR it shows." : "."}
        </p>

        {/* camera viewport — the scan trigger on the phone, decorative otherwise */}
        {canScan ? (
          <button
            ref={scanRef}
            type="button"
            onClick={() => void onScan()}
            disabled={scanning || connecting}
            aria-label="Scan QR code"
            aria-busy={scanning}
            className="group relative mb-1 mt-5 aspect-square overflow-hidden rounded-[18px] border border-border bg-[linear-gradient(150deg,#080a11,#04050a)] shadow-[inset_0_0_60px_rgba(0,0,0,.6)] transition hover:border-accent-2/40 disabled:opacity-80"
          >
            <Viewfinder showScanLine={!scanning && !connecting} />
          </button>
        ) : (
          <div
            aria-hidden="true"
            className="relative mb-1 mt-5 aspect-square overflow-hidden rounded-[18px] border border-border bg-[linear-gradient(150deg,#080a11,#04050a)] shadow-[inset_0_0_60px_rgba(0,0,0,.6)]"
          >
            <Viewfinder showScanLine={!connecting} />
          </div>
        )}

        {/* viewport caption — below the frame so it never collides with the brackets */}
        <div className="mt-[13px] flex items-center justify-center gap-2 font-mono text-[11px] tracking-[0.5px] text-[#7a8499]">
          <span className="pc-dot pc-dot--cyan" aria-hidden="true" />
          {scanning
            ? "Scanning…"
            : connecting
              ? "Reading…"
              : canScan
                ? "Point at the QR on your desktop"
                : "Show the QR from your desktop"}
        </div>

        {/* divider */}
        <div className="my-4 flex items-center gap-3 font-mono text-[10px] tracking-[2px] text-faint/70">
          <span className="h-px flex-1 bg-border" /> OR PASTE CODE{" "}
          <span className="h-px flex-1 bg-border" />
        </div>

        {/* paste-code field — a multi-line area for the QR payload JSON */}
        <label className="flex items-start gap-[9px] rounded-[11px] border border-border-2 bg-panel px-3.5 py-3 transition focus-within:border-accent-2/45 focus-within:shadow-glow-cyan">
          <textarea
            ref={pasteRef}
            value={qr}
            onChange={(e) => setQr(e.target.value)}
            disabled={connecting}
            rows={2}
            spellCheck={false}
            aria-label="Pairing code"
            placeholder='{ "version": 1, "publicKey": "…", "nodeAddr": { … } }'
            className="min-w-0 flex-1 resize-none break-all bg-transparent font-mono text-[12px] leading-[1.5] text-fg/90 outline-none placeholder:text-faint select-text disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => void onPaste()}
            disabled={connecting}
            className="mt-px shrink-0 rounded-md border border-accent-2/30 bg-accent-2/10 px-2 py-1 font-mono text-[10px] tracking-[1px] text-accent-2 transition hover:bg-accent-2/20 disabled:opacity-40"
          >
            PASTE
          </button>
        </label>
        {pasteError && (
          <p className="mt-1.5 text-[11px] text-faint">
            Couldn’t read the clipboard — paste the code by hand.
          </p>
        )}

        {/* calm cross-launch reconnect: a remembered desktop, dial it without re-scanning */}
        {canReconnect && (
          <div className="mt-4 rounded-[11px] border border-accent-2/30 bg-accent-2/5 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="pc-dot pc-dot--cyan" aria-hidden="true" />
              <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-accent-2">
                Paired desktop
              </span>
            </div>
            <p className="mt-1.5 text-[12px] leading-[1.5] text-muted">
              Reconnect to the desktop you paired with — no need to re-scan.
            </p>
            <button
              onClick={() => void onReconnect()}
              disabled={reconnecting}
              aria-busy={reconnecting}
              className="mt-2.5 h-11 w-full rounded-[11px] border border-accent-2/40 bg-accent-2/10 font-display text-[13px] font-semibold tracking-[0.4px] text-accent-2 transition hover:bg-accent-2/20 hover:shadow-glow-cyan disabled:opacity-40"
            >
              {reconnecting ? "Reconnecting…" : "Reconnect"}
            </button>
          </div>
        )}
      </div>

      {/* footer — status/errors then the pinned primary action */}
      <div className="pt-3">
        {scanError && (
          <p role="alert" className="mb-[13px] flex items-start gap-1.5 text-[11.5px] text-danger">
            <span aria-hidden="true">⚠</span>
            <span>{scanError}</span>
          </p>
        )}
        {error && (
          <div
            role="alert"
            className="mb-[13px] flex items-start gap-2.5 rounded-[11px] border border-danger/40 bg-danger/[0.07] px-3 py-3"
          >
            <span className="mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-danger/50 bg-danger/[0.16] text-[13px] font-bold text-danger">
              !
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-[#ffd2d5]">Couldn’t connect</p>
              <p className="mt-0.5 break-words text-[12px] leading-[1.45] text-[#a9889a]">
                {error}
              </p>
            </div>
          </div>
        )}

        {connecting ? (
          <>
            <button
              disabled
              aria-busy="true"
              className="flex h-[54px] w-full items-center justify-center gap-2.5 rounded-[13px] border border-accent/50 bg-accent/[0.14] font-display text-[15px] font-semibold tracking-[0.6px] text-[#ff7eb0] shadow-[0_0_22px_rgba(255,46,126,.18)]"
            >
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#ff7eb0]/30 border-t-[#ff7eb0] motion-reduce:animate-none" />
              CONNECTING…
            </button>
            <p className="mt-[11px] flex items-center justify-center gap-[7px] font-mono text-[11px] text-faint">
              <span className="pc-dot pc-dot--cyan" aria-hidden="true" /> reaching your desktop…
            </p>
          </>
        ) : (
          <button
            onClick={() => void connect()}
            disabled={!qr.trim()}
            className="h-[54px] w-full rounded-[13px] border border-accent bg-accent font-display text-[15px] font-bold tracking-[0.8px] text-bg shadow-glow-accent transition hover:shadow-[0_0_34px_rgba(255,46,126,.75)] hover:brightness-110 active:brightness-90 disabled:opacity-30 disabled:shadow-none disabled:hover:brightness-100"
          >
            {error ? "↻ Try again" : "Connect"}
          </button>
        )}
      </div>
    </div>
  );
}

/** The camera viewfinder: scan-texture, four corner brackets, a faint QR ghost,
 *  and (idle) a sweeping cyan scan line. Pure decoration — `aria-hidden`. */
function Viewfinder({ showScanLine }: { showScanLine: boolean }) {
  return (
    <span aria-hidden="true">
      <span className="absolute inset-0 [background:repeating-linear-gradient(115deg,rgba(33,230,255,.03)_0_2px,transparent_2px_9px)]" />
      <Bracket className="left-[26px] top-[26px] rounded-tl-[7px] border-l-[3px] border-t-[3px]" />
      <Bracket className="right-[26px] top-[26px] rounded-tr-[7px] border-r-[3px] border-t-[3px]" />
      <Bracket className="bottom-[26px] left-[26px] rounded-bl-[7px] border-b-[3px] border-l-[3px]" />
      <Bracket className="bottom-[26px] right-[26px] rounded-br-[7px] border-b-[3px] border-r-[3px]" />
      <QrGhost />
      {showScanLine && (
        <span
          className="absolute left-[8%] right-[8%] h-0.5 bg-[linear-gradient(90deg,transparent,#21e6ff,transparent)] shadow-[0_0_14px_2px_rgba(33,230,255,.6)] motion-safe:animate-[pcScanV_2.4s_ease-in-out_infinite_alternate]"
          style={{ top: "6%" }}
        />
      )}
    </span>
  );
}

function Bracket({ className }: { className: string }) {
  return (
    <span
      className={`absolute h-10 w-10 border-accent-2 shadow-[0_0_10px_rgba(33,230,255,.4)] ${className}`}
    />
  );
}

function QrGhost() {
  return (
    <svg
      className="absolute left-1/2 top-1/2 h-[46%] w-[46%] -translate-x-1/2 -translate-y-1/2 opacity-[0.16]"
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
    >
      <path d="M10 10h26v26H10zM64 10h26v26H64zM10 64h26v26H10z" stroke="#21e6ff" strokeWidth="5" />
      <path d="M18 18h10v10H18zM72 18h10v10H72zM18 72h10v10H18z" fill="#21e6ff" />
      <path d="M64 64h10v10H64zM80 64h10v10H80zM64 80h10v10H64zM80 80h10v10H80z" fill="#21e6ff" />
    </svg>
  );
}

/** State 2 — SAFETY. Anti-MITM gate: show the SAS large for out-of-band comparison. */
function SafetyPanel() {
  const sas = useStore((s) => s.remoteSas);
  const confirmRemoteSas = useStore((s) => s.confirmRemoteSas);
  const disconnectRemote = useStore((s) => s.disconnectRemote);

  // Land initial focus on the SAS code, NOT the affirmative confirm: focusing
  // "It matches — Confirm" would let a queued/habitual Enter verify the connection
  // without the user comparing codes, defeating the SAS check.
  const sasRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    sasRef.current?.focus();
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col px-[22px] pb-6 pt-5">
      <p className="font-mono text-[10px] tracking-[3px] text-warn [text-shadow:0_0_8px_rgba(255,176,46,.4)]">
        ⛨ SECURITY CHECK
      </p>
      <h1 className="mb-1.5 mt-[9px] font-display text-[25px] font-bold leading-[1.14] tracking-[0.3px] text-fg">
        Confirm it’s really your desktop
      </h1>
      <p className="text-[13px] leading-[1.5] text-muted">
        Check this code matches the one shown on{" "}
        <span className="font-mono text-fg/90">your desktop</span>.
      </p>

      <div className="flex min-h-0 flex-1 items-center justify-center py-4">
        {/* The SAS, large and unmissable — the one security-critical artifact. Takes
            initial focus (tabIndex=-1) so the user reads the code first. The aria-label
            carries the code so a screen reader hears the actual SAS (the out-of-band
            comparison), never a bare "Safety code" with the digits suppressed. */}
        <div
          ref={sasRef}
          role="status"
          tabIndex={-1}
          aria-label={`Safety code: ${sas ?? "not available"}`}
          className="w-full rounded-[18px] border border-accent/[0.32] bg-[linear-gradient(160deg,rgba(255,46,126,.07),rgba(33,230,255,.05))] px-[18px] py-[30px] text-center shadow-[0_0_40px_rgba(255,46,126,.14),inset_0_0_30px_rgba(33,230,255,.05)] outline-none"
        >
          <p className="mb-4 font-mono text-[10px] tracking-[3px] text-faint">SAFETY CODE</p>
          <p className="select-text break-all font-mono text-[clamp(26px,8.5vw,44px)] font-semibold leading-tight tracking-[4px] text-white [text-shadow:0_0_18px_rgba(255,46,126,.55),0_0_4px_rgba(33,230,255,.4)]">
            {sas ?? "—"}
          </p>
          <p className="mt-[18px] text-[11.5px] leading-[1.45] text-muted">
            This proves no one is intercepting the connection.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <button
          onClick={() => confirmRemoteSas()}
          disabled={!sas}
          className="h-[54px] w-full rounded-[13px] border border-accent bg-accent font-display text-[15px] font-bold tracking-[0.8px] text-bg shadow-glow-accent transition hover:shadow-[0_0_34px_rgba(255,46,126,.75)] hover:brightness-110 disabled:opacity-40 disabled:shadow-none disabled:hover:brightness-100"
        >
          ✓ It matches — Confirm
        </button>
        <button
          onClick={() => void disconnectRemote()}
          className="h-12 w-full rounded-[13px] border border-border-2 bg-panel-2/60 font-display text-[14px] font-semibold tracking-[0.5px] text-[#a9b2c4] transition hover:border-danger/50 hover:text-danger"
        >
          It doesn’t match — Cancel
        </button>
      </div>
    </div>
  );
}

/** Full-screen overlay shown while the native camera is scanning. The page chrome
 *  goes transparent (see the `pc-scanning` class in index.css + lib/scanner) so the
 *  camera preview shows through; this paints only a viewfinder + a Cancel control.
 *  Portaled to <body> so it sits outside the hidden app shell and stays visible. */
function ScanOverlay({ onCancel }: { onCancel: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Give this aria-modal dialog the keyboard affordances every other overlay has.
  // While scanning, `pc-scanning` sets `#root { visibility: hidden }`, dropping the
  // opener (the viewport button) out of the focus order — so without this,
  // activeElement is stranded on <body> with no keyboard path to Cancel.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, [onCancel]);

  return (
    <div
      className="pc-scan-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Scanning for a pairing QR code"
      onKeyDown={(e) => {
        if (e.key === "Tab") {
          e.preventDefault();
          cancelRef.current?.focus();
        }
      }}
    >
      <div className="pc-scan-frame" aria-hidden="true" />
      <p className="pc-scan-hint">Point your camera at the QR code on your desktop</p>
      <button ref={cancelRef} type="button" onClick={onCancel} className="pc-scan-cancel">
        Cancel
      </button>
    </div>
  );
}
