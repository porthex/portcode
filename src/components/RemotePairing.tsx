import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store/store";
import { isScannerAvailable, scanQrPayload, cancelScan } from "../lib/scanner";

// The remote-mode pairing screen. Shown on the phone (or any client in remote
// mode) until a live desktop session is both established AND its SAS verified.
// Two visual states:
//
//   1. CONNECT  — scan the desktop's QR with the camera (native phone client) or
//                 paste the QR payload (JSON) as a fallback, then dial.
//   2. VERIFY   — once connected, show the SAS prominently for out-of-band
//                 comparison; "Continue" confirms it and hands off to the session.
//
// The camera path uses the native barcode scanner (see lib/scanner); it is only
// offered where it exists (the phone), and paste always works as a fallback.
// Styled with the Neon-Noir utility classes, mirroring the desktop pairing UI in
// Settings.
export function RemotePairing() {
  const connectRemote = useStore((s) => s.connectRemote);
  const remoteConnected = useStore((s) => s.remoteConnected);

  const [qr, setQr] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  // Dial a payload. connectRemote never throws — it folds failures into
  // store.remoteError, which the connect panel surfaces inline. On success it
  // flips remoteConnected and this screen swaps to the VERIFY state.
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
  // payload also lands in the textarea so a failed dial can be retried/edited.
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
    <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto bg-bg px-6 py-10 text-fg">
      <div className="pc-neon-frame w-full max-w-[440px]">
        <div className="rounded-[13px] bg-panel p-6">
          {/* Brand + mode header */}
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg border border-accent/60 bg-gradient-to-br from-accent/30 to-accent-2/25 shadow-[0_0_14px_rgba(255,46,126,0.4)]">
              <Logo />
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="pc-wordmark">PORTCODE</span>
              <span className="pc-eyebrow-mono text-[8.5px]">REMOTE CLIENT</span>
            </div>
          </div>

          {remoteConnected ? (
            <VerifyPanel />
          ) : (
            <ConnectPanel
              qr={qr}
              setQr={setQr}
              connect={connect}
              connecting={connecting}
              onScan={onScan}
              scanning={scanning}
              scanError={scanError}
            />
          )}
        </div>
      </div>

      <p className="mt-5 text-center font-mono text-[10.5px] tracking-wide text-faint">
        End-to-end encrypted · paired over your local network
      </p>

      {/* The camera preview renders behind a transparented webview; this overlay
          (outside the hidden app shell, via a body portal) is the only painted UI. */}
      {scanning &&
        createPortal(<ScanOverlay onCancel={() => void onCancelScan()} />, document.body)}
    </div>
  );
}

/** State 1 — scan the desktop's QR (phone) or paste its payload, then dial. */
function ConnectPanel({
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
  const dropped = useStore((s) => s.remoteDropped);
  const canReconnect = useStore((s) => s.lastPairingQr !== null);
  const reconnectRemote = useStore((s) => s.reconnectRemote);
  const [reconnecting, setReconnecting] = useState(false);

  // Place initial focus on the primary action: the Scan button on the phone,
  // otherwise the pairing textarea — so the panel is operable from the keyboard
  // without a hunt.
  const scanRef = useRef<HTMLButtonElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (canScan && !(scanning || connecting)) scanRef.current?.focus();
    else if (!connecting) pasteRef.current?.focus();
    // Run once on mount; the connecting/scanning guards just avoid focusing a
    // disabled control if the panel happens to mount mid-flight.
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

  return (
    <div>
      {/* The drop is announced by a persistent live region at the App shell (it
          survives the connected↔pairing remount); a region inside this panel can't,
          since the panel only mounts on the drop and so is born with content set. */}
      {canReconnect && (
        <div
          className={`mb-4 rounded-xl border px-4 py-3.5 ${
            dropped ? "border-warn/40 bg-warn/5" : "border-accent-2/30 bg-accent-2/5"
          }`}
        >
          <div className="flex items-center gap-2">
            <span className={`pc-dot ${dropped ? "pc-dot--warn" : "pc-dot--cyan"}`} />
            <span
              className={`font-mono text-[11px] uppercase tracking-[1.5px] ${
                dropped ? "text-warn" : "text-accent-2"
              }`}
            >
              {dropped ? "Connection lost" : "Paired desktop"}
            </span>
          </div>
          <p className="mt-1.5 text-[12px] leading-[1.5] text-muted">
            {dropped
              ? "The link to your desktop dropped. Reconnect without re-scanning."
              : "Reconnect to the desktop you paired with — no need to re-scan."}
          </p>
          <button
            onClick={() => void onReconnect()}
            disabled={reconnecting}
            aria-busy={reconnecting}
            className="pc-btn-accent mt-2.5 w-full px-3 py-2.5 text-[13px] disabled:opacity-40"
          >
            {reconnecting ? "Reconnecting…" : "Reconnect"}
          </button>
        </div>
      )}
      <div className="pc-eyebrow pc-eyebrow--accent">CONNECT TO DESKTOP</div>
      <p className="mb-3 text-[12px] leading-[1.5] text-muted">
        On your desktop, open <span className="text-fg">Settings → Phone Sync</span> and choose{" "}
        <span className="text-fg">Pair a phone</span>
        {canScan ? ", then scan the QR it shows." : ". Paste the pairing code below."}
      </p>

      {canScan && (
        <>
          <button
            ref={scanRef}
            type="button"
            onClick={() => void onScan()}
            disabled={scanning || connecting}
            aria-busy={scanning}
            className="pc-btn-accent mb-2 flex w-full items-center justify-center gap-2 px-3 py-2.5 text-[13px] disabled:opacity-40"
          >
            <CameraIcon />
            {scanning ? "Scanning…" : "Scan QR code"}
          </button>
          {scanError && (
            <p role="alert" className="mb-2 flex items-start gap-1.5 text-[11.5px] text-danger">
              <span aria-hidden="true">⚠</span>
              <span>{scanError}</span>
            </p>
          )}
          <div className="my-3 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[1.5px] text-faint">
            <span className="h-px flex-1 bg-border" />
            or enter manually
            <span className="h-px flex-1 bg-border" />
          </div>
        </>
      )}

      <label htmlFor="pc-remote-qr" className="mb-1.5 block text-[12.5px] font-medium text-fg">
        Pairing code
      </label>
      <textarea
        ref={pasteRef}
        id="pc-remote-qr"
        value={qr}
        onChange={(e) => setQr(e.target.value)}
        disabled={connecting}
        rows={4}
        spellCheck={false}
        placeholder={'{ "version": 1, "publicKey": "…", "nonce": "…", "nodeAddr": { … } }'}
        className="w-full resize-none rounded-lg border border-border bg-panel-2 px-3 py-2.5 font-mono text-[11.5px] leading-[1.5] text-fg outline-none transition-colors placeholder:text-faint focus:border-accent/50 select-text disabled:cursor-not-allowed disabled:opacity-60"
      />

      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-[11.5px] text-danger">
          <span aria-hidden="true">⚠</span>
          <span>Couldn’t connect: {error}</span>
        </p>
      )}

      <button
        onClick={() => void connect()}
        disabled={connecting || !qr.trim()}
        aria-busy={connecting}
        className="pc-btn-accent mt-3.5 w-full px-3 py-2.5 text-[13px] disabled:opacity-30"
      >
        {connecting ? "Connecting…" : "Connect"}
      </button>
    </div>
  );
}

/** State 2 — connected; show the SAS for out-of-band verification. */
function VerifyPanel() {
  const sas = useStore((s) => s.remoteSas);
  const confirmRemoteSas = useStore((s) => s.confirmRemoteSas);
  const disconnectRemote = useStore((s) => s.disconnectRemote);

  // Land initial focus on the SAS code, NOT the affirmative confirm: focusing
  // "Codes match — Continue" would let a queued/habitual Enter verify the
  // connection without the user comparing codes, defeating the SAS check.
  const sasRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    sasRef.current?.focus();
  }, []);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="pc-dot pc-dot--success" />
        <span className="font-mono text-[11px] uppercase tracking-[1.5px] text-success">
          Connected
        </span>
      </div>

      <div className="pc-eyebrow pc-eyebrow--accent">VERIFY THIS CODE</div>
      <p className="mb-3 text-[12px] leading-[1.5] text-muted">
        Compare this code with the one shown on your desktop. They must match before you trust this
        connection.
      </p>

      {/* The SAS, large and unmissable — the one security-critical artifact.
          Takes initial focus (tabIndex=-1) so the user reads the code first. */}
      <div
        ref={sasRef}
        tabIndex={-1}
        aria-label={`Pairing verification code: ${sas ?? "not available"}`}
        className="rounded-xl border border-accent/40 bg-panel-2 px-4 py-5 text-center shadow-[0_0_24px_rgba(255,46,126,0.16)] outline-none"
      >
        <div className="select-text break-all font-mono text-[26px] font-bold leading-tight tracking-[3px] text-accent-2">
          {sas ?? "—"}
        </div>
      </div>

      <button
        onClick={() => confirmRemoteSas()}
        className="pc-btn-accent mt-4 w-full px-3 py-2.5 text-[13px]"
      >
        Codes match — Continue
      </button>
      <button
        onClick={() => void disconnectRemote()}
        className="mt-2 w-full rounded-lg border border-border bg-panel px-3 py-2.5 text-[12.5px] text-muted transition-colors hover:border-danger/50 hover:text-danger"
      >
        Codes don’t match — Disconnect
      </button>
    </div>
  );
}

/** Full-screen overlay shown while the native camera is scanning. The page chrome
 *  goes transparent (see the `pc-scanning` class in index.css + lib/scanner) so the
 *  camera preview shows through; this paints only a viewfinder + a Cancel control.
 *  Portaled to <body> so it sits outside the hidden app shell and stays visible. */
function ScanOverlay({ onCancel }: { onCancel: () => void }) {
  return (
    <div
      className="pc-scan-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Scanning for a pairing QR code"
    >
      <div className="pc-scan-frame" aria-hidden="true" />
      <p className="pc-scan-hint">Point your camera at the QR code on your desktop</p>
      <button type="button" onClick={onCancel} className="pc-scan-cancel">
        Cancel
      </button>
    </div>
  );
}

function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M7 9l3 3-3 3M13 15h4"
        stroke="var(--color-accent-hi)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 8a2 2 0 0 1 2-2h2l1.2-1.6a1 1 0 0 1 .8-.4h6a1 1 0 0 1 .8.4L19 6h0a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
