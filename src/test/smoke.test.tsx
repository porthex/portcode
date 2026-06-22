import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { DEFAULT_SETTINGS, estimateCost, type Usage } from "../types";

// A small but real smoke test: it exercises the shared pricing/settings logic
// and proves the jsdom + Testing Library harness is wired up. Phase 1 adds the
// higher-value suites (store selectors, IPC serialization).

describe("shared types", () => {
  it("ship sensible default settings", () => {
    expect(DEFAULT_SETTINGS.provider).toBe("anthropic");
    expect(DEFAULT_SETTINGS.defaultPolicy).toBe("ask");
    expect(DEFAULT_SETTINGS.apiKeySet).toBe(false);
  });

  it("estimate cost from per-million-token pricing", () => {
    const usage: Usage = { input: 1_000_000, output: 1_000_000 };
    // Opus 4.8 list price: $5 in / $25 out per million tokens.
    expect(estimateCost("claude-opus-4-8", usage)).toBeCloseTo(30);
  });

  it("treat unknown models as free instead of throwing", () => {
    expect(estimateCost("no-such-model", { input: 10, output: 10 })).toBe(0);
  });
});

describe("testing-library harness", () => {
  it("renders into the jsdom document", () => {
    render(<div role="status">Portcode</div>);
    expect(screen.getByRole("status")).toHaveTextContent("Portcode");
  });
});
