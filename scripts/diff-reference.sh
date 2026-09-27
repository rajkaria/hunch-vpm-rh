#!/usr/bin/env bash
# HunchVPM = the vendored reference settler + diffs D1-D9, and nothing else. This script
# proves it on every CI run. (D1-D7 are docs/spec/03-contracts.md's product diffs; D8 and D9
# are the two safety fixes documented in DIFF.md.)
#
#   bash scripts/diff-reference.sh           regenerate contracts/DIFF.md, then run the checks
#   bash scripts/diff-reference.sh --check   fail (exit 1) if DIFF.md is stale or any check fails
#
# Checks:
#   1. Every hunk of `diff -u reference HunchVPM` that adds or removes a line carries a diff
#      tag: a `//` comment on one of its ADDED lines naming D1..D9. A pure deletion cannot
#      carry a tag, so it fails too.
#   2. Every one of D1..D9 is cited by at least one hunk.
#   3. The parts of the reference the spec forbids touching are byte-identical in HunchVPM
#      (the mechanism's functions, the Position/Book structs, nonReentrant), and `resolve` /
#      `voidMarket` differ from the reference by exactly the one D8 line each.
#   4. (--check) contracts/DIFF.md equals what this script generates.
# Plain bash + diff + awk + grep, so it runs anywhere CI does.
set -euo pipefail

CHECK=0
case "${1:-}" in
  --check) CHECK=1 ;;
  "") ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/../contracts"
REF="src/reference/VestedParimutuel.sol"
NEW="src/HunchVPM.sol"
OUT="DIFF.md"
FAIL=0
fail() { echo "diff-reference: $*" >&2; FAIL=1; }

# ---------------------------------------------------------------- the diff (exit 1 = differs)
set +e
PATCH="$(diff -u --label "a/$REF" --label "b/$NEW" "$REF" "$NEW")"
rc=$?
set -e
if [ "$rc" -gt 1 ]; then echo "diff-reference: diff failed" >&2; exit 2; fi

# ---------------------------------------------------------------- 1 + 2: hunk tags
# Prints "STAT <hunks> <added> <removed> <n1> .. <n9>" and one "UNTAGGED <header>" per bad hunk.
TAGS="$(printf '%s\n' "$PATCH" | awk '
  function flush() {
    if (inhunk && changed) {
      hunks++
      if (!tagged) print "UNTAGGED " header
      for (t = 1; t <= 9; t++) if (cite[t]) { cited[t]++; cite[t] = 0 }
    }
  }
  /^@@/ { flush(); inhunk = 1; changed = 0; tagged = 0; header = $0; next }
  !inhunk { next }                                  # the ---/+++ file header
  /^-/ { changed = 1; removed++; next }
  /^\+/ {
    changed = 1; added++
    i = index($0, "//")
    if (i > 0) {
      c = substr($0, i)
      for (t = 1; t <= 9; t++) {
        if (c ~ ("(^|[^A-Za-z0-9_])D" t "([^0-9]|$)")) { tagged = 1; cite[t] = 1 }
      }
      # "D1–D9" / "D1-D9" cites the whole range
      if (c ~ /D1(–|-)D9/) { tagged = 1; for (t = 1; t <= 9; t++) cite[t] = 1 }
    }
  }
  END {
    flush()
    printf "STAT %d %d %d", hunks, added, removed
    for (t = 1; t <= 9; t++) printf " %d", cited[t] + 0
    printf "\n"
  }')"

while IFS= read -r line; do
  case "$line" in
    UNTAGGED*) fail "hunk without a D1..D9 tag on an added line: ${line#UNTAGGED }" ;;
  esac
done <<< "$TAGS"
read -r _ HUNKS ADDED REMOVED C1 C2 C3 C4 C5 C6 C7 C8 C9 <<< "$(grep '^STAT' <<< "$TAGS")"
i=1
for n in "$C1" "$C2" "$C3" "$C4" "$C5" "$C6" "$C7" "$C8" "$C9"; do
  [ "$n" -gt 0 ] || fail "D$i is never cited: every listed diff must appear in the code"
  i=$((i + 1))
done

# ---------------------------------------------------------------- 3: untouchable parts
# Extract a top-level member (function/struct/modifier) from its declaration line to the
# first line that is exactly "    }" (the reference's own formatting), and compare.
extract() { # file kind name
  awk -v kind="$2" -v name="$3" '
    !on && $0 ~ ("^    " kind " " name "[ ({]") { on = 1 }
    on { print }
    on && $0 == "    }" { exit }
  ' "$1"
}
UNTOUCHED_FUNCTIONS="_seedVintage _sum _seedClamp finalizeVintage _rollVintage _finalizeVintage claimResidue transferPosition marketCount positionCount getMarket getBook pendingCount headroom previewPayout _headroom _times _u128 _addCapacity _pull _push"
for f in $UNTOUCHED_FUNCTIONS; do
  a="$(extract "$REF" function "$f")"
  b="$(extract "$NEW" function "$f")"
  [ -n "$a" ] || fail "reference has no function $f (update UNTOUCHED_FUNCTIONS)"
  [ "$a" = "$b" ] || fail "function $f differs from the reference; the spec forbids touching it"
done
# D8: resolve and voidMarket may differ from the reference by exactly one line each, the
# reference's `_rollVintage(marketId);` replaced by the D8 unconditional finalization.
D8_LINE='        if (m.vintageOpen) _finalizeVintage(marketId); // D8: even in the last entry'"'"'s L1 block'
for f in resolve voidMarket; do
  a="$(extract "$REF" function "$f" | sed 's/^        _rollVintage(marketId);$/@SETTLE@/')"
  b="$(extract "$NEW" function "$f" | awk -v d="$D8_LINE" '$0 == d { print "@SETTLE@"; next } { print }')"
  [ "$a" = "$b" ] || fail "function $f differs from the reference beyond its one D8 line"
done
for s in Position Book; do
  [ "$(extract "$REF" struct "$s")" = "$(extract "$NEW" struct "$s")" ] || fail "struct $s differs from the reference"
done
[ "$(extract "$REF" modifier nonReentrant)" = "$(extract "$NEW" modifier nonReentrant)" ] || fail "modifier nonReentrant differs"
for c in "uint256 public constant SCALE = 1e18;" "uint256 public constant KAPPA_UNBOUNDED = type(uint256).max;"; do
  grep -qF "$c" "$NEW" || fail "constant changed or missing: $c"
done

# ---------------------------------------------------------------- DIFF.md
render() {
  cat <<'EOF'
# HunchVPM against the reference settler

`src/HunchVPM.sol` is `src/reference/VestedParimutuel.sol` (vendored byte for byte, see
`VENDORED.md`) changed by the seven product diffs of `docs/spec/03-contracts.md` (D1-D7),
two safety fixes found while building for Robinhood Chain and extended after the independent
review of 2026-09-28 (D8, D9), and nothing else. This file is generated by
`scripts/diff-reference.sh`; CI runs it with `--check`, which fails if this file is stale or
if any rule below is broken.

| Tag | Diff | What changes |
|---|---|---|
| D1 | Fee on winners' gains | `create` takes `feeBps` (at most 500). A winning claim pays `payout - fee` with `fee = floor((payout - accepted) * feeBps / 10000)`; `paidOut` stays gross, so the residue is the reference's. `feesAccrued[token]`, `sweepFees(token)` to the immutable `treasury`. No fee on losses, voids, refunds or residue. |
| D2 | Anyone delivers, only to the owner | `claimFor`, `withdrawRefundFor` (permissionless). `claim` / `withdrawRefund` keep the owner check. All four pay `positions[id].owner` through the shared `_claim` / `_withdrawRefund`. |
| D3 | Entry bounds | `create` takes `minEntry`, `maxEntry` (0 = no bound), immutable per market; entries outside them revert on the offered amount. |
| D4 | Entries pause | The immutable `guardian` may `setEntriesPaused`. Only `enter` and `enterWithAuthorization` read it. |
| D5 | Gasless entry, paid entries | `enterWithAuthorization` pays with the bettor's signed USDG `receiveWithAuthorization` (EIP-3009, `bytes` signature). `enterNonce` binds chain, contract, market, side, amount and salt. `enter` and it share `_enter(owner, ...)`. A used or cancelled nonce reverts `AuthorizationUsed` before anything is booked (USDG returns without paying for one), and every pull (`create`, `enter`, `enterWithAuthorization`) must raise the settler's balance by the amount (`NotPaid`, via `_pullExact`; the reference `_pull` is unchanged). |
| D6 | Views | `accrued`, `previewFee`, `marketTerms`, `marketPositionCount`, `marketPositions` (backed by a per-market id list). `getMarket` keeps the reference's twelve fields. |
| D7 | Events | Added `FeeAccrued`, `FeesSwept`, `EntriesPaused`. The reference events are unchanged; `Claimed.payout` is the amount sent for the settlement (gross minus fee). |
| D8 | Settlement finalizes the last vintage | `resolve` and `voidMarket` finalize an open vintage unconditionally instead of only when `block.number` has advanced (one line each). |
| D9 | Lock prevention | `enter` reverts `VintageFull` once the current block's vintage holds `MAX_VINTAGE_ENTRIES` (200) entries or would exceed `MAX_VINTAGE_WORK` (12,800) entry-outcome pairs (entries × n: 200 entries up to 64 outcomes, 50 at 255); the entry goes in the next block (~12 s). `create` accepts a finite κ only up to `MAX_KAPPA` (1e9), besides `KAPPA_UNBOUNDED`. |

## Why D8 exists

The reference groups entries into vintages by `block.number` and settles a market only after
its freeze, so on Ethereum the settling transaction is always in a later block than every
entry and `resolve` / `voidMarket` always finalize the last vintage (the reference's `claim`
relies on it: "resolve/void finalized the last vintage, so p.finalized holds here"). On
Robinhood Chain (Arbitrum Orbit) `block.number` is the L1 block estimate, which stays the same
for about 12 seconds of L2 blocks with rising timestamps. A market can therefore be settled in
the same `block.number` as its last entry. The reference then leaves that vintage pending, a
claim on a pending position returns its whole stake as a refund, and a later
`finalizeVintage` vests the same stake into the winners a second time. Because one settler
holds every market's escrow, the difference is taken from other markets:
`test/SameBlockSettlement.t.sol` reproduces the drain on the reference and shows HunchVPM
refusing it. Finalizing at settlement is exactly the reference's behaviour whenever
`block.number` has advanced (the only case the reference was specified for), and is safe in
the same block because no entry can join a vintage after the freeze.

## Why D9 exists

Every way out of a market (the next entry, `finalizeVintage`, `resolve`, `voidMarket`, a
refund before settlement) finalizes the pending vintage first, so finalizing must always fit
in a block and must never revert; otherwise nothing could settle or void that market and
every stake in it would be locked for good. D9 closes the three ways the reference allows
it:

- **Too many entries.** Finalizing costs about 34,000 gas per entry. On Robinhood Chain a
  vintage spans one L1 block, about 12 seconds and dozens of L2 blocks, so anyone could pour
  about a thousand minimum-size entries into one vintage and push its finalization past the
  32M block gas limit. `MAX_VINTAGE_ENTRIES` = 200.
- **Too many outcomes per entry** (independent review, M-2). Finalizing loops over every
  outcome for every entry, and `create` is permissionless up to 255 outcomes: 200 entries on
  a 110-outcome market no longer fit in a block. `MAX_VINTAGE_WORK` = 12,800 caps
  entries × outcomes, which leaves binary markets at 200 entries and bounds the worst full
  vintage of any market that can be created inside 32M gas (up to about 140 outcomes) at
  about 23.1M gas (64 outcomes, every book rationed).
- **A huge finite κ** (independent review, I-1). Finalizing computes κ·a with checked
  arithmetic, so κ = 1e70 overflowed on a 20 USDG entry and reverted every exit.
  `MAX_KAPPA` = 1e9 (the largest finite κ among the paper's published vectors, P9 and P12):
  κ·a then stays below 2^158 for any amount a position can hold, and the accumulator below
  2^128. `KAPPA_UNBOUNDED` stays accepted.

`test/VintageStuffing.t.sol` locks a reference market by stuffing, shows a full 200-entry
binary HunchVPM vintage settling in under 7M gas, measures the fullest vintage of every
creatable outcome count, and replays the reviewer's many-outcome and huge-κ locks, which now
cannot happen. The caps are invisible at the venue's traffic (binary markets, κ 30) and cost
one warm read per entry.

## Rules the script enforces

1. **Every hunk is tagged.** Each hunk below that adds or removes a line has, on one of its
   added lines, a `//` comment naming its diff (`D1` ... `D9`; `D1–D9` cites all nine). A
   hunk that only deletes lines cannot carry a tag and fails.
2. **Every diff is cited.** Each of D1 ... D9 appears in at least one hunk.
3. **The mechanism is untouched.** These are compared byte for byte with the reference:
   `_seedVintage`, `_seedClamp`, `_sum`, `finalizeVintage`, `_rollVintage`,
   `_finalizeVintage`, `claimResidue`, `transferPosition`, every reference view
   (`marketCount`, `positionCount`, `getMarket`, `getBook`, `pendingCount`, `headroom`,
   `previewPayout`), the helpers `_headroom`, `_times`, `_u128`, `_addCapacity`, `_pull`,
   `_push`, the `Position` and `Book` structs, `nonReentrant`, `SCALE` and
   `KAPPA_UNBOUNDED`. `resolve` and `voidMarket` must equal the reference except for their
   single D8 line.
4. **This file is current.** `--check` regenerates it and compares.

One hunk is tagged for a mechanical reason rather than a behavioural one: `create` inlines
its local `n` as `seed.length`, because the three new arguments (D1, D3) would otherwise
exceed the legacy code generator's 16-slot stack (`via_ir` stays off, as in the reference).
Behaviour is identical, which `test/Differential.t.sol` proves: with fee 0, no bounds and
entries unpaused, HunchVPM and the reference produce the same accepted amounts, payouts,
refunds and residue on all 118 published vectors and on fuzzed sequences (settling, as the
reference assumes, in a later block than the last entry).

EOF
  echo "## Summary (generated)"
  echo
  echo "- hunks: $HUNKS; lines added: $ADDED; lines removed: $REMOVED"
  echo "- hunks citing each diff: D1 $C1 · D2 $C2 · D3 $C3 · D4 $C4 · D5 $C5 · D6 $C6 · D7 $C7 · D8 $C8 · D9 $C9"
  echo
  echo "## The diff"
  echo
  echo '```diff'
  printf '%s\n' "$PATCH"
  echo '```'
}

if [ "$CHECK" -eq 1 ]; then
  if [ ! -f "$OUT" ]; then
    fail "contracts/$OUT is missing: run bash scripts/diff-reference.sh"
  elif [ "$(render)" != "$(cat "$OUT")" ]; then
    fail "contracts/$OUT is stale: run bash scripts/diff-reference.sh and commit it"
  fi
else
  render > "$OUT"
  echo "wrote contracts/$OUT ($HUNKS hunks, +$ADDED -$REMOVED)"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "diff-reference: FAILED" >&2
  exit 1
fi
echo "diff-reference: ok ($HUNKS hunks, every one tagged; D1..D9 cited $C1/$C2/$C3/$C4/$C5/$C6/$C7/$C8/$C9; mechanism untouched)"
