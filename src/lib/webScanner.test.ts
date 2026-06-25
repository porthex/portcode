import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isWebCameraAvailable,
  scanFromFile,
  scanWithCamera,
  type ScannerDeps,
  type QrDecoder,
} from "./webScanner";

// A throwaway ImageData stand-in: jsdom has no real canvas, so we never construct
// a true ImageData. The decoder only ever passes this through, so its shape is
// irrelevant to the code under test.
const fakeImage = { data: new Uint8ClampedArray(4), width: 1, height: 1 } as unknown as ImageData;

// A File stand-in (jsdom's File works, but we never read it — the injected
// decodeFile bypasses real canvas decoding).
const fakeFile = new File(["x"], "qr.png", { type: "image/png" });

describe("isWebCameraAvailable", () => {
  const orig = globalThis.navigator;
  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", { value: orig, configurable: true });
  });

  it("is true when getUserMedia exists", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: { getUserMedia: () => Promise.resolve({} as MediaStream) } },
      configurable: true,
    });
    expect(isWebCameraAvailable()).toBe(true);
  });

  it("is false when mediaDevices is absent", () => {
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
    expect(isWebCameraAvailable()).toBe(false);
  });

  it("is false when getUserMedia is not a function", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: {} },
      configurable: true,
    });
    expect(isWebCameraAvailable()).toBe(false);
  });
});

describe("scanFromFile", () => {
  it("returns ok with the decoded value", async () => {
    const deps: ScannerDeps = { decodeFile: vi.fn().mockResolvedValue(fakeImage) };
    const decode: QrDecoder = vi.fn().mockResolvedValue("payload-json");
    const out = await scanFromFile(fakeFile, decode, deps);
    expect(out).toEqual({ ok: true, value: "payload-json" });
    expect(deps.decodeFile).toHaveBeenCalledWith(fakeFile);
    expect(decode).toHaveBeenCalledWith(fakeImage);
  });

  it("returns cancelled when the image has no pixels (decodeFile → null)", async () => {
    const deps: ScannerDeps = { decodeFile: vi.fn().mockResolvedValue(null) };
    const decode: QrDecoder = vi.fn();
    const out = await scanFromFile(fakeFile, decode, deps);
    expect(out).toEqual({ ok: false, reason: "cancelled" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("returns cancelled when the decoder finds no QR (returns null)", async () => {
    const deps: ScannerDeps = { decodeFile: vi.fn().mockResolvedValue(fakeImage) };
    const decode: QrDecoder = vi.fn().mockResolvedValue(null);
    const out = await scanFromFile(fakeFile, decode, deps);
    expect(out).toEqual({ ok: false, reason: "cancelled" });
  });

  it("returns error when decodeFile throws", async () => {
    const deps: ScannerDeps = { decodeFile: vi.fn().mockRejectedValue(new Error("boom")) };
    const out = await scanFromFile(fakeFile, vi.fn(), deps);
    expect(out).toEqual({ ok: false, reason: "error", message: "boom" });
  });

  it("stringifies non-Error throws", async () => {
    const deps: ScannerDeps = { decodeFile: vi.fn().mockRejectedValue("plain") };
    const out = await scanFromFile(fakeFile, vi.fn(), deps);
    expect(out).toEqual({ ok: false, reason: "error", message: "plain" });
  });
});

// A fake media track that records whether it was stopped.
function fakeTrack() {
  return { stop: vi.fn() };
}
// A fake MediaStream exposing those tracks.
function fakeStream(tracks: ReturnType<typeof fakeTrack>[]) {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

// A `setTimeout` shim that fires immediately so the polling loop doesn't actually
// wait. Returns a dummy handle (clearTimeout no-ops on it harmlessly).
const immediateTimeout = ((fn: () => void) => {
  fn();
  return 0 as unknown as ReturnType<typeof setTimeout>;
}) as unknown as typeof setTimeout;

describe("scanWithCamera", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("polls frames and returns ok once the decoder yields a value, stopping tracks", async () => {
    const track = fakeTrack();
    const stream = fakeStream([track]);
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const captureFrame = vi.fn().mockReturnValue(fakeImage);
    // null, null, then a hit on the third frame.
    const decode = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("the-payload");

    const out = await scanWithCamera({
      decode,
      deps: { getUserMedia, captureFrame, setTimeoutFn: immediateTimeout },
    });

    expect(out).toEqual({ ok: true, value: "the-payload" });
    expect(decode).toHaveBeenCalledTimes(3);
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: "environment" } });
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("requests the rear camera and tolerates tracks without a stop()", async () => {
    // A track whose stop throws — stopStream must swallow it.
    const badTrack = {
      stop: vi.fn(() => {
        throw new Error("nope");
      }),
    };
    const stream = fakeStream([badTrack as unknown as ReturnType<typeof fakeTrack>]);
    const out = await scanWithCamera({
      decode: vi.fn().mockResolvedValue("v"),
      deps: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
        captureFrame: vi.fn().mockReturnValue(fakeImage),
        setTimeoutFn: immediateTimeout,
      },
    });
    expect(out).toEqual({ ok: true, value: "v" });
    expect(badTrack.stop).toHaveBeenCalled();
  });

  it("skips frames when captureFrame returns null, then succeeds", async () => {
    const track = fakeTrack();
    const captureFrame = vi
      .fn()
      .mockReturnValueOnce(null) // no frame yet → decode skipped, loop waits
      .mockReturnValueOnce(fakeImage);
    const decode = vi.fn().mockResolvedValue("ok-after-null-frame");
    const out = await scanWithCamera({
      decode,
      deps: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream([track])),
        captureFrame,
        setTimeoutFn: immediateTimeout,
      },
    });
    expect(out).toEqual({ ok: true, value: "ok-after-null-frame" });
    expect(decode).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalled();
  });

  it("maps NotAllowedError to denied", async () => {
    const out = await scanWithCamera({
      decode: vi.fn(),
      deps: {
        getUserMedia: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" })),
      },
    });
    expect(out).toEqual({ ok: false, reason: "denied" });
  });

  it("maps a generic getUserMedia rejection to error", async () => {
    const out = await scanWithCamera({
      decode: vi.fn(),
      deps: { getUserMedia: vi.fn().mockRejectedValue(new Error("hardware fault")) },
    });
    expect(out).toEqual({ ok: false, reason: "error", message: "hardware fault" });
  });

  it("returns unavailable when getUserMedia resolves to no stream", async () => {
    const out = await scanWithCamera({
      decode: vi.fn(),
      deps: { getUserMedia: vi.fn().mockResolvedValue(null as unknown as MediaStream) },
    });
    expect(out).toEqual({ ok: false, reason: "unavailable" });
  });

  it("returns cancelled immediately for an already-aborted signal (no camera opened)", async () => {
    const getUserMedia = vi.fn();
    const out = await scanWithCamera({
      decode: vi.fn(),
      signal: AbortSignal.abort(),
      deps: { getUserMedia },
    });
    expect(out).toEqual({ ok: false, reason: "cancelled" });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("returns cancelled and stops tracks when aborted during the poll wait", async () => {
    const track = fakeTrack();
    const controller = new AbortController();
    const getUserMedia = vi.fn().mockResolvedValue(fakeStream([track]));
    const captureFrame = vi.fn().mockReturnValue(fakeImage);
    const decode = vi.fn().mockResolvedValue(null); // never finds a QR
    // setTimeout shim that, instead of firing, aborts the signal so the wait
    // promise resolves via the abort listener (the cancellation path).
    const abortingTimeout = ((_fn: () => void) => {
      controller.abort();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const out = await scanWithCamera({
      decode,
      signal: controller.signal,
      deps: { getUserMedia, captureFrame, setTimeoutFn: abortingTimeout },
    });

    expect(out).toEqual({ ok: false, reason: "cancelled" });
    expect(track.stop).toHaveBeenCalled();
  });

  it("returns cancelled when aborted right after a non-matching decode", async () => {
    const track = fakeTrack();
    const controller = new AbortController();
    const captureFrame = vi.fn().mockReturnValue(fakeImage);
    // Abort as a side effect of the decode call, so the post-decode abort check
    // (before the wait) fires.
    const decode = vi.fn().mockImplementation(async () => {
      controller.abort();
      return null;
    });
    const out = await scanWithCamera({
      decode,
      signal: controller.signal,
      deps: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream([track])),
        captureFrame,
        setTimeoutFn: immediateTimeout,
      },
    });
    expect(out).toEqual({ ok: false, reason: "cancelled" });
    expect(track.stop).toHaveBeenCalled();
  });

  it("catches an unexpected throw from captureFrame and reports error", async () => {
    const track = fakeTrack();
    const out = await scanWithCamera({
      decode: vi.fn(),
      deps: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream([track])),
        captureFrame: vi.fn(() => {
          throw new Error("draw failed");
        }),
        setTimeoutFn: immediateTimeout,
      },
    });
    expect(out).toEqual({ ok: false, reason: "error", message: "draw failed" });
    expect(track.stop).toHaveBeenCalled();
  });
});
