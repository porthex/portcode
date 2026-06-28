#!/usr/bin/env bash
# THROWAWAY Phase-0 iOS spike build script.
#
# Builds the wasm browser echo client into web/pkg/ with wasm-pack, so
# web/index.html can `import` it. The native desktop peer is run separately
# (see notes at the bottom and README.md).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Checking prerequisites"
command -v cargo >/dev/null || { echo "missing: rust/cargo (https://rustup.rs)"; exit 1; }
command -v wasm-pack >/dev/null || {
  echo "missing: wasm-pack — install with:"
  echo "    cargo install wasm-pack"
  echo "  (or: curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh)"
  exit 1
}
rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown || {
  echo "==> Adding wasm32-unknown-unknown target"
  rustup target add wasm32-unknown-unknown
}
command -v clang >/dev/null || {
  echo "WARNING: clang not found. wasm builds of the crypto/QUIC deps need LLVM"
  echo "         clang (Apple Clang cannot target wasm32). Install LLVM clang."
}

echo "==> Building echo-web (wasm-pack build --target web)"
# NOTE: wasm-opt (binaryen) is disabled in echo-web/Cargo.toml
# ([package.metadata.wasm-pack.profile.release] wasm-opt = false) because
# wasm-pack downloads binaryen from GitHub at build time, which fails in
# network-restricted sandboxes. The wasm works without it; it is just larger.
# Re-enable it for a size-optimized build once binaryen is available.
cd "$here/echo-web"
# --target web emits an init() + echo_web_bg.wasm + echo_web.js into ./pkg
# --out-dir points it straight into the web/ dir so index.html can import it.
wasm-pack build --release --target web --out-dir "$here/web/pkg"

echo
echo "==> Done. wasm bundle is in web/pkg/"
echo
echo "Next:"
echo "  1) In another terminal, run the desktop echo peer and copy its endpoint id:"
echo "         cd $here/echo-desktop && cargo run --release"
echo
echo "  2) Serve the web/ dir over HTTP (a secure context is required for wasm +"
echo "     PWA install; localhost counts as secure):"
echo "         cd $here/web && python3 -m http.server 8000"
echo "     then open http://<this-machine-LAN-ip>:8000 on the iPhone,"
echo "     OR deploy the web/ dir to Vercel as a static site (see README.md)."
echo
echo "  3) Follow README.md for the on-device GO/NO-GO test."
