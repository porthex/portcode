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

  it("disables 'Pair a different desktop' while a reconnect is in flight", async () => {
    // While reconnectRemote() is awaiting, a second tap on the fallback button
    // must be a no-op — an in-flight dial reattaching to the old desktop while
    // the user already pivoted to pair a different one would be confusing.
    let resolveReconnect!: () => void;
    reconnectRemote.mockReturnValueOnce(
      new Promise<void>((res) => {
        resolveReconnect = res;
      }),
    );
    useStore.setState({ lastPairingQr: "QR-REMEMBERED" });
    render(<DisconnectedState />);

    const pairBtn = screen.getByRole("button", { name: "Pair a different desktop" });
    const reconnectBtn = screen.getByRole("button", { name: /Reconnect/ });

    // Kick off the reconnect — it won't resolve until we let it.
    fireEvent.click(reconnectBtn);

    // While in flight: the fallback button is disabled and clicking it is a no-op.
    await act(async () => {
      await Promise.resolve();
    });
    expect(pairBtn).toBeDisabled();
    fireEvent.click(pairBtn);
    expect(forgetRemotePairing).not.toHaveBeenCalled();

    // Once the reconnect settles the button is enabled again.
    await act(async () => {
      resolveReconnect();
      await Promise.resolve();
    });
    expect(pairBtn).not.toBeDisabled();
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
