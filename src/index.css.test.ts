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

describe("inline Agent Forge workflow", () => {
  it("stays in transcript flow without creating a nested scroller or loading bar", () => {
    const cardRule = css.match(/\.pc-agent-workflow\s*\{([^}]*)\}/)?.[1];

    expect(cardRule).toBeDefined();
    expect(cardRule).not.toMatch(/\bmax-height\s*:/);
    expect(cardRule).not.toMatch(/\boverflow(?:-y)?\s*:\s*(?:auto|scroll)/);
    expect(cardRule).toMatch(/\bwidth:\s*min\(520px,\s*100%\)/);
    expect(cardRule).toMatch(/\bpadding:\s*7px\s+9px\s+8px/);
    expect(css).not.toContain(".pc-agent-workflow__progress");
    expect(css).not.toContain(".pc-agent-workflow__signal-core");
  });

  it("uses a compact horizontal agent strip", () => {
    const forgeRule = css.match(/\.pc-agent-forge\s*\{([^}]*)\}/)?.[1];
    const agentRule = css.match(/\.pc-agent-forge__agent\s*\{([^}]*)\}/)?.[1];
    const cubeRule = css.match(/\.pc-agent-forge__cube\s*\{([^}]*)\}/)?.[1];

    expect(forgeRule).toMatch(/\bdisplay:\s*flex/);
    expect(forgeRule).toMatch(/\bmargin:\s*6px\s+0\s+5px/);
    expect(agentRule).toMatch(/\bmin-height:\s*34px/);
    expect(agentRule).toMatch(/\bpadding:\s*3px\s+5px/);
    expect(cubeRule).toMatch(/\bwidth:\s*26px/);
    expect(cubeRule).toMatch(/\bheight:\s*25px/);
  });

  it("renders three-face cubes with distinct lifecycle palettes", () => {
    expect(css).toMatch(/\.pc-agent-forge__cube\s*\{/);
    expect(css).toMatch(/\.pc-agent-forge__face--top\s*\{/);
    expect(css).toMatch(/\.pc-agent-forge__face--left\s*\{/);
    expect(css).toMatch(/\.pc-agent-forge__face--right\s*\{/);
    for (const state of ["launching", "running", "completed", "failed", "stopped", "attention"]) {
      expect(css).toContain(`[data-agent-state="${state}"]`);
    }
  });

  it("changes terminal cube geometry instead of relying on color alone", () => {
    expect(css).toMatch(
      /\[data-agent-state="failed"\][^{]*\.pc-agent-forge__face--right\s*\{[^}]*transform:\s*translate\(5px,\s*-2px\);/s,
    );
    expect(css).toMatch(
      /\[data-agent-state="stopped"\][^{]*\.pc-agent-forge__face--top\s*\{[^}]*transform:\s*translateY\(-4px\);/s,
    );
    expect(css).toMatch(
      /\[data-agent-state="stopped"\][^{]*\.pc-agent-forge__face--left\s*\{[^}]*transform:\s*translate\(-2px,\s*2px\);/s,
    );
    expect(css).toMatch(
      /\[data-agent-state="stopped"\][^{]*\.pc-agent-forge__face--right\s*\{[^}]*transform:\s*translate\(2px,\s*2px\);/s,
    );
  });

  it("keeps active motion local to cubes and disables it for reduced motion", () => {
    expect(css).toMatch(/@keyframes\s+pcForgeCore\b/);
    expect(css).toMatch(
      /\[data-agent-state="running"\][^{]*\.pc-agent-forge__core\s*\{[^}]*animation:[^;}]*pcForgeCore[^;}]*infinite;/s,
    );
    const completedRule = css.match(
      /\[data-agent-state="completed"\][^{]*\.pc-agent-forge__cube\s*\{([^}]*)\}/s,
    )?.[1];
    expect(completedRule).toBeDefined();
    expect(completedRule).not.toContain("infinite");
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.pc-agent-forge__cube,[\s\S]*?\.pc-agent-forge__core\s*\{[^}]*animation:\s*none\s*!important;[^}]*transition:\s*none\s*!important;/,
    );
  });
});
