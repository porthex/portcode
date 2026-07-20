import { describe, it, expect, vi, afterEach } from "vitest";

import {
  markdownLiteralText,
  relativeTime,
  remoteAccountLabel,
  workspaceLabel,
} from "./sessionFormat";

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

describe("remoteAccountLabel", () => {
  it("returns no attribution for an unpinned session", () => {
    expect(remoteAccountLabel(null, [])).toBeNull();
  });

  it("derives stable ordinals without exposing opaque profile ids", () => {
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    const sessions = [{ accountProfileId: second }, { accountProfileId: first }];

    expect(remoteAccountLabel(first, sessions)).toBe("ChatGPT account 1");
    expect(remoteAccountLabel(second, sessions)).toBe("ChatGPT account 2");
    expect(remoteAccountLabel(second, sessions)).not.toContain(second);
  });
});

describe("markdownLiteralText", () => {
  it("wraps an ordinary label in a literal code span", () => {
    expect(markdownLiteralText("one@chatgpt.test")).toBe("` one@chatgpt.test `");
  });

  it("uses a fence longer than hostile backticks and leaves nested syntax literal", () => {
    const hostile =
      "`![root [nested]](https://evil.test/pixel)``` <img src=x> &lbrack;still-hostile&rbrack;";
    const escaped = markdownLiteralText(hostile);

    expect(escaped).toBe(`\`\`\`\` ${hostile} \`\`\`\``);
    expect(markdownLiteralText("")).toBe("");
  });
});
