# `portcode-wasm` — committed browser transport artifact

**This directory is GENERATED and CHECKED IN on purpose.** Do not hand-edit it.

It holds the `wasm-pack --target web` output of the `crates/portcode-wasm`
crate — the iroh-in-browser Phone Sync `Session` class the deployed PWA loads at
runtime (IOS_WEB_CLIENT_PLAN.md §5.4). Vercel runs `pnpm build:web` with **no
Rust toolchain**, so the wasm cannot be built there: it must be prebuilt and
committed here for the web bundle to import it.

Files (all tracked):

- `portcode_wasm.js` — the wasm-bindgen ES-module glue (`default` export is the
  async `init(module_or_path)`; named export `Session`).
- `portcode_wasm_bg.wasm` — the WebAssembly binary. Built with `wasm-opt`
  disabled (binaryen downloads a binary at build time, which fails in the
  network-restricted CI sandbox — see the crate's
  `[package.metadata.wasm-pack.profile.release]`). It is therefore **unoptimized
  / larger than a fully-optimized build** (~4 MB on disk), but Vercel serves it
  Brotli-compressed on the wire, so the transfer size is a fraction of that.
- `portcode_wasm.d.ts` / `portcode_wasm_bg.wasm.d.ts` — TypeScript types.

## Regenerating

```sh
wasm-pack build --target web crates/portcode-wasm
cp crates/portcode-wasm/pkg/portcode_wasm.js \
   crates/portcode-wasm/pkg/portcode_wasm_bg.wasm \
   crates/portcode-wasm/pkg/portcode_wasm.d.ts \
   crates/portcode-wasm/pkg/portcode_wasm_bg.wasm.d.ts \
   web/wasm/portcode-wasm/
```

CI (`.github/workflows/ci.yml`, the `wasm` job) rebuilds the crate and runs
`git diff --exit-code` over the tracked source files in this directory, so a
stale/forgotten copy reddens CI. (The `.wasm` binary itself is excluded from the
freshness diff because its bytes are not bit-for-bit reproducible across
toolchain patch versions; the `.js`/`.d.ts` glue is the interop contract and
**is** diffed.)

## How it is loaded

`src/lib/webSession.ts`'s `defaultWasmLoader` dynamically imports
`portcode_wasm.js` and calls its default `init()`, passing the `_bg.wasm` URL via
a Vite `?url` import so the fetch resolves to the content-hashed asset the web
build emits into `web-dist/assets/`. If the import or init throws,
`createWasmConnector` transparently falls back to the deterministic mock so a
broken/missing wasm never bricks the PWA.
