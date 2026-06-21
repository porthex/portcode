import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// scanner.ts wraps the native barcode-scanner plugin behind a typed, never-throws
// surface. We mock the plugin and the platform/host detectors (TDD London) so we
// can drive every branch — permission grant/deny, cancel, error — deterministically
// without a real camera, and assert on the observable outcome + the `pc-scanning`
// chrome toggle. House style mirrors ipc.test.ts / store.test.ts.
vi.mock("./platform", () => ({ isMobilePlatform: vi.fn() }));
vi.mock("./ipc", () => ({ isTauri: vi.fn() }));
vi.mock("@tauri-apps/plugin-barcode-scanner", () => ({
  scan: vi.fn(),
  cancel: vi.fn(),
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  Format: { QRCode: "QR_CODE" },
}));

import { isScannerAvailable, scanQrPayload, cancelScan } from "./scanner";
import { isMobilePlatform } from "./platform";
import { isTauri } from "./ipc";
import * as plugin from "@tauri-apps/plugin-barcode-scanner";

const mPlatform = vi.mocked(isMobilePlatform);
const mTauri = vi.mocked(isTauri);
const mPlugin = vi.mocked(plugin);

// The plugin's Scanned shape is richer than the one field we read; build it
// through `unknown` so tests stay terse without `any`.
type ScanResult = Awaited<ReturnType<typeof plugin.scan>>;
const scanResult = (content: string): ScanResult => ({ content }) as unknown as ScanResult;

const SCANNING = () => document.documentElement.classList.contains("pc-scanning");

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the native phone, camera already granted, a clean read.
  mTauri.mockReturnValue(true);
  mPlatform.mockReturnValue(true);
  mPlugin.checkPermissions.mockResolvedValue("granted");
  mPlugin.requestPermissions.mockResolvedValue("granted");
  mPlugin.scan.mockResolvedValue(scanResult("PAYLOAD"));
  mPlugin.cancel.mockResolvedValue(undefined);
});

afterEach(() => {
  document.documentElement.classList.remove("pc-scanning");
});

describe("isScannerAvailable", () => {
  it("is true only on the native phone (tauri + mobile)", () => {
    expect(isScannerAvailable()).toBe(true);
  });

  it("is false in the browser preview (not tauri)", () => {
    mTauri.mockReturnValue(false);
    expect(isScannerAvailable()).toBe(false);
  });

  it("is false on the desktop (tauri but not mobile)", () => {
    mPlatform.mockReturnValue(false);
    expect(isScannerAvailable()).toBe(false);
  });
});

describe("scanQrPayload", () => {
  it("returns unavailable off the phone without touching the plugin", async () => {
    mTauri.mockReturnValue(false);
    expect(await scanQrPayload()).toEqual({ ok: false, reason: "unavailable" });
    expect(mPlugin.scan).not.toHaveBeenCalled();
  });

  it("returns the trimmed scanned payload on success", async () => {
    mPlugin.scan.mockResolvedValue(scanResult("  PAYLOAD  "));
    expect(await scanQrPayload()).toEqual({ ok: true, value: "PAYLOAD" });
    expect(mPlugin.scan).toHaveBeenCalledWith({ windowed: false, formats: ["QR_CODE"] });
  });

  it("prompts for camera permission when not yet granted, then scans", async () => {
    mPlugin.checkPermissions.mockResolvedValue("prompt");
    mPlugin.requestPermissions.mockResolvedValue("granted");
    const r = await scanQrPayload();
    expect(mPlugin.requestPermissions).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: true, value: "PAYLOAD" });
  });

  it("returns denied (without scanning) when permission is refused", async () => {
    mPlugin.checkPermissions.mockResolvedValue("prompt");
    mPlugin.requestPermissions.mockResolvedValue("denied");
    expect(await scanQrPayload()).toEqual({ ok: false, reason: "denied" });
    expect(mPlugin.scan).not.toHaveBeenCalled();
  });

  it("treats an empty read as a cancellation", async () => {
    mPlugin.scan.mockResolvedValue(scanResult("   "));
    expect(await scanQrPayload()).toEqual({ ok: false, reason: "cancelled" });
  });

  it("maps a cancellation error to cancelled", async () => {
    mPlugin.scan.mockRejectedValue(new Error("Scan was cancelled by the user"));
    expect(await scanQrPayload()).toEqual({ ok: false, reason: "cancelled" });
  });

  it("maps an unexpected failure to error and releases the camera", async () => {
    mPlugin.scan.mockRejectedValue(new Error("camera busy"));
    expect(await scanQrPayload()).toEqual({ ok: false, reason: "error", message: "camera busy" });
    // The error path defensively tears the native camera down.
    expect(mPlugin.cancel).toHaveBeenCalledTimes(1);
  });

  it("clears the scanning chrome after a scan settles", async () => {
    await scanQrPayload();
    expect(SCANNING()).toBe(false);
  });

  it("clears the scanning chrome even when the scan throws", async () => {
    mPlugin.scan.mockRejectedValue(new Error("boom"));
    await scanQrPayload();
    expect(SCANNING()).toBe(false);
  });

  it("applies the scanning chrome while the camera is open", async () => {
    let release!: (v: ScanResult) => void;
    mPlugin.scan.mockReturnValue(
      new Promise<ScanResult>((res) => {
        release = res;
      }),
    );
    const pending = scanQrPayload();
    // Wait until it has cleared the dynamic import + permission checks and entered
    // scan() — the chrome is applied just before the camera opens.
    await vi.waitFor(() => expect(SCANNING()).toBe(true));

    release(scanResult("PAYLOAD"));
    expect(await pending).toEqual({ ok: true, value: "PAYLOAD" });
    expect(SCANNING()).toBe(false);
  });
});

describe("cancelScan", () => {
  it("removes the chrome and tells the plugin to stop", async () => {
    document.documentElement.classList.add("pc-scanning");
    await cancelScan();
    expect(SCANNING()).toBe(false);
    expect(mPlugin.cancel).toHaveBeenCalledTimes(1);
  });

  it("is a no-op off the phone", async () => {
    mTauri.mockReturnValue(false);
    await cancelScan();
    expect(mPlugin.cancel).not.toHaveBeenCalled();
  });
});
