#!/bin/bash
# Fetches the pinned sources into third_party/ (not committed). Then: build-deps.sh, build-wasm.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TP="$ROOT/third_party"
mkdir -p "$TP" && cd "$TP"

MOSH_TAG=mosh-1.4.0
MOSH_COMMIT=bc73a26316ede2a79259d859f8ee309b32412420
if [ ! -d mosh ]; then
  git -c advice.detachedHead=false clone -q --depth 1 -b "$MOSH_TAG" https://github.com/mobile-shell/mosh.git mosh
fi
[ "$(git -C mosh rev-parse HEAD)" = "$MOSH_COMMIT" ] || { echo "mosh: unexpected commit" >&2; exit 1; }

fetch() { # url sha256 dir
  local f; f="$(basename "$1")"
  [ -f "$f" ] || curl -sSLo "$f" "$1"
  echo "$2  $f" | shasum -a 256 -c - >/dev/null || { echo "$f: checksum mismatch" >&2; exit 1; }
  [ -d "$3" ] || tar xzf "$f"
}
fetch https://github.com/protocolbuffers/protobuf/releases/download/v21.12/protobuf-cpp-3.21.12.tar.gz \
  4eab9b524aa5913c6fffb20b2a8abf5ef7f95a80bc0701f3a6dbb4c607f73460 protobuf-3.21.12
fetch https://ftp.gnu.org/gnu/nettle/nettle-3.10.2.tar.gz \
  fe9ff51cb1f2abb5e65a6b8c10a92da0ab5ab6eaf26e7fc2b675c45f1fb519b5 nettle-3.10.2
echo "third_party ready"
