# End-to-end tests

End-to-end (E2E) tests drive the **built** Portcode desktop app the way a user
would — launching the real window and asserting against the live UI — using
[WebdriverIO](https://webdriver.io/) on top of
[`tauri-driver`](https://v2.tauri.app/develop/tests/webdriver/).

Tauri exposes a standard WebDriver interface through `tauri-driver`, a
cross-platform wrapper around the operating system's native WebDriver server. On
**Windows** that server is **Microsoft Edge Driver** (`msedgedriver.exe`),
driving the **WebView2** runtime that renders Portcode's UI.

> **Platform support:** `tauri-driver` supports **Windows and Linux only** —
> macOS has no WKWebView driver. Portcode is Windows-first today, so this suite
> and its CI run on Windows.

## What the smoke test covers

[`specs/smoke.e2e.ts`](specs/smoke.e2e.ts) is a "does the app boot and paint?"
gate. It launches the built binary and asserts that:

1. the main window loads with the document title `Portcode`,
2. the React root (`#root`) is mounted with rendered content, and
3. the application shell (the layout container and title bar) is displayed.

The assertions are deliberately **data-independent** — they never touch agent,
session, or LLM state — so the suite stays green without a backend, API keys, or
seeded data. (E2E never makes live LLM calls; see `CONTRIBUTING.md`.)

## Prerequisites

1. **Rust toolchain** — already required to build the app (see
   `rust-toolchain.toml`).

2. **`tauri-driver`** — a Rust binary, installed via Cargo (it is _not_ an npm
   package):

   ```sh
   cargo install tauri-driver --locked
   ```

   It installs to Cargo's bin directory (`~/.cargo/bin`), which the config finds
   automatically. Override with `TAURI_DRIVER_PATH` if you use a custom
   `CARGO_HOME`.

3. **Microsoft Edge Driver (Windows)** — `tauri-driver` needs an
   `msedgedriver.exe` whose version matches the installed Microsoft Edge. The
   easiest way to fetch the matching build is
   [`msedgedriver-tool`](https://github.com/chippers/msedgedriver-tool):

   ```sh
   cargo install --git https://github.com/chippers/msedgedriver-tool
   msedgedriver-tool          # downloads msedgedriver.exe into the current dir
   ```

   Put the resulting `msedgedriver.exe` on your `PATH`, or point the config at it
   with `MSEDGEDRIVER_PATH=/full/path/to/msedgedriver.exe` (the config then
   passes `--native-driver` to `tauri-driver`). If the Edge and driver versions
   disagree, the session typically hangs while connecting.

4. **Node dependencies** — `pnpm install`.

## Running the tests

```sh
pnpm test:e2e
```

By default this builds the debug binary first (`pnpm tauri build --debug
--no-bundle`) so a fresh, up-to-date app is under test, then runs the suite. If
you have already built it, skip the rebuild:

```sh
# PowerShell
$env:PORTCODE_E2E_SKIP_BUILD = "1"; pnpm test:e2e

# bash
PORTCODE_E2E_SKIP_BUILD=1 pnpm test:e2e
```

Type-check the E2E sources (the WebdriverIO runner transpiles them with `tsx`,
which does **not** type-check):

```sh
pnpm test:e2e:typecheck
```

## Environment variables

| Variable                  | Purpose                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `PORTCODE_E2E_SKIP_BUILD` | When set, skip the debug build in `onPrepare` (the app is already built).  |
| `TAURI_DRIVER_PATH`       | Path to the `tauri-driver` binary (default: `~/.cargo/bin/tauri-driver`).  |
| `MSEDGEDRIVER_PATH`       | Path to `msedgedriver.exe`; passed to `tauri-driver` as `--native-driver`. |

## Layout

| Path              | Purpose                                                      |
| ----------------- | ------------------------------------------------------------ |
| `../wdio.conf.ts` | WebdriverIO runner config (spawns/cleans up `tauri-driver`). |
| `specs/*.e2e.ts`  | Test specs.                                                  |
| `tsconfig.json`   | TypeScript config for type-checking the E2E sources.         |

## Continuous integration

[`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml) runs this suite on a
Windows runner: it installs `tauri-driver` and a matching Microsoft Edge Driver,
builds the debug app, and runs the smoke test.
