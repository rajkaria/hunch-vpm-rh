#!/usr/bin/env bash
# go-live.sh: the mainnet launch in one command, from the keys scripts/make-wallets.sh created
# and the RPC scripts/set-rpc.sh stored.
#
#   bash scripts/go-live.sh            check, then do every step that is not done yet
#   bash scripts/go-live.sh --check    read-only: balances, the Safe address, what each step would do
#   bash scripts/go-live.sh --resume   DeployRH stopped mid-broadcast: resume it instead of starting over
#   bash scripts/go-live.sh --env <file> --deployment deployments/local/<x>.json
#                                      rehearse this script against an anvil fork (scripts/test-go-live.sh):
#                                      writes that JSON, never wires README or the client, verifies --print only
#
# Steps (each is skipped when the chain shows it is already done, so a rerun resumes):
#   1. preflight: chain 4663, deployer ETH, keeper ETH and its USDG seed float
#   2. a 2-of-3 Safe (SafeProxyFactory v1.4.1 + SafeL2 v1.4.1, owners SAFE_OWNER_1..3, sent by the
#      deployer); its address is CREATE2-derived, so a rerun finds it
#   3. contracts/script/DeployRH.s.sol --broadcast, then scripts/post-deploy.sh (receipts -> JSON, pnpm wire)
#   4. scripts/verify-contracts.sh (Blockscout, Sourcify fallback); a failure here is reported, not fatal
#   5. the Safe accepts factory ownership: owners 1 and 2 sign acceptOwnership(), the deployer submits
#   6. read-back from chain: factory owner = Safe, keeper is an opener, settler guardian and treasury = Safe,
#      the settler's only creator is the factory and its pauser is the deployer (or PAUSER_ADDRESS)
# It deploys and wires contracts only and never moves USDG: the keeper pays the seeds itself when
# the Vercel cron (or the operator) lists markets.
set -euo pipefail
cd "$(dirname "$0")/.."

CHECK_ONLY=0
RESUME=0
ENV_FILE=.env
MAINNET_JSON=deployments/robinhood-mainnet.json
JSON=$MAINNET_JSON
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --resume) RESUME=1 ;;
    --env) ENV_FILE="${2:?}"; shift ;;
    --deployment) JSON="${2:?}"; shift ;;
    -h | --help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'go-live: unknown argument %s (see --help)\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
MAINNET=0
[ "$JSON" = "$MAINNET_JSON" ] && MAINNET=1

BACKUP="$HOME/.config/hunch-rh/mainnet.env"
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
SAFE_FACTORY=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67  # SafeProxyFactory v1.4.1
SAFE_L2=0x29fcB43b46531BcA003ddC8FCB67FFE91900C762       # SafeL2 v1.4.1 singleton
SAFE_FALLBACK=0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99 # CompatibilityFallbackHandler v1.4.1
SAFE_SALT=4663
ZERO=0x0000000000000000000000000000000000000000
DEPLOYER_MIN_WEI=600000000000000 # 0.0006 ETH: DeployRH's 0.0005 preflight + the Safe's two transactions
KEEPER_MIN_WEI=1000000000000000  # 0.001 ETH: the keeper-eth health floor

say() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m!!\033[0m  %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mSTOPPED:\033[0m %s\n' "$*" >&2; exit 1; }
lc() { printf '%s' "$1" | tr 'A-F' 'a-f'; }
first() { awk '{print $1}'; }
usd() { printf '%d.%02d' $(($1 / 1000000)) $((($1 % 1000000) / 10000)); }

[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing: run bash scripts/make-wallets.sh first"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
[ -n "${RH_RPC_URL:-}" ] || die "RH_RPC_URL is not set in $ENV_FILE: run bash scripts/set-rpc.sh"
for v in DEPLOYER_PRIVATE_KEY DEPLOYER_ADDRESS KEEPER_ADDRESS SAFE_OWNER_1_ADDRESS SAFE_OWNER_2_ADDRESS \
  SAFE_OWNER_3_ADDRESS SAFE_OWNER_1_PRIVATE_KEY SAFE_OWNER_2_PRIVATE_KEY; do
  [ -n "${!v:-}" ] || die "$v is not set in $ENV_FILE: run bash scripts/make-wallets.sh"
done
RPC=$RH_RPC_URL
view() { cast call --rpc-url "$RPC" "$@"; }
has_code() { [ "$(cast code --rpc-url "$RPC" "$1")" != "0x" ]; }
send() { # label key to signature args...
  local label=$1 key=$2 out status hash
  shift 2
  out=$(cast send --rpc-url "$RPC" --private-key "$key" --json "$@") || die "$label failed"
  status=$(jq -r .status <<<"$out")
  hash=$(jq -r .transactionHash <<<"$out")
  [ "$status" = "0x1" ] || [ "$status" = "1" ] || die "$label reverted: $hash"
  say "ok  $label  $hash"
}
remember() { # name value: into the env file (and the key backup, for mainnet)
  local f files=("$ENV_FILE")
  [ "$MAINNET" = "1" ] && [ -f "$BACKUP" ] && files+=("$BACKUP")
  for f in "${files[@]}"; do
    grep -vE "^$1=" "$f" >"$f.tmp" || true
    printf '%s=%s\n' "$1" "$2" >>"$f.tmp"
    mv "$f.tmp" "$f"
    chmod 600 "$f"
  done
}
json_status() { if [ -f "$JSON" ]; then jq -r .status "$JSON"; else printf 'not-deployed'; fi; }

# ------------------------------------------------------------------ 1. preflight
step "1. Preflight"
[ "$(cast chain-id --rpc-url "$RPC")" = "4663" ] || die "RH_RPC_URL is not Robinhood Chain mainnet (chain id 4663)"
[ "$(lc "$KEEPER_ADDRESS")" != "$(lc "$DEPLOYER_ADDRESS")" ] || die "the keeper must not be the deployer"
SEED=$(jq -r .params.seedPerLeg "$MAINNET_JSON")
MARKETS=$(jq '[.feeds[] | select(.pendingFlatRateCheck != true) | .families | length] | add // 0' "$MAINNET_JSON")
FLOAT=$((MARKETS * 2 * SEED)) # packages/keeper/src/health.ts keeperUsdgFloor: every enabled market open
dep_eth=$(cast balance --rpc-url "$RPC" "$DEPLOYER_ADDRESS")
kep_eth=$(cast balance --rpc-url "$RPC" "$KEEPER_ADDRESS")
kep_usdg=$(view "$USDG" 'balanceOf(address)(uint256)' "$KEEPER_ADDRESS" | first)
say "gas price  $(cast from-wei "$(cast gas-price --rpc-url "$RPC")" gwei) gwei"
say "deployer   $DEPLOYER_ADDRESS  $(cast from-wei "$dep_eth") ETH"
say "keeper     $KEEPER_ADDRESS  $(cast from-wei "$kep_eth") ETH, $(usd "$kep_usdg") USDG"
say "seed       $(usd "$SEED") USDG per side, $MARKETS markets enabled: the float (health floor) is $(usd "$FLOAT")"
deployed=0
[ "$(json_status)" = "not-deployed" ] || deployed=1
if [ "$deployed" = "0" ] && [ "$dep_eth" -lt "$DEPLOYER_MIN_WEI" ]; then
  [ "$CHECK_ONLY" = "1" ] || die "the deployer holds $(cast from-wei "$dep_eth") ETH and needs 0.0006; send it 0.001 ETH"
  warn "the deployer needs 0.0006 ETH before step 2 (send 0.001)"
fi
[ "$kep_eth" -ge "$KEEPER_MIN_WEI" ] || warn "the keeper needs ETH for gas: send it 0.003 ETH (health floor 0.001)"
[ "$kep_usdg" -ge "$FLOAT" ] || warn "the keeper needs $(usd "$FLOAT") USDG for seeds (holds $(usd "$kep_usdg")); deploying does not need it"

# ------------------------------------------------------------------ 2. Safe
step "2. Safe (2 of 3)"
OWNERS="[$SAFE_OWNER_1_ADDRESS,$SAFE_OWNER_2_ADDRESS,$SAFE_OWNER_3_ADDRESS]"
SETUP=$(cast calldata 'setup(address[],uint256,address,bytes,address,address,uint256,address)' \
  "$OWNERS" 2 "$ZERO" 0x "$SAFE_FALLBACK" "$ZERO" 0 "$ZERO")
# SafeProxyFactory v1.4.1: CREATE2 with salt keccak(keccak(initializer), saltNonce) over
# proxyCreationCode ++ uint256(singleton). The sender does not enter it.
salt=$(cast keccak "$(cast concat-hex "$(cast keccak "$SETUP")" "$(cast to-uint256 "$SAFE_SALT")")")
init=$(cast concat-hex "$(view "$SAFE_FACTORY" 'proxyCreationCode()(bytes)')" "$(cast abi-encode 'f(address)' "$SAFE_L2")")
digest=$(cast keccak "$(cast concat-hex 0xff "$SAFE_FACTORY" "$salt" "$(cast keccak "$init")")")
SAFE=$(cast to-check-sum-address "0x${digest: -40}")
if has_code "$SAFE"; then
  say "exists     $SAFE"
else
  predicted=$(view --from "$DEPLOYER_ADDRESS" "$SAFE_FACTORY" 'createProxyWithNonce(address,bytes,uint256)(address)' "$SAFE_L2" "$SETUP" "$SAFE_SALT")
  [ "$(lc "$predicted")" = "$(lc "$SAFE")" ] || die "the factory would create the Safe at $predicted, not the derived $SAFE"
  if [ "$CHECK_ONLY" = "1" ]; then
    say "would create $SAFE (owners 1-3, threshold 2), sent by the deployer"
  else
    send "SafeProxyFactory.createProxyWithNonce (2 of 3)" "$DEPLOYER_PRIVATE_KEY" "$SAFE_FACTORY" \
      'createProxyWithNonce(address,bytes,uint256)' "$SAFE_L2" "$SETUP" "$SAFE_SALT"
  fi
fi
if has_code "$SAFE"; then
  [ "$(view "$SAFE" 'getThreshold()(uint256)' | first)" = "2" ] || die "Safe $SAFE: threshold is not 2"
  owners=$(view "$SAFE" 'getOwners()(address[])' | tr -d '[] ' | tr ',' '\n')
  [ "$(printf '%s\n' "$owners" | grep -c .)" = "3" ] || die "Safe $SAFE: not 3 owners"
  for o in "$SAFE_OWNER_1_ADDRESS" "$SAFE_OWNER_2_ADDRESS" "$SAFE_OWNER_3_ADDRESS"; do
    printf '%s\n' "$owners" | grep -qi "^$o$" || die "Safe $SAFE: $o is not an owner"
  done
  say "ok  2 of 3: owners 1, 2 and 3 ($SAFE)"
  [ "$CHECK_ONLY" = "1" ] || remember SAFE_ADDRESS "$SAFE"
fi

# ------------------------------------------------------------------ 3. deploy
step "3. Deploy (DeployRH, then post-deploy)"
mkdir -p deployments/local
if [ "$MAINNET" = "1" ]; then
  RUN=contracts/broadcast/DeployRH.s.sol/4663/run-latest.json
  LOG=deployments/local/deploy-mainnet.log
else
  export FOUNDRY_BROADCAST="$PWD/deployments/local/go-live-broadcast"
  RUN=$FOUNDRY_BROADCAST/DeployRH.s.sol/4663/run-latest.json
  LOG=deployments/local/deploy-go-live-test.log
fi
if [ "$deployed" = "1" ]; then
  say "done       $JSON says \"$(json_status)\""
elif [ "$CHECK_ONLY" = "1" ]; then
  say "would run  DeployRH --broadcast --slow (preflight, 3 contracts, 4 feeds, the keeper as opener, ownership to the Safe), then post-deploy"
else
  # the repo's pinned forge release (scripts/forge.sh), the one scripts/rehearse-fork.sh rehearses with
  FORGE=$(bash scripts/forge.sh --which) || die "the pinned forge is not installed (scripts/forge.sh)"
  extra=()
  [ "$RESUME" = "1" ] && extra+=(--resume)
  SAFE_ADDRESS=$SAFE KEEPER_ADDRESS=$KEEPER_ADDRESS DEPLOYMENTS_OUT="$PWD/$JSON" DEPLOYMENTS_TEMPLATE="$PWD/$MAINNET_JSON" \
    "$FORGE" script contracts/script/DeployRH.s.sol:DeployRH --root contracts --rpc-url "$RPC" \
    --private-key "$DEPLOYER_PRIVATE_KEY" --sender "$DEPLOYER_ADDRESS" --broadcast --slow ${extra[@]+"${extra[@]}"} \
    >"$LOG" 2>&1 || die "DeployRH failed (log: $LOG): $(grep -E 'DeployRH:|Error' "$LOG" | tail -3). If it stopped mid-broadcast: bash scripts/go-live.sh --resume"
  grep -E '^\s+(ok |Preflight|StockRoundResolver|HunchVPM|HunchMarketFactory)' "$LOG" | sed 's/^ */  /' | head -14
  if [ "$MAINNET" = "1" ]; then
    bash scripts/post-deploy.sh | sed 's/^/  /'
  else
    bash scripts/post-deploy.sh --deployment "$JSON" --broadcast "$RUN" --rpc-url "$RPC" --no-wire | sed 's/^/  /'
  fi
  [ "$(json_status)" != "not-deployed" ] || die "post-deploy did not complete $JSON"
  deployed=1
fi

if [ "$deployed" = "1" ]; then
  FACTORY=$(jq -r .contracts.HunchMarketFactory.address "$JSON")
  VPM=$(jq -r .contracts.HunchVPM.address "$JSON")
  [ "$(lc "$(jq -r .safe "$JSON")")" = "$(lc "$SAFE")" ] || die "$JSON names Safe $(jq -r .safe "$JSON"), not $SAFE"

  # ---------------------------------------------------------------- 4. verify
  step "4. Verify the source on Blockscout"
  if [ "$CHECK_ONLY" = "1" ]; then
    say "would run  scripts/verify-contracts.sh"
  elif [ "$MAINNET" = "0" ]; then
    bash scripts/verify-contracts.sh --deployment "$JSON" --rpc-url "$RPC" --print >/dev/null || die "verify-contracts --print failed"
    say "ok  constructor arguments match the creation transactions (--print: a fork has nothing to verify)"
  elif bash scripts/verify-contracts.sh 2>&1 | sed 's/^/  /'; then
    say "ok  submitted: open each address on https://robinhoodchain.blockscout.com and look for the green badge"
  else
    warn "verification did not finish; rerun: bash scripts/verify-contracts.sh --verifier sourcify"
  fi

  # ---------------------------------------------------------------- 5. ownership
  step "5. Factory ownership -> Safe"
  if [ "$(lc "$(view "$FACTORY" 'owner()(address)')")" = "$(lc "$SAFE")" ]; then
    say "done       the Safe owns the factory"
  elif [ "$CHECK_ONLY" = "1" ]; then
    say "would run  Safe.execTransaction(factory.acceptOwnership()), signed by owners 1 and 2"
  else
    [ "$(lc "$(view "$FACTORY" 'pendingOwner()(address)')")" = "$(lc "$SAFE")" ] || die "the factory's pending owner is not the Safe"
    data=$(cast calldata 'acceptOwnership()')
    nonce=$(view "$SAFE" 'nonce()(uint256)' | first)
    hash=$(view "$SAFE" 'getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)' \
      "$FACTORY" 0 "$data" 0 0 0 0 "$ZERO" "$ZERO" "$nonce")
    keys="$SAFE_OWNER_1_PRIVATE_KEY $SAFE_OWNER_2_PRIVATE_KEY" # Safe wants signatures sorted by owner
    [[ "$(lc "$SAFE_OWNER_1_ADDRESS")" < "$(lc "$SAFE_OWNER_2_ADDRESS")" ]] || keys="$SAFE_OWNER_2_PRIVATE_KEY $SAFE_OWNER_1_PRIVATE_KEY"
    sigs=""
    for k in $keys; do
      s=$(cast wallet sign --no-hash --private-key "$k" "$hash")
      sigs="$sigs${s#0x}"
    done
    send "Safe.execTransaction: factory.acceptOwnership()" "$DEPLOYER_PRIVATE_KEY" "$SAFE" \
      'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)' \
      "$FACTORY" 0 "$data" 0 0 0 0 "$ZERO" "$ZERO" "0x$sigs"
  fi

  # ---------------------------------------------------------------- 6. read-back
  step "6. Read-back from chain"
  bad=0
  check() { # label actual expected
    if [ "$(lc "$2")" = "$(lc "$3")" ]; then say "ok  $1"; else warn "$1: $2 (expected $3)"; bad=1; fi
  }
  check "factory owner = Safe" "$(view "$FACTORY" 'owner()(address)')" "$SAFE"
  check "factory pending owner cleared" "$(view "$FACTORY" 'pendingOwner()(address)')" "$ZERO"
  check "keeper is an opener" "$(view "$FACTORY" 'openers(address)(bool)' "$KEEPER_ADDRESS")" true
  check "settler guardian = Safe" "$(view "$VPM" 'guardian()(address)')" "$SAFE"
  check "settler treasury = Safe" "$(view "$VPM" 'treasury()(address)')" "$SAFE"
  check "settler's only creator = the factory (D10)" "$(view "$VPM" 'factory()(address)')" "$FACTORY"
  check "settler pauser = ${PAUSER_ADDRESS:-the deployer}" "$(view "$VPM" 'pauser()(address)')" "${PAUSER_ADDRESS:-$DEPLOYER_ADDRESS}"
  [ "$CHECK_ONLY" = "1" ] || [ "$bad" = "0" ] || die "the read-back disagrees with the plan (above)"
fi

step "Next"
if [ "$deployed" = "0" ]; then
  say "fund the wallets above, then: bash scripts/go-live.sh"
elif [ "$MAINNET" = "1" ]; then
  say "pnpm verify"
  say "git add deployments/robinhood-mainnet.json packages/client/src/deployment/embedded.ts README.md contracts/broadcast/DeployRH.s.sol/4663/"
  say "git commit -m 'deploy: Robinhood Chain mainnet' && git push    (Vercel deploys main)"
else
  say "rehearsal complete: $JSON"
fi
