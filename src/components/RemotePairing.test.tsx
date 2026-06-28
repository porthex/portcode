import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { RemotePairing } from "./RemotePairing";
import { useStore } from "../store/store";
import * as ipc from "../lib/ipc";
import * as scanner from "../lib/scanner";
import * as webScanner from "../lib/webScanner";
import * as platform from "../lib/platform";
import type { ConnectInfo, SyncFrame } from "../types";

// RemotePairing is the remote-mode pair/safety flow (design_handoff_mobile_remote).
// It reads remote state from the real store and drives it through connectRemote /
// confirmRemoteSas / disconnectRemote / reconnectRemote. We mock the IPC layer,
// the native camera scanner, the browser (webScanner) path, and the platform sniff
// (TDD London style) so connect resolves a deterministic SAS without a real
// desktop, and a scan resolves a payload without a real camera; then we assert on
// observable DOM + store state.
//
// Scan backend selection (detectScanMode in the component):
//   - native: isTauri() && isMobilePlatform()
//   - web:    isWebCameraAvailable()
//   - none:   neither (paste only)
vi.mock("../lib/ipc", () => ({
  phoneSyncConnect: vi.fn(),
  phoneSyncSendCommand: vi.fn(),
  phoneSyncDisconnect: vi.fn(),
  phoneSyncReject: vi.fn(),
  onPhoneSyncFrame: vi.fn(),
  onPhoneSyncDisconnected: vi.fn(),
  isTauri: vi.fn(),
}));
vi.mock("../lib/scanner", () => ({
  isScannerAvailable: vi.fn(),
  scanQrPayload: vi.fn(),
  cancelScan: vi.fn(),
}));
vi.mock("../lib/webScanner", () => ({
  isWebCameraAvailable: vi.fn(),
  scanWithCamera: vi.fn(),
  scanFromFile: vi.fn(),
  // A sentinel decoder object: the component passes it straight to the (mocked)
  // scan functions, so its identity is all that matters — never invoked here.
  defaultQrDecoder: vi.fn(),
}));
vi.mock("../lib/platform", () => ({
  isMobilePlatform: vi.fn(),
}));

const m = vi.mocked(ipc);
const s = vi.mocked(scanner);
const w = vi.mocked(webScanner);
const p = vi.mocked(platform);
const initial = useStore.getState();

const codeBox = () => screen.getByLabelText("Pairing code") as HTMLTextAreaElement;
const connectBtn = () => screen.getByRole("button", { name: "Connect" });
const scanBtn = () => screen.getByRole("button", { name: "Scan QR code" });
const uploadBtn = () => screen.getByRole("button", { name: /Upload a photo of the QR/ });

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
  // Default to the non-phone, non-camera host (preview/desktop): paste only.
  m.isTauri.mockReturnValue(false);
  p.isMobilePlatform.mockReturnValue(false);
  s.isScannerAvailable.mockReturnValue(false);
  s.cancelScan.mockResolvedValue(undefined);
  w.isWebCameraAvailable.mockReturnValue(false);
});

describe("RemotePairing — pair panel", () => {
  it("renders the design eyebrow/title and the paste field, hiding the camera off-phone", () => {
    render(<RemotePairing />);

    expect(screen.getByText("◧ REMOTE MODE")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pair a phone" })).toBeInTheDocument();
    expect(codeBox()).toBeInTheDocument();
    // No camera scanner in the preview/desktop host — paste is the only path.
    expect(screen.queryByRole("button", { name: "Scan QR code" })).not.toBeInTheDocument();
    // Upload affordance IS present even with no live camera: a still photo of the
    // QR can always be decoded regardless of camera availability (fix #1).
    expect(uploadBtn()).toBeInTheDocument();
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

describe("RemotePairing — camera scan (native phone)", () => {
  beforeEach(() => {
    // Native backend: Tauri + mobile.
    m.isTauri.mockReturnValue(true);
    p.isMobilePlatform.mockReturnValue(true);
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

    expect(s.scanQrPayload).toHaveBeenCalledTimes(1);
    // Native path, never the web path.
    expect(w.scanWithCamera).not.toHaveBeenCalled();
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

  it("shows the scanning overlay while the camera is open and cancels it (native)", async () => {
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
    // Native overlay carries no live <video> preview (camera is behind the webview).
    expect(screen.queryByLabelText("Live camera preview")).not.toBeInTheDocument();

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

describe("RemotePairing — camera scan (web client)", () => {
  beforeEach(() => {
    // Web backend: not Tauri, but getUserMedia exists.
    m.isTauri.mockReturnValue(false);
    p.isMobilePlatform.mockReturnValue(false);
    w.isWebCameraAvailable.mockReturnValue(true);
  });

  it("offers an enabled camera viewport on the web client", () => {
    render(<RemotePairing />);
    expect(scanBtn()).toBeEnabled();
    // The idle viewport reads as "tap to open the camera", never a QR.
    expect(screen.getByText("TAP TO SCAN")).toBeInTheDocument();
  });

  it("dials the scanned payload via the web scanner on a successful scan", async () => {
    w.scanWithCamera.mockResolvedValue({ ok: true, value: "{web-scanned}" });
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(scanBtn());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Routed through the WEB scanner with an AbortSignal + the default decoder.
    expect(w.scanWithCamera).toHaveBeenCalledTimes(1);
    const opts = w.scanWithCamera.mock.calls[0][0];
    expect(opts.decode).toBe(webScanner.defaultQrDecoder);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(typeof opts.deps?.makeVideo).toBe("function");
    // …never the native path.
    expect(s.scanQrPayload).not.toHaveBeenCalled();
    expect(m.phoneSyncConnect).toHaveBeenCalledWith("{web-scanned}", false);
    expect(useStore.getState().remoteConnected).toBe(true);
    expect(useStore.getState().remoteSas).toBe("TANGO-42");
  });

  it("surfaces a denied web camera as an inline hint", async () => {
    w.scanWithCamera.mockResolvedValue({ ok: false, reason: "denied" });
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(scanBtn());
      await Promise.resolve();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/Camera access was denied/);
    expect(useStore.getState().remoteConnected).toBe(false);
    expect(m.phoneSyncConnect).not.toHaveBeenCalled();
  });

  it("surfaces an unexpected web scanner failure inline", async () => {
    w.scanWithCamera.mockResolvedValue({ ok: false, reason: "error", message: "decode boom" });
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(scanBtn());
      await Promise.resolve();
    });

    expect(screen.getByRole("alert")).toHaveTextContent("decode boom");
  });

  it("shows the live <video> preview overlay and aborts the scan on Cancel", async () => {
    let release!: (o: webScanner.WebScanOutcome) => void;
    w.scanWithCamera.mockImplementation(
      () =>
        new Promise<webScanner.WebScanOutcome>((res) => {
          release = res;
        }),
    );
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(scanBtn());
      await Promise.resolve();
    });

    // The web overlay carries the live camera <video>.
    expect(screen.getByLabelText("Live camera preview")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: /Scanning for a pairing QR/ })).toBeInTheDocument();

    const signal = w.scanWithCamera.mock.calls[0][0].signal!;
    expect(signal.aborted).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await Promise.resolve();
    });
    // Web Cancel aborts the loop (which releases the camera) — not the native cancel.
    expect(signal.aborted).toBe(true);
    expect(s.cancelScan).not.toHaveBeenCalled();

    await act(async () => {
      release({ ok: false, reason: "cancelled" });
      await Promise.resolve();
    });
    expect(
      screen.queryByRole("dialog", { name: /Scanning for a pairing QR/ }),
    ).not.toBeInTheDocument();
  });

  it("makeVideo binds the stream to the visible <video> and returns it", async () => {
    let capturedMakeVideo!: (stream: MediaStream) => Promise<unknown>;
    // Keep the scan pending so the overlay (and its <video>) stays mounted while we
    // exercise the captured makeVideo seam.
    w.scanWithCamera.mockImplementation((opts) => {
      capturedMakeVideo = opts.deps!.makeVideo as typeof capturedMakeVideo;
      return new Promise<webScanner.WebScanOutcome>(() => {});
    });
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(scanBtn());
      await Promise.resolve();
    });

    // Drive the injected seam with a fake stream while the overlay's <video> exists.
    const play = vi
      .spyOn(window.HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined as unknown as void);
    const fakeStream = { id: "stream" } as unknown as MediaStream;
    let result: unknown;
    await act(async () => {
      result = await capturedMakeVideo(fakeStream);
    });

    const video = screen.getByLabelText("Live camera preview") as HTMLVideoElement;
    expect(result).toBe(video);
    expect(video.srcObject).toBe(fakeStream);
    expect(play).toHaveBeenCalled();
    play.mockRestore();
  });
});

describe("RemotePairing — unmount cleanup", () => {
  it("aborts an in-flight web scan when the component unmounts (no camera leak)", async () => {
    // Web backend so the AbortController path is taken.
    m.isTauri.mockReturnValue(false);
    p.isMobilePlatform.mockReturnValue(false);
    w.isWebCameraAvailable.mockReturnValue(true);

    let capturedSignal!: AbortSignal;
    w.scanWithCamera.mockImplementation((opts) => {
      capturedSignal = opts.signal!;
      return new Promise<webScanner.WebScanOutcome>(() => {}); // never resolves
    });

    const { unmount } = render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(scanBtn());
      await Promise.resolve();
    });

    expect(capturedSignal.aborted).toBe(false);
    unmount();
    expect(capturedSignal.aborted).toBe(true);
  });

  it("calls cancelScan on unmount when a native scan is in flight", async () => {
    // Native backend (Tauri + mobile).
    m.isTauri.mockReturnValue(true);
    p.isMobilePlatform.mockReturnValue(true);
    s.scanQrPayload.mockReturnValue(new Promise<scanner.ScanOutcome>(() => {}));

    const { unmount } = render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(scanBtn());
      await Promise.resolve();
    });

    expect(s.cancelScan).not.toHaveBeenCalled();
    unmount();
    // cancelScan is fire-and-forget in the cleanup; assert it was called.
    expect(s.cancelScan).toHaveBeenCalledTimes(1);
  });
});

describe("RemotePairing — photo-upload fallback (web client)", () => {
  beforeEach(() => {
    m.isTauri.mockReturnValue(false);
    w.isWebCameraAvailable.mockReturnValue(true);
  });

  const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;
  const photo = () => new File(["x"], "qr.png", { type: "image/png" });

  it("offers the upload affordance and a hidden capture input", () => {
    render(<RemotePairing />);
    expect(uploadBtn()).toBeInTheDocument();
    const input = fileInput();
    expect(input).toBeInTheDocument();
    expect(input.accept).toBe("image/*");
    expect(input.getAttribute("capture")).toBe("environment");
  });

  it("also offers the upload affordance when scanMode=none (no live camera at all)", () => {
    // Override: no live camera backend on this host.
    w.isWebCameraAvailable.mockReturnValue(false);
    render(<RemotePairing />);
    // The live-scan button is absent, but the photo-upload fallback IS present.
    expect(screen.queryByRole("button", { name: "Scan QR code" })).not.toBeInTheDocument();
    expect(uploadBtn()).toBeInTheDocument();
  });

  it("decodes an uploaded photo and dials the payload", async () => {
    w.scanFromFile.mockResolvedValue({ ok: true, value: "{from-photo}" });
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.change(fileInput(), { target: { files: [photo()] } });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(w.scanFromFile).toHaveBeenCalledTimes(1);
    expect(w.scanFromFile.mock.calls[0][1]).toBe(webScanner.defaultQrDecoder);
    expect(m.phoneSyncConnect).toHaveBeenCalledWith("{from-photo}", false);
    expect(useStore.getState().remoteConnected).toBe(true);
  });

  it("shows a gentle hint when the photo holds no QR (cancelled)", async () => {
    w.scanFromFile.mockResolvedValue({ ok: false, reason: "cancelled" });
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.change(fileInput(), { target: { files: [photo()] } });
      await Promise.resolve();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/No QR found in that photo/);
    expect(m.phoneSyncConnect).not.toHaveBeenCalled();
  });

  it("surfaces a decode error from the uploaded photo", async () => {
    w.scanFromFile.mockResolvedValue({ ok: false, reason: "error", message: "bad image" });
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.change(fileInput(), { target: { files: [photo()] } });
      await Promise.resolve();
    });

    expect(screen.getByRole("alert")).toHaveTextContent("bad image");
  });

  it("ignores a change event with no file", async () => {
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.change(fileInput(), { target: { files: [] } });
      await Promise.resolve();
    });

    expect(w.scanFromFile).not.toHaveBeenCalled();
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

  it("Cancel rejects the pairing via the store (sends a reject, drops the channel)", async () => {
    useStore.setState({ remoteConnected: true, remoteVerified: false, remoteSas: "TANGO-42" });
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /doesn.t match/ }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Cancel now REJECTS (sends a pairing_reject + tears down), not a bare disconnect.
    expect(m.phoneSyncReject).toHaveBeenCalledTimes(1);
    expect(m.phoneSyncDisconnect).not.toHaveBeenCalled();
    const st = useStore.getState();
    expect(st.remoteConnected).toBe(false);
    expect(st.remoteRejected).toBe(true);
  });

  it("Confirm is gated off once the desktop rejected (a desktop reject closes the door)", () => {
    // A desktop pairing_reject flips remoteConnected→false + remoteRejected→true, so
    // the safety panel isn't shown; but if state momentarily has SAS + rejected, the
    // Confirm button must be non-actionable. Force the panel by keeping connected but
    // rejected to assert the gate directly.
    useStore.setState({
      remoteConnected: true,
      remoteSas: "TANGO-42",
      remoteRejected: true,
    });
    render(<RemotePairing />);
    expect(screen.getByRole("button", { name: /It matches/ })).toBeDisabled();
  });
});

describe("RemotePairing — rejected panel", () => {
  it("renders the rejected banner when the pairing was declined", () => {
    useStore.setState({ remoteConnected: false, remoteRejected: true, remoteRejectReason: null });
    render(<RemotePairing />);

    expect(screen.getByText("⛌ PAIRING DECLINED")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Connection rejected on the other device/ }),
    ).toBeInTheDocument();
    // The pair panel and safety panel are both gone.
    expect(screen.queryByText("◧ REMOTE MODE")).not.toBeInTheDocument();
    expect(screen.queryByText("⛨ SECURITY CHECK")).not.toBeInTheDocument();
  });

  it("shows a desktop-supplied reason when present", () => {
    useStore.setState({
      remoteConnected: false,
      remoteRejected: true,
      remoteRejectReason: "Codes didn't match",
    });
    render(<RemotePairing />);
    expect(screen.getByText("Codes didn't match")).toBeInTheDocument();
  });

  it("'Pair again' clears the rejection and returns to the pair screen", async () => {
    useStore.setState({ remoteConnected: false, remoteRejected: true });
    render(<RemotePairing />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pair again" }));
      await Promise.resolve();
    });

    expect(useStore.getState().remoteRejected).toBe(false);
    // Back on the pair panel.
    expect(screen.getByText("◧ REMOTE MODE")).toBeInTheDocument();
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
