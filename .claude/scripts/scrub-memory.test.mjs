// node --test self-test for scrub-memory.mjs
// Run: node --test .claude/scripts/scrub-memory.test.mjs
//
// Coverage: every redaction pattern gets a positive (must redact) case plus at least
// one false-positive/negative guard (must NOT redact). Plus an end-to-end fixture and
// the --check exit-code contract (exit 2 when it would redact, 0 when clean).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { scrub } from "./scrub-memory.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRUBBER = join(HERE, "scrub-memory.mjs");

function redacted(input) {
  return scrub(input).text;
}
function hitNames(input) {
  return scrub(input).hits.map((h) => h.pattern);
}

// --- 1. private key ---------------------------------------------------------
test("private-key: PEM block redacted", () => {
  const pem =
    "-----BEGIN RSA PRIV" +
    "ATE KEY-----\nMIIBOgIBAAJBAKj\nabc/def+ghi=\n-----END RSA PRIVATE KEY-----";
  const out = redacted(pem);
  assert.equal(out, "[REDACTED_PRIVATE_KEY]");
  assert.ok(!out.includes("MIIBOgIBAAJBAKj"));
});
test("private-key: prose mentioning private key is untouched", () => {
  const s = "Store the private key outside the repo.";
  assert.equal(redacted(s), s);
});

// --- 2. email ---------------------------------------------------------------
test("email: address redacted", () => {
  assert.equal(redacted("ping alice.dev+tag@example.co.uk now"), "ping [REDACTED_EMAIL] now");
});
test("email: '@channel' / decorator-ish text without TLD not matched", () => {
  const s = "Use the @decorator and notify @channel please";
  assert.equal(redacted(s), s);
  assert.ok(!hitNames(s).includes("email"));
});

// --- 3. unix home path ------------------------------------------------------
test("home-path-unix: /home and /Users redacted", () => {
  assert.equal(redacted("at /home/alice/proj"), "at [REDACTED_HOME]/proj");
  assert.equal(redacted("at /Users/bob/proj"), "at [REDACTED_HOME]/proj");
});
test("home-path-unix: ordinary repo path not matched", () => {
  const s = "see src/lib/ipc.ts and /usr/local/bin";
  assert.equal(redacted(s), s);
  assert.ok(!hitNames(s).includes("home-path-unix"));
});

// --- 4. windows home path ---------------------------------------------------
test("home-path-windows: C:\\Users\\name redacted", () => {
  assert.equal(redacted("path C:\\Users\\carol\\dev"), "path [REDACTED_HOME]\\dev");
});
test("home-path-windows: C:\\Windows\\System32 not matched", () => {
  const s = "path C:\\Windows\\System32";
  assert.equal(redacted(s), s);
  assert.ok(!hitNames(s).includes("home-path-windows"));
});

// --- 5. jwt -----------------------------------------------------------------
test("jwt: three-segment token redacted", () => {
  const jwt =
    "ey" +
    "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV";
  assert.equal(redacted(jwt), "[REDACTED_TOKEN]");
});
test("jwt: dotted version string not matched", () => {
  const s = "version eyJ.is.short";
  // too short to satisfy {10,} segments -> not a JWT
  assert.ok(!hitNames(s).includes("jwt"));
});

// --- 6. bearer --------------------------------------------------------------
test("bearer: header value redacted, scheme kept", () => {
  assert.equal(
    redacted("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"),
    "Authorization: Bearer [REDACTED_TOKEN]",
  );
});
test("bearer: word 'bearer' in prose without long token not matched", () => {
  const s = "the bearer of bad news";
  assert.equal(redacted(s), s);
  assert.ok(!hitNames(s).includes("bearer"));
});

// --- 7. anthropic/openai sk- key -------------------------------------------
test("anthropic-openai-key: sk- token redacted", () => {
  assert.equal(redacted("key sk" + "-ABCdef0123456789ghijklmnop done"), "key [REDACTED_KEY] done");
});
test("anthropic-openai-key: short sk- prefix not matched", () => {
  const s = "sk-short";
  assert.equal(redacted(s), s);
  assert.ok(!hitNames(s).includes("anthropic-openai-key"));
});

// --- 8. github token --------------------------------------------------------
test("github-token: ghp_ token redacted", () => {
  assert.equal(redacted("gh" + "p_0123456789abcdefABCDEF0123456789ab"), "[REDACTED_KEY]");
});
test("github-token: 'github_actions' identifier not matched", () => {
  const s = "the github_actions workflow";
  assert.equal(redacted(s), s);
  assert.ok(!hitNames(s).includes("github-token"));
});

// --- 9. aws access key id ---------------------------------------------------
test("aws-access-key-id: AKIA id redacted", () => {
  assert.equal(redacted("AK" + "IAIOSFODNN7EXAMPLE"), "[REDACTED_KEY]");
});
test("aws-access-key-id: lowercase akia not matched", () => {
  const s = "akiasomethinglower1234";
  assert.ok(!hitNames(s).includes("aws-access-key-id"));
});

// --- 10. slack token --------------------------------------------------------
test("slack-token: xoxb token redacted", () => {
  assert.equal(redacted("xo" + "xb-1234567890-abcdefghijklmnop"), "[REDACTED_KEY]");
});
test("slack-token: bare 'xox' not matched", () => {
  const s = "xox and hugs";
  assert.ok(!hitNames(s).includes("slack-token"));
});

// --- 11. google api key -----------------------------------------------------
test("google-api-key: AIza key redacted", () => {
  // AIza prefix + exactly 35 chars from [0-9A-Za-z_-]
  const key = "AIza" + "Sy".concat("a".repeat(33)); // 35-char suffix
  assert.equal(redacted(key), "[REDACTED_KEY]");
});
test("google-api-key: short AIza prefix not matched", () => {
  const s = "AIzaShort";
  assert.ok(!hitNames(s).includes("google-api-key"));
});

// --- 12. ipv4 ---------------------------------------------------------------
test("ipv4: address redacted (incl loopback)", () => {
  assert.equal(redacted("host 192.168.1.42 up"), "host [REDACTED_IP] up");
  assert.equal(redacted("127.0.0.1"), "[REDACTED_IP]");
});
test("ipv4: three-group version string not matched", () => {
  const s = "v1.2.3 released";
  assert.equal(redacted(s), s);
  assert.ok(!hitNames(s).includes("ipv4"));
});

// --- 13. ipv6 ---------------------------------------------------------------
test("ipv6: address redacted", () => {
  assert.equal(redacted("addr 2001:db8:0:0:0:0:0:1 end"), "addr [REDACTED_IP] end");
});
test("ipv6: single hex word not matched", () => {
  const s = "color deadbeef";
  assert.ok(!hitNames(s).includes("ipv6"));
});

// --- 14. secret assignment --------------------------------------------------
test("secret-assignment: key=value redacted, key name kept", () => {
  assert.equal(redacted('api_key="abcdef1234567890"'), "api_key=[REDACTED_SECRET]");
  assert.equal(redacted("password: hunter2hunter2"), "password: [REDACTED_SECRET]");
});
test("secret-assignment: bare key-name prose not matched", () => {
  const s = "configure the api_key setting in the UI";
  assert.equal(redacted(s), s);
  assert.ok(!hitNames(s).includes("secret-assignment"));
});
test("secret-assignment: short value below threshold not matched", () => {
  const s = "token=short";
  assert.equal(redacted(s), s);
  assert.ok(!hitNames(s).includes("secret-assignment"));
});

// --- end-to-end -------------------------------------------------------------
test("end-to-end: mixed PII all redacted, no original survives", () => {
  const fixture = [
    "Contact alice@example.com from /home/alice/work",
    "key sk" + "-ABCdef0123456789ghijklmnop and 10.0.0.5",
    'password="supersecretvalue123"',
  ].join("\n");
  const { text } = scrub(fixture);
  assert.ok(text.includes("[REDACTED_EMAIL]"));
  assert.ok(text.includes("[REDACTED_HOME]"));
  assert.ok(text.includes("[REDACTED_KEY]"));
  assert.ok(text.includes("[REDACTED_IP]"));
  assert.ok(text.includes("[REDACTED_SECRET]"));
  assert.ok(!text.includes("alice@example.com"));
  assert.ok(!text.includes("/home/alice"));
  assert.ok(!text.includes("sk-ABCdef"));
  assert.ok(!text.includes("10.0.0.5"));
  assert.ok(!text.includes("supersecretvalue123"));
});

test("clean input: no hits, text unchanged", () => {
  const s = "Portcode is a Tauri + React project. graphify is a Skill, not a binary.";
  const { text, hits } = scrub(s);
  assert.equal(text, s);
  assert.equal(hits.length, 0);
});

// --- --check exit code contract --------------------------------------------
test("--check: exits 2 when it would redact", () => {
  const dir = mkdtempSync(join(tmpdir(), "scrub-test-"));
  const f = join(dir, "dirty.md");
  writeFileSync(f, "email alice@example.com here\n");
  try {
    execFileSync("node", [SCRUBBER, "--check", f], { stdio: "pipe" });
    assert.fail("expected non-zero exit");
  } catch (err) {
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /email/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--check: exits 0 when clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "scrub-test-"));
  const f = join(dir, "clean.md");
  writeFileSync(f, "Portcode is a Tauri + React project.\n");
  try {
    const out = execFileSync("node", [SCRUBBER, "--check", f], { stdio: "pipe" });
    assert.equal(String(out), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- pipe mode --------------------------------------------------------------
test("pipe mode: stdin -> scrubbed stdout", () => {
  const out = execFileSync("node", [SCRUBBER], {
    input: "see /home/bob/x and bob@example.org\n",
    stdio: "pipe",
  });
  const s = String(out);
  assert.ok(s.includes("[REDACTED_HOME]"));
  assert.ok(s.includes("[REDACTED_EMAIL]"));
  assert.ok(!s.includes("bob@example.org"));
});
