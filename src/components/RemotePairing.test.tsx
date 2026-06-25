import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { RemotePairing } from "./RemotePairing";
import { useStore } from "../store/store";
import * as ipc from "../lib/ipc";
import * as scanner from "../lib/scanner";
import type { ConnectInfo, SyncFrame } from "../types";

// RemotePairing is the remote-mode pair/safety flow (design_handoff_mobile_remote).
// It reads remote state from the real store and drives it through connectRemote /
// confirmRemoteSas / disconnectRemote / reconnectRemote. We mock the IPC layer and
// the camera scanner (TDD London style) so connect resolves a deterministic SAS
// without a real desktop, and a scan resolves a payload without a real camera; then
// we assert on observable DOM + store state.
vi.mock("../lib/ipc", () => ({
  phoneSyncConnect: vi.fn(),
  phoneSyncSendCommand: vi.fn(),
  phoneSyncDisconnect: vi.fn(),
  onPhoneSyncFrame: vi.fn(),
  onPhoneSyncDisconnected: vi.fn(),
}));
vi.mock("../lib/scanner", () => ({
  isScannerAvailable: vi.fn(),
  scanQrPayload: vi.fn(),
  cancelScan: vi.fn(),
}));

const m = vi.mocked(ipc);
const s = vi.mocked(scanner);
const initial = useStore.getState();

const codeBox = () => screen.getByLabelText("Pairing code") as HTMLTextAreaElement;
const connectBtn = () => screen.getByRole("button", { name: "Connect" });
const scanBtn = () => screen.getByRole("button", { name: "Scan QR code" });

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(initial, true);
  m.phoneSyncConnect.mockResolvedValue({
    sas: "TANGO-42",
    peerPublicKey: "PEER==",
  } satisfies ConnectInfo);
  m.phoneSyncSendCommand.mockResolvedValue(undefined);
  m.phoneSyncDisconnect.mockResolvedValue(undefined);
  m.onPhoneSyncFrame.mockResolvedValue(() => {});
  m.onPhoneSyncDisconnected.mockResolvedValue(() => {});
  // Default to the non-phone host (preview/desktop): paste only, no camera button.
  s.isScannerAvailable.mockReturnValue(false);
  s.cancelScan.mockResolvedValue(undefined);
});

describe("RemotePairing — pair panel", () => {
  it("renders the design eyebrow/title and the paste field, hiding the camera off-phone", () => {
    render(<RemotePairing />);

    expect(screen.getByText("◧ REMOTE MODE")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pair a phone" })).toBeInTheDocument();
    expect(codeBox()).toBeInTheDocument();
    // No camera scanner in the preview/desktop host — paste is the only path.
    expect(screen.queryByRole("button", { name: "Scan QR code" })).not.toBeInTheDocument();
  });

  it("autofocuses the paste field on mount (no camera)", () => {
    render(<RemotePairing />);
    expect(codeBox()).toHaveFocus();
  });

  it("disables Connect until the pairing code has content", () => {
    render(<RemotePairing />);
    expect(connectBtn()).toBeDisabled();

    fireEvent.change(codeBox(), { target: { value: "  " } });
    expect(connectBtn()).toBeDisabled();

    fireEvent.change(codeBox(), { target: { value: "{json}" } });
    expect(connectBtn()).toBeEnabled();
  });

  it("dials connectRemote with the trimmed payload on Connect", async () => {
    render(<RemotePairing />);

    fireEvent.change(codeBox(), { target: { value: "  {payload}  " } });
    await act(async () => {
      fireEvent.click(connectBtn());
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(m.phoneSyncConnect).toHaveBeenCalledWith("{payload}", false);
    expect(useStore.getState().remoteConnected).toBe(true);
    expect(useStore.getState().remoteSas).toBe("TANGO-42");
  });

  it("shows a pending state while the dial is in flight", async () => {
    let release!: (info: ConnectInfo) => void;
    m.phoneSyncConnect.mockReturnValue(
      new Promise<ConnectInfo>((res) => {
        release = res;
      }),
    );
    render(<RemotePairing />);

    fireEvent.change(codeBox(), { target: { value: "{payload}" } });
    await act(async () => {
      fireEvent.click(connectBtn());
      await Promise.resolve();
    });

    const pending = screen.getByRole("button", { name: "CONNECTING…" });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(codeBox()).toBeDisabled();
    expect(screen.getByText(/reaching your desktop/)).toBeInTheDocument();

    await act(async () => {
      release({ sas: "TANGO-42", peerPublicKey: "PEER==" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("⛨ SECURITY CHECK")).toBeInTheDocument();
  });

  it("surfaces a dial failure inline without losing the typed payload", async () => {
    m.phoneSyncConnect.mockRejectedValue(new Error("no route to host"));
    render(<RemotePairing />);

    fireEvent.change(codeBox(), { target: { value: "{payload}" } });
    await act(async () => {
      fireEvent.click(connectBtn());
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t connect");
    expect(alert).toHaveTextContent("no route to host");
    expect(useStore.getState().remoteConnected).toBe(false);
    // The field keeps the payload, and the CTA relabels to a retry.
    expect(codeBox().value).toBe("{payload}");
    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
  });

  it("fills the field from the clipboard via the PASTE chip", async () => {
    const readText = vi.fn().mockResolvedValue("{from-clipboard}");
    Object.defineProperty(navigator, "clipboard", { value: { readText }, configurable: true });
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "PASTE" }));
      await Promise.resolve();
    });

    expect(readText).toHaveBeenCalledTimes(1);
    expect(codeBox().value).toBe("{from-clipboard}");
  });

  it("surfaces a clipboard read failure as a hint", async () => {
    const readText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { readText }, configurable: true });
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "PASTE" }));
      await Promise.resolve();
    });

    expect(screen.getByText(/Couldn’t read the clipboard/)).toBeInTheDocument();
  });

  it("surfaces an empty clipboard as the same hint", async () => {
    const readText = vi.fn().mockResolvedValue("");
    Object.defineProperty(navigator, "clipboard", { value: { readText }, configurable: true });
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "PASTE" }));
      await Promise.resolve();
    });

    expect(screen.getByText(/Couldn’t read the clipboard/)).toBeInTheDocument();
    expect(codeBox().value).toBe("");
  });
});

describe("RemotePairing — camera scan (phone)", () => {
  beforeEach(() => {
    s.isScannerAvailable.mockReturnValue(true);
  });

  it("offers an enabled camera viewport on the phone", () => {
    render(<RemotePairing />);
    expect(scanBtn()).toBeEnabled();
  });

  it("autofocuses the camera viewport on mount (phone path)", () => {
    render(<RemotePairing />);
    expect(scanBtn()).toHaveFocus();
  });

  it("dials the scanned payload on a successful scan", async () => {
    s.scanQrPayload.mockResolvedValue({ ok: true, value: "{scanned}" });
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(scanBtn());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(m.phoneSyncConnect).toHaveBeenCalledWith("{scanned}", false);
    expect(useStore.getState().remoteConnected).toBe(true);
    expect(useStore.getState().remoteSas).toBe("TANGO-42");
  });

  it("surfaces a denied-camera scan as an inline hint, staying on pair", async () => {
    s.scanQrPayload.mockResolvedValue({ ok: false, reason: "denied" });
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(scanBtn());
      await Promise.resolve();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/Camera access was denied/);
    expect(useStore.getState().remoteConnected).toBe(false);
    expect(m.phoneSyncConnect).not.toHaveBeenCalled();
  });

  it("surfaces an unexpected scanner failure inline", async () => {
    s.scanQrPayload.mockResolvedValue({ ok: false, reason: "error", message: "camera busy" });
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(scanBtn());
      await Promise.resolve();
    });

    expect(screen.getByRole("alert")).toHaveTextContent("camera busy");
    expect(useStore.getState().remoteConnected).toBe(false);
  });

  it("stays silent when the user cancels the scan", async () => {
    s.scanQrPayload.mockResolvedValue({ ok: false, reason: "cancelled" });
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(scanBtn());
      await Promise.resolve();
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(m.phoneSyncConnect).not.toHaveBeenCalled();
  });

  it("shows the scanning overlay while the camera is open and cancels it", async () => {
    let release!: (o: scanner.ScanOutcome) => void;
    s.scanQrPayload.mockReturnValue(
      new Promise<scanner.ScanOutcome>((res) => {
        release = res;
      }),
    );
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(scanBtn());
      await Promise.resolve();
    });

    // The viewport reports busy and the viewfinder overlay (portaled to body) is up.
    expect(scanBtn()).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("dialog", { name: /Scanning for a pairing QR/ })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await Promise.resolve();
    });
    expect(s.cancelScan).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ ok: false, reason: "cancelled" });
      await Promise.resolve();
    });
    expect(
      screen.queryByRole("dialog", { name: /Scanning for a pairing QR/ }),
    ).not.toBeInTheDocument();
  });

  it("moves focus to Cancel and cancels on Escape (modal keyboard affordances)", async () => {
    s.scanQrPayload.mockReturnValue(new Promise<scanner.ScanOutcome>(() => {}));
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(scanBtn());
      await Promise.resolve();
    });

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
      await Promise.resolve();
    });
    expect(s.cancelScan).toHaveBeenCalledTimes(1);
  });

  it("traps Tab on the scanning overlay (focus stays on Cancel)", async () => {
    s.scanQrPayload.mockReturnValue(new Promise<scanner.ScanOutcome>(() => {}));
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(scanBtn());
      await Promise.resolve();
    });

    const dialog = screen.getByRole("dialog", { name: /Scanning for a pairing QR/ });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(cancel).toHaveFocus();
  });
});

describe("RemotePairing — safety panel", () => {
  it("shows the SAS prominently once connected", () => {
    useStore.setState({ remoteConnected: true, remoteSas: "TANGO-42" });
    render(<RemotePairing />);

    expect(screen.getByText("⛨ SECURITY CHECK")).toBeInTheDocument();
    expect(screen.getByText("TANGO-42")).toBeInTheDocument();
    // The SAS box's accessible NAME must INCLUDE the digits so a screen reader hears
    // the actual code (the out-of-band comparison), not a bare "Safety code".
    const sasBox = screen.getByLabelText(/Safety code/);
    expect(sasBox).toHaveAccessibleName(/TANGO-42/);
    expect(sasBox).toHaveTextContent("TANGO-42");
    // The pair panel is gone.
    expect(screen.queryByText("◧ REMOTE MODE")).not.toBeInTheDocument();
  });

  it("lands initial focus on the SAS code, not the affirmative confirm", () => {
    useStore.setState({ remoteConnected: true, remoteSas: "TANGO-42" });
    render(<RemotePairing />);
    expect(screen.getByLabelText(/Safety code/)).toHaveFocus();
    expect(screen.getByRole("button", { name: /It matches/ })).not.toHaveFocus();
  });

  it("renders a placeholder when the SAS is somehow absent", () => {
    useStore.setState({ remoteConnected: true, remoteSas: null });
    render(<RemotePairing />);
    const sasBox = screen.getByLabelText(/Safety code/);
    expect(sasBox).toHaveTextContent("—");
    expect(sasBox).toHaveAccessibleName(/not available/);
    // Anti-MITM: with no code to compare, Confirm must be non-actionable so a
    // state regression can't let the user verify an unverifiable connection.
    expect(screen.getByRole("button", { name: /It matches/ })).toBeDisabled();
  });

  it("Confirm marks the connection verified", () => {
    useStore.setState({ remoteConnected: true, remoteSas: "TANGO-42" });
    render(<RemotePairing />);

    fireEvent.click(screen.getByRole("button", { name: /It matches/ }));
    expect(useStore.getState().remoteVerified).toBe(true);
  });

  it("Cancel drops the channel via the store", async () => {
    useStore.setState({ remoteConnected: true, remoteVerified: false, remoteSas: "TANGO-42" });
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /doesn.t match/ }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(m.phoneSyncDisconnect).toHaveBeenCalledTimes(1);
    expect(useStore.getState().remoteConnected).toBe(false);
  });
});

describe("RemotePairing — cross-launch reconnect", () => {
  it("offers a one-tap reconnect for a remembered desktop", async () => {
    useStore.setState({ lastPairingQr: "QR-REMEMBERED" });
    render(<RemotePairing />);

    expect(screen.getByText("Paired desktop")).toBeInTheDocument();
    const reconnect = screen.getByRole("button", { name: "Reconnect" });

    await act(async () => {
      fireEvent.click(reconnect);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Re-dials the remembered desktop, pre-verified (no SAS re-comparison needed).
    expect(m.phoneSyncConnect).toHaveBeenCalledWith("QR-REMEMBERED", true);
    const st = useStore.getState();
    expect(st.remoteConnected).toBe(true);
    expect(st.remoteVerified).toBe(true);
  });

  it("shows no reconnect affordance without a remembered pairing", () => {
    useStore.setState({ lastPairingQr: null });
    render(<RemotePairing />);
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });
});

describe("RemotePairing — connect drives the live frame subscription", () => {
  it("routes desktop frames through applyFrame after connecting", async () => {
    let cb!: (frame: SyncFrame) => void;
    m.onPhoneSyncFrame.mockImplementation(async (fn) => {
      cb = fn;
      return () => {};
    });
    render(<RemotePairing />);

    fireEvent.change(codeBox(), { target: { value: "{payload}" } });
    await act(async () => {
      fireEvent.click(connectBtn());
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      cb({ t: "session_list", sessions: [] });
    });
    expect(m.onPhoneSyncFrame).toHaveBeenCalledTimes(1);
  });
});

// Snapshot the real clipboard descriptor before each test and restore it after, so
// the per-test `Object.defineProperty(navigator, "clipboard", …)` stub can't leak
// across tests/files. Fall back to delete only when there was no original descriptor.
let origClipboardDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  origClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
});

afterEach(() => {
  if (origClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", origClipboardDescriptor);
  } else if ("clipboard" in navigator) {
    // @ts-expect-error — test-only teardown of the stubbed property (no original).
    delete navigator.clipboard;
  }
});
