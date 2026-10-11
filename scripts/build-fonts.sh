#!/bin/bash
# Subsets a terminal font for the page (a Nerd Font, say): Latin, symbols, box drawing, braille and the Nerd Font icon
# ranges. CJK is left to the system font (PingFang on the iPad): a CJK font is tens of MB per weight. The output,
# mono-regular.woff2 and mono-bold.woff2, goes in the relay's static_dir beside a custom.css that names them
# (web/src/custom.css shows how). Needs fonttools: python3 -m venv build/venv && build/venv/bin/pip install fonttools brotli
#   scripts/build-fonts.sh <regular.ttf> <bold.ttf> [out dir; default build/fonts]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ $# -ge 2 ] || { sed -n 2,6p "$0" >&2; exit 2; }
OUT="${3:-$ROOT/build/fonts}"
mkdir -p "$OUT"
UNICODES="U+0020-007E,U+00A0-024F,U+0300-036F,U+2000-206F,U+2070-20CF,U+2100-21FF,U+2200-23FF,U+2460-24FF,U+2500-27BF,U+2800-28FF,U+E000-F8FF,U+F0000-FFFFD"
for pair in "regular:$1" "bold:$2"; do
  "$ROOT/build/venv/bin/pyftsubset" "${pair#*:}" --unicodes="$UNICODES" \
    --flavor=woff2 --layout-features='*' --no-hinting --desubroutinize --output-file="$OUT/mono-${pair%%:*}.woff2"
done
ls -la "$OUT"
