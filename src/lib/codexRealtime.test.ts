import { describe, expect, it, vi } from "vitest";

import {
  CodexRealtimeController,
  createCodexRealtimeController,
  type CodexRealtimeControllerDeps,
} from "./codexRealtime";
import type { CodexRealtimeEvent } from "./ipc";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function harness() {
  let emit: ((event: CodexRealtimeEvent) => void) | undefined;
  const unlisten = vi.fn();
  const track = { stop: vi.fn() } as unknown as MediaStreamTrack;
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const peer = {
    iceGatheringState: "complete",
    localDescription: null as RTCSessionDescription | null,
    remoteDescription: null as RTCSessionDescription | null,
    ontrack: null as RTCPeerConnection["ontrack"],
    connectionState: "new",
    onconnectionstatechange: null as RTCPeerConnection["onconnectionstatechange"],
    addTrack: vi.fn(),
    createDataChannel: vi.fn(),
    createOffer: vi.fn().mockResolvedValue({ type: "offer", sdp: "v=0\r\no=offer" }),
    setLocalDescription: vi.fn(async function (
      this: { localDescription: RTCSessionDescriptionInit | null },
      description: RTCSessionDescriptionInit,
    ) {
      this.localDescription = description;
    }),
    setRemoteDescription: vi.fn(async function (
      this: { remoteDescription: RTCSessionDescriptionInit | null },
      description: RTCSessionDescriptionInit,
    ) {
      this.remoteDescription = description;
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    close: vi.fn(),
  } as unknown as RTCPeerConnection;
  const audio = {
    autoplay: false,
    srcObject: null,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
  } as unknown as HTMLAudioElement;
  const deps: CodexRealtimeControllerDeps = {
    getUserMedia: vi.fn().mockResolvedValue(stream),
    createPeerConnection: vi.fn(() => peer),
    createAudioElement: vi.fn(() => audio),
    listen: vi.fn(async (_sessionId, onEvent) => {
      emit = onEvent;
      return unlisten;
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    iceTimeoutMs: 25,
  };
  return {
    deps,
    emit: (event: CodexRealtimeEvent) => emit?.(event),
    peer,
    stream,
    track,
    audio,
    unlisten,
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("CodexRealtimeController", () => {
  it("negotiates the pinned WebRTC media and event-channel shape before becoming live", async () => {
    const h = harness();
    const controller = new CodexRealtimeController(h.deps);

    await controller.start("session-1");
    expect(controller.snapshot()).toEqual({
      phase: "connecting",
      sessionId: "session-1",
      error: null,
    });
    expect(h.deps.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(h.peer.addTrack).toHaveBeenCalledWith(h.track, h.stream);
    expect(h.peer.createDataChannel).toHaveBeenCalledWith("oai-events");
    expect(h.deps.start).toHaveBeenCalledWith("session-1", "v=0\r\no=offer");

    h.emit({ type: "started" });
    h.emit({ type: "sdp", sdp: "v=0\r\no=answer" });
    await settle();

    expect(h.peer.setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: "v=0\r\no=answer",
    });
    expect(controller.snapshot().phase).toBe("live");
  });

  it("fails closed and releases the listener when microphone permission is denied", async () => {
    const h = harness();
    vi.mocked(h.deps.getUserMedia).mockRejectedValue(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    const controller = new CodexRealtimeController(h.deps);

    await controller.start("session-1");

    expect(controller.snapshot()).toEqual({
      phase: "error",
      sessionId: null,
      error: "Microphone access was denied.",
    });
    expect(h.unlisten).toHaveBeenCalledOnce();
    expect(h.deps.start).not.toHaveBeenCalled();
  });

  it("stops every local resource when native startup rejects", async () => {
    const h = harness();
    vi.mocked(h.deps.start).mockRejectedValue(new Error("conversation is not established"));
    const controller = new CodexRealtimeController(h.deps);

    await controller.start("session-1");

    expect(controller.snapshot().phase).toBe("error");
    expect(controller.snapshot().error).toContain("not established");
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.peer.close).toHaveBeenCalledOnce();
    expect(h.unlisten).toHaveBeenCalledOnce();
  });

  it("surfaces bounded native string rejections instead of replacing them with a generic error", async () => {
    const h = harness();
    vi.mocked(h.deps.start).mockRejectedValue(
      "Codex realtime is not enabled for this conversation: " + "x".repeat(2_048),
    );
    const controller = new CodexRealtimeController(h.deps);

    await controller.start("session-1");

    expect(controller.snapshot().error).toContain("Codex realtime is not enabled");
    expect(
      new TextEncoder().encode(controller.snapshot().error ?? "").byteLength,
    ).toBeLessThanOrEqual(1_024);
    expect(h.track.stop).toHaveBeenCalledOnce();
  });

  it("stops native voice and local media when applying the answer fails", async () => {
    const h = harness();
    vi.mocked(h.peer.setRemoteDescription).mockRejectedValue(new Error("bad answer"));
    const controller = new CodexRealtimeController(h.deps);
    await controller.start("session-1");

    h.emit({ type: "sdp", sdp: "v=0\r\nbad" });
    await settle();

    expect(h.deps.stop).toHaveBeenCalledWith("session-1");
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.peer.close).toHaveBeenCalledOnce();
    expect(controller.snapshot()).toEqual({ phase: "error", sessionId: null, error: "bad answer" });
  });

  it("fails and releases media when ICE gathering times out", async () => {
    vi.useFakeTimers();
    const h = harness();
    Object.defineProperty(h.peer, "iceGatheringState", { value: "gathering", configurable: true });
    const controller = new CodexRealtimeController(h.deps);
    const starting = controller.start("session-1");

    await settle();
    await vi.advanceTimersByTimeAsync(25);
    await starting;

    expect(controller.snapshot().error).toContain("timed out");
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.peer.close).toHaveBeenCalledOnce();
    expect(h.deps.start).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("tears down without a redundant stop when the remote side closes or errors", async () => {
    const closed = harness();
    const closedController = new CodexRealtimeController(closed.deps);
    await closedController.start("session-1");
    closed.emit({ type: "closed" });
    await settle();
    expect(closedController.snapshot().phase).toBe("idle");
    expect(closed.deps.stop).not.toHaveBeenCalled();
    expect(closed.track.stop).toHaveBeenCalledOnce();

    const failed = harness();
    const failedController = new CodexRealtimeController(failed.deps);
    await failedController.start("session-2");
    failed.emit({ type: "error", message: "transport failed" });
    await settle();
    expect(failedController.snapshot()).toEqual({
      phase: "error",
      sessionId: null,
      error: "transport failed",
    });
    expect(failed.deps.stop).not.toHaveBeenCalled();
    expect(failed.track.stop).toHaveBeenCalledOnce();
  });

  it("stops the exact owner on session switch and component disposal", async () => {
    const h = harness();
    const controller = new CodexRealtimeController(h.deps);
    await controller.start("session-1");

    await controller.switchSession("session-2");
    expect(h.deps.stop).toHaveBeenCalledWith("session-1");
    expect(controller.snapshot().phase).toBe("idle");

    await controller.start("session-2");
    await controller.dispose();
    expect(h.deps.stop).toHaveBeenLastCalledWith("session-2");
    expect(h.track.stop).toHaveBeenCalledTimes(2);
    expect(h.peer.close).toHaveBeenCalledTimes(2);
  });

  it("can start again after a dispose/setup cycle", async () => {
    const h = harness();
    const controller = new CodexRealtimeController(h.deps);
    await controller.dispose();

    const starting = controller.start("session-2");
    await vi.waitFor(() =>
      expect(h.deps.start).toHaveBeenCalledWith("session-2", expect.any(String)),
    );
    h.emit({ type: "started" });
    h.emit({ type: "sdp", sdp: "answer-sdp" });
    Object.defineProperty(h.peer, "connectionState", {
      value: "connected",
      configurable: true,
    });
    h.peer.onconnectionstatechange?.({} as Event);
    await starting;

    expect(controller.snapshot()).toMatchObject({
      phase: "live",
      sessionId: "session-2",
    });
  });

  it("rejects a double start without acquiring another microphone", async () => {
    const h = harness();
    const controller = new CodexRealtimeController(h.deps);
    await controller.start("session-1");

    await expect(controller.start("session-1")).rejects.toThrow("already");
    expect(h.deps.getUserMedia).toHaveBeenCalledOnce();
  });

  it("releases local media before waiting for a slow native stop", async () => {
    const h = harness();
    const nativeStop = deferred<void>();
    vi.mocked(h.deps.stop).mockReturnValue(nativeStop.promise);
    const controller = new CodexRealtimeController(h.deps);
    await controller.start("session-1");

    const stopping = controller.stop();
    await settle();
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.peer.close).toHaveBeenCalledOnce();

    nativeStop.resolve();
    await stopping;
    expect(controller.snapshot().phase).toBe("idle");
  });

  it("waits for a cancelled native start before stopping its possible owner", async () => {
    const h = harness();
    const nativeStart = deferred<void>();
    vi.mocked(h.deps.start).mockReturnValue(nativeStart.promise);
    const controller = new CodexRealtimeController(h.deps);
    const starting = controller.start("session-1");
    await vi.waitFor(() => expect(h.deps.start).toHaveBeenCalledOnce());

    const stopping = controller.stop();
    await settle();
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.deps.stop).not.toHaveBeenCalled();

    nativeStart.resolve();
    await Promise.all([starting, stopping]);
    expect(h.deps.stop).toHaveBeenCalledWith("session-1");
    expect(controller.snapshot().phase).toBe("idle");
  });

  it("unlistens a late subscription after disposal without acquiring media", async () => {
    const h = harness();
    const lateListen = deferred<() => void>();
    const lateUnlisten = vi.fn();
    vi.mocked(h.deps.listen).mockReturnValue(lateListen.promise);
    const controller = new CodexRealtimeController(h.deps);
    const starting = controller.start("session-1");

    await controller.dispose();
    lateListen.resolve(lateUnlisten);
    await starting;

    expect(lateUnlisten).toHaveBeenCalledOnce();
    expect(h.deps.getUserMedia).not.toHaveBeenCalled();
  });

  it("ignores lifecycle events that arrive before native startup owns the session", async () => {
    const h = harness();
    const microphone = deferred<MediaStream>();
    vi.mocked(h.deps.getUserMedia).mockReturnValue(microphone.promise);
    const controller = new CodexRealtimeController(h.deps);
    const starting = controller.start("session-1");
    await settle();

    h.emit({ type: "started" });
    h.emit({ type: "sdp", sdp: "v=0\r\npremature" });
    await settle();
    microphone.resolve(h.stream);
    await starting;

    h.emit({ type: "started" });
    await settle();

    expect(h.peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(controller.snapshot().phase).toBe("connecting");
  });

  it("cancels an in-flight ICE wait immediately during disposal", async () => {
    vi.useFakeTimers();
    const h = harness();
    Object.defineProperty(h.peer, "iceGatheringState", { value: "gathering", configurable: true });
    const controller = new CodexRealtimeController(h.deps);
    let startupSettled = false;
    const starting = controller.start("session-1").then(() => {
      startupSettled = true;
    });
    await settle();

    await controller.dispose();
    await settle();

    expect(h.peer.removeEventListener).toHaveBeenCalledWith(
      "icegatheringstatechange",
      expect.any(Function),
    );
    expect(startupSettled).toBe(true);
    await starting;
    vi.useRealTimers();
  });

  it("bounds local exception text before exposing it to the composer", async () => {
    const h = harness();
    vi.mocked(h.deps.getUserMedia).mockRejectedValue(new Error("x".repeat(2_048)));
    const controller = new CodexRealtimeController(h.deps);
    await controller.start("session-1");

    expect(
      new TextEncoder().encode(controller.snapshot().error ?? "").byteLength,
    ).toBeLessThanOrEqual(1_024);
  });

  it("truncates an exception only at a valid UTF-8 boundary", async () => {
    const h = harness();
    vi.mocked(h.deps.getUserMedia).mockRejectedValue(
      new Error(`${"x".repeat(1_023)}é${"x".repeat(50)}`),
    );
    const controller = new CodexRealtimeController(h.deps);
    await controller.start("session-1");

    const message = controller.snapshot().error ?? "";
    expect(new TextEncoder().encode(message).byteLength).toBe(1_023);
    expect(message).not.toContain("�");
  });

  it("stops media that resolves after cancellation and handles an idle stop", async () => {
    const h = harness();
    const microphone = deferred<MediaStream>();
    vi.mocked(h.deps.getUserMedia).mockReturnValue(microphone.promise);
    const controller = new CodexRealtimeController(h.deps);
    const starting = controller.start("session-1");
    await settle();

    await controller.stop();
    microphone.resolve(h.stream);
    await starting;
    await controller.stop();

    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.deps.start).not.toHaveBeenCalled();
    expect(controller.snapshot()).toEqual({ phase: "idle", sessionId: null, error: null });
  });

  it("fails closed when the microphone stream has no audio track or no local SDP", async () => {
    const noTrack = harness();
    vi.mocked(noTrack.deps.getUserMedia).mockResolvedValue({
      getAudioTracks: () => [],
      getTracks: () => [],
    } as unknown as MediaStream);
    const noTrackController = new CodexRealtimeController(noTrack.deps);
    await noTrackController.start("session-1");
    expect(noTrackController.snapshot().error).toContain("No microphone audio track");

    const noSdp = harness();
    vi.mocked(noSdp.peer.setLocalDescription).mockResolvedValue(undefined);
    const noSdpController = new CodexRealtimeController(noSdp.deps);
    await noSdpController.start("session-2");
    expect(noSdpController.snapshot().error).toContain("did not produce an SDP offer");
    expect(noSdp.track.stop).toHaveBeenCalledOnce();
  });

  it("plays remote audio, falls back to the received track, and tears down a failed peer", async () => {
    const h = harness();
    const RemoteMediaStream = class {
      constructor(readonly tracks: MediaStreamTrack[]) {}
    };
    vi.stubGlobal("MediaStream", RemoteMediaStream);
    vi.mocked(h.audio.play).mockRejectedValue(new Error("autoplay blocked"));
    const controller = new CodexRealtimeController(h.deps);
    await controller.start("session-1");

    const remoteTrack = {} as MediaStreamTrack;
    h.peer.ontrack?.({ streams: [], track: remoteTrack } as unknown as RTCTrackEvent);
    await settle();
    expect(h.audio.srcObject).toBeInstanceOf(MediaStream);

    Object.defineProperty(h.peer, "connectionState", { value: "failed", configurable: true });
    h.peer.onconnectionstatechange?.({} as Event);
    await settle();
    expect(h.deps.stop).toHaveBeenCalledWith("session-1");
    expect(controller.snapshot().error).toContain("closed unexpectedly");
    vi.unstubAllGlobals();
  });

  it("reports native stop failure after local media is already released", async () => {
    const h = harness();
    vi.mocked(h.deps.stop).mockRejectedValue(new Error("native stop failed"));
    const controller = new CodexRealtimeController(h.deps);
    await controller.start("session-1");

    await controller.stop();

    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(controller.snapshot()).toEqual({
      phase: "error",
      sessionId: null,
      error: "native stop failed",
    });
  });

  it("notifies and unsubscribes snapshot observers", async () => {
    const h = harness();
    const controller = new CodexRealtimeController(h.deps);
    const subscriber = vi.fn();
    const unsubscribe = controller.subscribe(subscriber);

    await controller.start("session-1");
    expect(subscriber).toHaveBeenCalled();
    subscriber.mockClear();
    unsubscribe();
    await controller.stop();
    expect(subscriber).not.toHaveBeenCalled();
  });

  it("wires the production browser media factories before the desktop-only bridge rejects", async () => {
    const h = harness();
    const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: h.deps.getUserMedia },
    });
    const peerFactory = vi.fn(function PeerFactory() {
      return h.peer;
    });
    const audioFactory = vi.fn(function AudioFactory() {
      return h.audio;
    });
    vi.stubGlobal("RTCPeerConnection", peerFactory);
    vi.stubGlobal("Audio", audioFactory);

    const controller = createCodexRealtimeController();
    await controller.start("session-1");

    expect(peerFactory).toHaveBeenCalledOnce();
    expect(audioFactory).toHaveBeenCalledOnce();
    expect(controller.snapshot().error).toContain("native desktop");
    vi.unstubAllGlobals();
    if (mediaDescriptor) Object.defineProperty(navigator, "mediaDevices", mediaDescriptor);
    else Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("drops stale media, lifecycle, answer, and peer-failure callbacks after stop", async () => {
    const h = harness();
    const answer = deferred<void>();
    vi.mocked(h.peer.setRemoteDescription).mockReturnValue(answer.promise);
    const controller = new CodexRealtimeController(h.deps);
    await controller.start("session-1");
    const staleTrack = h.peer.ontrack;
    const stalePeerChange = h.peer.onconnectionstatechange;

    h.emit({ type: "sdp", sdp: "v=0\r\nanswer" });
    await controller.stop();
    h.emit({ type: "started" });
    staleTrack?.call(h.peer, { streams: [h.stream], track: h.track } as unknown as RTCTrackEvent);
    Object.defineProperty(h.peer, "connectionState", { value: "failed", configurable: true });
    stalePeerChange?.call(h.peer, {} as Event);
    answer.resolve();
    await settle();

    expect(controller.snapshot().phase).toBe("idle");
    expect(h.audio.play).not.toHaveBeenCalled();
  });

  it("finishes ICE gathering once and ignores repeated completion signals", async () => {
    const h = harness();
    Object.defineProperty(h.peer, "iceGatheringState", { value: "gathering", configurable: true });
    const controller = new CodexRealtimeController(h.deps);
    const starting = controller.start("session-1");
    await settle();
    const listener = vi.mocked(h.peer.addEventListener).mock.calls[0]?.[1] as EventListener;

    Object.defineProperty(h.peer, "iceGatheringState", { value: "complete", configurable: true });
    listener({} as Event);
    listener({} as Event);
    await starting;

    expect(h.deps.start).toHaveBeenCalledOnce();
    expect(h.peer.removeEventListener).toHaveBeenCalledOnce();
  });

  it("lets a newer stop operation supersede a slow native stop", async () => {
    const h = harness();
    const nativeStop = deferred<void>();
    vi.mocked(h.deps.stop).mockReturnValueOnce(nativeStop.promise).mockResolvedValue(undefined);
    const controller = new CodexRealtimeController(h.deps);
    await controller.start("session-1");

    const first = controller.stop();
    await settle();
    const second = controller.stop();
    await second;
    nativeStop.resolve();
    await first;

    expect(controller.snapshot().phase).toBe("idle");
  });

  it("cancels after an offer resolves when disposal replaced the startup operation", async () => {
    const h = harness();
    const offer = deferred<RTCSessionDescriptionInit>();
    const createOffer = vi.fn(() => offer.promise);
    Object.defineProperty(h.peer, "createOffer", { value: createOffer, configurable: true });
    const controller = new CodexRealtimeController(h.deps);
    const starting = controller.start("session-1");
    await settle();
    await controller.dispose();

    offer.resolve({ type: "offer", sdp: "v=0\r\nlate" });
    await starting;

    expect(h.peer.setLocalDescription).not.toHaveBeenCalled();
    expect(createOffer).toHaveBeenCalledOnce();
    expect(controller.snapshot().phase).toBe("idle");
  });

  it("cannot resurrect startup after local-description setup resolves behind disposal", async () => {
    const h = harness();
    const localDescription = deferred<void>();
    vi.mocked(h.peer.setLocalDescription).mockReturnValue(localDescription.promise);
    const controller = new CodexRealtimeController(h.deps);
    const starting = controller.start("session-1");
    await settle();
    await controller.dispose();

    localDescription.resolve();
    await starting;

    expect(h.deps.start).not.toHaveBeenCalled();
    expect(controller.snapshot().phase).toBe("idle");
  });
});
