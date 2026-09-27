#!/usr/bin/env bash
# Completes the deployment JSON after DeployRH, from the broadcast receipts and the chain itself.
#
#   bash scripts/post-deploy.sh                          mainnet (docs/OPERATOR.md, right after step 6)
#   bash scripts/post-deploy.sh --deployment deployments/local/robinhood-fork.json \
#        --broadcast deployments/local/broadcast/DeployRH.s.sol/4663/run-latest.json \
#        --rpc-url http://127.0.0.1:8545 --no-wire      what scripts/rehearse-fork.sh runs
#
# DeployRH writes the addresses, the Safe and the keeper, and leaves the deploy transactions,
# their blocks, `startBlock` and `deployedAt` null: inside the EVM on Robinhood Chain,
# `block.number` is the L1 block estimate, while log scans need the L2 block. This script:
#   1. reads the three CREATE transactions from the forge broadcast (run-latest.json) and checks
#      that they deployed exactly the addresses the JSON names;
#   2. fetches every receipt of the broadcast from the RPC (the chain, not forge's copy):
#      each must have succeeded; the deploy receipts give the L2 block numbers;
#   3. reads the wiring back from the chain (factory → settler, resolver, USDG, treasury,
#      owner / pending owner, keeper as opener, each feed's allow-list entry; settler →
#      guardian, treasury) and refuses to write anything if one disagrees with the JSON;
#   4. writes deployTx and block per contract, startBlock (the first deploy's L2 block),
#      deployedAt (that block's time, ISO 8601 UTC) and gitCommit (HEAD, "-dirty" if
#      contracts/ has uncommitted changes);
#   5. runs `pnpm wire` for the mainnet file (README table + the client's embedded copy).
# Idempotent: running it again rewrites the same values. Needs bash, jq, cast and git.
set -euo pipefail
cd "$(dirname "$0")/.."

MAINNET_JSON="deployments/robinhood-mainnet.json"
DEPLOYMENT="$MAINNET_JSON"
BROADCAST="contracts/broadcast/DeployRH.s.sol/4663/run-latest.json"
RPC="${RH_RPC_URL:-}"
WIRE=1
USDG="0x5fc5360d0400a0fd4f2af552add042d716f1d168"

die() { printf 'post-deploy: %s\n' "$*" >&2; exit 1; }
say() { printf 'post-deploy: %s\n' "$*"; }
usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; }
lc() { printf '%s' "$1" | tr 'A-F' 'a-f'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --deployment) DEPLOYMENT="${2:?}"; shift ;;
    --broadcast) BROADCAST="${2:?}"; shift ;;
    --rpc-url) RPC="${2:?}"; shift ;;
    --no-wire) WIRE=0 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
  shift
done

for tool in jq cast git; do command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"; done
[ -n "$RPC" ] || die "set RH_RPC_URL (e.g. set -a; . ./.env; set +a) or pass --rpc-url"
[ -f "$DEPLOYMENT" ] || die "no deployment JSON at $DEPLOYMENT"
[ -f "$BROADCAST" ] || die "no broadcast at $BROADCAST: run DeployRH with --broadcast first"

chain=$(cast chain-id --rpc-url "$RPC") || die "the RPC does not answer"
[ "$chain" = "4663" ] || die "the RPC is chain $chain, not Robinhood Chain (4663)"
[ "$(jq -r '.chain' "$BROADCAST")" = "4663" ] || die "$BROADCAST is not a chain-4663 broadcast"
jq -e '.status == "deployed"' "$DEPLOYMENT" >/dev/null || die "$DEPLOYMENT is not \"deployed\": run DeployRH first"

call() { cast call "$1" "$2" "${@:3}" --rpc-url "$RPC"; }
receipt_field() { jq -r "$2" <<<"$1"; }
ok_status() { [ "$1" = "0x1" ] || [ "$1" = "1" ]; }

# ------------------------------------------------------------------ 1-2. deploy transactions
JQ_ARGS=()
START=""
for name in StockRoundResolver HunchVPM HunchMarketFactory; do
  want=$(jq -r --arg n "$name" '.contracts[$n].address' "$DEPLOYMENT")
  creates=$(jq -c --arg n "$name" '[.transactions[] | select(.transactionType == "CREATE" and .contractName == $n)]' "$BROADCAST")
  [ "$(jq 'length' <<<"$creates")" = "1" ] || die "the broadcast has $(jq 'length' <<<"$creates") CREATE transactions for $name (expected 1)"
  hash=$(jq -r '.[0].hash' <<<"$creates")
  made=$(jq -r '.[0].contractAddress' <<<"$creates")
  [ "$(lc "$made")" = "$(lc "$want")" ] || die "the broadcast deployed $name at $made but $DEPLOYMENT says $want"

  rc=$(cast receipt "$hash" --json --rpc-url "$RPC" 2>/dev/null) || die "no receipt for $name's deploy $hash on this RPC (wrong network, or not mined yet)"
  ok_status "$(receipt_field "$rc" '.status')" || die "$name's deploy $hash failed on chain"
  [ "$(lc "$(receipt_field "$rc" '.contractAddress')")" = "$(lc "$want")" ] || die "$name's deploy receipt created another address"
  block=$(cast to-dec "$(receipt_field "$rc" '.blockNumber')")
  code=$(cast code "$want" --rpc-url "$RPC")
  [ "$code" != "0x" ] || die "$name has no code at $want"
  say "$name $want  tx $hash  L2 block $block"
  JQ_ARGS+=(--arg "${name}_tx" "$hash" --argjson "${name}_block" "$block")
  if [ -z "$START" ] || [ "$block" -lt "$START" ]; then START=$block; fi
done

# every other transaction of the run (setFeed x4, setOpener, transferOwnership) succeeded too
n=$(jq '.transactions | length' "$BROADCAST")
for ((i = 0; i < n; i++)); do
  hash=$(jq -r ".transactions[$i].hash" "$BROADCAST")
  what=$(jq -r ".transactions[$i] | (.function // .contractName // \"?\")" "$BROADCAST")
  rc=$(cast receipt "$hash" --json --rpc-url "$RPC" 2>/dev/null) || die "no receipt for $what ($hash)"
  ok_status "$(receipt_field "$rc" '.status')" || die "$what ($hash) failed on chain: the deploy is incomplete"
done
say "all $n transactions of the broadcast succeeded on chain"

# ------------------------------------------------------------------ 3. wiring read back from the chain
FACTORY=$(jq -r '.contracts.HunchMarketFactory.address' "$DEPLOYMENT")
VPM=$(jq -r '.contracts.HunchVPM.address' "$DEPLOYMENT")
RESOLVER=$(jq -r '.contracts.StockRoundResolver.address' "$DEPLOYMENT")
SAFE=$(jq -r '.safe' "$DEPLOYMENT")
KEEPER=$(jq -r '.keeper' "$DEPLOYMENT")
[ "$(lc "$(jq -r '.usdg' "$DEPLOYMENT")")" = "$USDG" ] || die "the JSON's usdg is not the canonical USDG"

expect() { # label, actual, wanted
  [ "$(lc "$2")" = "$(lc "$3")" ] || die "on chain, $1 is $2 but the JSON implies $3"
}
expect "factory.settler()" "$(call "$FACTORY" 'settler()(address)')" "$VPM"
expect "factory.resolver()" "$(call "$FACTORY" 'resolver()(address)')" "$RESOLVER"
expect "factory.usdg()" "$(call "$FACTORY" 'usdg()(address)')" "$USDG"
expect "factory.treasury()" "$(call "$FACTORY" 'treasury()(address)')" "$SAFE"
expect "settler.guardian()" "$(call "$VPM" 'guardian()(address)')" "$SAFE"
expect "settler.treasury()" "$(call "$VPM" 'treasury()(address)')" "$SAFE"
expect "factory.openers(keeper)" "$(call "$FACTORY" 'openers(address)(bool)' "$KEEPER")" "true"
owner=$(call "$FACTORY" 'owner()(address)')
pending=$(call "$FACTORY" 'pendingOwner()(address)')
if [ "$(lc "$owner")" = "$(lc "$SAFE")" ]; then
  say "factory owner is the Safe (ownership accepted)"
elif [ "$(lc "$pending")" = "$(lc "$SAFE")" ]; then
  say "factory owner is still the deployer $owner; the Safe must call acceptOwnership() (docs/OPERATOR.md step 8)"
else
  die "factory owner $owner and pending owner $pending: neither is the Safe $SAFE"
fi
nfeeds=$(jq '.feeds | length' "$DEPLOYMENT")
for ((i = 0; i < nfeeds; i++)); do
  f=$(jq -c ".feeds[$i]" "$DEPLOYMENT")
  ticker=$(jq -r .ticker <<<"$f")
  cfg=$(call "$FACTORY" 'feeds(address)(address,uint32,uint32,bool,string)' "$(jq -r .feed <<<"$f")" --json |
    jq -r 'map(tostring) | join(" ")')
  want=$(jq -r '[.stockToken, .maxStrikeAge, .maxFinalAge, true, .ticker] | map(tostring) | join(" ")' <<<"$f")
  [ "$(lc "$cfg")" = "$(lc "$want")" ] || die "on chain, the factory's $ticker entry is [$cfg], the JSON says [$want]"
done
say "on-chain wiring matches the JSON (settler, resolver, USDG, Safe, keeper, $nfeeds feeds)"

# ------------------------------------------------------------------ 4. time and source
ts=$(cast block "$START" --field timestamp --rpc-url "$RPC")
DEPLOYED_AT=$(jq -rn --argjson t "$ts" '$t | todate')
COMMIT=$(git rev-parse HEAD)
if [ -n "$(git status --porcelain -- contracts/src contracts/script contracts/foundry.toml contracts/foundry.lock)" ]; then
  COMMIT="$COMMIT-dirty"
  say "WARNING: contracts/ has uncommitted changes; gitCommit is marked -dirty (verification needs the exact source)"
fi
BROADCAST_COMMIT=$(jq -r '.commit // empty' "$BROADCAST")
if [ -n "$BROADCAST_COMMIT" ] && [ "${COMMIT#"$BROADCAST_COMMIT"}" = "$COMMIT" ]; then
  say "WARNING: forge recorded commit $BROADCAST_COMMIT for this broadcast but HEAD is $COMMIT"
fi

# ------------------------------------------------------------------ write
tmp=$(mktemp)
jq "${JQ_ARGS[@]}" --argjson start "$START" --arg at "$DEPLOYED_AT" --arg commit "$COMMIT" '
  .contracts.StockRoundResolver.deployTx = $StockRoundResolver_tx
  | .contracts.StockRoundResolver.block = $StockRoundResolver_block
  | .contracts.HunchVPM.deployTx = $HunchVPM_tx
  | .contracts.HunchVPM.block = $HunchVPM_block
  | .contracts.HunchMarketFactory.deployTx = $HunchMarketFactory_tx
  | .contracts.HunchMarketFactory.block = $HunchMarketFactory_block
  | .startBlock = $start
  | .deployedAt = $at
  | .gitCommit = $commit
' "$DEPLOYMENT" >"$tmp"
mv "$tmp" "$DEPLOYMENT"
say "wrote $DEPLOYMENT: startBlock $START, deployedAt $DEPLOYED_AT, gitCommit $COMMIT"

if [ "$WIRE" = "1" ] && [ "$DEPLOYMENT" = "$MAINNET_JSON" ]; then
  command -v pnpm >/dev/null 2>&1 || die "pnpm is not installed: run 'pnpm wire' yourself"
  pnpm wire
fi
say "done. Next: bash scripts/verify-contracts.sh, then acceptOwnership() from the Safe."
