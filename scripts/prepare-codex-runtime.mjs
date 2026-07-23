import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_LOCK_PATH = join(REPO_ROOT, "codex-runtime.lock.json");
const DEFAULT_GENERATED_ROOT = join(REPO_ROOT, "src-tauri", "generated");
const DEFAULT_OUTPUT_DIR = join(DEFAULT_GENERATED_ROOT, "codex-runtime");
const DEFAULT_CACHE_DIR = join(DEFAULT_GENERATED_ROOT, "codex-runtime-cache");
const OFFICIAL_SOURCE = "https://github.com/openai/codex";
const MAX_EXPANDED_BYTES = 1_500_000_000;
const MAX_PAX_BYTES = 64 * 1024;

export const OFFICIAL_TARGETS = Object.freeze([
  "aarch64-apple-darwin",
  "aarch64-pc-windows-msvc",
  "aarch64-unknown-linux-musl",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-musl",
]);

const TARGET_ALIASES = Object.freeze({
  "aarch64-unknown-linux-gnu": "aarch64-unknown-linux-musl",
  "x86_64-unknown-linux-gnu": "x86_64-unknown-linux-musl",
});

const HOST_TARGETS = Object.freeze({
  "darwin:arm64": "aarch64-apple-darwin",
  "darwin:x64": "x86_64-apple-darwin",
  "linux:arm64": "aarch64-unknown-linux-musl",
  "linux:x64": "x86_64-unknown-linux-musl",
  "win32:arm64": "aarch64-pc-windows-msvc",
  "win32:x64": "x86_64-pc-windows-msvc",
});

export async function loadRuntimeLock(lockPath = DEFAULT_LOCK_PATH) {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  validateRuntimeLock(lock);
  return lock;
}

export function validateRuntimeLock(lock) {
  assert.equal(
    lock.source,
    OFFICIAL_SOURCE,
    "runtime source must be the official OpenAI Codex repository",
  );
  assert.match(lock.version, /^\d+\.\d+\.\d+$/, "runtime version must be exact semver");
  assert.equal(lock.tag, `rust-v${lock.version}`, "runtime tag must exactly pin the version");
  assert.equal(lock.layoutVersion, 1, "unsupported Codex package layout");
  assert.equal(lock.variant, "codex-app-server", "runtime must use the app-server package variant");
  assert.deepEqual(
    Object.keys(lock.assets).sort(),
    [...OFFICIAL_TARGETS],
    "runtime lock must cover exactly the six official desktop targets",
  );

  for (const target of OFFICIAL_TARGETS) {
    const asset = lock.assets[target];
    const expectedFile = `codex-app-server-package-${target}.tar.gz`;
    assert.deepEqual(
      Object.keys(asset).sort(),
      ["file", "sha256", "size", "url"],
      `${target} asset has unexpected lock fields`,
    );
    assert.equal(asset.file, expectedFile, `${target} asset filename is not canonical`);
    assert.equal(
      asset.url,
      `${OFFICIAL_SOURCE}/releases/download/${lock.tag}/${expectedFile}`,
      `${target} asset URL must be exact and pinned`,
    );
    assert.match(asset.sha256, /^[0-9a-f]{64}$/, `${target} asset needs a lowercase SHA-256`);
    assert.ok(
      Number.isSafeInteger(asset.size) && asset.size > 0,
      `${target} asset needs an exact positive size`,
    );
  }
}

export function isMobileBuild(env = process.env) {
  const platform = String(env.TAURI_ENV_PLATFORM ?? "").toLowerCase();
  return platform === "android" || platform === "ios";
}

export function resolveRuntimeTarget({
  target,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
} = {}) {
  const requested =
    target ??
    env.PORTCODE_CODEX_RUNTIME_TARGET ??
    env.TAURI_ENV_TARGET_TRIPLE ??
    env.CARGO_BUILD_TARGET;
  if (requested) {
    return TARGET_ALIASES[requested] ?? requested;
  }

  const tauriPlatform = String(env.TAURI_ENV_PLATFORM ?? "").toLowerCase();
  const tauriArch = String(env.TAURI_ENV_ARCH ?? "").toLowerCase();
  const normalizedPlatform =
    tauriPlatform === "windows"
      ? "win32"
      : tauriPlatform === "macos"
        ? "darwin"
        : tauriPlatform || platform;
  const normalizedArch =
    tauriArch === "aarch64" ? "arm64" : tauriArch === "x86_64" ? "x64" : tauriArch || arch;
  const resolved = HOST_TARGETS[`${normalizedPlatform}:${normalizedArch}`];
  if (!resolved) {
    throw new Error(
      `No pinned Codex app-server runtime for ${normalizedPlatform}/${normalizedArch}; set PORTCODE_CODEX_RUNTIME_TARGET to a supported desktop target`,
    );
  }
  return resolved;
}

export function canonicalPackageLayout(target) {
  if (!OFFICIAL_TARGETS.includes(target)) {
    throw new Error(`Unsupported Codex runtime target: ${target}`);
  }
  const windows = target.includes("windows");
  const linux = target.includes("linux");
  const suffix = windows ? ".exe" : "";
  const entries = new Map([
    ["bin", { type: "directory" }],
    [`bin/codex-app-server${suffix}`, { type: "file", executable: !windows }],
    [`bin/codex-code-mode-host${suffix}`, { type: "file", executable: !windows }],
    ["codex-package.json", { type: "file", executable: false }],
    ["codex-path", { type: "directory" }],
    [`codex-path/rg${suffix}`, { type: "file", executable: !windows }],
    ["codex-resources", { type: "directory" }],
  ]);
  if (windows) {
    entries.set("codex-resources/codex-command-runner.exe", { type: "file", executable: false });
    entries.set("codex-resources/codex-windows-sandbox-setup.exe", {
      type: "file",
      executable: false,
    });
  } else {
    entries.set("codex-resources/zsh", { type: "directory" });
    entries.set("codex-resources/zsh/bin", { type: "directory" });
    entries.set("codex-resources/zsh/bin/zsh", { type: "file", executable: true });
    if (linux) {
      entries.set("codex-resources/bwrap", { type: "file", executable: true });
    }
  }
  return entries;
}

export function normalizeArchiveEntryPath(rawPath, { control = false } = {}) {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.includes("\0")) {
    throw new Error("archive contains an empty or NUL path");
  }
  if (rawPath.includes("\\")) {
    throw new Error(`archive path uses a non-canonical separator: ${rawPath}`);
  }
  if (isAbsolute(rawPath) || rawPath.startsWith("/") || /^[A-Za-z]:/.test(rawPath)) {
    throw new Error(`archive path is absolute: ${rawPath}`);
  }
  const trimmed = rawPath.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "..")) {
    throw new Error(`archive path traverses outside the package: ${rawPath}`);
  }
  if (!control && parts.some((part) => part === "" || part === ".")) {
    throw new Error(`archive path is not canonical: ${rawPath}`);
  }
  const normalized = parts.filter((part) => control || part !== ".").join("/");
  if (!normalized) {
    throw new Error(`archive path is empty after normalization: ${rawPath}`);
  }
  return normalized;
}

export async function hashFile(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

export async function verifyArchive(archivePath, asset) {
  const archiveStat = await stat(archivePath);
  if (!archiveStat.isFile()) {
    throw new Error(`Codex runtime archive is not a file: ${archivePath}`);
  }
  if (archiveStat.size !== asset.size) {
    throw new Error(
      `Codex runtime archive size mismatch: expected ${asset.size}, got ${archiveStat.size}`,
    );
  }
  const actual = await hashFile(archivePath);
  if (actual !== asset.sha256) {
    throw new Error(
      `Codex runtime archive SHA-256 mismatch: expected ${asset.sha256}, got ${actual}`,
    );
  }
}

async function downloadArchive(asset, destination, fetchImpl) {
  const parsed = new URL(asset.url);
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing non-HTTPS Codex runtime URL: ${asset.url}`);
  }
  const response = await fetchImpl(asset.url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Codex runtime download failed (${response.status} ${response.statusText})`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) !== asset.size) {
    throw new Error(
      `Codex runtime response size mismatch: expected ${asset.size}, got ${contentLength}`,
    );
  }
  await pipeline(
    Readable.fromWeb(response.body),
    (await import("node:fs")).createWriteStream(destination, { flags: "wx" }),
  );
}

export async function ensureCachedArchive(
  asset,
  { cacheDir = DEFAULT_CACHE_DIR, offline = false, fetchImpl = globalThis.fetch } = {},
) {
  await mkdir(cacheDir, { recursive: true });
  const archivePath = join(cacheDir, asset.file);
  try {
    await verifyArchive(archivePath, asset);
    return archivePath;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      await rm(archivePath, { force: true });
    }
  }

  if (offline) {
    throw new Error(`Offline Codex runtime cache miss: ${archivePath}`);
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("No fetch implementation is available to download the Codex runtime");
  }

  const temporary = `${archivePath}.part-${process.pid}-${randomUUID()}`;
  try {
    await downloadArchive(asset, temporary, fetchImpl);
    await verifyArchive(temporary, asset);
    await rename(temporary, archivePath);
    return archivePath;
  } finally {
    await rm(temporary, { force: true });
  }
}

function decodeTarString(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    end === -1 ? field : field.subarray(0, end),
  );
}

function parseTarNumber(block, offset, length, label) {
  const field = block.subarray(offset, offset + length);
  if ((field[0] & 0x80) !== 0) {
    throw new Error(`archive uses unsupported base-256 ${label}`);
  }
  const text = field.toString("ascii").replace(/\0.*$/, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new Error(`archive has invalid octal ${label}: ${JSON.stringify(text)}`);
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`archive has unsafe ${label}: ${text}`);
  }
  return value;
}

function isZeroBlock(block) {
  return block.every((byte) => byte === 0);
}

function parseTarHeader(block) {
  const expectedChecksum = parseTarNumber(block, 148, 8, "checksum");
  let actualChecksum = 0;
  for (let index = 0; index < block.length; index += 1) {
    actualChecksum += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  if (expectedChecksum !== actualChecksum) {
    throw new Error(
      `archive header checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`,
    );
  }
  const name = decodeTarString(block, 0, 100);
  const prefix = decodeTarString(block, 345, 155);
  return {
    name: prefix ? `${prefix}/${name}` : name,
    mode: parseTarNumber(block, 100, 8, "mode"),
    size: parseTarNumber(block, 124, 12, "size"),
    type: String.fromCharCode(block[156] || 0),
    linkName: decodeTarString(block, 157, 100),
  };
}

function parsePax(data) {
  const values = {};
  let offset = 0;
  while (offset < data.length) {
    const separator = data.indexOf(0x20, offset);
    if (separator === -1) throw new Error("archive has malformed PAX record length");
    const length = Number.parseInt(data.subarray(offset, separator).toString("ascii"), 10);
    if (
      !Number.isSafeInteger(length) ||
      length <= separator - offset + 1 ||
      offset + length > data.length
    ) {
      throw new Error("archive has invalid PAX record length");
    }
    const record = data.subarray(separator + 1, offset + length);
    if (record.at(-1) !== 0x0a) throw new Error("archive has unterminated PAX record");
    const equals = record.indexOf(0x3d);
    if (equals <= 0) throw new Error("archive has malformed PAX key/value record");
    const key = new TextDecoder("utf-8", { fatal: true }).decode(record.subarray(0, equals));
    const value = new TextDecoder("utf-8", { fatal: true }).decode(record.subarray(equals + 1, -1));
    if (Object.hasOwn(values, key)) throw new Error(`archive repeats PAX key ${key}`);
    if (key === "size" || key === "linkpath")
      throw new Error(`archive uses unsupported PAX key ${key}`);
    if (
      key !== "path" &&
      key !== "mtime" &&
      key !== "atime" &&
      key !== "ctime" &&
      !key.startsWith("SCHILY.")
    ) {
      throw new Error(`archive uses unexpected PAX key ${key}`);
    }
    values[key] = value;
    offset += length;
  }
  return values;
}

async function writeAll(fileHandle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await fileHandle.write(buffer, offset, buffer.length - offset, null);
    if (bytesWritten === 0) throw new Error("failed to write extracted Codex runtime file");
    offset += bytesWritten;
  }
}

function assertDestinationInside(root, entryPath) {
  const destination = resolve(root, ...entryPath.split("/"));
  const prefix = `${resolve(root)}${sep}`;
  if (!destination.startsWith(prefix)) {
    throw new Error(`archive entry escapes staging directory: ${entryPath}`);
  }
  return destination;
}

async function finishTarEntry(current, state) {
  if (current.fileHandle) {
    await current.fileHandle.close();
    current.fileHandle = undefined;
    if (current.mode & 0o111) {
      await chmod(current.destination, current.mode & 0o777);
    }
  }
  if (current.kind === "pax") {
    const values = parsePax(Buffer.concat(current.parts));
    if (current.paxType === "g") {
      if (Object.hasOwn(values, "path")) throw new Error("global PAX path override is not allowed");
      Object.assign(state.globalPax, values);
    } else {
      state.pendingPax = values;
    }
  }
}

export async function extractCanonicalArchive(archivePath, outputDir, release) {
  const layout = canonicalPackageLayout(release.target);
  const seen = new Map();
  const state = { globalPax: {}, pendingPax: {} };
  const compressed = createReadStream(archivePath);
  const tarStream = compressed.pipe(createGunzip());
  let buffer = Buffer.alloc(0);
  let current;
  let zeroBlocks = 0;
  let ended = false;
  let expandedBytes = 0;

  await mkdir(outputDir, { recursive: false });
  try {
    for await (const chunk of tarStream) {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      while (buffer.length > 0) {
        if (ended) {
          if (!buffer.every((byte) => byte === 0))
            throw new Error("archive has data after its end marker");
          buffer = Buffer.alloc(0);
          break;
        }

        if (!current) {
          if (buffer.length < 512) break;
          const headerBlock = buffer.subarray(0, 512);
          buffer = buffer.subarray(512);
          if (isZeroBlock(headerBlock)) {
            zeroBlocks += 1;
            if (zeroBlocks >= 2) ended = true;
            continue;
          }
          if (zeroBlocks !== 0) throw new Error("archive has data after an end marker");
          const header = parseTarHeader(headerBlock);
          const type = header.type === "\0" ? "0" : header.type;

          if (type === "x" || type === "g") {
            normalizeArchiveEntryPath(header.name, { control: true });
            if (header.size > MAX_PAX_BYTES)
              throw new Error("archive PAX header is unreasonably large");
            current = {
              kind: "pax",
              paxType: type,
              remaining: header.size,
              padding: (512 - (header.size % 512)) % 512,
              parts: [],
            };
          } else {
            if (type === "1" || type === "2") {
              throw new Error(`archive links are forbidden: ${header.name} -> ${header.linkName}`);
            }
            if (type !== "0" && type !== "5") {
              throw new Error(
                `archive entry type ${JSON.stringify(type)} is forbidden: ${header.name}`,
              );
            }
            const pax = { ...state.globalPax, ...state.pendingPax };
            state.pendingPax = {};
            const entryPath = normalizeArchiveEntryPath(pax.path ?? header.name);
            const expected = layout.get(entryPath);
            if (!expected) throw new Error(`archive contains unexpected entry: ${entryPath}`);
            if (seen.has(entryPath)) throw new Error(`archive repeats entry: ${entryPath}`);
            const actualType = type === "5" ? "directory" : "file";
            if (actualType !== expected.type) {
              throw new Error(
                `archive entry ${entryPath} is ${actualType}, expected ${expected.type}`,
              );
            }
            if (actualType === "directory" && header.size !== 0) {
              throw new Error(`archive directory has a payload: ${entryPath}`);
            }
            if (actualType === "file" && expected.executable && (header.mode & 0o111) === 0) {
              throw new Error(`archive executable lacks execute permission: ${entryPath}`);
            }
            expandedBytes += header.size;
            if (expandedBytes > MAX_EXPANDED_BYTES)
              throw new Error("archive expands beyond the safety limit");
            seen.set(entryPath, actualType);
            const destination = assertDestinationInside(outputDir, entryPath);
            if (actualType === "directory") {
              await mkdir(destination, { recursive: true });
              current = { kind: "directory", remaining: 0, padding: 0 };
            } else {
              await mkdir(dirname(destination), { recursive: true });
              current = {
                kind: "file",
                remaining: header.size,
                padding: (512 - (header.size % 512)) % 512,
                fileHandle: await open(destination, "wx", header.mode & 0o777),
                destination,
                mode: header.mode,
              };
            }
          }
        }

        if (current.remaining > 0) {
          if (buffer.length === 0) break;
          const length = Math.min(current.remaining, buffer.length);
          const payload = buffer.subarray(0, length);
          buffer = buffer.subarray(length);
          if (current.kind === "file") await writeAll(current.fileHandle, payload);
          if (current.kind === "pax") current.parts.push(Buffer.from(payload));
          current.remaining -= length;
          if (current.remaining > 0) continue;
        }
        if (current.padding > 0) {
          if (buffer.length === 0) break;
          const length = Math.min(current.padding, buffer.length);
          const padding = buffer.subarray(0, length);
          if (!padding.every((byte) => byte === 0))
            throw new Error("archive contains non-zero padding");
          buffer = buffer.subarray(length);
          current.padding -= length;
          if (current.padding > 0) continue;
        }
        await finishTarEntry(current, state);
        current = undefined;
      }
    }

    if (current) throw new Error("archive ended in the middle of an entry");
    if (!ended || zeroBlocks < 2) throw new Error("archive is missing its end marker");
    if (Object.keys(state.pendingPax).length !== 0)
      throw new Error("archive ends with an unused PAX header");
    const missing = [...layout.keys()].filter((entry) => !seen.has(entry));
    if (missing.length !== 0)
      throw new Error(`archive is missing required entries: ${missing.join(", ")}`);
    await validateCanonicalPackage(outputDir, release);
  } catch (error) {
    if (current?.fileHandle) await current.fileHandle.close().catch(() => {});
    compressed.destroy();
    tarStream.destroy();
    throw error;
  }
}

async function walkPackage(root, current = root, entries = []) {
  for (const item of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, item.name);
    const itemStat = await lstat(absolute);
    if (itemStat.isSymbolicLink())
      throw new Error(`staged package contains a symbolic link: ${absolute}`);
    const entry = relative(root, absolute).split(sep).join("/");
    if (itemStat.isDirectory()) {
      entries.push([entry, "directory", itemStat]);
      await walkPackage(root, absolute, entries);
    } else if (itemStat.isFile()) {
      entries.push([entry, "file", itemStat]);
    } else {
      throw new Error(`staged package contains a special file: ${absolute}`);
    }
  }
  return entries;
}

export async function validateCanonicalPackage(packageDir, release) {
  const layout = canonicalPackageLayout(release.target);
  const entries = await walkPackage(packageDir);
  const actual = new Map(entries.map(([entry, type]) => [entry, type]));
  assert.deepEqual(
    [...actual.keys()].sort(),
    [...layout.keys()].sort(),
    "staged package layout is not canonical",
  );

  for (const [entry, expected] of layout) {
    assert.equal(actual.get(entry), expected.type, `${entry} has the wrong file type`);
    if (expected.type === "file") {
      const entryStat = await stat(assertDestinationInside(packageDir, entry));
      assert.ok(entryStat.size > 0, `${entry} must not be empty`);
      if (expected.executable)
        assert.ok((entryStat.mode & 0o111) !== 0, `${entry} must be executable`);
    }
  }

  const metadata = JSON.parse(await readFile(join(packageDir, "codex-package.json"), "utf8"));
  const windows = release.target.includes("windows");
  const expectedMetadata = {
    layoutVersion: release.layoutVersion,
    version: release.version,
    target: release.target,
    variant: release.variant,
    entrypoint: `bin/codex-app-server${windows ? ".exe" : ""}`,
    resourcesDir: "codex-resources",
    pathDir: "codex-path",
  };
  assert.deepEqual(
    metadata,
    expectedMetadata,
    "Codex package launch metadata does not match the pinned runtime",
  );
}

async function publishDirectory(stagedDir, outputDir) {
  await mkdir(dirname(outputDir), { recursive: true });
  try {
    await rename(stagedDir, outputDir);
    return;
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
  }

  const backupDir = `${outputDir}.previous-${process.pid}-${randomUUID()}`;
  await rename(outputDir, backupDir);
  try {
    await rename(stagedDir, outputDir);
  } catch (error) {
    await rename(backupDir, outputDir).catch(() => {});
    throw error;
  }
  await rm(backupDir, { recursive: true, force: true });
}

export async function stageVerifiedRuntime(archivePath, asset, outputDir, release) {
  // Supply-chain invariant: read and hash the complete compressed artifact before
  // creating or writing the extraction directory.
  await verifyArchive(archivePath, asset);
  const parent = dirname(outputDir);
  await mkdir(parent, { recursive: true });
  const stagedDir = join(
    parent,
    `.${relative(parent, outputDir)}.staging-${process.pid}-${randomUUID()}`,
  );
  if (!resolve(stagedDir).startsWith(`${resolve(parent)}${sep}`)) {
    throw new Error("refusing to stage the Codex runtime outside the generated directory");
  }
  try {
    await extractCanonicalArchive(archivePath, stagedDir, release);
    await publishDirectory(stagedDir, outputDir);
  } finally {
    await rm(stagedDir, { recursive: true, force: true });
  }
}

async function stageMobileMarker(outputDir) {
  const parent = dirname(outputDir);
  await mkdir(parent, { recursive: true });
  const stagedDir = join(
    parent,
    `.${relative(parent, outputDir)}.staging-${process.pid}-${randomUUID()}`,
  );
  try {
    await mkdir(stagedDir, { recursive: false });
    await writeFile(
      join(stagedDir, ".mobile-sync-only"),
      "Codex app-server is a desktop runtime. Portcode mobile connects to its paired desktop.\n",
      "utf8",
    );
    await publishDirectory(stagedDir, outputDir);
  } finally {
    await rm(stagedDir, { recursive: true, force: true });
  }
}

export async function prepareCodexRuntime({
  target,
  lockPath = DEFAULT_LOCK_PATH,
  cacheDir = process.env.PORTCODE_CODEX_RUNTIME_CACHE || DEFAULT_CACHE_DIR,
  outputDir = DEFAULT_OUTPUT_DIR,
  offline = process.env.PORTCODE_CODEX_RUNTIME_OFFLINE === "1",
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (isMobileBuild(env)) {
    await stageMobileMarker(outputDir);
    return { skipped: true, reason: "mobile-sync-only", outputDir };
  }

  const lock = await loadRuntimeLock(lockPath);
  const resolvedTarget = resolveRuntimeTarget({ target, env });
  const asset = lock.assets[resolvedTarget];
  if (!asset) {
    throw new Error(`Pinned Codex runtime does not contain target ${resolvedTarget}`);
  }
  const release = {
    version: lock.version,
    layoutVersion: lock.layoutVersion,
    variant: lock.variant,
    target: resolvedTarget,
  };

  try {
    await validateCanonicalPackage(outputDir, release);
    return { reused: true, target: resolvedTarget, outputDir };
  } catch {
    // A missing, partial, stale, or unexpected package is replaced only after a
    // fresh package has been completely verified in a sibling staging directory.
  }

  const archivePath = await ensureCachedArchive(asset, { cacheDir, offline, fetchImpl });
  await stageVerifiedRuntime(archivePath, asset, outputDir, release);
  return { reused: false, target: resolvedTarget, archivePath, outputDir };
}

function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--offline") {
      parsed.offline = true;
      continue;
    }
    const key = {
      "--target": "target",
      "--cache-dir": "cacheDir",
      "--output-dir": "outputDir",
      "--lock": "lockPath",
    }[arg];
    if (!key || index + 1 >= args.length) throw new Error(`Unknown or incomplete argument: ${arg}`);
    parsed[key] = resolve(args[++index]);
    if (key === "target") parsed[key] = args[index];
  }
  return parsed;
}

export async function main(args = process.argv.slice(2)) {
  const result = await prepareCodexRuntime(parseArguments(args));
  if (result.skipped) {
    console.log("Codex app-server packaging skipped for the mobile sync client.");
  } else {
    console.log(
      `Codex app-server ${result.target} is staged at ${result.outputDir}${result.reused ? " (cached)" : ""}.`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
