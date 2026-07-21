import { afterEach, describe, expect, it, vi } from "vitest";

import { channel, isBeta, isSelfDev } from "./channel";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("channel", () => {
  it("reports the self-dev channel when VITE_PORTCODE_CHANNEL is 'dev'", () => {
    vi.stubEnv("VITE_PORTCODE_CHANNEL", "dev");
    expect(channel()).toBe("dev");
    expect(isSelfDev()).toBe(true);
    expect(isBeta()).toBe(false);
  });

  it("reports the beta channel when VITE_PORTCODE_CHANNEL is 'beta'", () => {
    vi.stubEnv("VITE_PORTCODE_CHANNEL", "beta");
    expect(channel()).toBe("beta");
    expect(isBeta()).toBe(true);
    expect(isSelfDev()).toBe(false);
  });

  it("falls back to the stable channel when the flag is empty/unset", () => {
    vi.stubEnv("VITE_PORTCODE_CHANNEL", "");
    expect(channel()).toBe("stable");
    expect(isSelfDev()).toBe(false);
    expect(isBeta()).toBe(false);
  });

  it("treats any non-'dev' value as the stable channel", () => {
    vi.stubEnv("VITE_PORTCODE_CHANNEL", "production");
    expect(channel()).toBe("stable");
    expect(isSelfDev()).toBe(false);
    expect(isBeta()).toBe(false);
  });
});
