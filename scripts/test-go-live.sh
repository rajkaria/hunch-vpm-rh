#!/usr/bin/env bash
# test-go-live.sh: run scripts/go-live.sh end to end against an anvil fork of Robinhood Chain,
# with anvil's public test keys in place of the operator's. No money moves.
#
#   bash scripts/test-go-live.sh                      fork through the public RPC
#   RH_RPC_URL=<keyed RPC> bash scripts/test-go-live.sh
#
# Proves, on the forked chain (real Safe v1.4.1 factory, real USDG, real feeds):
#   1. go-live --check sends nothing and predicts the Safe;
#   2. go-live creates the 2-of-3 Safe, deploys, completes the JSON, accepts ownership from the
#      Safe and reads everything back, with the deployer holding only 0.001 ETH;
#   3. a second go-live changes nothing (every step reports done).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
FORK_URL="${RH_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
LOCAL="$ROOT/deployments/local"
ENV_FILE="$LOCAL/go-live-test.env"
JSON=deployments/local/go-live-test.json
ANVIL_LOG="$LOCAL/go-live-test-anvil.log"
mkdir -p "$LOCAL"

say() { printf '  %s\n' "$*"; }
die() { printf '\n\033[31mTEST FAILED:\033[0m %s\n' "$*" >&2; exit 1; }
eq() { if [ "$(printf '%s' "$2" | tr 'A-F' 'a-f')" = "$(printf '%s' "$3" | tr 'A-F' 'a-f')" ]; then say "ok  $1 = $2"; else die "$1: $2 (expected $3)"; fi; }

PORT=$((19545 + RANDOM % 1000))
RPC="http://127.0.0.1:$PORT"
anvil --fork-url "$FORK_URL" --chain-id 4663 --port "$PORT" --host 127.0.0.1 --retries 10 --timeout 60000 >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!
trap 'kill "$ANVIL_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  kill -0 "$ANVIL_PID" 2>/dev/null || die "anvil exited: $(tail -5 "$ANVIL_LOG")"
  sleep 0.5
done
eq "fork chain id" "$(cast chain-id --rpc-url "$RPC")" 4663

# anvil's well-known test keys (mnemonic "test test ... junk"); never valid anywhere else
keys=(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
  0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
  0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
  0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a)
roles=(DEPLOYER KEEPER SAFE_OWNER_1 SAFE_OWNER_2 SAFE_OWNER_3)
: >"$ENV_FILE"
for i in 0 1 2 3 4; do
  printf '%s_PRIVATE_KEY=%s\n%s_ADDRESS=%s\n' "${roles[$i]}" "${keys[$i]}" "${roles[$i]}" "$(cast wallet address --private-key "${keys[$i]}")" >>"$ENV_FILE"
done
printf 'RH_RPC_URL=%s\n' "$RPC" >>"$ENV_FILE"
chmod 600 "$ENV_FILE"
DEPLOYER=$(cast wallet address --private-key "${keys[0]}")
KEEPER=$(cast wallet address --private-key "${keys[1]}")
# What the operator sends: 0.001 ETH to the deployer, 0.003 ETH to the keeper; owners hold nothing.
cast rpc --rpc-url "$RPC" anvil_setBalance "$DEPLOYER" "$(cast to-hex "$(cast to-wei 0.001)")" >/dev/null
cast rpc --rpc-url "$RPC" anvil_setBalance "$KEEPER" "$(cast to-hex "$(cast to-wei 0.003)")" >/dev/null
for i in 2 3 4; do cast rpc --rpc-url "$RPC" anvil_setBalance "$(cast wallet address --private-key "${keys[$i]}")" 0x0 >/dev/null; done
cp deployments/robinhood-mainnet.json "$JSON" # a not-deployed copy: go-live writes the fork deployment here

printf '\n\033[1m[1] go-live --check\033[0m\n'
nonce0=$(cast nonce --rpc-url "$RPC" "$DEPLOYER")
out=$(bash scripts/go-live.sh --env "$ENV_FILE" --deployment "$JSON" --check) || die "go-live --check failed: $out"
printf '%s\n' "$out" | sed 's/^/    /'
printf '%s' "$out" | grep -q "would create 0x" || die "--check did not predict the Safe"
eq "deployer nonce after --check (nothing sent)" "$(cast nonce --rpc-url "$RPC" "$DEPLOYER")" "$nonce0"
PREDICTED=$(printf '%s' "$out" | grep -o 'would create 0x[0-9a-fA-F]*' | awk '{print $3}')

printf '\n\033[1m[2] go-live\033[0m\n'
out=$(bash scripts/go-live.sh --env "$ENV_FILE" --deployment "$JSON" 2>&1) || die "go-live failed: $(printf '%s' "$out" | tail -15)"
printf '%s\n' "$out" | sed 's/^/    /'
SAFE=$(jq -r .safe "$JSON")
FACTORY=$(jq -r .contracts.HunchMarketFactory.address "$JSON")
eq "Safe = the --check prediction" "$SAFE" "$PREDICTED"
eq "JSON status" "$(jq -r .status "$JSON")" deployed
eq "factory owner" "$(cast call --rpc-url "$RPC" "$FACTORY" 'owner()(address)')" "$SAFE"
eq "Safe threshold" "$(cast call --rpc-url "$RPC" "$SAFE" 'getThreshold()(uint256)')" 2
eq "Safe nonce (one Safe transaction)" "$(cast call --rpc-url "$RPC" "$SAFE" 'nonce()(uint256)')" 1
eq "SAFE_ADDRESS remembered in the env file" "$(grep '^SAFE_ADDRESS=' "$ENV_FILE" | cut -d= -f2)" "$SAFE"
left=$(cast balance --rpc-url "$RPC" "$DEPLOYER")
say "deployer spent $(cast from-wei $((1000000000000000 - left))) of its 0.001 ETH on the fork (no L1 data fee on anvil)"

printf '\n\033[1m[3] go-live again (must change nothing)\033[0m\n'
nonce1=$(cast nonce --rpc-url "$RPC" "$DEPLOYER")
out=$(bash scripts/go-live.sh --env "$ENV_FILE" --deployment "$JSON" 2>&1) || die "second go-live failed: $(printf '%s' "$out" | tail -15)"
printf '%s' "$out" | grep -q "exists     $SAFE" || die "second run did not find the Safe"
printf '%s' "$out" | grep -q 'says "deployed"' || die "second run did not see the deployment"
printf '%s' "$out" | grep -q "the Safe owns the factory" || die "second run did not see the ownership"
eq "deployer nonce after the second run" "$(cast nonce --rpc-url "$RPC" "$DEPLOYER")" "$nonce1"

printf '\n\033[32mGO-LIVE TEST PASSED\033[0m\n'
