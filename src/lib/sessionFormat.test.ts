import { describe, it, expect, vi, afterEach } from "vitest";

import { relativeTime, workspaceLabel } from "./sessionFormat";

describe("workspaceLabel", () => {
  it("returns 'local' when no workspace is set", () => {
    expect(workspaceLabel(null)).toBe("local");
  });

  it("returns the basename of a POSIX path", () => {
    expect(workspaceLabel("/home/me/projects/portcode")).toBe("portcode");
  });

  it("returns the basename of a Windows path", () => {
    expect(workspaceLabel("C:\\dev\\porthex\\portcode")).toBe("portcode");
  });

  it("ignores a trailing separator", () => {
    expect(workspaceLabel("/home/me/repo/")).toBe("repo");
  });

  it("falls back to 'local' for a path that is only separators", () => {
    expect(workspaceLabel("///")).toBe("local");
  });
});

describe("relativeTime", () => {
  afterEach(() => vi.useRealTimers());

  const at = (msAgo: number) => Date.now() - msAgo;

  it("reports 'now' under a minute", () => {
    expect(relativeTime(at(30_000))).toBe("now");
  });

  it("reports minutes under an hour", () => {
    expect(relativeTime(at(5 * 60_000))).toBe("5m");
  });

  it("reports hours under a day", () => {
    expect(relativeTime(at(3 * 3_600_000))).toBe("3h");
  });

  it("reports 'yest' at one day", () => {
    expect(relativeTime(at(25 * 3_600_000))).toBe("yest");
  });

  it("reports days beyond one day", () => {
    expect(relativeTime(at(3 * 86_400_000))).toBe("3d");
  });
});
