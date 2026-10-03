#!/usr/bin/env bash
# Prints the investor deck (/pitch) to public/hunch-pitch-deck.pdf with headless Chrome, using the
# page's own print layout (one 1920 x 1080 slide per page). Run it after any change to the deck,
# against a production server of this app, and commit the PDF with the change.
#
#   pnpm --filter @hunch-rh/web build && pnpm --filter @hunch-rh/web start -p 3201   # elsewhere
#   pnpm --filter @hunch-rh/web pitch:pdf [base-url]                                  # default http://localhost:3201
set -euo pipefail

BASE="${1:-http://localhost:3201}"
WEB="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$WEB/public/hunch-pitch-deck.pdf"
PARTIAL="$WEB/public/.hunch-pitch-deck.partial.pdf"

CHROME="${CHROME:-}"
if [[ -z "$CHROME" ]]; then
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v google-chrome || true)" \
    "$(command -v chromium || true)"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then CHROME="$candidate"; break; fi
  done
fi
[[ -n "$CHROME" ]] || { echo "pitch-pdf: no Chrome found; set CHROME=/path/to/chrome" >&2; exit 1; }

PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT

# The deck must be up before printing: a missing server would print Chrome's error page.
status="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/pitch" || true)"
[[ "$status" == "200" ]] || { echo "pitch-pdf: $BASE/pitch answered $status; start the app first" >&2; exit 1; }

# The virtual-time budget lets the entrance animations finish; print CSS shows every slide anyway.
# Some Chrome builds keep running after writing the PDF, so wait for the file to settle, then stop it.
rm -f "$PARTIAL"
"$CHROME" --headless=new --disable-gpu --user-data-dir="$PROFILE" --window-size=1920,1080 \
  --virtual-time-budget=4000 --no-pdf-header-footer --print-to-pdf="$PARTIAL" "$BASE/pitch" >/dev/null 2>&1 &
chrome=$!
last=-1
for _ in $(seq 1 90); do
  sleep 1
  size=0
  [[ -f "$PARTIAL" ]] && size="$(wc -c <"$PARTIAL" | tr -d ' ')"
  if [[ "$size" -gt 0 && "$size" == "$last" ]]; then break; fi
  if ! kill -0 "$chrome" 2>/dev/null && [[ "$size" -gt 0 ]]; then break; fi
  last="$size"
done
kill "$chrome" 2>/dev/null || true
wait "$chrome" 2>/dev/null || true
[[ -s "$PARTIAL" ]] || { echo "pitch-pdf: Chrome wrote no PDF" >&2; exit 1; }
mv "$PARTIAL" "$OUT"

pages="$(LC_ALL=C grep -a -o -E '/Type ?/Page([^s]|$)' "$OUT" | wc -l | tr -d ' ')"
echo "pitch-pdf: wrote $OUT ($(du -h "$OUT" | cut -f1), ${pages} pages)"
