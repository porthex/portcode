# End-to-end tests

The E2E desktop-journey test launches the built Portcode desktop app and inspects its live
WebView2 renderer through the Chrome DevTools Protocol (CDP). It uses WebView2's
loopback-only debugging endpoint, so no external EdgeDriver, Tauri WebDriver
server, browser-version matching, or test API is compiled into Portcode.

## What it covers

[`smoke.mts`](smoke.mts) remains data-independent, but now covers the core
interaction shell rather than stopping after first paint. It asserts that the
real desktop window:

1. has the `Portcode` document title,
2. has a non-empty React root (`#root`),
3. renders the visible application shell and title bar (`header`),
4. opens Settings without replacing the workspace with an error fallback,
5. opens Portcode's themed model listbox and exposes model options,
6. closes Settings cleanly, and
7. accepts and clears a draft through the real controlled composer.

It never sends the draft, changes a setting, starts an agent, or makes a live LLM
call. The dedicated WebView data directory keeps the test browser profile isolated.

## Running it

Install dependencies and run:

```sh
pnpm test:e2e
```

This builds the debug binary first. To reuse an existing debug build:

```powershell
$env:PORTCODE_E2E_SKIP_BUILD = "1"
pnpm test:e2e
```

Type-check the test separately with `pnpm test:e2e:typecheck`.

The suite is Windows-only while Portcode is Windows-first. The dedicated
`src-tauri/tauri.e2e.conf.json` build flavor enables the loopback DevTools port
for the test binary only. The runner verifies that port 9222 is free before
launch and closes the exact spawned app process afterward.
