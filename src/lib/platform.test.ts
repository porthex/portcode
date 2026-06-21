import { afterEach, describe, expect, it, vi } from "vitest";

import { isMobilePlatform } from "./platform";

// isMobilePlatform is a pure userAgent sniff. We drive it by stubbing
// `navigator` (jsdom's is read-only, so vi.stubGlobal swaps the whole object)
// and assert the Android branch in isolation.
afterEach(() => {
  vi.unstubAllGlobals();
});

const withUserAgent = (ua: string) => vi.stubGlobal("navigator", { userAgent: ua });

describe("isMobilePlatform", () => {
  it("is true for an Android user agent", () => {
    withUserAgent(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36",
    );
    expect(isMobilePlatform()).toBe(true);
  });

  it("matches case-insensitively (e.g. an 'android' token)", () => {
    withUserAgent("something-android-webview");
    expect(isMobilePlatform()).toBe(true);
  });

  it("is false for a desktop user agent", () => {
    withUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    );
    expect(isMobilePlatform()).toBe(false);
  });

  it("is false for a non-Android mobile (iOS) user agent", () => {
    withUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    );
    expect(isMobilePlatform()).toBe(false);
  });

  it("tolerates a navigator without a userAgent string", () => {
    vi.stubGlobal("navigator", {} as Navigator);
    expect(isMobilePlatform()).toBe(false);
  });

  it("returns false when navigator is undefined (non-DOM host)", () => {
    vi.stubGlobal("navigator", undefined);
    expect(isMobilePlatform()).toBe(false);
  });
});
