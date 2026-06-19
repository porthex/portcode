// WebdriverIO test-runner config for Portcode's end-to-end suite.
//
// Tauri exposes a standard WebDriver interface through `tauri-driver`, a
// cross-platform wrapper around the platform's native WebDriver server. On
// Windows that server is Microsoft Edge Driver (`msedgedriver.exe`), driving
// the WebView2 runtime that hosts the app's UI. See the official guidance:
// https://v2.tauri.app/develop/tests/webdriver/
//
// Prerequisites (see e2e/README.md for details):
//   - `cargo install tauri-driver --locked`
//   - Microsoft Edge + a matching `msedgedriver.exe` on PATH (Windows)
//   - A built debug binary (this config builds it in `onPrepare` unless
//     PORTCODE_E2E_SKIP_BUILD is set).
//
// tauri-driver only supports Windows and Linux — macOS has no WKWebView driver.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Register the custom `tauri:options` capability that tauri-driver reads to
// learn which built binary to launch. Erased at runtime; types only.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace WebdriverIO {
    interface Capabilities {
      "tauri:options"?: {
        application: string;
      };
    }
  }
}

// `wdio.conf.ts` lives at the repo root, so this resolves to the project root.
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const exeSuffix = process.platform === "win32" ? ".exe" : "";

// The binary tauri-driver launches. `pnpm tauri build --debug --no-bundle`
// produces it; the crate is named `portcode` (src-tauri/Cargo.toml), so the
// executable is `portcode[.exe]`. Computing the suffix per-platform keeps this
// ready for the Linux CI matrix.
const application = path.resolve(
  projectRoot,
  "src-tauri",
  "target",
  "debug",
  `portcode${exeSuffix}`,
);

// `tauri-driver` is installed with `cargo install tauri-driver --locked`, which
// drops it in Cargo's bin directory. Allow an override for a custom CARGO_HOME
// or a non-standard install location.
const tauriDriverPath =
  process.env.TAURI_DRIVER_PATH ??
  path.resolve(homedir(), ".cargo", "bin", `tauri-driver${exeSuffix}`);

// Keep a handle on the tauri-driver child process so we can always tear it down.
let tauriDriver: ChildProcess | undefined;
let shuttingDown = false;

function stopTauriDriver(): void {
  shuttingDown = true;
  tauriDriver?.kill();
  tauriDriver = undefined;
}

export const config: WebdriverIO.Config = {
  runner: "local",

  // tauri-driver speaks WebDriver on this address by default.
  hostname: "127.0.0.1",
  port: 4444,

  specs: ["./e2e/specs/**/*.e2e.ts"],
  exclude: [],

  // A native desktop window hosts a single driver session, so run serially.
  maxInstances: 1,
  capabilities: [
    {
      "tauri:options": {
        application,
      },
    },
  ],

  logLevel: "info",
  bail: 0,
  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,

  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    // The first run compiles the frontend and boots the native app, so be
    // generous with the per-test timeout.
    timeout: 120000,
  },

  // Build the debug binary before the suite so the session has something to
  // launch. CI builds it in a separate, cache-friendly step and sets
  // PORTCODE_E2E_SKIP_BUILD=1 to skip this redundant rebuild.
  onPrepare: () => {
    if (process.env.PORTCODE_E2E_SKIP_BUILD) {
      return;
    }
    const result = spawnSync("pnpm", ["tauri", "build", "--debug", "--no-bundle"], {
      cwd: projectRoot,
      stdio: "inherit",
      shell: true,
    });
    if (result.status !== 0) {
      throw new Error(
        `Failed to build the debug Tauri app (exit code ${result.status ?? "unknown"}).`,
      );
    }
  },

  // Start tauri-driver before the session so it can proxy WebDriver requests.
  beforeSession: () => {
    const args: string[] = [];
    // tauri-driver finds `msedgedriver` on PATH; allow an explicit override.
    if (process.env.MSEDGEDRIVER_PATH) {
      args.push("--native-driver", process.env.MSEDGEDRIVER_PATH);
    }

    tauriDriver = spawn(tauriDriverPath, args, {
      stdio: [null, process.stdout, process.stderr],
    });

    tauriDriver.on("error", (error) => {
      console.error(`tauri-driver failed to start: ${error.message}`);
      console.error(`Expected tauri-driver at: ${tauriDriverPath}`);
      console.error("Install it with: cargo install tauri-driver --locked");
      process.exit(1);
    });
    tauriDriver.on("exit", (code) => {
      if (!shuttingDown && code !== 0) {
        console.error(`tauri-driver exited early with code ${code ?? "unknown"}.`);
        process.exit(1);
      }
    });
  },

  // Clean up the tauri-driver process once the session ends.
  afterSession: () => {
    stopTauriDriver();
  },
};

// afterSession does not run if the session never starts (e.g. the build or the
// driver fails), so guarantee teardown on process exit as well.
for (const signal of ["exit", "SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
  process.on(signal, stopTauriDriver);
}
