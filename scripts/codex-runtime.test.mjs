import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  OFFICIAL_TARGETS,
  canonicalPackageLayout,
  ensureCachedArchive,
  isMobileBuild,
  loadRuntimeLock,
  normalizeArchiveEntryPath,
  prepareCodexRuntime,
  resolveRuntimeTarget,
  stageVerifiedRuntime,
} from "./prepare-codex-runtime.mjs";

const WINDOWS_TARGET = "x86_64-pc-windows-msvc";
const RELEASE = {
  version: "0.145.0",
  layoutVersion: 1,
  variant: "codex-app-server",
  target: WINDOWS_TARGET,
};

function writeTarString(header, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  assert.ok(encoded.length <= length, `tar field is too long: ${value}`);
  encoded.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  writeTarString(header, offset, length, `${encoded}\0`);
}

function tarHeader({ name, type = "0", mode = 0o644, size = 0, linkName = "" }) {
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, mode);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeTarString(header, 156, 1, type);
  writeTarString(header, 157, 100, linkName);
  writeTarString(header, 257, 6, "ustar\0");
  writeTarString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function tarArchive(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf8");
    chunks.push(
      tarHeader({
        name: entry.name,
        type: entry.type ?? "0",
        mode: entry.mode ?? (entry.type === "5" ? 0o755 : 0o644),
        size: data.length,
        linkName: entry.linkName,
      }),
      data,
    );
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 1 });
}

function metadata(overrides = {}) {
  return JSON.stringify(
    {
      layoutVersion: 1,
      version: "0.145.0",
      target: WINDOWS_TARGET,
      variant: "codex-app-server",
      entrypoint: "bin/codex-app-server.exe",
      resourcesDir: "codex-resources",
      pathDir: "codex-path",
      ...overrides,
    },
    null,
    2,
  );
}

function canonicalWindowsEntries(metadataText = metadata()) {
  const contents = new Map([
    ["bin/codex-app-server.exe", "app-server"],
    ["bin/codex-code-mode-host.exe", "code-mode-host"],
    ["codex-package.json", metadataText],
    ["codex-path/rg.exe", "ripgrep"],
    ["codex-resources/codex-command-runner.exe", "command-runner"],
    ["codex-resources/codex-windows-sandbox-setup.exe", "sandbox-setup"],
  ]);
  return [...canonicalPackageLayout(WINDOWS_TARGET)].map(([name, expected]) =>
    expected.type === "directory"
      ? { name, type: "5", mode: 0o755 }
      : { name, type: "0", mode: 0o644, data: contents.get(name) },
  );
}

function fixtureAsset(file, archive) {
  return {
    file,
    url: `https://example.invalid/${file}`,
    size: archive.length,
    sha256: createHash("sha256").update(archive).digest("hex"),
  };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "portcode-codex-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("lock pins the six exact OpenAI app-server package assets", async () => {
  const lock = await loadRuntimeLock(new URL("../codex-runtime.lock.json", import.meta.url));
  assert.equal(lock.version, "0.145.0");
  assert.equal(lock.tag, "rust-v0.145.0");
  assert.deepEqual(Object.keys(lock.assets).sort(), [...OFFICIAL_TARGETS]);
  for (const [target, asset] of Object.entries(lock.assets)) {
    assert.equal(asset.file, `codex-app-server-package-${target}.tar.gz`);
    assert.equal(
      asset.url,
      `https://github.com/openai/codex/releases/download/rust-v0.145.0/${asset.file}`,
    );
  }
});

test("target resolution stages one host package and normalizes GNU Linux builds to the portable musl asset", () => {
  assert.equal(resolveRuntimeTarget({ platform: "win32", arch: "x64", env: {} }), WINDOWS_TARGET);
  assert.equal(
    resolveRuntimeTarget({
      platform: "linux",
      arch: "x64",
      env: { CARGO_BUILD_TARGET: "x86_64-unknown-linux-gnu" },
    }),
    "x86_64-unknown-linux-musl",
  );
  assert.equal(
    resolveRuntimeTarget({
      platform: "darwin",
      arch: "arm64",
      env: { PORTCODE_CODEX_RUNTIME_TARGET: "aarch64-apple-darwin" },
    }),
    "aarch64-apple-darwin",
  );
});

test("entry-path validation rejects traversal, absolute paths, drives, and alternate separators", () => {
  assert.equal(normalizeArchiveEntryPath("bin/codex-app-server.exe"), "bin/codex-app-server.exe");
  for (const unsafe of [
    "../escape",
    "bin/../../escape",
    "/absolute",
    "C:/absolute",
    "bin\\escape.exe",
  ]) {
    assert.throws(() => normalizeArchiveEntryPath(unsafe));
  }
});

test("a verified package is extracted with its complete canonical layout and launch metadata", async (t) => {
  const root = await temporaryDirectory(t);
  const archive = tarArchive(canonicalWindowsEntries());
  const archivePath = join(root, "runtime.tar.gz");
  const outputDir = join(root, "generated", "codex-runtime");
  await writeFile(archivePath, archive);

  await stageVerifiedRuntime(
    archivePath,
    fixtureAsset("runtime.tar.gz", archive),
    outputDir,
    RELEASE,
  );

  assert.equal(
    JSON.parse(await readFile(join(outputDir, "codex-package.json"), "utf8")).entrypoint,
    "bin/codex-app-server.exe",
  );
  assert.equal((await stat(join(outputDir, "bin", "codex-app-server.exe"))).isFile(), true);
  assert.equal((await stat(join(outputDir, "codex-path", "rg.exe"))).isFile(), true);
});

test("the compressed archive is checksummed before an extraction directory is created", async (t) => {
  const root = await temporaryDirectory(t);
  const archive = tarArchive(canonicalWindowsEntries());
  const archivePath = join(root, "runtime.tar.gz");
  const outputDir = join(root, "generated", "codex-runtime");
  await writeFile(archivePath, archive);
  const asset = { ...fixtureAsset("runtime.tar.gz", archive), sha256: "0".repeat(64) };

  await assert.rejects(
    stageVerifiedRuntime(archivePath, asset, outputDir, RELEASE),
    /SHA-256 mismatch/,
  );
  await assert.rejects(stat(outputDir), { code: "ENOENT" });
});

test("traversal and link entries are rejected without escaping staging", async (t) => {
  const root = await temporaryDirectory(t);
  for (const [label, badEntry, message] of [
    ["traversal", { name: "../escape", data: "owned" }, /traverses/],
    [
      "symlink",
      { name: "bin/codex-app-server.exe", type: "2", linkName: "target" },
      /links are forbidden/,
    ],
    [
      "hardlink",
      { name: "bin/codex-app-server.exe", type: "1", linkName: "target" },
      /links are forbidden/,
    ],
  ]) {
    const archive = tarArchive([badEntry]);
    const archivePath = join(root, `${label}.tar.gz`);
    await writeFile(archivePath, archive);
    await assert.rejects(
      stageVerifiedRuntime(
        archivePath,
        fixtureAsset(`${label}.tar.gz`, archive),
        join(root, label),
        RELEASE,
      ),
      message,
    );
  }
  await assert.rejects(stat(join(root, "escape")), { code: "ENOENT" });
});

test("unexpected files, missing helpers, and mismatched launch metadata fail closed", async (t) => {
  const root = await temporaryDirectory(t);
  const fixtures = [
    [
      "unexpected",
      [...canonicalWindowsEntries(), { name: "surprise", data: "no" }],
      /unexpected entry/,
    ],
    [
      "missing",
      canonicalWindowsEntries().filter((entry) => entry.name !== "codex-path/rg.exe"),
      /missing required entries/,
    ],
    [
      "metadata",
      canonicalWindowsEntries(metadata({ target: "aarch64-pc-windows-msvc" })),
      /launch metadata/,
    ],
  ];
  for (const [label, entries, message] of fixtures) {
    const archive = tarArchive(entries);
    const archivePath = join(root, `${label}.tar.gz`);
    await writeFile(archivePath, archive);
    await assert.rejects(
      stageVerifiedRuntime(
        archivePath,
        fixtureAsset(`${label}.tar.gz`, archive),
        join(root, label),
        RELEASE,
      ),
      message,
    );
  }
});

test("a failed replacement leaves the previously published runtime intact", async (t) => {
  const root = await temporaryDirectory(t);
  const outputDir = join(root, "codex-runtime");
  const valid = tarArchive(canonicalWindowsEntries());
  const validPath = join(root, "valid.tar.gz");
  await writeFile(validPath, valid);
  await stageVerifiedRuntime(validPath, fixtureAsset("valid.tar.gz", valid), outputDir, RELEASE);

  const invalid = tarArchive([...canonicalWindowsEntries(), { name: "unexpected", data: "no" }]);
  const invalidPath = join(root, "invalid.tar.gz");
  await writeFile(invalidPath, invalid);
  await assert.rejects(
    stageVerifiedRuntime(invalidPath, fixtureAsset("invalid.tar.gz", invalid), outputDir, RELEASE),
    /unexpected entry/,
  );

  assert.equal(
    JSON.parse(await readFile(join(outputDir, "codex-package.json"), "utf8")).version,
    "0.145.0",
  );
});

test("offline mode reuses only a verified cache and never mutates PATH or CODEX_HOME", async (t) => {
  const root = await temporaryDirectory(t);
  const cacheDir = join(root, "cache");
  const archive = tarArchive(canonicalWindowsEntries());
  const asset = fixtureAsset("runtime.tar.gz", archive);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(cacheDir, { recursive: true }));
  await writeFile(join(cacheDir, asset.file), archive);
  const before = { path: process.env.PATH, codexHome: process.env.CODEX_HOME };

  assert.equal(
    await ensureCachedArchive(asset, { cacheDir, offline: true }),
    join(cacheDir, asset.file),
  );
  assert.deepEqual({ path: process.env.PATH, codexHome: process.env.CODEX_HOME }, before);

  await rm(join(cacheDir, asset.file));
  await assert.rejects(
    ensureCachedArchive(asset, { cacheDir, offline: true }),
    /Offline Codex runtime cache miss/,
  );
});

test("mobile builds stage only a sync-client marker and never fetch a desktop runtime", async (t) => {
  const root = await temporaryDirectory(t);
  const outputDir = join(root, "codex-runtime");
  let fetched = false;
  const env = {
    TAURI_ENV_PLATFORM: "android",
    TAURI_ENV_TARGET_TRIPLE: "aarch64-linux-android",
  };

  assert.equal(isMobileBuild(env), true);
  const result = await prepareCodexRuntime({
    outputDir,
    cacheDir: join(root, "cache"),
    env,
    fetchImpl: async () => {
      fetched = true;
      throw new Error("mobile builds must not fetch Codex");
    },
  });

  assert.equal(fetched, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "mobile-sync-only");
  assert.match(await readFile(join(outputDir, ".mobile-sync-only"), "utf8"), /paired desktop/);
  await assert.rejects(stat(join(outputDir, "bin", "codex-app-server")), { code: "ENOENT" });
});

test("Tauri bundles the staged package and its build hook prepares it without a runtime Node dependency", async () => {
  const root = new URL("..", import.meta.url);
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const tauri = JSON.parse(await readFile(new URL("src-tauri/tauri.conf.json", root), "utf8"));
  const dev = JSON.parse(await readFile(new URL("src-tauri/tauri.dev.conf.json", root), "utf8"));
  const beta = JSON.parse(await readFile(new URL("src-tauri/tauri.beta.conf.json", root), "utf8"));
  assert.match(packageJson.scripts["codex:runtime"], /^node scripts\/prepare-codex-runtime\.mjs$/);
  assert.match(tauri.build.beforeDevCommand, /^pnpm codex:runtime && pnpm dev$/);
  assert.match(tauri.build.beforeBuildCommand, /^pnpm codex:runtime && pnpm build$/);
  assert.match(dev.build.beforeDevCommand, /^pnpm codex:runtime && pnpm dev:self$/);
  assert.match(dev.build.beforeBuildCommand, /^pnpm codex:runtime && pnpm build:self$/);
  assert.match(beta.build.beforeDevCommand, /^pnpm codex:runtime && pnpm dev:beta$/);
  assert.match(beta.build.beforeBuildCommand, /^pnpm codex:runtime && pnpm build:beta$/);
  assert.equal(tauri.bundle.resources["generated/codex-runtime/"], "codex-runtime/");
  assert.equal(packageJson.dependencies.tar, undefined);
  assert.equal(packageJson.dependencies["@openai/codex"], undefined);
});
