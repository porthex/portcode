/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

describe("reduced-motion status dots", () => {
  it("disables the pcGlow and pcRing animations without removing their ordinary-motion rules", () => {
    expect(css).toMatch(/\.pc-dot\s*\{[^}]*animation:\s*pcGlow\b[^}]*\}/s);
    expect(css).toMatch(/\.pc-dot--ring\s*\{[^}]*animation:\s*pcRing\b[^}]*\}/s);
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.pc-dot\s*\{[^}]*animation:\s*none\s*!important;[^}]*\}/,
    );
  });
});

describe("expanded turn receipt layout", () => {
  it("lets expanded activity contribute its full height to the bounded transcript scroller", () => {
    const detailsRule = css.match(/\.pc-turn-receipt__details\s*\{([^}]*)\}/)?.[1];

    expect(detailsRule).toBeDefined();
    expect(detailsRule).not.toMatch(/\bmax-height\s*:/);
    expect(detailsRule).not.toMatch(/\boverflow(?:-y)?\s*:\s*(?:auto|scroll|hidden)/);
  });
});

describe("inline agent workflow card", () => {
  it("stays in transcript flow without creating a nested scroller", () => {
    const cardRule = css.match(/\.pc-agent-workflow\s*\{([^}]*)\}/)?.[1];

    expect(cardRule).toBeDefined();
    expect(cardRule).not.toMatch(/\bmax-height\s*:/);
    expect(cardRule).not.toMatch(/\boverflow(?:-y)?\s*:\s*(?:auto|scroll)/);
  });

  it("has a constrained-width collapse and reduced-motion-safe live signal", () => {
    expect(css).toMatch(
      /@container\s*\(max-width:\s*520px\)\s*\{[\s\S]*?\.pc-agent-workflow\s*\{[^}]*grid-template-columns:\s*1fr;/,
    );
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.pc-agent-workflow__signal-core\s*\{[^}]*animation:\s*none;/,
    );
  });
});
