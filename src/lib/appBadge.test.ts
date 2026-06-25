import { describe, expect, it, vi } from "vitest";

import { setPendingBadge, type AppBadgeApi } from "./appBadge";

// setPendingBadge is a tiny guarded reflector from a pending-decision count onto the
// Home-Screen icon badge (§5.7). It's injectable + never throws, so we test it with
// a fake badge API.

describe("setPendingBadge", () => {
  it("sets the numeric badge when count > 0", () => {
    const api: AppBadgeApi = {
      setAppBadge: vi.fn(async () => {}),
      clearAppBadge: vi.fn(async () => {}),
    };
    setPendingBadge(3, api);
    expect(api.setAppBadge).toHaveBeenCalledWith(3);
    expect(api.clearAppBadge).not.toHaveBeenCalled();
  });

  it("clears the badge when count is 0", () => {
    const api: AppBadgeApi = {
      setAppBadge: vi.fn(async () => {}),
      clearAppBadge: vi.fn(async () => {}),
    };
    setPendingBadge(0, api);
    expect(api.clearAppBadge).toHaveBeenCalledTimes(1);
    expect(api.setAppBadge).not.toHaveBeenCalled();
  });

  it("clears the badge when count is negative (defensive)", () => {
    const api: AppBadgeApi = { clearAppBadge: vi.fn(async () => {}) };
    setPendingBadge(-1, api);
    expect(api.clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it("no-ops when the badge API is absent (undefined)", () => {
    expect(() => setPendingBadge(5, undefined)).not.toThrow();
  });

  it("no-ops when setAppBadge is missing on the api object", () => {
    const api: AppBadgeApi = {}; // navigator without the badge methods
    expect(() => setPendingBadge(2, api)).not.toThrow();
  });

  it("no-ops when clearAppBadge is missing on the api object", () => {
    const api: AppBadgeApi = {};
    expect(() => setPendingBadge(0, api)).not.toThrow();
  });

  it("swallows a rejected setAppBadge promise (cosmetic, never breaks the app)", async () => {
    const api: AppBadgeApi = {
      setAppBadge: vi.fn(async () => {
        throw new Error("NotAllowedError");
      }),
    };
    // The rejection is caught internally; nothing escapes.
    expect(() => setPendingBadge(1, api)).not.toThrow();
    await Promise.resolve();
  });

  it("swallows a rejected clearAppBadge promise", async () => {
    const api: AppBadgeApi = {
      clearAppBadge: vi.fn(async () => {
        throw new Error("nope");
      }),
    };
    expect(() => setPendingBadge(0, api)).not.toThrow();
    await Promise.resolve();
  });

  it("defaults to the global navigator and no-ops under jsdom (no badge methods)", () => {
    // jsdom's navigator lacks setAppBadge/clearAppBadge → default resolution is safe.
    expect(() => setPendingBadge(4)).not.toThrow();
  });
});
