#!/bin/bash
# WASM module + page + relay binaries into build/relay/: webmosh-relay for this computer (the tests run it), and one
# per platform a relay can run on, webmosh-relay-<os>-<arch>: Linux (amd64, arm64, arm for 32-bit Raspberry Pi OS)
# and macOS (arm64, amd64). The page is inside each. Windows has no mosh-server: a relay there would run in WSL.
# The page's fonts and pictures are the deployment's own (the relay config's static_dir), not built here.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/build-wasm.sh" >/dev/null
cd "$ROOT/web" && npm run -s build
rm -rf "$ROOT/relay/static" && mkdir -p "$ROOT/relay/static"
cp "$ROOT/web/dist/"{index.html,custom.css,app.js,xterm.css,webmosh.mjs,webmosh.wasm} "$ROOT/relay/static/"
cd "$ROOT/relay"
mkdir -p "$ROOT/build/relay"
# the relay reports the commit it was built from (-version, its startup line, /site.json); -dirty: uncommitted changes
VERSION="$(git -C "$ROOT" describe --always --dirty 2>/dev/null || echo dev)"
go build -trimpath -ldflags="-X main.version=$VERSION" -o "$ROOT/build/relay/webmosh-relay" .
for t in linux/amd64 linux/arm64 linux/arm darwin/arm64 darwin/amd64; do
  # GOARM=6: every Raspberry Pi with a 32-bit OS, the Zero and 1 too
  GOOS=${t%/*} GOARCH=${t#*/} GOARM=6 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=$VERSION" \
    -o "$ROOT/build/relay/webmosh-relay-${t%/*}-${t#*/}" .
done
ls -la "$ROOT/build/relay" "$ROOT/relay/static"
