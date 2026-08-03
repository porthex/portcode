import {
  listenCodexRealtime,
  startCodexRealtime,
  stopCodexRealtime,
  type CodexRealtimeEvent,
} from "./ipc";

type RealtimeUnlisten = () => void;

export type CodexRealtimePhase =
  "idle" | "requestingMicrophone" | "connecting" | "live" | "stopping" | "error";

export interface CodexRealtimeSnapshot {
  phase: CodexRealtimePhase;
  sessionId: string | null;
  error: string | null;
}

export interface CodexRealtimeControllerDeps {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createPeerConnection: () => RTCPeerConnection;
  createAudioElement: () => HTMLAudioElement;
  listen: (
    sessionId: string,
    onEvent: (event: CodexRealtimeEvent) => void,
  ) => Promise<RealtimeUnlisten>;
  start: (sessionId: string, sdp: string) => Promise<void>;
  stop: (sessionId: string) => Promise<void>;
  iceTimeoutMs: number;
}

const defaultDeps = (): CodexRealtimeControllerDeps => ({
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  createPeerConnection: () => new RTCPeerConnection(),
  createAudioElement: () => new Audio(),
  listen: listenCodexRealtime,
  start: startCodexRealtime,
  stop: stopCodexRealtime,
  iceTimeoutMs: 10_000,
});

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Microphone access was denied.";
  }
  const message =
    typeof error === "string" && error.trim()
      ? error
      : error instanceof Error && error.message.trim()
        ? error.message
        : "Voice could not start.";
  const encoded = new TextEncoder().encode(message);
  if (encoded.byteLength <= 1_024) return message;
  let end = 1_024;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      return decoder.decode(encoded.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "Voice could not start.";
}

export class CodexRealtimeController {
  private readonly deps: CodexRealtimeControllerDeps;
  private state: CodexRealtimeSnapshot = { phase: "idle", sessionId: null, error: null };
  private readonly subscribers = new Set<() => void>();
  private operation = 0;
  private stream: MediaStream | null = null;
  private peer: RTCPeerConnection | null = null;
  private audio: HTMLAudioElement | null = null;
  private unlisten: RealtimeUnlisten | null = null;
  private remoteStarted = false;
  private answerApplied = false;
  private remoteStartRequested = false;
  private pendingNativeStart: Promise<void> | null = null;
  private cancelIceWait: (() => void) | null = null;

  constructor(deps: CodexRealtimeControllerDeps = defaultDeps()) {
    this.deps = deps;
  }

  snapshot = (): CodexRealtimeSnapshot => this.state;

  subscribe = (subscriber: () => void): (() => void) => {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  };

  async start(sessionId: string): Promise<void> {
    if (this.state.phase !== "idle" && this.state.phase !== "error") {
      throw new Error("Voice is already starting or active.");
    }
    const operation = ++this.operation;
    this.setState({ phase: "requestingMicrophone", sessionId, error: null });
    this.remoteStarted = false;
    this.answerApplied = false;
    this.remoteStartRequested = false;

    try {
      const unlisten = await this.deps.listen(sessionId, (event) => {
        void this.handleEvent(operation, sessionId, event);
      });
      if (!this.isCurrent(operation, sessionId)) {
        unlisten();
        return;
      }
      this.unlisten = unlisten;

      const stream = await this.deps.getUserMedia({ audio: true });
      if (!this.isCurrent(operation, sessionId)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;

      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) throw new Error("No microphone audio track was available.");
      const peer = this.deps.createPeerConnection();
      this.peer = peer;
      const audio = this.deps.createAudioElement();
      audio.autoplay = true;
      this.audio = audio;
      peer.ontrack = (event) => {
        if (!this.isCurrent(operation, sessionId)) return;
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio.play().catch(() => undefined);
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed" || peer.connectionState === "closed") {
          void this.fail(operation, sessionId, "The voice connection closed unexpectedly.", true);
        }
      };
      peer.addTrack(audioTrack, stream);
      peer.createDataChannel("oai-events");
      const offer = await peer.createOffer();
      this.assertCurrent(operation, sessionId);
      await peer.setLocalDescription(offer);
      this.assertCurrent(operation, sessionId);
      await this.waitForIce(peer, operation, sessionId);
      this.assertCurrent(operation, sessionId);
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("WebRTC did not produce an SDP offer.");

      this.setState({ phase: "connecting", sessionId, error: null });
      this.remoteStartRequested = true;
      const nativeStart = this.deps.start(sessionId, sdp);
      this.pendingNativeStart = nativeStart;
      try {
        await nativeStart;
      } finally {
        if (this.pendingNativeStart === nativeStart) this.pendingNativeStart = null;
      }
      this.assertCurrent(operation, sessionId);
    } catch (error) {
      if (this.isCurrent(operation, sessionId)) {
        await this.fail(operation, sessionId, errorMessage(error), this.remoteStartRequested);
      }
    }
  }

  async stop(): Promise<void> {
    const sessionId = this.state.sessionId;
    if (!sessionId) {
      await this.releaseLocal();
      this.setState({ phase: "idle", sessionId: null, error: null });
      return;
    }
    const operation = ++this.operation;
    this.setState({ phase: "stopping", sessionId, error: null });
    const shouldStopRemote = this.remoteStartRequested;
    await this.releaseLocal();
    let stopError: unknown;
    if (shouldStopRemote) {
      try {
        await this.stopRemoteAfterPendingStart(sessionId);
      } catch (error) {
        stopError = error;
      }
    }
    if (operation !== this.operation) return;
    if (stopError) {
      this.setState({ phase: "error", sessionId: null, error: errorMessage(stopError) });
    } else {
      this.setState({ phase: "idle", sessionId: null, error: null });
    }
  }

  async switchSession(nextSessionId: string | null): Promise<void> {
    if (this.state.sessionId && this.state.sessionId !== nextSessionId) {
      await this.stop();
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.subscribers.clear();
  }

  private async handleEvent(
    operation: number,
    sessionId: string,
    event: CodexRealtimeEvent,
  ): Promise<void> {
    if (!this.isCurrent(operation, sessionId)) return;
    if (!this.remoteStartRequested) return;
    if (event.type === "started") {
      this.remoteStarted = true;
      this.updateLiveState(sessionId);
      return;
    }
    if (event.type === "sdp") {
      try {
        await this.peer?.setRemoteDescription({ type: "answer", sdp: event.sdp });
        if (!this.isCurrent(operation, sessionId)) return;
        this.answerApplied = true;
        this.updateLiveState(sessionId);
      } catch (error) {
        await this.fail(operation, sessionId, errorMessage(error), true);
      }
      return;
    }
    if (event.type === "closed") {
      ++this.operation;
      await this.releaseLocal();
      this.setState({ phase: "idle", sessionId: null, error: null });
      return;
    }
    await this.fail(operation, sessionId, errorMessage(new Error(event.message)), true);
  }

  private updateLiveState(sessionId: string) {
    if (this.remoteStarted && this.answerApplied) {
      this.setState({ phase: "live", sessionId, error: null });
    }
  }

  private async fail(
    operation: number,
    sessionId: string,
    message: string,
    stopRemote: boolean,
  ): Promise<void> {
    if (!this.isCurrent(operation, sessionId)) return;
    ++this.operation;
    await this.releaseLocal();
    if (stopRemote) {
      try {
        await this.stopRemoteAfterPendingStart(sessionId);
      } catch {
        // Local media cleanup remains authoritative even when native stop fails.
      }
    }
    this.setState({ phase: "error", sessionId: null, error: message });
  }

  private async releaseLocal(): Promise<void> {
    this.cancelIceWait?.();
    this.cancelIceWait = null;
    this.unlisten?.();
    this.unlisten = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.peer) {
      this.peer.ontrack = null;
      this.peer.onconnectionstatechange = null;
      this.peer.close();
      this.peer = null;
    }
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
      this.audio = null;
    }
    this.remoteStarted = false;
    this.answerApplied = false;
    this.remoteStartRequested = false;
  }

  private async stopRemoteAfterPendingStart(sessionId: string): Promise<void> {
    const pendingNativeStart = this.pendingNativeStart;
    if (pendingNativeStart) {
      try {
        await pendingNativeStart;
      } catch {
        // A rejected start can still have established native ownership before failing.
      }
    }
    await this.deps.stop(sessionId);
  }

  private waitForIce(peer: RTCPeerConnection, operation: number, sessionId: string): Promise<void> {
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const onChange = () => {
        if (peer.iceGatheringState === "complete") finish(resolve);
      };
      const cancel = () => finish(() => reject(new Error("Voice startup was cancelled.")));
      const timer = window.setTimeout(() => {
        finish(() => reject(new Error("WebRTC timed out while gathering connection candidates.")));
      }, this.deps.iceTimeoutMs);
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        peer.removeEventListener("icegatheringstatechange", onChange);
        if (this.cancelIceWait === cancel) this.cancelIceWait = null;
        if (!this.isCurrent(operation, sessionId)) {
          reject(new Error("Voice startup was cancelled."));
          return;
        }
        complete();
      };
      this.cancelIceWait = cancel;
      peer.addEventListener("icegatheringstatechange", onChange);
    });
  }

  private assertCurrent(operation: number, sessionId: string) {
    if (!this.isCurrent(operation, sessionId)) throw new Error("Voice startup was cancelled.");
  }

  private isCurrent(operation: number, sessionId: string): boolean {
    return operation === this.operation && this.state.sessionId === sessionId;
  }

  private setState(state: CodexRealtimeSnapshot) {
    this.state = state;
    this.subscribers.forEach((subscriber) => subscriber());
  }
}

export function createCodexRealtimeController(): CodexRealtimeController {
  return new CodexRealtimeController();
}
