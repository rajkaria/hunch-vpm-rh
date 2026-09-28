#!/usr/bin/env bash
# Verifies the three deployed contracts on Blockscout (robinhoodchain.blockscout.com), falling
# back to Sourcify for any contract Blockscout refuses (its API sits behind a Cloudflare
# challenge that can block the CLI). The operator runs it after scripts/post-deploy.sh
# (docs/OPERATOR.md step 8); nothing in the test suites calls it.
#
#   bash scripts/verify-contracts.sh                        Blockscout, then Sourcify on failure
#   bash scripts/verify-contracts.sh --verifier sourcify    Sourcify only
#   bash scripts/verify-contracts.sh --verifier blockscout  Blockscout only
#   bash scripts/verify-contracts.sh --print                print the commands, verify nothing
#   bash scripts/verify-contracts.sh --deployment deployments/local/robinhood-fork.json \
#        --rpc-url http://127.0.0.1:8545 --print             (what scripts/rehearse-fork.sh runs)
#
# Constructor arguments are rebuilt from the deployment JSON, never guessed:
#   StockRoundResolver  none
#   HunchVPM            cast abi-encode "constructor(address,address,address,address)" \
#                         <safe> <safe> <HunchMarketFactory> <pauser>
#   HunchMarketFactory  cast abi-encode "constructor(address,address,address,address,address)" \
#                         <HunchVPM> <StockRoundResolver> <usdg> <deployer> <safe>
# where <deployer> is the sender of the factory's deploy transaction (the factory's first
# owner, before the Safe accepted ownership) and <pauser> is the address HunchVPM's
# constructor announced in its PauserSet event (the Safe may have named another since). Each encoding is checked against the tail of
# its creation transaction's input before anything is submitted. Compiler settings (solc
# 0.8.28, optimizer 200 runs, via-ir off, EVM cancun) come from contracts/foundry.toml, so run
# this from the commit recorded in the JSON's gitCommit. Needs bash, jq, cast, forge and git.
set -euo pipefail
cd "$(dirname "$0")/.."

DEPLOYMENT="deployments/robinhood-mainnet.json"
RPC="${RH_RPC_URL:-}"
VERIFIER="auto"
PRINT=0
BLOCKSCOUT_API="https://robinhoodchain.blockscout.com/api/"

die() { printf 'verify-contracts: %s\n' "$*" >&2; exit 1; }
say() { printf 'verify-contracts: %s\n' "$*"; }
lc() { printf '%s' "$1" | tr 'A-F' 'a-f'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --deployment) DEPLOYMENT="${2:?}"; shift ;;
    --rpc-url) RPC="${2:?}"; shift ;;
    --verifier) VERIFIER="${2:?}"; shift ;;
    --print) PRINT=1 ;;
    -h | --help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
  shift
done
case "$VERIFIER" in auto | blockscout | sourcify) ;; *) die "--verifier must be blockscout, sourcify or auto" ;; esac
for tool in jq cast forge git; do command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"; done
[ -n "$RPC" ] || die "set RH_RPC_URL or pass --rpc-url"
[ -f "$DEPLOYMENT" ] || die "no deployment JSON at $DEPLOYMENT"
jq -e '.status == "deployed" and (.contracts.HunchMarketFactory.deployTx | type) == "string"' "$DEPLOYMENT" >/dev/null ||
  die "$DEPLOYMENT is not deployed, or post-deploy.sh has not filled the deploy transactions yet"
[ "$(cast chain-id --rpc-url "$RPC")" = "4663" ] || die "the RPC is not Robinhood Chain (4663)"

J() { jq -r "$1" "$DEPLOYMENT"; }
SAFE=$(J .safe)
USDG=$(J .usdg)
VPM=$(J .contracts.HunchVPM.address)
RESOLVER=$(J .contracts.StockRoundResolver.address)
FACTORY=$(J .contracts.HunchMarketFactory.address)
DEPLOYER=$(cast tx "$(J .contracts.HunchMarketFactory.deployTx)" from --rpc-url "$RPC")
PAUSER_SET=$(cast keccak 'PauserSet(address)')
PAUSER_TOPIC=$(cast receipt "$(J .contracts.HunchVPM.deployTx)" --json --rpc-url "$RPC" |
  jq -r --arg t "$PAUSER_SET" '[.logs[] | select((.topics[0] | ascii_downcase) == ($t | ascii_downcase))][0].topics[1] // empty')
[ -n "$PAUSER_TOPIC" ] || die "HunchVPM's creation receipt has no PauserSet event: is this the D10 settler?"
PAUSER="0x${PAUSER_TOPIC: -40}"

COMMIT=$(J .gitCommit)
HEAD=$(git rev-parse HEAD)
if [ "${COMMIT%-dirty}" != "$HEAD" ]; then
  say "WARNING: the deployment was built at $COMMIT, HEAD is $HEAD: check out that commit if verification fails"
fi

args_for() {
  case "$1" in
    StockRoundResolver) printf '' ;;
    HunchVPM) cast abi-encode 'constructor(address,address,address,address)' "$SAFE" "$SAFE" "$FACTORY" "$PAUSER" ;;
    HunchMarketFactory)
      cast abi-encode 'constructor(address,address,address,address,address)' "$VPM" "$RESOLVER" "$USDG" "$DEPLOYER" "$SAFE"
      ;;
  esac
}

FAILED=""
for c in StockRoundResolver HunchVPM HunchMarketFactory; do
  addr=$(J ".contracts.$c.address")
  tx=$(J ".contracts.$c.deployTx")
  [ "$(cast code "$addr" --rpc-url "$RPC")" != "0x" ] || die "$c has no code at $addr"
  args=$(args_for "$c")
  input=$(cast tx "$tx" input --rpc-url "$RPC")
  if [ -n "$args" ]; then
    case "$(lc "$input")" in
      *"$(lc "${args#0x}")") say "$c constructor args match the tail of its creation tx $tx" ;;
      *) die "$c: the rebuilt constructor args are not the tail of creation tx $tx" ;;
    esac
    arg_flags=(--constructor-args "$args")
  else
    arg_flags=()
  fi

  base=(forge verify-contract "$addr" "src/$c.sol:$c" --root contracts --chain-id 4663 --rpc-url '$RH_RPC_URL')
  blockscout=("${base[@]}" --verifier blockscout --verifier-url "$BLOCKSCOUT_API" ${arg_flags[@]+"${arg_flags[@]}"} --watch)
  sourcify=("${base[@]}" --verifier sourcify ${arg_flags[@]+"${arg_flags[@]}"})

  if [ "$PRINT" = "1" ]; then
    printf '%s\n' "${blockscout[*]}"
    continue
  fi
  run() { # the command with the real RPC in place of the $RH_RPC_URL placeholder
    local out=() a
    for a in "$@"; do if [ "$a" = '$RH_RPC_URL' ]; then out+=("$RPC"); else out+=("$a"); fi; done
    "${out[@]}"
  }
  ok=0
  if [ "$VERIFIER" != "sourcify" ]; then
    say "$c on Blockscout..."
    if run "${blockscout[@]}"; then ok=1; else say "$c: Blockscout refused or failed"; fi
  fi
  if [ "$ok" = "0" ] && [ "$VERIFIER" != "blockscout" ]; then
    say "$c on Sourcify..."
    if run "${sourcify[@]}"; then ok=1; else say "$c: Sourcify failed too"; fi
  fi
  [ "$ok" = "1" ] || FAILED="$FAILED $c"
done

[ "$PRINT" = "1" ] && { say "printed only (--print): nothing was submitted"; exit 0; }
EXPLORER=$(J .explorer)
say "open each page in a browser and confirm the green \"verified\" badge:"
for c in StockRoundResolver HunchVPM HunchMarketFactory; do
  printf '  %-19s %s/address/%s?tab=contract\n' "$c" "$EXPLORER" "$(J ".contracts.$c.address")"
done
[ -z "$FAILED" ] || die "not verified:$FAILED"
say "all three submitted and accepted"
