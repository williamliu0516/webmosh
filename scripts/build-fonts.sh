#!/bin/bash
# Subsets a terminal font for the page (a Nerd Font, say): Latin, symbols, box drawing, braille and the Nerd Font icon
# ranges. CJK is left to the system font (PingFang on the iPad): a CJK font is tens of MB per weight. The output,
# mono-regular.woff2 and mono-bold.woff2, goes in the relay's static_dir beside a custom.css that names them
# (web/src/custom.css shows how). Needs fonttools: python3 -m venv build/venv && build/venv/bin/pip install fonttools brotli
#   [FEATURES="cv01 zero"] scripts/build-fonts.sh <regular.ttf> <bold.ttf> [out dir; default build/fonts]
# FEATURES bakes OpenType features into the font (character variants, stylistic sets, a slashed zero: single
# substitutions only): each character maps straight to its variant. The WebGL renderer draws glyphs on a canvas, which
# takes no CSS font-feature-settings, so variants picked that way would show in the DOM renderer only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ $# -ge 2 ] || { sed -n 2,9p "$0" >&2; exit 2; }
OUT="${3:-$ROOT/build/fonts}"
mkdir -p "$OUT"
UNICODES="U+0020-007E,U+00A0-024F,U+0300-036F,U+2000-206F,U+2070-20CF,U+2100-21FF,U+2200-23FF,U+2460-24FF,U+2500-27BF,U+2800-28FF,U+E000-F8FF,U+F0000-FFFFD"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for pair in "regular:$1" "bold:$2"; do
  src="${pair#*:}"
  if [ -n "${FEATURES:-}" ]; then
    "$ROOT/build/venv/bin/python" -I - "$src" "$TMP/font.ttf" "$FEATURES" <<'PY'
import sys
from fontTools.ttLib import TTFont
src, dst, tags = sys.argv[1], sys.argv[2], sys.argv[3].replace(',', ' ').split()
font = TTFont(src)
gsub = font['GSUB'].table
for tag in tags:
    mapping = {}
    records = [r for r in gsub.FeatureList.FeatureRecord if r.FeatureTag == tag]
    if not records:
        sys.exit(f'no feature {tag} in {src}')
    for i in sorted({i for r in records for i in r.Feature.LookupListIndex}):
        lookup = gsub.LookupList.Lookup[i]
        for sub in lookup.SubTable:
            if lookup.LookupType == 7:
                sub = sub.ExtSubTable
            if sub.LookupType != 1:
                sys.exit(f'feature {tag} in {src} is not a single substitution (lookup type {sub.LookupType})')
            mapping.update(sub.mapping)
    for table in font['cmap'].tables:
        for cp, glyph in table.cmap.items():
            table.cmap[cp] = mapping.get(glyph, glyph)
font.save(dst)
PY
    src="$TMP/font.ttf"
  fi
  "$ROOT/build/venv/bin/pyftsubset" "$src" --unicodes="$UNICODES" \
    --flavor=woff2 --layout-features='*' --no-hinting --desubroutinize --output-file="$OUT/mono-${pair%%:*}.woff2"
done
ls -la "$OUT"
