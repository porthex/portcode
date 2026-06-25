// Browser-based QR pairing for the iOS web client (docs/IOS_WEB_CLIENT_PLAN.md §5.9).
//
// The desktop advertises a QR encoding its `PairingPayload` JSON (the exact string
// `phone_sync_connect` parses); this module is the web app's *scanner* for that QR.
// It mirrors the native scanner's contract (`src/lib/scanner.ts`): every entry
// point returns a typed `WebScanOutcome` and NEVER throws — failures fold into a
// `reason` the caller can branch on for the right UX.
//
// Why a hand-rolled decoder instead of the platform `BarcodeDetector`:
// iOS Safari (the only browser engine allowed on iOS) does NOT ship
// `BarcodeDetector`. We therefore cannot rely on the native barcode API the way
// Chromium-based browsers could. Instead we capture a raw frame — either a live
// camera frame via `getUserMedia`, or a still photo via an `<input capture>` file
// fallback — pull its pixels off a canvas as `ImageData`, and feed that to a
// software QR decoder.
//
// Why the decoder is INJECTED (dependency injection) rather than imported:
// the real decoder will be `zxing-wasm`, wired in a later phase. Keeping this
// module dependency-free (the caller passes a `QrDecoder`) means:
//   1) we don't pull a wasm blob into bundles/tests that don't need it yet, and
//   2) the heavy DOM/camera plumbing stays unit-testable in jsdom (which has no
//      real 2D canvas, `<video>`, or `getUserMedia`) by injecting fakes.
//
// Why we ALWAYS stop the media tracks before resolving:
// `getUserMedia` holds the camera hardware (and shows the OS "in use" indicator)
// until every `MediaStreamTrack` is `.stop()`ed. If we resolved without stopping,
// the camera light would stay on and the device would be locked out of the camera
// for other apps. So `scanWithCamera` stops tracks on EVERY exit path — success,
// cancellation, permission denial, or error.

/**
 * A QR decoder: given a frame's pixels, return the decoded text, or `null` if no
 * QR code was found. May be sync or async (the real zxing-wasm path is async).
 * Injected so this module stays decoder-agnostic until zxing-wasm lands.
 */
export type QrDecoder = (image: ImageData) => string | null | Promise<string | null>;

/**
 * The result of a web scan attempt. Like the native `ScanOutcome`, the scan
 * functions never throw — they fold every failure into one of these reasons:
 *   - `cancelled`   — the user aborted, or a still image contained no QR.
 *   - `denied`      — the user refused camera permission (`NotAllowedError`).
 *   - `unavailable` — no camera API in this environment.
 *   - `error`       — anything else (decode threw, canvas failed, etc.).
 */
export type WebScanOutcome =
  | { ok: true; value: string }
  | {
      ok: false;
      reason: "cancelled" | "denied" | "unavailable" | "error";
      message?: string;
    };

/**
 * Injectable seams for the heavy DOM access. Each field defaults to a real
 * browser implementation, but tests pass fakes so they never touch a real
 * canvas, `<video>`, or `getUserMedia` (none of which work in jsdom).
 */
export interface ScannerDeps {
  /** Open a camera stream. Defaults to `navigator.mediaDevices.getUserMedia`. */
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  /** Grab one frame's `ImageData` from a source (a `<video>` or image element). */
  captureFrame?: (source: unknown) => ImageData | null;
  /** Wrap a camera `MediaStream` in a frame source (a `<video>`) for `captureFrame`.
   *  Defaults to creating a hidden, muted, playing `<video>`; tests inject a fake. */
  makeVideo?: (stream: MediaStream) => Promise<HTMLVideoElement | MediaStream>;
  /** Decode a still-image `File` to `ImageData` via a canvas. */
  decodeFile?: (file: File) => Promise<ImageData | null>;
  /** Monotonic-ish clock; defaults to `Date.now`. */
  now?: () => number;
  /** Timer used to poll camera frames; defaults to the global `setTimeout`. */
  setTimeoutFn?: typeof setTimeout;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * True when this environment exposes a camera capture API. This is the *browser*
 * path, so it checks only for `navigator.mediaDevices?.getUserMedia` — it does
 * NOT require Tauri (that's the native scanner's job). The web client also offers
 * a file-fallback and manual paste when this returns false.
 */
export function isWebCameraAvailable(): boolean {
  return (
    typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

// ── Real-DOM default helpers ────────────────────────────────────────────────
// These are the production canvas/getUserMedia implementations. They are tiny and
// untestable in jsdom (no 2D canvas context), so tests inject fakes instead.
// They are exercised only in a real browser.

/* c8 ignore start */
function defaultGetUserMedia(c: MediaStreamConstraints): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia(c);
}

/** Draw a frame-bearing source (a `<video>` or `<img>`) onto a 2D canvas and
 *  read its pixels back as `ImageData`. Returns null if no 2D context. */
function drawToImageData(
  source: CanvasImageSource,
  width: number,
  height: number,
): ImageData | null {
  if (!width || !height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

function defaultCaptureFrame(source: unknown): ImageData | null {
  const v = source as HTMLVideoElement;
  return drawToImageData(v, v.videoWidth, v.videoHeight);
}

async function defaultDecodeFile(file: File): Promise<ImageData | null> {
  const bitmap = await createImageBitmap(file);
  try {
    return drawToImageData(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/**
 * Wrap a live `MediaStream` in a hidden, muted, autoplaying `<video>` so the
 * default `captureFrame` (which reads `videoWidth`/`videoHeight`) has a real
 * frame source. Muted + `playsInline` is required for iOS Safari to autoplay
 * without a user gesture. Returns the stream itself (no video) when there is no
 * `document` (non-browser host) — that path is only reachable with the real
 * default capture, which also needs a real DOM, so it degrades to a null frame
 * rather than crashing.
 */
async function defaultMakeVideo(stream: MediaStream): Promise<HTMLVideoElement | MediaStream> {
  if (typeof document === "undefined") return stream;
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    // Autoplay can reject in some browsers; we still try to capture frames — a
    // not-yet-playing video simply yields null frames until it produces one.
  }
  return video;
}

/** Best-effort teardown of a `<video>` we created to host the camera stream:
 *  pause it and detach the stream so it stops holding the source. */
function teardownVideo(source: unknown): void {
  if (typeof HTMLVideoElement === "undefined" || !(source instanceof HTMLVideoElement)) return;
  try {
    source.pause();
    source.srcObject = null;
  } catch {
    // best-effort — tearing the video down must never throw
  }
}
/* c8 ignore stop */

function resolveDeps(deps?: ScannerDeps): Required<ScannerDeps> {
  return {
    getUserMedia: deps?.getUserMedia ?? defaultGetUserMedia,
    captureFrame: deps?.captureFrame ?? defaultCaptureFrame,
    makeVideo: deps?.makeVideo ?? defaultMakeVideo,
    decodeFile: deps?.decodeFile ?? defaultDecodeFile,
    now: deps?.now ?? Date.now,
    setTimeoutFn: deps?.setTimeoutFn ?? setTimeout,
  };
}

/**
 * Decode a still image `File` (the `<input capture>` fallback for browsers/users
 * without a usable live camera). Draws the file to a canvas, reads its pixels,
 * and runs the injected decoder. Never throws.
 *
 * @returns `{ok:true,value}` on a successful decode; `{ok:false,reason:"cancelled"}`
 *   if the image contained no QR (or produced no pixels); `{ok:false,reason:"error"}`
 *   on any exception.
 */
export async function scanFromFile(
  file: File,
  decode: QrDecoder,
  deps?: ScannerDeps,
): Promise<WebScanOutcome> {
  const { decodeFile } = resolveDeps(deps);
  try {
    const image = await decodeFile(file);
    if (!image) return { ok: false, reason: "cancelled" };
    const value = await decode(image);
    if (value == null) return { ok: false, reason: "cancelled" };
    return { ok: true, value };
  } catch (e) {
    return { ok: false, reason: "error", message: errMessage(e) };
  }
}

/** Options for {@link scanWithCamera}. */
export interface CameraScanOptions {
  /** The QR decoder to run on each captured frame (injected; zxing-wasm later). */
  decode: QrDecoder;
  /** Aborts the scan loop → resolves `{ok:false,reason:"cancelled"}`. */
  signal?: AbortSignal;
  /** Delay between frame captures, in ms. Defaults to 250ms. */
  intervalMs?: number;
  /** Injectable DOM seams (tests pass fakes). */
  deps?: ScannerDeps;
}

/** Stop every track on a stream so the camera hardware is released. Best-effort:
 *  a track without a `stop` (some fakes) is simply skipped. */
function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // best-effort — releasing the camera must never throw
    }
  }
}

/**
 * Open the rear camera and poll frames until one decodes to a QR, or the
 * `AbortSignal` aborts. Requests `facingMode: "environment"` (the back camera,
 * which faces the desktop's QR). Maps a permission rejection (`NotAllowedError`)
 * to `"denied"`, a missing camera API to `"unavailable"`, and anything else to
 * `"error"`.
 *
 * ALWAYS stops the media tracks before resolving (see the file header on why the
 * camera light otherwise stays on).
 */
export async function scanWithCamera(opts: CameraScanOptions): Promise<WebScanOutcome> {
  const { getUserMedia, captureFrame, makeVideo, setTimeoutFn } = resolveDeps(opts.deps);
  const intervalMs = opts.intervalMs ?? 250;
  const signal = opts.signal;
  // Whether we fell back to the real `navigator`-backed default (no fake injected).
  // Only then do we gate on `isWebCameraAvailable()` for the "API missing" case;
  // an injected `getUserMedia` is always considered present.
  const usesDefaultGetUserMedia = opts.deps?.getUserMedia === undefined;

  // Fast path: nothing to open if the user already aborted.
  if (signal?.aborted) return { ok: false, reason: "cancelled" };

  let stream: MediaStream | null = null;
  let source: unknown = null;
  try {
    // No camera API in this environment at all → `unavailable` so callers fall
    // back to the file/manual path. This is distinct from a *runtime* failure
    // (hardware fault, etc.) below, which maps to `error`. We check BEFORE the
    // call because the default `getUserMedia` would otherwise throw a TypeError
    // when `navigator.mediaDevices` is absent, which would be mis-mapped to
    // `error`. Callers that inject a custom `getUserMedia` opt out of this gate.
    if (usesDefaultGetUserMedia && !isWebCameraAvailable()) {
      return { ok: false, reason: "unavailable" };
    }

    try {
      stream = await getUserMedia({ video: { facingMode: "environment" } });
    } catch (e) {
      // A permission refusal surfaces as a `NotAllowedError` DOMException.
      if (e instanceof Error && e.name === "NotAllowedError") {
        return { ok: false, reason: "denied" };
      }
      return { ok: false, reason: "error", message: errMessage(e) };
    }

    if (!stream) return { ok: false, reason: "unavailable" };

    // The default `captureFrame` reads pixels off an `HTMLVideoElement` (needs
    // `videoWidth`/`videoHeight`), so a raw `MediaStream` would always yield a
    // null frame. Wrap the stream in a hidden, muted, autoplaying `<video>` and
    // pass THAT to `captureFrame`. Tests inject a fake `makeVideo`/`captureFrame`
    // so this stays unit-testable under jsdom (no real `<video>`).
    source = await makeVideo(stream);

    // Poll frames on an interval until a QR decodes or we're aborted.
    for (;;) {
      if (signal?.aborted) return { ok: false, reason: "cancelled" };

      const frame = captureFrame(source);
      if (frame) {
        const value = await opts.decode(frame);
        if (value != null) return { ok: true, value };
      }

      if (signal?.aborted) return { ok: false, reason: "cancelled" };

      // Wait `intervalMs` before the next capture; resolve early if aborted.
      const aborted = await new Promise<boolean>((resolve) => {
        // Initialized to undefined so a synchronous abort (onAbort firing during
        // addEventListener, before the timer is armed) hits a harmless
        // clearTimeout(undefined) instead of a temporal-dead-zone reference.
        let timer: ReturnType<typeof setTimeout> | undefined = undefined;
        function onAbort() {
          clearTimeout(timer);
          resolve(true);
        }
        // Register the abort listener BEFORE arming the timer: the injected timer
        // may fire (and a test's signal may abort) synchronously, so the listener
        // must already be attached or a sync abort would be missed.
        signal?.addEventListener?.("abort", onAbort, { once: true });
        timer = setTimeoutFn(() => {
          signal?.removeEventListener?.("abort", onAbort);
          resolve(false);
        }, intervalMs) as ReturnType<typeof setTimeout>;
      });
      if (aborted) return { ok: false, reason: "cancelled" };
    }
  } catch (e) {
    return { ok: false, reason: "error", message: errMessage(e) };
  } finally {
    // The camera is released on EVERY exit path: detach the `<video>` we created
    // (if any) and stop every track so the hardware/indicator is freed.
    teardownVideo(source);
    stopStream(stream);
  }
}
