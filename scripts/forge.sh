#!/usr/bin/env bash
# Runs the forge release this repo is pinned to, whichever forge `foundryup` last put on PATH.
#
#   bash scripts/forge.sh test --root contracts      forge <args>, with the pinned release
#   bash scripts/forge.sh --which                    print the pinned forge's path (scripts use it)
#   FORGE=/path/to/forge bash scripts/forge.sh ...   use that binary (it must be the pinned release)
#
# Why a pin: the gas figures and budgets depend on the forge release, not only on the code.
# Moving from 1.5.1 to 1.8.4 left the compiled contracts byte-identical but flipped two
# test-runner defaults (isolate, dynamic_test_linking: now pinned in contracts/foundry.toml)
# and changed what isolate mode reports: 1.5.1 gave a call's gas net of its refund, 1.8.4 gives
# the gas the transaction needs (what eth_estimateGas returns), which is what the D9 block-fit
# tests and the fork gas suite measure. See docs/spec/03-contracts.md section Gas.
#
# Resolution order: $FORGE, then `forge` on PATH, then foundryup's own install of the pinned
# release (~/.foundry/versions/foundry-rs/foundry/v<version>/forge), so a newer global forge
# installed for another project does not break this repo as long as the pinned one is installed.
set -euo pipefail

FOUNDRY_VERSION=1.8.4

version_of() { "$1" --version 2>/dev/null | sed -n 's/^forge Version: \([0-9][0-9.]*\).*/\1/p' | head -1; }

pinned=""
candidates=()
if [ -n "${FORGE:-}" ]; then
  candidates+=("$FORGE")
else
  command -v forge >/dev/null 2>&1 && candidates+=("$(command -v forge)")
  candidates+=("${FOUNDRY_DIR:-$HOME/.foundry}/versions/foundry-rs/foundry/v$FOUNDRY_VERSION/forge")
fi
for c in "${candidates[@]}"; do
  if [ -x "$c" ] && [ "$(version_of "$c")" = "$FOUNDRY_VERSION" ]; then pinned=$c; break; fi
done

if [ -z "$pinned" ]; then
  found=""
  for c in "${candidates[@]}"; do
    [ -x "$c" ] && found="$found\n    $c: forge $(version_of "$c")"
  done
  {
    if [ -n "${FORGE:-}" ]; then
      printf 'forge.sh: FORGE=%s is not forge %s, the release this repo is pinned to.\n' "$FORGE" "$FOUNDRY_VERSION"
    else
      printf 'forge.sh: this repo is pinned to forge %s, and it is not installed.\n' "$FOUNDRY_VERSION"
    fi
    [ -n "$found" ] && printf '  found instead:%b\n' "$found"
    printf '  The gas figures and budgets (contracts/GAS.md, test/VintageStuffing.t.sol) are measured\n'
    printf '  with forge %s; other releases measure differently (docs/spec/03-contracts.md, Gas).\n' "$FOUNDRY_VERSION"
    printf '  Install it next to your other versions:   foundryup --install v%s\n' "$FOUNDRY_VERSION"
    printf '  (that also makes it the default forge; foundryup --use <version> switches back,\n'
    printf '  and this script keeps finding v%s in ~/.foundry/versions)\n' "$FOUNDRY_VERSION"
  } >&2
  exit 1
fi

if [ "${1:-}" = "--which" ]; then
  printf '%s\n' "$pinned"
  exit 0
fi
exec "$pinned" "$@"
