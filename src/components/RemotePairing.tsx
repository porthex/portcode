import { useState } from "react";
import { useStore } from "../store/store";

// The remote-mode pairing screen. Shown on the phone (or any client in remote
// mode) until a live desktop session is both established AND its SAS verified.
// Two visual states:
//
//   1. CONNECT  — paste the desktop's QR payload (JSON) and dial.
//   2. VERIFY   — once connected, show the SAS prominently for out-of-band
//                 comparison; "Continue" confirms it and hands off to the session.
//
// Camera/QR scanning is intentionally out of scope here (no QR dependency yet);
// the "Scan QR" control is a clearly-labelled disabled affordance and paste is
// the working path. Styled with the Neon-Noir utility classes, mirroring the
// desktop pairing UI in Settings.
export function RemotePairing() {
  const connectRemote = useStore((s) => s.connectRemote);
  const remoteConnected = useStore((s) => s.remoteConnected);

  const [qr, setQr] = useState("");
  const [connecting, setConnecting] = useState(false);

  const connect = async () => {
    if (!qr.trim() || connecting) return;
    setConnecting(true);
    try {
      // connectRemote never throws — it folds failures into store.remoteError,
      // which the connect panel surfaces inline. On success it flips
      // remoteConnected and this screen swaps to the VERIFY state.
      await connectRemote(qr.trim());
    } finally {
      setConnecting(false);
    }
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
            <ConnectPanel qr={qr} setQr={setQr} connect={connect} connecting={connecting} />
          )}
        </div>
      </div>

      <p className="mt-5 text-center font-mono text-[10.5px] tracking-wide text-faint">
        End-to-end encrypted · paired over your local network
      </p>
    </div>
  );
}

/** State 1 — paste the desktop's pairing payload and dial. */
function ConnectPanel({
  qr,
  setQr,
  connect,
  connecting,
}: {
  qr: string;
  setQr: (v: string) => void;
  connect: () => void | Promise<void>;
  connecting: boolean;
}) {
  const error = useStore((s) => s.remoteError);

  return (
    <div>
      <div className="pc-eyebrow pc-eyebrow--accent">CONNECT TO DESKTOP</div>
      <p className="mb-3 text-[12px] leading-[1.5] text-muted">
        On your desktop, open <span className="text-fg">Settings → Phone Sync</span> and choose{" "}
        <span className="text-fg">Pair a phone</span>. Paste the pairing code below.
      </p>

      <label htmlFor="pc-remote-qr" className="mb-1.5 block text-[12.5px] font-medium text-fg">
        Pairing code
      </label>
      <textarea
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

      {/* Camera QR scan is not wired yet — a labelled, disabled affordance so the
          intent is visible without pulling in a QR/camera dependency. */}
      <button
        type="button"
        disabled
        aria-disabled="true"
        title="Camera scanning is coming in a future update"
        className="mt-2 flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-lg border border-border bg-panel-2/60 px-3 py-2.5 text-[12.5px] text-faint"
      >
        <CameraIcon />
        Scan QR (coming soon)
      </button>
    </div>
  );
}

/** State 2 — connected; show the SAS for out-of-band verification. */
function VerifyPanel() {
  const sas = useStore((s) => s.remoteSas);
  const confirmRemoteSas = useStore((s) => s.confirmRemoteSas);
  const disconnectRemote = useStore((s) => s.disconnectRemote);

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

      {/* The SAS, large and unmissable — the one security-critical artifact. */}
      <div
        aria-label="Pairing verification code"
        className="rounded-xl border border-accent/40 bg-panel-2 px-4 py-5 text-center shadow-[0_0_24px_rgba(255,46,126,0.16)]"
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
