// Camera QR scanning for the phone's pairing screen.
//
// The phone pairs by scanning the QR the desktop shows in Settings → Phone Sync.
// That QR encodes the desktop's `PairingPayload` JSON verbatim — the exact string
// `phone_sync_connect` parses — so a successful scan yields a payload we can dial
// straight away.
//
// We use the native `@tauri-apps/plugin-barcode-scanner` (MLKit on Android) rather
// than a webview `getUserMedia` decoder: the native path sidesteps Android webview
// camera-permission quirks and is the Tauri-blessed way to scan on mobile. The
// plugin renders the camera preview *behind* a transparented webview, so callers
// toggle the `pc-scanning` chrome (see index.css) for the duration of a scan.
//
// The plugin only exists in the mobile build (the Rust crate is gated to
// android/iOS and registered under `#[cfg(mobile)]`), so every entry point here is
// guarded by `isScannerAvailable()` and the import is dynamic — desktop/preview
// bundles never pull it in, and unit tests can mock the module wholesale.

import { isMobilePlatform } from "./platform";
import { isTauri } from "./ipc";

/** CSS hook toggled on <html> while the native camera preview is live: it makes
 *  the webview content transparent so the camera shows through (see index.css). */
const SCANNING_CLASS = "pc-scanning";

/** True only on the native phone client, where the camera scanner exists. Desktop
 *  and the browser preview advertise the QR instead of scanning one, so the scan
 *  affordance is hidden there. */
export function isScannerAvailable(): boolean {
  return isTauri() && isMobilePlatform();
}

/** The result of a scan attempt. `scanQrPayload` never throws — it folds every
 *  failure into a typed reason the caller can branch on for the right UX. */
export type ScanOutcome =
  | { ok: true; value: string }
  | {
      ok: false;
      reason: "cancelled" | "denied" | "unavailable" | "error";
      message?: string;
    };

function toggleScanningChrome(on: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(SCANNING_CLASS, on);
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Open the native camera and scan one QR code, returning its raw text (the
 *  desktop's `PairingPayload` JSON). Requests camera permission on first use.
 *  Always restores the page chrome before resolving. */
export async function scanQrPayload(): Promise<ScanOutcome> {
  if (!isScannerAvailable()) return { ok: false, reason: "unavailable" };

  let plugin: typeof import("@tauri-apps/plugin-barcode-scanner");
  try {
    plugin = await import("@tauri-apps/plugin-barcode-scanner");
  } catch (e) {
    return { ok: false, reason: "error", message: errMessage(e) };
  }

  try {
    // Camera permission: check, then prompt once if not already granted.
    let state = await plugin.checkPermissions();
    if (state !== "granted") state = await plugin.requestPermissions();
    if (state !== "granted") return { ok: false, reason: "denied" };

    toggleScanningChrome(true);
    // `windowed: true` is REQUIRED, not cosmetic. In windowed mode the native
    // plugin renders the camera preview *behind* the webview and makes the webview
    // transparent (`webView.bringToFront()` on Android), so our own `ScanOverlay`
    // viewfinder + Cancel button paint ON TOP and stay tappable. With
    // `windowed: false` the plugin instead stacks a full-screen camera view OVER
    // the webview: the custom overlay is hidden behind it AND the only way out (our
    // Cancel) becomes untappable — the user gets stuck on a chrome-less camera and
    // has to force-kill the app. Keep this `true`; the `pc-scanning` chrome toggle
    // and the whole overlay design assume it.
    const res = await plugin.scan({
      windowed: true,
      formats: [plugin.Format.QRCode],
    });
    const value = res?.content?.trim();
    // An empty result means the user dismissed the scanner without a read.
    if (!value) return { ok: false, reason: "cancelled" };
    return { ok: true, value };
  } catch (e) {
    const message = errMessage(e);
    // The plugin throws a cancellation-flavoured error when the user backs out.
    if (/cancel/i.test(message)) return { ok: false, reason: "cancelled" };
    // Defensive: a non-cancel failure may leave the native camera running, so ask
    // the plugin to release it before reporting the error (the `finally` only drops
    // the page chrome).
    try {
      await plugin.cancel();
    } catch {
      // best-effort
    }
    return { ok: false, reason: "error", message };
  } finally {
    toggleScanningChrome(false);
  }
}

/** Abort an in-flight scan (the overlay's Cancel button). Best-effort and
 *  idempotent: it restores the chrome and tells the plugin to stop the camera. */
export async function cancelScan(): Promise<void> {
  toggleScanningChrome(false);
  if (!isScannerAvailable()) return;
  try {
    const { cancel } = await import("@tauri-apps/plugin-barcode-scanner");
    await cancel();
  } catch {
    // Best-effort — the camera tears down on its own when the scan promise settles.
  }
}
