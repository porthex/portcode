import { afterEach, describe, expect, it, vi } from "vitest";

import { getInstallState, isIosSafari, isStandalonePwa } from "./installGate";

// These are pure global sniffs (navigator + window.matchMedia). jsdom's globals
// are read-only, so we swap whole objects with vi.stubGlobal (the pattern from
// platform.test.ts) and restore after each test.
afterEach(() => {
  vi.unstubAllGlobals();
});

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const stubNavigator = (nav: Partial<Navigator> & Record<string, unknown>) =>
  vi.stubGlobal("navigator", nav);

/** Stub window.matchMedia to report a fixed standalone result. */
const stubMatchMedia = (matches: boolean) =>
  vi.stubGlobal("window", {
    matchMedia: (_query: string) => ({ matches }),
  });

describe("isIosSafari", () => {
  it("is true for an iPhone user agent", () => {
    stubNavigator({ userAgent: IPHONE_UA, maxTouchPoints: 5 });
    expect(isIosSafari()).toBe(true);
  });

  it("is true for iPadOS-as-desktop (Macintosh UA + maxTouchPoints > 1)", () => {
    stubNavigator({ userAgent: MAC_UA, maxTouchPoints: 5 });
    expect(isIosSafari()).toBe(true);
  });

  it("is false for a real Mac (Macintosh UA, no touch)", () => {
    stubNavigator({ userAgent: MAC_UA, maxTouchPoints: 0 });
    expect(isIosSafari()).toBe(false);
  });

  it("is false for a desktop (Windows) user agent", () => {
    stubNavigator({ userAgent: DESKTOP_UA, maxTouchPoints: 0 });
    expect(isIosSafari()).toBe(false);
  });

  it("tolerates a navigator without userAgent / maxTouchPoints", () => {
    stubNavigator({});
    expect(isIosSafari()).toBe(false);
  });

  it("returns false when navigator is undefined (non-DOM host)", () => {
    vi.stubGlobal("navigator", undefined);
    expect(isIosSafari()).toBe(false);
  });
});

describe("isStandalonePwa", () => {
  it("is true when matchMedia reports display-mode: standalone", () => {
    stubMatchMedia(true);
    stubNavigator({ userAgent: IPHONE_UA });
    expect(isStandalonePwa()).toBe(true);
  });

  it("is false when matchMedia reports it is not standalone", () => {
    stubMatchMedia(false);
    stubNavigator({ userAgent: IPHONE_UA });
    expect(isStandalonePwa()).toBe(false);
  });

  it("is true via legacy iOS navigator.standalone when matchMedia is false", () => {
    stubMatchMedia(false);
    stubNavigator({ userAgent: IPHONE_UA, standalone: true });
    expect(isStandalonePwa()).toBe(true);
  });

  it("is false when navigator.standalone is present but not true", () => {
    stubMatchMedia(false);
    stubNavigator({ userAgent: IPHONE_UA, standalone: false });
    expect(isStandalonePwa()).toBe(false);
  });

  it("falls back to navigator.standalone when matchMedia is absent", () => {
    vi.stubGlobal("window", {});
    stubNavigator({ userAgent: IPHONE_UA, standalone: true });
    expect(isStandalonePwa()).toBe(true);
  });

  it("is false when window and navigator are both absent", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("navigator", undefined);
    expect(isStandalonePwa()).toBe(false);
  });
});

describe("getInstallState", () => {
  it("allows pairing when installed (reason ok)", () => {
    stubMatchMedia(true);
    stubNavigator({ userAgent: IPHONE_UA, maxTouchPoints: 5 });
    const state = getInstallState();
    expect(state).toMatchObject({
      installed: true,
      ios: true,
      canPair: true,
      reason: "ok",
    });
    expect(state.guidance).toMatch(/installed/i);
  });

  it("blocks pairing on iOS when not installed (reason needs-install)", () => {
    stubMatchMedia(false);
    stubNavigator({ userAgent: IPHONE_UA, maxTouchPoints: 5 });
    const state = getInstallState();
    expect(state).toMatchObject({
      installed: false,
      ios: true,
      canPair: false,
      reason: "needs-install",
    });
    expect(state.guidance).toMatch(/Add to Home Screen/i);
  });

  it("allows pairing on non-iOS when not installed (reason not-ios-ok)", () => {
    stubMatchMedia(false);
    stubNavigator({ userAgent: DESKTOP_UA, maxTouchPoints: 0 });
    const state = getInstallState();
    expect(state).toMatchObject({
      installed: false,
      ios: false,
      canPair: true,
      reason: "not-ios-ok",
    });
    expect(state.guidance).toMatch(/best experience/i);
  });
});
