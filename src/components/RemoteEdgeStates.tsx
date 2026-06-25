import { useState } from "react";
import { useStore } from "../store/store";

// Remote edge states (design_handoff_mobile_remote, screens 6 & 7), wired to the
// real store. Both fill the remote shell as full-screen centered states.

/** The desktop ended the session (channel dropped). Offer a one-tap reconnect to
 *  the remembered desktop, or fall back to pairing a different one. */
export function DisconnectedState() {
  const lastPairingQr = useStore((s) => s.lastPairingQr);
  const reconnectRemote = useStore((s) => s.reconnectRemote);
  const forgetRemotePairing = useStore((s) => s.forgetRemotePairing);
  const remoteError = useStore((s) => s.remoteError);
  const [reconnecting, setReconnecting] = useState(false);

  const onReconnect = async () => {
    if (reconnecting || !lastPairingQr) {
      // No remembered desktop to dial — fall straight back to the pairing screen.
      if (!lastPairingQr) forgetRemotePairing();
      return;
    }
    setReconnecting(true);
    try {
      await reconnectRemote();
    } finally {
      setReconnecting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg p-[22px] text-fg">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 text-center">
        <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-[22px] border border-danger/[0.32] bg-danger/[0.06] shadow-[0_0_30px_rgba(255,77,87,.1)]">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 4l16 16" stroke="#ff4d57" strokeWidth="1.8" strokeLinecap="round" />
            <path
              d="M9.5 5.2A12 12 0 0 1 21 8M3 8a12 12 0 0 1 3.4-2M6.3 11.4A8 8 0 0 1 9 9.9M14.5 9.6a8 8 0 0 1 3.2 1.8M9 14.4a4 4 0 0 1 4.6-.6"
              stroke="#ff4d57"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
            <circle cx="12" cy="18.5" r="1.4" fill="#ff4d57" />
          </svg>
        </div>
        <p className="font-mono text-[10px] tracking-[3px] text-danger">⚠ DISCONNECTED</p>
        <h1 className="mt-2 font-display text-[22px] font-bold text-fg">
          Desktop ended the session
        </h1>
        <p className="mt-2 text-[13px] leading-[1.55] text-muted">
          <span className="font-mono text-fg/90">Your desktop</span> closed Phone Sync or went to
          sleep. Your session is safe on the desktop.
        </p>
      </div>
      <div className="flex flex-col gap-2.5">
        {remoteError && !reconnecting && (
          <p role="alert" className="text-center text-[12px] leading-[1.5] text-danger">
            Couldn’t reconnect: {remoteError}
          </p>
        )}
        <button
          onClick={() => void onReconnect()}
          disabled={reconnecting}
          aria-busy={reconnecting}
          className="h-[54px] w-full rounded-[13px] border border-accent bg-accent font-display text-[15px] font-bold tracking-[0.7px] text-bg shadow-glow-accent transition hover:shadow-[0_0_34px_rgba(255,46,126,.7)] hover:brightness-110 disabled:opacity-40 disabled:shadow-none"
        >
          {reconnecting ? "Reconnecting…" : "↻ Reconnect"}
        </button>
        <button
          onClick={forgetRemotePairing}
          className="h-12 w-full rounded-[13px] border border-border-2 bg-panel-2/60 font-display text-[14px] font-semibold tracking-[0.5px] text-[#a9b2c4] transition hover:border-accent-2/40 hover:text-accent-2"
        >
          Pair a different desktop
        </button>
      </div>
    </div>
  );
}

/** No network — the phone can't reach the desktop. Auto-recovers when the App's
 *  online listener flips `online` back true; "Try again" re-checks immediately. */
export function OfflineState() {
  const setOnline = useStore((s) => s.setOnline);
  const onRetry = () => {
    setOnline(typeof navigator !== "undefined" && "onLine" in navigator ? navigator.onLine : true);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg p-[22px] text-fg">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 text-center">
        <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-[22px] border border-warn/30 bg-warn/[0.05]">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M2 4l20 20" stroke="#ffb02e" strokeWidth="1.7" strokeLinecap="round" />
            <path
              d="M5 12.5a10 10 0 0 1 4-2.3M2 8.8A15 15 0 0 1 6 6.4M18 6.4A15 15 0 0 1 22 8.8M12 7c1.2 0 2.4.15 3.5.45M8.5 15.8A6 6 0 0 1 12 14.6c.9 0 1.7.18 2.5.5"
              stroke="#ffb02e"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
            <circle cx="12" cy="19" r="1.4" fill="#ffb02e" />
          </svg>
        </div>
        <p className="font-mono text-[10px] tracking-[3px] text-warn">○ NO CONNECTION</p>
        <h1 className="mt-2 font-display text-[22px] font-bold text-fg">You’re offline</h1>
        <p className="mt-2 text-[13px] leading-[1.55] text-muted">
          Portcode needs a network to reach your desktop. We’ll reconnect automatically when you’re
          back.
        </p>
      </div>
      <button
        onClick={onRetry}
        className="h-[54px] w-full rounded-[13px] border border-warn/40 bg-warn/10 font-display text-[15px] font-bold tracking-[0.7px] text-warn transition hover:bg-warn/[0.18] hover:shadow-[0_0_22px_rgba(255,176,46,.18)]"
      >
        ↻ Try again
      </button>
    </div>
  );
}
