#!/usr/bin/env bash
# Rehearse the whole mainnet launch on a local anvil fork of Robinhood Chain (4663). No money
# moves: anvil forks the live chain in memory; every transaction below stays on this machine.
#
#   bash scripts/rehearse-fork.sh                 rehearse, print REHEARSAL PASSED, stop anvil
#   bash scripts/rehearse-fork.sh --keep          same, then leave anvil running for the web / keeper
#   bash scripts/rehearse-fork.sh --port 18545    choose the port (default: a free one)
#   RH_RPC_URL=<keyed RPC> bash scripts/rehearse-fork.sh   fork through your own RPC
#   bash scripts/rehearse-fork.sh --template deployments/local/candidate.json
#                                                  rehearse candidate params (seed, entry bounds, fee)
#                                                  before writing them into the mainnet JSON
#
# What it proves, in order (each step fails the run if it does not hold):
#   1. anvil forks chain 4663 at the latest block (real USDG, real Chainlink feeds, real Stock
#      Tokens, the real Safe v1.4.1 factory);
#   2. a real 2-of-3 Safe is created through SafeProxyFactory v1.4.1 + SafeL2;
#   3. wallets are funded like the operator's (small ETH; USDG from the USDG/WETH pool);
#   4. DeployRH refuses a 1-of-1 Safe (no ALLOW_1OF1); its dry run (no --broadcast) passes every
#      check and writes nothing; then it deploys for real with --broadcast against the 2-of-3
#      Safe, running every mainnet preflight check on the forked chain, and the settler's only
#      creator is the factory (D10) with the deployer as its pause-only pauser;
#   5. scripts/post-deploy.sh completes the fork deployment JSON from the receipts and reads
#      the wiring back from the chain; the JSON is checked field by field (EIP-55 included);
#   6. scripts/verify-contracts.sh --print derives the verification commands and checks the
#      constructor arguments against the creation transactions;
#   7. the Safe accepts factory ownership and allow-lists a TEST MockAggregator, each through a
#      real execTransaction signed by 2 of its 3 owners;
#   8. the keeper lists a TEST market with contracts/script/OpenUpDown.s.sol;
#   9. Alice bets UP with `enter` (she pays gas); Carol bets DOWN gasless: she signs USDG's
#      EIP-712 ReceiveWithAuthorization with `cast wallet sign --data` over USDG's real domain,
#      the keeper relays it with `enterWithAuthorization`, and Carol holds 0 ETH throughout;
#      replaying her signature fails;
#  10. resolving before the bell fails; after the bell (evm_increaseTime + evm_mine) a stranger
#      resolves from two proven rounds (preview says UP first);
#  11. the keeper delivers every position with claimFor, fees are swept to the Safe, the Safe
#      claims the residue; every balance is checked to the base unit and the settler and the
#      factory end holding nothing.
# The fork deployment JSON is written to deployments/local/robinhood-fork.json (gitignored).
# Uses bash, anvil, forge, cast and jq only. The only private keys used are anvil's public
# test keys, on anvil.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

KEEP=0
PORT=""
PARAMS_JSON=$ROOT/deployments/robinhood-mainnet.json
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --port) PORT="${2:?}"; shift ;;
    --template) PARAMS_JSON=$(cd "$(dirname "${2:?}")" && pwd)/$(basename "$2"); shift ;;
    -h | --help) sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'rehearse: unknown argument %s (see --help)\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

FORK_URL="${RH_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
LOCAL="$ROOT/deployments/local"
FORK_JSON="$LOCAL/robinhood-fork.json"
BROADCAST_DIR="$LOCAL/broadcast"
ANVIL_LOG="$LOCAL/anvil.log"
ERR="$LOCAL/last-error.log"
mkdir -p "$LOCAL"

# ------------------------------------------------------------------ constants (chain 4663)
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
POOL=0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca # USDG/WETH fee-100 pool: the USDG source
SAFE_FACTORY=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67 # SafeProxyFactory v1.4.1
SAFE_L2=0x29fcB43b46531BcA003ddC8FCB67FFE91900C762 # SafeL2 v1.4.1 singleton
SAFE_FALLBACK=0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99 # CompatibilityFallbackHandler v1.4.1
MULTICALL3=0xcA11bde05977b3631167028862bE2a173976CA11
ZERO=0x0000000000000000000000000000000000000000
USDG_DOMAIN_SEPARATOR=0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036

# The bets follow the mainnet JSON's params, so the rehearsal lists exactly what mainnet will.
# Alice bets A UP, then Carol bets C = S + A DOWN: the UP book's accumulator goes 1 -> 2 exactly
# (C / (S + A) = 1), so every payout is a whole multiple of the seed and the bets (whole USDG).
S=$(jq -r .params.seedPerLeg "$PARAMS_JSON")
MAXE=$(jq -r .params.maxEntry "$PARAMS_JSON")
KAPPA=$(jq -r .params.kappa "$PARAMS_JSON")
FEE_BPS=$(jq -r .params.feeBps "$PARAMS_JSON")
A=20000000
if [ $((MAXE - S)) -lt "$A" ]; then A=$((MAXE - S)); fi             # C = S + A stays within the max entry
if [ $(((KAPPA - 1) * S)) -lt "$A" ]; then A=$(((KAPPA - 1) * S)); fi # and A within the DOWN book's headroom
C=$((S + A))
KEEPER_FUND=25000000 # the operator's keeper float at a 1 USDG seed
if [ $((2 * S + 5000000)) -gt "$KEEPER_FUND" ]; then KEEPER_FUND=$((2 * S + 5000000)); fi
ALICE_FUND=$((A + 30000000))
CAROL_FUND=$((C + 20000000))
FEE_K=$((2 * S * FEE_BPS / 10000)) # the keeper's UP seed gains 2S
FEE_A=$((A * FEE_BPS / 10000))     # Alice gains A
usd() { printf '%d.%02d' $(($1 / 1000000)) $((($1 % 1000000) / 10000)); }

# anvil's well-known test keys (mnemonic "test test ... junk"); never valid anywhere else
K_DEPLOYER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
K_KEEPER=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
K_ALICE=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
K_CAROL=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
K_STRANGER=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
K_OWNER1=0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
K_OWNER2=0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e
K_OWNER3=0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356

# ------------------------------------------------------------------ helpers
STEP=0
T0=$(date +%s)
step() { STEP=$((STEP + 1)); printf '\n\033[1m[%2d] %s\033[0m  (+%ss)\n' "$STEP" "$*" "$(($(date +%s) - T0))"; }
say() { printf '     %s\n' "$*"; }
die() { printf '\n\033[31mREHEARSAL FAILED\033[0m at step %s: %s\n' "$STEP" "$*" >&2; exit 1; }
lc() { printf '%s' "$1" | tr 'A-F' 'a-f'; }
mask() { printf '%s' "$1" | sed -E 's#^(https?://[^/]+).*#\1/…#'; }
addr_of() { cast wallet address --private-key "$1"; }
ok_status() { [ "$1" = "0x1" ] || [ "$1" = "1" ]; }
eq() { # label actual expected (case-insensitive, so addresses compare regardless of checksum)
  [ "$(lc "$2")" = "$(lc "$3")" ] || die "$1: got $2, expected $3"
  say "ok  $1 = $3"
}
view() { cast call --rpc-url "$RPC" "$@"; }
first() { awk '{print $1}'; } # "93600 [9.36e4]" -> "93600"
usdg_of() { view "$USDG" 'balanceOf(address)(uint256)' "$1" | first; }
eth_of() { cast balance --rpc-url "$RPC" "$1"; }
rpc() { cast rpc --rpc-url "$RPC" "$@" >/dev/null; }
set_eth() { rpc anvil_setBalance "$1" "$(cast to-hex "$(cast to-wei "$2")")"; }

GAS_LOG=""
LAST_TX=""
record() { # label receipt-json
  local hash gas
  hash=$(jq -r .transactionHash <<<"$2")
  gas=$(cast to-dec "$(jq -r .gasUsed <<<"$2")")
  ok_status "$(jq -r .status <<<"$2")" || die "$1 reverted ($hash)"
  LAST_TX=$hash
  GAS_LOG="$GAS_LOG$(printf '     %-62s %9s gas  %s' "$1" "$gas" "$hash")"$'\n'
}
cast_error() { # why a `cast send --json` failed: cast 1.8 prints its errors as JSON on stdout
  { tail -3 "$ERR"; jq -r '.errors[]?.message' <<<"$1" 2>/dev/null; } | paste -sd ' ' -
}
send() { # label key to signature args...  (a transaction signed with an anvil test key)
  local label=$1 key=$2 out
  shift 2
  out=$(cast send --rpc-url "$RPC" --private-key "$key" --json "$@" 2>"$ERR") || die "$label: $(cast_error "$out")"
  record "$label" "$out"
}
send_as() { # label from to signature args...  (an impersonated account)
  local label=$1 from=$2 out
  shift 2
  out=$(cast send --rpc-url "$RPC" --unlocked --from "$from" --json "$@" 2>"$ERR") || die "$label: $(cast_error "$out")"
  record "$label" "$out"
}
reverts() { # label signature-call...  (an eth_call that must revert)
  local label=$1
  shift
  if cast call --rpc-url "$RPC" "$@" >/dev/null 2>&1; then die "$label: expected a revert, it succeeded"; fi
  say "ok  $label reverts"
}

# ------------------------------------------------------------------ preconditions
for tool in anvil cast jq git; do command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"; done
# the repo's pinned forge release (scripts/forge.sh); scripts/go-live.sh deploys with the same one
FORGE=$(bash scripts/forge.sh --which) || die "the pinned forge is not installed (scripts/forge.sh)"
printf 'Hunch on Robinhood Chain: fork rehearsal (%s)\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
say "fork source $(mask "$FORK_URL")"
step "Build the contracts"
"$FORGE" build --root contracts >"$LOCAL/build.log" 2>&1 || die "forge build failed: $(grep -m3 -A3 Error "$LOCAL/build.log")"
say "ok  forge build ($("$FORGE" --version | head -1))"

# ------------------------------------------------------------------ 1. anvil
step "Start anvil: a fork of chain 4663 at the latest block"
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
if [ -z "$PORT" ]; then
  for _ in $(seq 1 50); do
    PORT=$((18545 + RANDOM % 1000))
    port_busy "$PORT" || break
  done
fi
port_busy "$PORT" && die "port $PORT is in use"
RPC="http://127.0.0.1:$PORT"
anvil --fork-url "$FORK_URL" --chain-id 4663 --port "$PORT" --host 127.0.0.1 --retries 10 --timeout 60000 \
  >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!
LEAVE_RUNNING=0
cleanup() { if [ "$LEAVE_RUNNING" != "1" ]; then kill "$ANVIL_PID" 2>/dev/null || true; fi; }
trap cleanup EXIT
for _ in $(seq 1 120); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  kill -0 "$ANVIL_PID" 2>/dev/null || die "anvil exited: $(tail -5 "$ANVIL_LOG")"
  sleep 0.5
done
eq "chain id" "$(cast chain-id --rpc-url "$RPC")" 4663
FORK_BLOCK=$(cast block-number --rpc-url "$RPC")
FORK_TIME=$(cast block latest --field timestamp --rpc-url "$RPC")
say "anvil pid $ANVIL_PID at $RPC, fork block $FORK_BLOCK ($(jq -rn --argjson t "$FORK_TIME" '$t | todate'))"
say "the public RPC keeps ~10 min of state: every remote read below happens in the first minutes"
# cast and forge 1.8 price EIP-1559 transactions from eth_feeHistory over the last 10 blocks, and
# anvil 1.8 fetches the pre-fork blocks of that window from the remote RPC, which a non-archive
# node refuses within a minute of the fork ("historical state ... is not available"). Mine 12
# empty local blocks, each at the forked base fee (an empty block would lower it), so the window
# is local and the fees stay the chain's.
FORK_BASE_FEE=$(cast to-hex "$(cast block latest --field baseFeePerGas --rpc-url "$RPC")")
for _ in $(seq 1 12); do rpc anvil_setNextBlockBaseFeePerGas "$FORK_BASE_FEE" && rpc evm_mine; done
eq "USDG DOMAIN_SEPARATOR() (real, on the fork)" "$(view "$USDG" 'DOMAIN_SEPARATOR()(bytes32)')" "$USDG_DOMAIN_SEPARATOR"

DEPLOYER=$(addr_of "$K_DEPLOYER")
KEEPER=$(addr_of "$K_KEEPER")
ALICE=$(addr_of "$K_ALICE")
CAROL=$(addr_of "$K_CAROL")
STRANGER=$(addr_of "$K_STRANGER")
OWNER1=$(addr_of "$K_OWNER1")
OWNER2=$(addr_of "$K_OWNER2")
OWNER3=$(addr_of "$K_OWNER3")

# ------------------------------------------------------------------ 2. Safe
step "Create a 2-of-3 Safe (SafeProxyFactory v1.4.1 + SafeL2, both on chain 4663)"
SALT_BASE=$(date +%s)
SAFE=$(view --from "$STRANGER" "$SAFE_FACTORY" 'createProxyWithNonce(address,bytes,uint256)(address)' "$SAFE_L2" \
  "$(cast calldata 'setup(address[],uint256,address,bytes,address,address,uint256,address)' \
    "[$OWNER1,$OWNER2,$OWNER3]" 2 "$ZERO" 0x "$SAFE_FALLBACK" "$ZERO" 0 "$ZERO")" "$SALT_BASE")
send "SafeProxyFactory.createProxyWithNonce (2-of-3 Safe)" "$K_STRANGER" "$SAFE_FACTORY" \
  'createProxyWithNonce(address,bytes,uint256)' "$SAFE_L2" \
  "$(cast calldata 'setup(address[],uint256,address,bytes,address,address,uint256,address)' \
    "[$OWNER1,$OWNER2,$OWNER3]" 2 "$ZERO" 0x "$SAFE_FALLBACK" "$ZERO" 0 "$ZERO")" "$SALT_BASE"
eq "Safe threshold" "$(view "$SAFE" 'getThreshold()(uint256)')" 2
eq "Safe owners" "$(view "$SAFE" 'getOwners()(address[])')" "[$OWNER1, $OWNER2, $OWNER3]"
eq "Safe version" "$(view "$SAFE" 'VERSION()(string)')" '"1.4.1"'
say "Safe $SAFE"
SAFE_1OF1=$(view --from "$STRANGER" "$SAFE_FACTORY" 'createProxyWithNonce(address,bytes,uint256)(address)' "$SAFE_L2" \
  "$(cast calldata 'setup(address[],uint256,address,bytes,address,address,uint256,address)' \
    "[$OWNER1]" 1 "$ZERO" 0x "$SAFE_FALLBACK" "$ZERO" 0 "$ZERO")" "$((SALT_BASE + 1))")
send "SafeProxyFactory.createProxyWithNonce (1-of-1 Safe)" "$K_STRANGER" "$SAFE_FACTORY" \
  'createProxyWithNonce(address,bytes,uint256)' "$SAFE_L2" \
  "$(cast calldata 'setup(address[],uint256,address,bytes,address,address,uint256,address)' \
    "[$OWNER1]" 1 "$ZERO" 0x "$SAFE_FALLBACK" "$ZERO" 0 "$ZERO")" "$((SALT_BASE + 1))"
eq "1-of-1 Safe threshold (used to prove the preflight refuses it)" "$(view "$SAFE_1OF1" 'getThreshold()(uint256)')" 1

# Signs a Safe transaction with owners 1 and 2 (2 of 3) and executes it from owner 1.
SORTED_SIGNERS=""
if [[ "$(lc "$OWNER1")" < "$(lc "$OWNER2")" ]]; then SORTED_SIGNERS="$K_OWNER1 $K_OWNER2"; else SORTED_SIGNERS="$K_OWNER2 $K_OWNER1"; fi
safe_exec() { # label to calldata
  local label=$1 to=$2 data=$3 nonce hash sigs="" k s
  nonce=$(view "$SAFE" 'nonce()(uint256)' | first)
  hash=$(view "$SAFE" 'getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)' \
    "$to" 0 "$data" 0 0 0 0 "$ZERO" "$ZERO" "$nonce")
  for k in $SORTED_SIGNERS; do
    s=$(cast wallet sign --no-hash --private-key "$k" "$hash")
    sigs="$sigs${s#0x}"
  done
  send "Safe.execTransaction: $label" "$K_OWNER1" "$SAFE" \
    'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)' \
    "$to" 0 "$data" 0 0 0 0 "$ZERO" "$ZERO" "0x$sigs"
  eq "Safe nonce after $label" "$(view "$SAFE" 'nonce()(uint256)' | first)" "$((nonce + 1))"
}

# ------------------------------------------------------------------ 3. funding
step "Fund the wallets: ETH like the operator's, USDG from the USDG/WETH pool (impersonated)"
set_eth "$DEPLOYER" 0.001 # what the operator sends the deployer; the preflight needs 0.0005
set_eth "$KEEPER" 0.003 # what the operator sends the keeper
set_eth "$ALICE" 0.001    # Alice pays gas for her bet
set_eth "$CAROL" 0        # Carol never holds ETH: her bet is signed and relayed
set_eth "$OWNER1" 0.01    # the Safe owner who executes Safe transactions
set_eth "$POOL" 1         # gas for the impersonated pool
rpc anvil_impersonateAccount "$POOL"
send_as "USDG.transfer pool -> keeper ($(usd "$KEEPER_FUND") USDG)" "$POOL" "$USDG" 'transfer(address,uint256)' "$KEEPER" "$KEEPER_FUND"
send_as "USDG.transfer pool -> Alice ($(usd "$ALICE_FUND") USDG)" "$POOL" "$USDG" 'transfer(address,uint256)' "$ALICE" "$ALICE_FUND"
send_as "USDG.transfer pool -> Carol ($(usd "$CAROL_FUND") USDG)" "$POOL" "$USDG" 'transfer(address,uint256)' "$CAROL" "$CAROL_FUND"
rpc anvil_stopImpersonatingAccount "$POOL"
eq "keeper USDG" "$(usdg_of "$KEEPER")" "$KEEPER_FUND"
eq "Alice USDG" "$(usdg_of "$ALICE")" "$ALICE_FUND"
eq "Carol USDG" "$(usdg_of "$CAROL")" "$CAROL_FUND"
eq "Carol ETH" "$(eth_of "$CAROL")" 0

# ------------------------------------------------------------------ 4. DeployRH
deploy() { # extra forge flags...
  SAFE_ADDRESS="$DEPLOY_SAFE" KEEPER_ADDRESS="$KEEPER" DEPLOYMENTS_OUT="$FORK_JSON" DEPLOYMENTS_TEMPLATE="$PARAMS_JSON" \
    FOUNDRY_BROADCAST="$BROADCAST_DIR" \
    "$FORGE" script contracts/script/DeployRH.s.sol:DeployRH --root contracts --rpc-url "$RPC" \
    --private-key "$K_DEPLOYER" --sender "$DEPLOYER" "$@"
}
step "DeployRH preflight refuses a 1-of-1 Safe without ALLOW_1OF1 (simulation only)"
DEPLOY_SAFE=$SAFE_1OF1
if out=$(deploy 2>&1); then die "DeployRH accepted a 1-of-1 Safe"; fi
printf '%s' "$out" | grep -q "use a threshold of at least 2" || die "unexpected DeployRH failure: $(printf '%s' "$out" | tail -5)"
say "ok  refused: $(printf '%s' "$out" | grep -o 'DeployRH: the Safe is 1-of-1[^"]*' | head -1)"

step "DeployRH dry run (no --broadcast): every check passes, nothing is sent or written"
DEPLOY_SAFE=$SAFE
before=$( { shasum "$FORK_JSON" 2>/dev/null || echo absent; } | awk '{print $1}')
nonce_before=$(cast nonce "$DEPLOYER" --rpc-url "$RPC")
out=$(deploy 2>&1) || die "DeployRH dry run failed: $(printf '%s' "$out" | tail -8)"
printf '%s' "$out" | grep -q "DRY RUN: every check passed" || die "the dry run did not say DRY RUN"
eq "fork JSON after the dry run (unchanged)" "$( { shasum "$FORK_JSON" 2>/dev/null || echo absent; } | awk '{print $1}')" "$before"
eq "deployer nonce after the dry run (nothing sent)" "$(cast nonce "$DEPLOYER" --rpc-url "$RPC")" "$nonce_before"

step "DeployRH --broadcast (the mainnet command, with anvil's key 0 as the deployer)"
deploy --broadcast --slow >"$LOCAL/deploy.log" 2>&1 || die "DeployRH failed: $(tail -20 "$LOCAL/deploy.log")"
grep -E '^\s+(ok |Preflight|StockRoundResolver|HunchVPM|HunchMarketFactory)' "$LOCAL/deploy.log" | sed 's/^ */     /' | head -12
RUN="$BROADCAST_DIR/DeployRH.s.sol/4663/run-latest.json"
[ -f "$RUN" ] || die "no broadcast at $RUN"
for i in $(seq 0 $(($(jq '.receipts | length' "$RUN") - 1))); do
  rc=$(jq -c ".receipts[$i]" "$RUN")
  what=$(jq -r ".transactions[$i] | if .transactionType == \"CREATE\" then \"deploy \" + .contractName else \"factory.\" + (.function | split(\"(\")[0]) end" "$RUN")
  record "DeployRH: $what" "$rc"
done

# ------------------------------------------------------------------ 5. post-deploy + JSON checks
step "scripts/post-deploy.sh: tx hashes, L2 blocks, time and commit, from the chain"
bash scripts/post-deploy.sh --deployment "$FORK_JSON" --broadcast "$RUN" --rpc-url "$RPC" --no-wire |
  sed 's/^/     /' || die "post-deploy failed"
J() { jq -r "$1" "$FORK_JSON"; }
VPM=$(J .contracts.HunchVPM.address)
RESOLVER=$(J .contracts.StockRoundResolver.address)
FACTORY=$(J .contracts.HunchMarketFactory.address)
eq "JSON status" "$(J .status)" deployed
eq "HunchVPM.factory() (D10: the only creator)" "$(view "$VPM" 'factory()(address)')" "$FACTORY"
eq "HunchVPM.pauser() (D10: the deployer by default)" "$(view "$VPM" 'pauser()(address)')" "$DEPLOYER"
reverts "HunchVPM.create from anyone but the factory (D10)" --from "$KEEPER" "$VPM" \
  'create(address,uint256[],uint256,uint64,uint64,address,address,uint16,uint128,uint128)' \
  "$USDG" '[10000000,10000000]' 30 "$(( $(cast block latest --field timestamp --rpc-url "$RPC") + 86400 ))" 259200 "$KEEPER" "$KEEPER" 0 0 0
reverts "HunchVPM.setEntriesPaused(false) from the pauser (D10: it can never resume)" --from "$DEPLOYER" "$VPM" 'setEntriesPaused(bool)' false
eq "JSON safe" "$(J .safe)" "$SAFE"
eq "JSON keeper" "$(J .keeper)" "$KEEPER"
eq "JSON gitCommit" "$(J .gitCommit | cut -c1-40)" "$(git rev-parse HEAD)"
for c in StockRoundResolver HunchVPM HunchMarketFactory; do
  a=$(J ".contracts.$c.address")
  [ "$a" = "$(cast to-check-sum-address "$a")" ] || die "JSON $c address is not EIP-55: $a"
  [ "$(J ".contracts.$c.deployTx")" != null ] && [ "$(J ".contracts.$c.block")" != null ] || die "JSON $c misses deployTx or block"
done
jq -e '(.startBlock | type) == "number" and (.deployedAt | type) == "string"' "$FORK_JSON" >/dev/null || die "startBlock / deployedAt"
jq -e --slurpfile m "$PARAMS_JSON" \
  '(.feeds | map(del(.aggregator))) == ($m[0].feeds | map(del(.aggregator))) and .params == $m[0].params' \
  "$FORK_JSON" >/dev/null || die "the fork JSON's feeds or params differ from $PARAMS_JSON"
for f in $(J '.feeds[] | .feed, .aggregator, .stockToken'); do
  [ "$f" = "$(cast to-check-sum-address "$f")" ] || die "JSON feed address is not EIP-55: $f"
done
say "ok  every field of the fork JSON is set, checksummed, and its feeds/params equal $(basename "$PARAMS_JSON")'s"
eq "startBlock = the resolver's deploy block" "$(J .startBlock)" "$(J .contracts.StockRoundResolver.block)"

step "scripts/verify-contracts.sh --print: the exact verification commands, args checked on chain"
bash scripts/verify-contracts.sh --deployment "$FORK_JSON" --rpc-url "$RPC" --print | sed 's/^/     /' ||
  die "verify-contracts --print failed"

# ------------------------------------------------------------------ 7. the Safe takes over
step "The Safe accepts factory ownership (execTransaction, 2 of 3 signatures)"
eq "factory owner before" "$(view "$FACTORY" 'owner()(address)')" "$DEPLOYER"
eq "factory pendingOwner before" "$(view "$FACTORY" 'pendingOwner()(address)')" "$SAFE"
safe_exec "factory.acceptOwnership()" "$FACTORY" "$(cast calldata 'acceptOwnership()')"
eq "factory owner" "$(view "$FACTORY" 'owner()(address)')" "$SAFE"
eq "factory pendingOwner" "$(view "$FACTORY" 'pendingOwner()(address)')" "$ZERO"
reverts "setFeed from the old owner (the deployer)" --from "$DEPLOYER" "$FACTORY" \
  'setFeed(address,address,string,uint32,uint32,bool)' "$ZERO" "$ZERO" X 1 1 false

step "Deploy a TEST MockAggregator + MockStockToken; the Safe allow-lists them"
create() { # contract-path (relative to contracts/) constructor-args...
  local out a
  out=$("$FORGE" create --root contracts "$1" --rpc-url "$RPC" --private-key "$K_STRANGER" --broadcast --json \
    --constructor-args "${@:2}" 2>"$ERR") || die "forge create $1: $(tail -3 "$ERR")"
  a=$(printf '%s\n' "$out" | sed -n '/^{/,$p' | jq -r .deployedTo 2>/dev/null) || true
  [ -n "$a" ] && [ "$a" != null ] || die "forge create $1: no address in its output"
  printf '%s' "$a"
}
TEST_FEED=$(create src/mocks/MockAggregator.sol:MockAggregator "TEST / USD")
TEST_TOKEN=$(create src/mocks/MockStockToken.sol:MockStockToken "TEST")
say "TEST feed $TEST_FEED, TEST Stock Token $TEST_TOKEN"
safe_exec "factory.setFeed(TEST)" "$FACTORY" \
  "$(cast calldata 'setFeed(address,address,string,uint32,uint32,bool)' "$TEST_FEED" "$TEST_TOKEN" TEST 93600 93600 true)"
eq "factory.feeds(TEST)" "$(view "$FACTORY" 'feeds(address)(address,uint32,uint32,bool,string)' "$TEST_FEED" --json | jq -r 'map(tostring) | join(" ")')" \
  "$TEST_TOKEN 93600 93600 true TEST"
tmp=$(mktemp)
jq --arg f "$TEST_FEED" --arg t "$TEST_TOKEN" \
  '.feeds += [{ticker: "TEST", feed: $f, aggregator: $f, stockToken: $t, maxStrikeAge: 93600, maxFinalAge: 93600, families: [], description: "TEST / USD (MockAggregator, fork only)"}]' \
  "$FORK_JSON" >"$tmp" && mv "$tmp" "$FORK_JSON"
say "added the TEST feed to the fork JSON (families [] so the keeper never auto-lists it)"

# ------------------------------------------------------------------ 8. a market
step "The keeper lists a TEST market with contracts/script/OpenUpDown.s.sol"
NOW=$(cast block latest --field timestamp --rpc-url "$RPC")
STRIKE=$((NOW + 60))
FINAL=$((NOW + 3600))
send "TEST feed: strike-time round (100.00)" "$K_STRANGER" "$TEST_FEED" 'addRound(int256,uint256)' 10000000000 "$NOW"
R1=$(view "$TEST_FEED" 'latestRound()(uint256)' | first)
FEED="$TEST_FEED" STRIKE_TIME="$STRIKE" FINAL_TIME="$FINAL" DEPLOYMENT_JSON="$FORK_JSON" \
  FOUNDRY_BROADCAST="$BROADCAST_DIR" \
  "$FORGE" script contracts/script/OpenUpDown.s.sol:OpenUpDown --root contracts --rpc-url "$RPC" \
  --private-key "$K_KEEPER" --sender "$KEEPER" --broadcast --slow >"$LOCAL/open.log" 2>&1 ||
  die "OpenUpDown failed: $(tail -20 "$LOCAL/open.log")"
grep -E 'Listed|spec id' "$LOCAL/open.log" | sed 's/^ */     /'
OPEN_RUN="$BROADCAST_DIR/OpenUpDown.s.sol/4663/run-latest.json"
for i in $(seq 0 $(($(jq '.receipts | length' "$OPEN_RUN") - 1))); do
  record "OpenUpDown: $(jq -r ".transactions[$i].function | split(\"(\")[0]" "$OPEN_RUN")" "$(jq -c ".receipts[$i]" "$OPEN_RUN")"
done
eq "listings" "$(view "$FACTORY" 'listingCount()(uint256)')" 1
LISTING=$(view "$FACTORY" 'listings(uint256)(uint256,bytes32,address,uint64,uint64,uint32,uint32,uint128,uint128,uint128,address,uint64)' 0 --json)
MID=$(jq -r '.[0] | tostring' <<<"$LISTING")
SPEC=$(jq -r '.[1]' <<<"$LISTING")
eq "listing feed" "$(jq -r '.[2]' <<<"$LISTING")" "$TEST_FEED"
eq "listing final time" "$(jq -r '.[4] | tostring' <<<"$LISTING")" "$FINAL"
eq "resolver.specIdOf(settler, market)" "$(view "$RESOLVER" 'specIdOf(address,uint256)(bytes32)' "$VPM" "$MID")" "$SPEC"
eq "keeper USDG after the $(usd "$S") + $(usd "$S") seed" "$(usdg_of "$KEEPER")" "$((KEEPER_FUND - 2 * S))"
eq "factory USDG (keeps nothing)" "$(usdg_of "$FACTORY")" 0
eq "factory allowance to the settler (zeroed)" "$(view "$USDG" 'allowance(address,address)(uint256)' "$FACTORY" "$VPM" | first)" 0

# ------------------------------------------------------------------ 9. bets
step "Alice bets $(usd "$A") UP with enter (she pays gas)"
send "USDG.approve(settler, $(usd "$A")) by Alice" "$K_ALICE" "$USDG" 'approve(address,uint256)' "$VPM" "$A"
send "HunchVPM.enter UP $(usd "$A") USDG (Alice)" "$K_ALICE" "$VPM" 'enter(uint256,uint8,uint256)' "$MID" 0 "$A"

step "Carol bets $(usd "$C") DOWN gasless: EIP-712 signature over USDG's real domain, relayed by the keeper"
SALT=$(cast keccak "carol-rehearsal-$NOW")
NONCE=$(view "$VPM" 'enterNonce(uint256,uint8,uint256,bytes32)(bytes32)' "$MID" 1 "$C" "$SALT")
VALID_BEFORE=$((NOW + 1800))
TYPED="$LOCAL/carol-authorization.json"
jq -n --arg value "$C" --arg usdg "$USDG" --arg from "$CAROL" --arg to "$VPM" --arg vb "$VALID_BEFORE" --arg nonce "$NONCE" '{
  types: {
    EIP712Domain: [{name: "name", type: "string"}, {name: "version", type: "string"},
                   {name: "chainId", type: "uint256"}, {name: "verifyingContract", type: "address"}],
    ReceiveWithAuthorization: [{name: "from", type: "address"}, {name: "to", type: "address"},
      {name: "value", type: "uint256"}, {name: "validAfter", type: "uint256"},
      {name: "validBefore", type: "uint256"}, {name: "nonce", type: "bytes32"}]
  },
  primaryType: "ReceiveWithAuthorization",
  domain: {name: "Global Dollar", version: "1", chainId: 4663, verifyingContract: $usdg},
  message: {from: $from, to: $to, value: $value, validAfter: "0", validBefore: $vb, nonce: $nonce}
}' >"$TYPED"
SIG=$(cast wallet sign --data --from-file "$TYPED" --private-key "$K_CAROL")
say "Carol signed ReceiveWithAuthorization(to = HunchVPM, $(usd "$C") USDG, nonce = enterNonce(market, DOWN, $(usd "$C"), salt))"
send "HunchVPM.enterWithAuthorization DOWN $(usd "$C") USDG (Carol, relayed)" "$K_KEEPER" "$VPM" \
  'enterWithAuthorization(address,uint256,uint8,uint256,uint256,uint256,bytes32,bytes)' \
  "$CAROL" "$MID" 1 "$C" 0 "$VALID_BEFORE" "$SALT" "$SIG"
eq "USDG authorizationState(Carol, nonce)" "$(view "$USDG" 'authorizationState(address,bytes32)(bool)' "$CAROL" "$NONCE")" true
eq "Carol ETH (never paid gas)" "$(eth_of "$CAROL")" 0
# Real USDG does NOT revert a used (or cancelled) authorization: it emits AuthorizationAlreadyUsed
# and returns without paying and without checking the signature. HunchVPM must refuse these itself,
# or anyone could book unpaid entries against other bettors' escrow.
reverts "replaying Carol's signed entry (HunchVPM must refuse a used authorization)" --from "$KEEPER" "$VPM" \
  'enterWithAuthorization(address,uint256,uint8,uint256,uint256,uint256,bytes32,bytes)' \
  "$CAROL" "$MID" 1 "$C" 0 "$VALID_BEFORE" "$SALT" "$SIG"
reverts "an entry on Carol's used nonce with a junk signature" --from "$STRANGER" "$VPM" \
  'enterWithAuthorization(address,uint256,uint8,uint256,uint256,uint256,bytes32,bytes)' \
  "$CAROL" "$MID" 1 "$C" 0 "$VALID_BEFORE" "$SALT" "0x$(printf '%0130d' 0)"
reverts "Carol's signature for another amount" --from "$KEEPER" "$VPM" \
  'enterWithAuthorization(address,uint256,uint8,uint256,uint256,uint256,bytes32,bytes)' \
  "$CAROL" "$MID" 1 "$((C - 1000000))" 0 "$VALID_BEFORE" "$SALT" "$SIG"
eq "settler escrow (seed $(usd $((2 * S))) + Alice $(usd "$A") + Carol $(usd "$C"))" "$(usdg_of "$VPM")" "$((2 * S + A + C))"

# ------------------------------------------------------------------ 10. the bell
step "The price moves to 101.00 before the bell; nobody can resolve early; after the bell anyone can"
rpc evm_setNextBlockTimestamp "$((FINAL - 300))"
send "TEST feed: last round before the bell (101.00)" "$K_STRANGER" "$TEST_FEED" 'addRound(int256,uint256)' 10100000000 "$((FINAL - 300))"
R2=$(view "$TEST_FEED" 'latestRound()(uint256)' | first)
reverts "resolve before the bell" --from "$STRANGER" "$RESOLVER" 'resolve(bytes32,uint80,uint80)' "$SPEC" "$R1" "$R2"
LATEST=$(cast block latest --field timestamp --rpc-url "$RPC")
rpc evm_increaseTime "$((FINAL + 30 - LATEST))"
rpc evm_mine
say "warped past the bell: now $(cast block latest --field timestamp --rpc-url "$RPC"), final time $FINAL"
PREVIEW=$(view "$RESOLVER" 'preview(bytes32,uint80,uint80)(uint8,int256,uint256,int256,uint256)' "$SPEC" "$R1" "$R2" --json)
eq "resolver.preview status (1 = UP)" "$(jq -r '.[0] | tostring' <<<"$PREVIEW")" 1
reverts "resolve with an off-by-one strike round" --from "$STRANGER" "$RESOLVER" 'resolve(bytes32,uint80,uint80)' "$SPEC" "$R2" "$R2"
send "StockRoundResolver.resolve (a stranger, rounds proven on chain)" "$K_STRANGER" "$RESOLVER" \
  'resolve(bytes32,uint80,uint80)' "$SPEC" "$R1" "$R2"
MARKET=$(view "$VPM" 'getMarket(uint256)(address,address,address,address,uint64,uint64,uint8,uint8,uint8,uint256,uint256,uint256)' "$MID" --json)
eq "market status (1 = resolved)" "$(jq -r '.[7] | tostring' <<<"$MARKET")" 1
eq "market winner (0 = UP)" "$(jq -r '.[8] | tostring' <<<"$MARKET")" 0
eq "accepted pool" "$(jq -r '.[10] | tostring' <<<"$MARKET")" "$((2 * S + A + C))"

# ------------------------------------------------------------------ 11. delivery
step "The keeper delivers every position (claimFor), fees go to the Safe, the Safe takes the residue"
IDS=$(view "$VPM" 'marketPositions(uint256,uint256,uint256)(uint256[])' "$MID" 0 50 --json | jq -r '.[0][] | tostring')
for id in $IDS; do
  owner=$(view "$VPM" 'positions(uint256)(uint64,address,uint8,bool,bool,bool,uint64,uint128,uint128,uint128)' "$id" --json | jq -r '.[1]')
  send "HunchVPM.claimFor position $id (owner $(printf '%s' "$owner" | cut -c1-8)...)" "$K_KEEPER" "$VPM" 'claimFor(uint256)' "$id"
done
send "HunchVPM.sweepFees(USDG) (anyone)" "$K_STRANGER" "$VPM" 'sweepFees(address)' "$USDG"
safe_exec "HunchVPM.claimResidue(market)" "$VPM" "$(cast calldata 'claimResidue(uint256)' "$MID")"

# UP won. Books: UP seed S + Alice A (entry acc 1.0), DOWN seed S + Carol C = S + A.
#   A_UP = S/S (seed vintage) + C/(S + A) (Carol) = 2.0 ; payout = s * (1 + A_UP - entryAcc)
#   keeper UP seed: S * 3.0 = 3S, fee on the 2S gain (DOWN seed: 0)
#   Alice:          A * 2.0 = 2A, fee on the A gain
#   Carol: 0. Pool 2S + A + C = 3S + 2A, residue 0, both fees to the Safe.
#   (Seed 10, A 20, C 30, fee 2%: keeper +29.60, Alice +39.60, Safe 0.80.)
eq "keeper USDG: $(usd "$KEEPER_FUND") - $(usd $((2 * S))) seed + $(usd $((3 * S - FEE_K)))" "$(usdg_of "$KEEPER")" "$((KEEPER_FUND - 2 * S + 3 * S - FEE_K))"
eq "Alice USDG:  $(usd "$ALICE_FUND") - $(usd "$A") + $(usd $((2 * A - FEE_A)))" "$(usdg_of "$ALICE")" "$((ALICE_FUND - A + 2 * A - FEE_A))"
eq "Carol USDG:  $(usd "$CAROL_FUND") - $(usd "$C")" "$(usdg_of "$CAROL")" "$((CAROL_FUND - C))"
eq "Safe USDG:   fees $(usd $((FEE_K + FEE_A))) + residue 0" "$(usdg_of "$SAFE")" "$((FEE_K + FEE_A))"
eq "settler USDG (everything delivered)" "$(usdg_of "$VPM")" 0
eq "factory USDG" "$(usdg_of "$FACTORY")" 0
eq "Carol ETH (still never paid gas)" "$(eth_of "$CAROL")" 0
eq "settler feesAccrued(USDG)" "$(view "$VPM" 'feesAccrued(address)(uint256)' "$USDG" | first)" 0

# ------------------------------------------------------------------ summary
step "Receipts (gas used per transaction on the fork)"
printf '%s' "$GAS_LOG"
say "fork deployment JSON: deployments/local/robinhood-fork.json"
say "elapsed: $(($(date +%s) - T0)) s"

if [ "$KEEP" = "1" ]; then
  # Warm the slots the web and the keeper read most (public-RPC forks cannot fetch new state
  # once the fork block is ~10 minutes old).
  view "$MULTICALL3" 'getBlockNumber()(uint256)' >/dev/null
  for f in $(J '.feeds[] | .feed'); do view "$f" 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' >/dev/null; done
  LEAVE_RUNNING=1
  disown "$ANVIL_PID" 2>/dev/null || true
  printf '\nanvil keeps running (pid %s) at %s, chain id 4663.\n' "$ANVIL_PID" "$RPC"
  printf 'Point the web and the keeper at it:\n'
  printf '  export RH_RPC_URL=%s NEXT_PUBLIC_RH_RPC_URL=%s\n' "$RPC" "$RPC"
  printf '  export HUNCH_DEPLOYMENT_JSON="$(cat deployments/local/robinhood-fork.json)"\n'
  printf '  export NEXT_PUBLIC_HUNCH_DEPLOYMENT_JSON="$HUNCH_DEPLOYMENT_JSON"\n'
  printf '  export KEEPER_PRIVATE_KEY=%s   # anvil test key 1 = the fork keeper\n' "$K_KEEPER"
  printf 'Market %s (TEST) is resolved and delivered; list more with OpenUpDown.s.sol or the keeper.\n' "$MID"
  printf 'With the public RPC, anvil can fetch state it has not seen only while the fork block is\n'
  printf 'younger than ~10 minutes; use a keyed RPC (RH_RPC_URL) for a longer session.\n'
  printf 'Stop it with: kill %s\n' "$ANVIL_PID"
fi
printf '\n\033[32mREHEARSAL PASSED\033[0m\n'
