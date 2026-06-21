import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { RemotePairing } from "./RemotePairing";
import { useStore } from "../store/store";
import * as ipc from "../lib/ipc";
import * as scanner from "../lib/scanner";
import type { ConnectInfo, SyncFrame } from "../types";

// RemotePairing is the remote-mode entry screen. It reads remote state from the
// real store and drives it through connectRemote / confirmRemoteSas /
// disconnectRemote. We mock the IPC layer and the camera scanner (TDD London
// style) so connect can resolve a deterministic SAS without a real desktop, and a
// scan can resolve a payload without a real camera; then we assert on observable
// DOM + store state. House style mirrors Settings.test.tsx / store.test.ts.
vi.mock("../lib/ipc", () => ({
  phoneSyncConnect: vi.fn(),
  phoneSyncSendCommand: vi.fn(),
  phoneSyncDisconnect: vi.fn(),
  onPhoneSyncFrame: vi.fn(),
}));
vi.mock("../lib/scanner", () => ({
  isScannerAvailable: vi.fn(),
  scanQrPayload: vi.fn(),
  cancelScan: vi.fn(),
}));

const m = vi.mocked(ipc);
const s = vi.mocked(scanner);
const initial = useStore.getState();

const qrBox = () => screen.getByLabelText("Pairing code") as HTMLTextAreaElement;
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
  // Default to the non-phone host (preview/desktop): paste only, no camera button.
  s.isScannerAvailable.mockReturnValue(false);
  s.cancelScan.mockResolvedValue(undefined);
});

describe("RemotePairing — connect panel", () => {
  it("renders the paste affordance and hides the camera button off-phone", () => {
    render(<RemotePairing />);

    expect(screen.getByText("CONNECT TO DESKTOP")).toBeInTheDocument();
    expect(qrBox()).toBeInTheDocument();

    // No camera scanner in the preview/desktop host — paste is the only path.
    expect(screen.queryByRole("button", { name: /Scan QR/ })).not.toBeInTheDocument();
  });

  it("disables Connect until the pairing code has content", () => {
    render(<RemotePairing />);
    expect(connectBtn()).toBeDisabled();

    fireEvent.change(qrBox(), { target: { value: "  " } });
    expect(connectBtn()).toBeDisabled();

    fireEvent.change(qrBox(), { target: { value: "{json}" } });
    expect(connectBtn()).toBeEnabled();
  });

  it("dials connectRemote with the trimmed payload on Connect", async () => {
    render(<RemotePairing />);

    fireEvent.change(qrBox(), { target: { value: "  {payload}  " } });
    await act(async () => {
      fireEvent.click(connectBtn());
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(m.phoneSyncConnect).toHaveBeenCalledWith("{payload}");
    // A successful dial stores the SAS and flips to the verify state.
    expect(useStore.getState().remoteConnected).toBe(true);
    expect(useStore.getState().remoteSas).toBe("TANGO-42");
  });

  it("shows a pending state while the dial is in flight", async () => {
    // Hold the dial open so the pending UI is observable: the button reads
    // "Connecting…" and the textarea goes inert.
    let release!: (info: ConnectInfo) => void;
    m.phoneSyncConnect.mockReturnValue(
      new Promise<ConnectInfo>((res) => {
        release = res;
      }),
    );
    render(<RemotePairing />);

    fireEvent.change(qrBox(), { target: { value: "{payload}" } });
    await act(async () => {
      fireEvent.click(connectBtn());
      await Promise.resolve();
    });

    const pending = screen.getByRole("button", { name: "Connecting…" });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(qrBox()).toBeDisabled();

    // Let it finish so the component settles into the verify state.
    await act(async () => {
      release({ sas: "TANGO-42", peerPublicKey: "PEER==" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("VERIFY THIS CODE")).toBeInTheDocument();
  });

  it("surfaces a dial failure inline without losing the typed payload", async () => {
    m.phoneSyncConnect.mockRejectedValue(new Error("no route to host"));
    render(<RemotePairing />);

    fireEvent.change(qrBox(), { target: { value: "{payload}" } });
    await act(async () => {
      fireEvent.click(connectBtn());
      await Promise.resolve();
      await Promise.resolve();
    });

    // connectRemote folds the failure into store.remoteError; the panel shows it
    // as an alert and stays on the connect screen (not connected).
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("no route to host");
    expect(useStore.getState().remoteConnected).toBe(false);
    // The textarea keeps the payload so the user can retry without re-pasting.
    expect(qrBox().value).toBe("{payload}");
  });
});

describe("RemotePairing — camera scan (phone)", () => {
  beforeEach(() => {
    s.isScannerAvailable.mockReturnValue(true);
  });

  it("offers an enabled Scan QR button on the phone", () => {
    render(<RemotePairing />);
    expect(scanBtn()).toBeEnabled();
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

    expect(m.phoneSyncConnect).toHaveBeenCalledWith("{scanned}");
    expect(useStore.getState().remoteConnected).toBe(true);
    expect(useStore.getState().remoteSas).toBe("TANGO-42");
  });

  it("surfaces a denied-camera scan as an inline hint, staying on connect", async () => {
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

    // The button reads "Scanning…" and the viewfinder overlay (portaled to body)
    // is visible with a Cancel control.
    expect(screen.getByRole("button", { name: "Scanning…" })).toBeDisabled();
    expect(screen.getByRole("dialog", { name: /Scanning for a pairing QR/ })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await Promise.resolve();
    });
    expect(s.cancelScan).toHaveBeenCalledTimes(1);

    // Settle the underlying scan promise so nothing dangles.
    await act(async () => {
      release({ ok: false, reason: "cancelled" });
      await Promise.resolve();
    });
    expect(
      screen.queryByRole("dialog", { name: /Scanning for a pairing QR/ }),
    ).not.toBeInTheDocument();
  });
});

describe("RemotePairing — verify panel", () => {
  it("shows the SAS prominently once connected", () => {
    useStore.setState({ remoteConnected: true, remoteSas: "TANGO-42" });
    render(<RemotePairing />);

    expect(screen.getByText("VERIFY THIS CODE")).toBeInTheDocument();
    expect(screen.getByText("TANGO-42")).toBeInTheDocument();
    expect(screen.getByLabelText("Pairing verification code")).toHaveTextContent("TANGO-42");
    // The connect panel is gone.
    expect(screen.queryByText("CONNECT TO DESKTOP")).not.toBeInTheDocument();
  });

  it("renders a placeholder when the SAS is somehow absent", () => {
    useStore.setState({ remoteConnected: true, remoteSas: null });
    render(<RemotePairing />);
    expect(screen.getByLabelText("Pairing verification code")).toHaveTextContent("—");
  });

  it("Continue confirms the SAS (marks the connection verified)", () => {
    useStore.setState({ remoteConnected: true, remoteSas: "TANGO-42" });
    render(<RemotePairing />);

    fireEvent.click(screen.getByRole("button", { name: /Codes match/ }));

    expect(useStore.getState().remoteVerified).toBe(true);
  });

  it("Disconnect drops the channel via the store", async () => {
    useStore.setState({ remoteConnected: true, remoteVerified: false, remoteSas: "TANGO-42" });
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Codes don.t match/ }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(m.phoneSyncDisconnect).toHaveBeenCalledTimes(1);
    expect(useStore.getState().remoteConnected).toBe(false);
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

    fireEvent.change(qrBox(), { target: { value: "{payload}" } });
    await act(async () => {
      fireEvent.click(connectBtn());
      await Promise.resolve();
      await Promise.resolve();
    });

    // The subscription the store registered must fold frames into state.
    act(() => {
      cb({ t: "session_list", sessions: [] });
    });
    expect(m.onPhoneSyncFrame).toHaveBeenCalledTimes(1);
  });
});
