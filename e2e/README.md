# End-to-end tests

The E2E smoke test launches the built Portcode desktop app and inspects its live
WebView2 renderer through the Chrome DevTools Protocol (CDP). It uses WebView2's
loopback-only debugging endpoint, so no external EdgeDriver, Tauri WebDriver
server, browser-version matching, or test API is compiled into Portcode.

## What it covers

[`smoke.mts`](smoke.mts) is a data-independent "does the app boot and paint?"
gate. It asserts that the real desktop window renders:

1. the `Portcode` document title,
2. a non-empty React root (`#root`), and
3. the visible application shell and title bar (`header`).

It never touches agent, session, or LLM state and makes no live LLM calls.

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
