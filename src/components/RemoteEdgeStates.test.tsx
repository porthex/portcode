import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { DisconnectedState, OfflineState } from "./RemoteEdgeStates";
import { useStore } from "../store/store";

// The remote edge states (disconnected / offline). We override the store actions
// they call with spies and assert the component wiring + DOM.
const initial = useStore.getState();

const reconnectRemote = vi.fn(async () => {});
const forgetRemotePairing = vi.fn();
const setOnline = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(initial, true);
  useStore.setState({ reconnectRemote, forgetRemotePairing, setOnline });
});

describe("DisconnectedState", () => {
  it("explains the desktop ended the session", () => {
    render(<DisconnectedState />);
    expect(screen.getByText("Desktop ended the session")).toBeInTheDocument();
    expect(screen.getByText("⚠ DISCONNECTED")).toBeInTheDocument();
  });

  it("reconnects to the remembered desktop", async () => {
    useStore.setState({ lastPairingQr: "QR-REMEMBERED" });
    render(<DisconnectedState />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Reconnect/ }));
      await Promise.resolve();
    });
    expect(reconnectRemote).toHaveBeenCalledTimes(1);
  });

  it("falls back to pairing when Reconnect is pressed with no remembered desktop", async () => {
    useStore.setState({ lastPairingQr: null });
    render(<DisconnectedState />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Reconnect/ }));
      await Promise.resolve();
    });
    // No desktop to dial → drop back to the pairing screen instead.
    expect(reconnectRemote).not.toHaveBeenCalled();
    expect(forgetRemotePairing).toHaveBeenCalledTimes(1);
  });

  it("pairs a different desktop, forgetting the remembered one", () => {
    useStore.setState({ lastPairingQr: "QR-REMEMBERED" });
    render(<DisconnectedState />);

    fireEvent.click(screen.getByRole("button", { name: "Pair a different desktop" }));
    expect(forgetRemotePairing).toHaveBeenCalledTimes(1);
  });

  it("surfaces a reconnect failure instead of silently returning to the idle button", async () => {
    // reconnectRemote folds failures into remoteError (it never throws); the screen
    // must show that error so the user isn't left tapping Reconnect with no feedback.
    const failing = vi.fn(async () => {
      useStore.setState({ remoteError: "no route to host" });
    });
    useStore.setState({ lastPairingQr: "QR-REMEMBERED", reconnectRemote: failing });
    render(<DisconnectedState />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Reconnect/ }));
      await Promise.resolve();
    });

    expect(failing).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("no route to host");
  });

  it("hides the reconnect error while a retry is in flight", async () => {
    // A prior failure left an error, but once the user taps Reconnect again the
    // stale error is replaced by the busy state rather than shown alongside it.
    let release!: () => void;
    const pending = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    useStore.setState({
      lastPairingQr: "QR-REMEMBERED",
      remoteError: "earlier failure",
      reconnectRemote: pending,
    });
    render(<DisconnectedState />);

    fireEvent.click(screen.getByRole("button", { name: /Reconnect/ }));
    // Mid-flight: the button is busy and the stale error is suppressed.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reconnecting/ })).toBeInTheDocument();

    await act(async () => {
      release();
      await Promise.resolve();
    });
  });
});

describe("OfflineState", () => {
  it("explains the device is offline", () => {
    render(<OfflineState />);
    expect(screen.getByText("You’re offline")).toBeInTheDocument();
    expect(screen.getByText("○ NO CONNECTION")).toBeInTheDocument();
  });

  it("re-checks connectivity on Try again", () => {
    render(<OfflineState />);
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(setOnline).toHaveBeenCalledWith(navigator.onLine);
  });
});
