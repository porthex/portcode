import { afterEach, describe, expect, it, vi } from "vitest";

import { channel, isSelfDev } from "./channel";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("channel", () => {
  it("reports the self-dev channel when VITE_PORTCODE_CHANNEL is 'dev'", () => {
    vi.stubEnv("VITE_PORTCODE_CHANNEL", "dev");
    expect(channel()).toBe("dev");
    expect(isSelfDev()).toBe(true);
  });

  it("falls back to the stable channel when the flag is empty/unset", () => {
    vi.stubEnv("VITE_PORTCODE_CHANNEL", "");
    expect(channel()).toBe("stable");
    expect(isSelfDev()).toBe(false);
  });

  it("treats any non-'dev' value as the stable channel", () => {
    vi.stubEnv("VITE_PORTCODE_CHANNEL", "production");
    expect(channel()).toBe("stable");
    expect(isSelfDev()).toBe(false);
  });
});
