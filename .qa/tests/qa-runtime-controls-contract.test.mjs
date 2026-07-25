import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("QA controls are compile-time isolated to the calibration frontend build", async () => {
  const [vite, main, pkgText, tauriQa] = await Promise.all([
    read("vite.config.ts"),
    read("src/main.tsx"),
    read("package.json"),
    read(".qa/tauri.qa.conf.json"),
  ]);
  const pkg = JSON.parse(pkgText);
  assert.match(vite, /mode\s*===\s*["']qa["']/);
  assert.match(vite, /__PORTCODE_QA_CONTROLS__/);
  assert.match(main, /if\s*\(__PORTCODE_QA_CONTROLS__\)[\s\S]*import\(["']\.\/qa\/install["']\)/);
  assert.match(pkg.scripts["build:qa"], /vite build --mode qa/);
  assert.match(tauriQa, /build:qa/);
});
