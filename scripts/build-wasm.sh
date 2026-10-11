#!/bin/bash
# Builds web/dist/webmosh.mjs + webmosh.wasm: mosh 1.4.0's client core with webmosh's socketless
# network layer. Run scripts/build-deps.sh once first.
#
# mosh's headers include "network.h" by quoted path from their own directory, so the overrides
# cannot win through -I order. Instead the sources are staged: copy mosh/src, drop the overrides in.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
B="$ROOT/build"
STAGE="$B/stage"
GEN="$B/gen"
OBJ="$B/obj"
OUT="$ROOT/web/dist"
MOSH="$ROOT/third_party/mosh/src"
PB="$ROOT/third_party/protobuf-3.21.12/src"
OPT="${OPT:--O2}"

rm -rf "$STAGE" && mkdir -p "$STAGE" "$GEN" "$OBJ" "$OUT"
cp -R "$MOSH"/{crypto,network,statesync,terminal,frontend,util,protobufs} "$STAGE/"
cp "$ROOT/wasm/override/network.h" "$STAGE/network/network.h"
cp "$ROOT/wasm/override/network_web.cc" "$STAGE/network/network.cc"
cp "$ROOT/wasm/override/terminaldisplayinit_web.cc" "$STAGE/terminal/terminaldisplayinit.cc"

"$B/protoc-host/protoc" --cpp_out="$GEN" -I"$STAGE/protobufs" "$STAGE"/protobufs/*.proto

SRCS=(
  crypto/base64.cc crypto/crypto.cc crypto/ocb_internal.cc
  network/network.cc network/compressor.cc network/transportfragment.cc
  statesync/completeterminal.cc statesync/user.cc
  terminal/parser.cc terminal/parseraction.cc terminal/parserstate.cc terminal/terminal.cc
  terminal/terminaldispatcher.cc terminal/terminaldisplay.cc terminal/terminaldisplayinit.cc
  terminal/terminalframebuffer.cc terminal/terminalfunctions.cc terminal/terminaluserinput.cc
  frontend/terminaloverlay.cc util/timestamp.cc
)
INC=(-I"$ROOT/wasm" -I"$GEN" -I"$PB" -I"$B/nettle-wasm/include")
for d in crypto network statesync terminal frontend util; do INC+=(-I"$STAGE/$d"); done
CXXFLAGS=("$OPT" ${DEBUG:+-DWEBMOSH_DEBUG} -std=c++17 -fwasm-exceptions -sUSE_ZLIB=1 -Wno-deprecated-declarations -Wno-unused-parameter)

objs=()
compile() { # src obj
  em++ "${CXXFLAGS[@]}" "${INC[@]}" -c "$1" -o "$2"
}
pids=()
for s in "${SRCS[@]}"; do
  o="$OBJ/$(echo "$s" | tr / _).o"; objs+=("$o")
  compile "$STAGE/$s" "$o" & pids+=($!)
done
for p in "$GEN"/*.pb.cc; do
  o="$OBJ/$(basename "$p").o"; objs+=("$o")
  compile "$p" "$o" & pids+=($!)
done
o="$OBJ/webmosh.o"; objs+=("$o")
compile "$ROOT/wasm/webmosh.cc" "$o" & pids+=($!)
fail=0; for p in "${pids[@]}"; do wait "$p" || fail=1; done
[ "$fail" = 0 ] || { echo "compile failed" >&2; exit 1; }

EXPORTS='["_wm_start","_wm_input","_wm_resize","_wm_datagram","_wm_tick","_wm_repaint","_wm_shutdown","_wm_status","_wm_take_screen","_wm_take_datagram","_wm_scratch","_wm_error","_wm_since_heard","_wm_hops",'"${DEBUG:+\"_wm_debug\",}"'"_malloc","_free"]'
em++ "$OPT" -fwasm-exceptions -sUSE_ZLIB=1 "${objs[@]}" \
  "$B/protobuf-wasm/libprotobuf-lite.a" "$B/nettle-wasm/lib/libnettle.a" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createWebMosh -sENVIRONMENT=web,node \
  -sALLOW_MEMORY_GROWTH=1 -sDYNAMIC_EXECUTION=0 -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8","UTF8ToString","stringToNewUTF8","lengthBytesUTF8","stringToUTF8"]' \
  -o "$OUT/webmosh.mjs"
ls -la "$OUT"
