#!/bin/bash
# Builds what the WASM mosh client links against, into build/:
#   protoc-host/      protoc 21.12 for this machine (Homebrew's protoc 36 needs abseil at runtime)
#   protobuf-wasm/    libprotobuf-lite.a for wasm32
#   nettle-wasm/      libnettle.a (AES for mosh's OCB) for wasm32
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TP="$ROOT/third_party"
B="$ROOT/build"
PB="$TP/protobuf-3.21.12"
NT="$TP/nettle-3.10.2"
EH="-fwasm-exceptions"
mkdir -p "$B"
NCPU="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"   # macOS and Linux

step() { echo "== $*"; }

if [ ! -x "$B/protoc-host/protoc" ]; then
  step "protoc (host)"
  cmake -S "$PB" -B "$B/protoc-host" -DCMAKE_BUILD_TYPE=Release -Dprotobuf_BUILD_TESTS=OFF \
    -Dprotobuf_BUILD_SHARED_LIBS=OFF -DCMAKE_POLICY_VERSION_MINIMUM=3.5 >/dev/null
  cmake --build "$B/protoc-host" --target protoc -j"$NCPU" >/dev/null
fi

if [ ! -f "$B/protobuf-wasm/libprotobuf-lite.a" ]; then
  step "libprotobuf-lite (wasm)"
  emcmake cmake -S "$PB" -B "$B/protobuf-wasm" -DCMAKE_BUILD_TYPE=Release -Dprotobuf_BUILD_TESTS=OFF \
    -Dprotobuf_BUILD_PROTOC_BINARIES=OFF -Dprotobuf_WITH_ZLIB=OFF -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DCMAKE_CXX_FLAGS="$EH" >/dev/null
  cmake --build "$B/protobuf-wasm" --target libprotobuf-lite -j"$NCPU" >/dev/null
fi

if [ ! -f "$B/nettle-wasm/lib/libnettle.a" ]; then
  step "nettle (wasm)"
  rm -rf "$B/nettle-obj" && mkdir -p "$B/nettle-obj" && cd "$B/nettle-obj"
  HOST_CC=/usr/bin/cc CC_FOR_BUILD=/usr/bin/cc emconfigure "$NT/configure" --prefix="$B/nettle-wasm" --disable-assembler --disable-shared \
    --disable-public-key --disable-openssl --disable-documentation --disable-fat >/dev/null
  emmake make -j"$NCPU" libnettle.a >/dev/null
  mkdir -p "$B/nettle-wasm/lib" "$B/nettle-wasm/include/nettle"
  cp libnettle.a "$B/nettle-wasm/lib/"
  cp "$NT"/*.h "$B/nettle-wasm/include/nettle/" 2>/dev/null || true
  cp nettle-stdint.h version.h "$B/nettle-wasm/include/nettle/" 2>/dev/null || true
fi
step done
ls -la "$B/protoc-host/protoc" "$B/protobuf-wasm/libprotobuf-lite.a" "$B/nettle-wasm/lib/libnettle.a"
