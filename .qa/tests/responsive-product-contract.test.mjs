import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const styles = readFileSync(new URL("../../src/index.css", import.meta.url), "utf8");
const chat = readFileSync(new URL("../../src/components/Chat.tsx", import.meta.url), "utf8");

test("Attach has distinct enabled pointer-down feedback", () => {
  const activeStart = styles.indexOf(".pc-attach-button:active:not(:disabled)");
  const activeRule = activeStart >= 0 ? styles.slice(activeStart, activeStart + 320) : "";
  assert.match(activeRule, /transform: translateY\(1px\)/);
  assert.match(activeRule, /box-shadow: inset/);
});

test("composer reflows from actual desktop-main width and clips compact labels", () => {
  const start = styles.indexOf("@container desktop-main (max-width: 760px)");
  const rule = start >= 0 ? styles.slice(start, start + 900) : "";
  assert.match(rule, /\.pc-composer-toolbar/);
  assert.match(rule, /grid-template-columns: minmax\(0, 1fr\) 38px/);
  assert.match(rule, /\.pc-composer-controls[\s\S]*?flex-wrap: wrap/);
  assert.match(rule, /\.pc-composer-state[\s\S]*?grid-column: 1 \/ -1/);

  const triggerStart = styles.indexOf(".pc-run-setup__trigger {");
  const trigger = triggerStart >= 0 ? styles.slice(triggerStart, triggerStart + 450) : "";
  assert.match(trigger, /overflow: hidden/);
});

test("composer chain shrinks while only the validation issue list scrolls", () => {
  assert.match(chat, /data-testid="chat-composer-area" className="w-full min-h-0 shrink"/);

  for (const selector of [
    ".pc-composer-dock {",
    ".pc-neon-frame {",
    ".pc-composer-surface {",
    ".pc-attachment-tray {",
    ".pc-attachment-error {",
  ]) {
    const start = styles.indexOf(selector);
    const rule = start >= 0 ? styles.slice(start, start + 360) : "";
    assert.match(rule, /min-height: 0/, `${selector} must be shrinkable`);
  }

  const issuesStart = styles.indexOf(".pc-attachment-error > ul {");
  const issues = issuesStart >= 0 ? styles.slice(issuesStart, issuesStart + 320) : "";
  assert.match(issues, /overflow-y: auto/);
  assert.match(issues, /min-height: 0/);
});
