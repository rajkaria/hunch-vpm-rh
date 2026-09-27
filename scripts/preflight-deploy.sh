#!/usr/bin/env bash
# Everything worth checking BEFORE a deploy spends gas.
#
# A failed deploy on Arc costs real USDC and leaves half a settlement layer on
# chain with no record of it, because Deploy.s.sol writes no file. Every check
# here is one that has actually bitten someone, and every one is read-only.
#
#   bash scripts/preflight-deploy.sh <keystore-account> [testnet|mainnet]
set -uo pipefail
cd "$(dirname "$0")/.."

ACCOUNT="${1:-}"
NETWORK="${2:-testnet}"

FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

if [ "$NETWORK" = "mainnet" ]; then
  RPC_VAR=ARC_MAINNET_RPC_URL; WANT_CHAIN=5042; ALIAS=arc_mainnet
else
  RPC_VAR=ARC_TESTNET_RPC_URL; WANT_CHAIN=5042002; ALIAS=arc_testnet
fi
RPC="${!RPC_VAR:-}"

step "Tooling"
command -v forge >/dev/null && ok "forge $(forge --version | head -1)" || bad "forge is not on PATH"
command -v cast  >/dev/null && ok "cast present"                        || bad "cast is not on PATH"

step "The build"
# A fresh `git worktree` or a clone without --recurse-submodules has an EMPTY
# contracts/lib/forge-std, and Deploy.s.sol imports forge-std/Script.sol. That
# failed a real deploy at compile time — harmless, but only because it failed
# before signing. Compile here, where failing costs nothing.
if [ ! -f contracts/lib/forge-std/src/Script.sol ]; then
  bad "contracts/lib/forge-std is empty. Run: git submodule update --init --recursive"
elif forge build --root contracts >/dev/null 2>&1; then
  ok "contracts compile (forge build)"
else
  bad "forge build --root contracts fails. Run it to see why; nothing deploys until it passes"
fi

step "The signer"
if [ -z "$ACCOUNT" ]; then
  bad "no keystore account given. Usage: preflight-deploy.sh <keystore-account> [testnet|mainnet]"
# Foundry 1.5 prints each account with a kind suffix — "arc-deployer (Local)" —
# so an exact-line match against the bare name refused a keystore that existed.
elif cast wallet list 2>/dev/null | sed 's/ ([^)]*)$//' | grep -qx "$ACCOUNT"; then
  ok "keystore account '$ACCOUNT' exists"
else
  bad "no keystore account called '$ACCOUNT'. Create one with: cast wallet import $ACCOUNT --interactive"
  printf '       (cast wallet list shows: %s)\n' "$(cast wallet list 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
fi

# ETH_PASSWORD is Foundry's own variable for a keystore PASSWORD FILE path (not
# the password). When it is set, cast and forge read the keystore without a
# prompt, and this check can read the deployer's address and balance.
PASSWORD_FILE="${ETH_PASSWORD:-}"
PASSWORD_FLAGS=()
if [ -n "$PASSWORD_FILE" ]; then
  if [ -r "$PASSWORD_FILE" ]; then
    ok "ETH_PASSWORD points at a readable password file — no prompt"
    PASSWORD_FLAGS=(--password-file "$PASSWORD_FILE")
  else
    bad "ETH_PASSWORD is set but $PASSWORD_FILE is not a readable file"
  fi
fi

step "The endpoint"
if [ -z "$RPC" ]; then
  bad "$RPC_VAR is not set. foundry.toml reads it for the '$ALIAS' alias"
else
  ok "$RPC_VAR is set"
  CHAIN="$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)"
  if [ -z "$CHAIN" ]; then
    bad "the endpoint did not answer eth_chainId — wrong URL, or it needs a key"
  elif [ "$CHAIN" != "$WANT_CHAIN" ]; then
    bad "that endpoint is chain $CHAIN, not Arc $NETWORK ($WANT_CHAIN). DO NOT DEPLOY"
  else
    ok "chain id $CHAIN, which is Arc $NETWORK"
    BLOCK="$(cast block-number --rpc-url "$RPC" 2>/dev/null || echo '?')"
    ok "head is block $BLOCK — record this as the subgraph startBlock floor"
  fi
fi

step "Gas, which on Arc is USDC"
if [ -n "$RPC" ] && [ -n "$ACCOUNT" ]; then
  # stdin from /dev/null: without a password file cast would otherwise sit on a
  # hidden prompt, and a preflight that hangs is one nobody finishes reading.
  ADDR="$(cast wallet address --account "$ACCOUNT" ${PASSWORD_FLAGS[@]+"${PASSWORD_FLAGS[@]}"} </dev/null 2>/dev/null || true)"
  if [ -z "$ADDR" ]; then
    warn "could not read the address without the keystore password — skipping the balance check"
    warn "set ETH_PASSWORD to a password file, or run: cast balance \$(cast wallet address --account $ACCOUNT) --rpc-url \"\$$RPC_VAR\""
  else
    ok "deployer is $ADDR"
    BAL="$(cast balance "$ADDR" --rpc-url "$RPC" 2>/dev/null || echo 0)"
    # `cast balance` is the NATIVE view of USDC, which is 18 decimals. The
    # ERC-20 view at 0x3600…0000 is 6 decimals — one balance, raw values off by
    # 10^12. Reading this native figure at 6 would report a balance a trillion
    # times too large, which is exactly the check most likely to wave through
    # an empty deployer.
    HUMAN="$(cast to-unit "$BAL" 18 2>/dev/null || echo '?')"
    # The full deploy simulated at ~7.35M gas, ~0.30 USDC. Refuse below 0.35
    # (0.35e18 native units): running out between contract four and five leaves
    # a half-deployed layer. A value longer than 18 digits is already >= 1.
    MIN_WEI=350000000000000000
    if [ "$BAL" = "0" ]; then
      bad "deployer holds NO USDC. It is the gas token here — nothing can be sent"
    elif [ "${#BAL}" -le 18 ] && [ "$BAL" -lt "$MIN_WEI" ]; then
      bad "deployer holds $HUMAN USDC; the deploy needs ~0.30. Fund it to at least 0.35 first"
    else
      ok "deployer holds $HUMAN USDC (native view, 18 decimals)"
    fi
  fi
fi

step "The oracle this run would ship"
KIND="${ORACLE_KIND:-stork}"
case "$KIND" in
  chainlink) ok "ORACLE_KIND=chainlink — ChainlinkFeedOracle, no address needed at deploy" ;;
  mock)      bad "ORACLE_KIND=mock is for local chains only. Do not ship it to Arc" ;;
  stork)     ok "ORACLE_KIND=stork" ;;
  *)         warn "ORACLE_KIND='$KIND' is unrecognised and falls through to Stork SILENTLY. Fix the typo" ;;
esac

if [ "$KIND" != "chainlink" ] && [ "$KIND" != "mock" ] && [ -n "$RPC" ]; then
  STORK="${STORK_ADDRESS:-0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62}"
  CODE="$(cast code "$STORK" --rpc-url "$RPC" 2>/dev/null || echo 0x)"
  if [ "$CODE" = "0x" ] || [ -z "$CODE" ]; then
    bad "no contract at Stork address $STORK on this chain. StorkOracle would wrap nothing"
  else
    ok "Stork contract present at $STORK (${#CODE} bytes of code)"
  fi
fi

step "Verification"
# Arcscan is Blockscout: no API key, just the verifier and its URL. Testnet's is
# published; mainnet's explorer is not yet, so mainnet verifies only once
# ARC_VERIFIER_URL is set to its Blockscout API root.
if [ "$NETWORK" = "mainnet" ]; then
  VERIFIER_URL="${ARC_VERIFIER_URL:-}"
else
  VERIFIER_URL="${ARC_VERIFIER_URL:-https://testnet.arcscan.app/api/}"
fi
if [ -n "$VERIFIER_URL" ]; then
  ok "will verify inline on Blockscout at $VERIFIER_URL (no API key needed)"
  VERIFY_FLAGS=" --verify --verifier blockscout --verifier-url $VERIFIER_URL"
else
  warn "no Blockscout verifier URL for mainnet yet — set ARC_VERIFIER_URL once the explorer is published, or verify after the fact"
  VERIFY_FLAGS=""
fi

step "The tree"
if [ -n "$(git status --porcelain)" ]; then
  warn "working tree is dirty. Deploy from a commit you can point at later"
else
  ok "clean tree at $(git rev-parse --short HEAD)"
fi
[ -f deployments/arc-${NETWORK}.json ] 2>/dev/null \
  && warn "deployments/arc-${NETWORK}.json already exists — this would be a REDEPLOY" \
  || ok "no address file yet for this network, as expected for a first deploy"

if [ "$FAIL" -ne 0 ]; then
  printf '\n\033[31mNOT READY.\033[0m Fix the ✗ lines above. Nothing was sent.\n'; exit 1
fi
PASSWORD_ARG=""
[ -n "$PASSWORD_FILE" ] && PASSWORD_ARG=" --password-file $PASSWORD_FILE"
printf '\n\033[32mREADY.\033[0m The deploy command:\n\n'
cat <<CMD
  # pipefail: without it \`| tee\` exits 0 even when forge fails, and a failed
  # deploy reads as a finished one.
  set -o pipefail
  ORACLE_KIND=${KIND} \\
  forge script contracts/script/Deploy.s.sol \\
    --root contracts --rpc-url ${ALIAS} --account ${ACCOUNT}${PASSWORD_ARG} --broadcast${VERIFY_FLAGS} \\
    | tee deploy.log

  sed -n '/^  {\$/,/^  }\$/p' deploy.log | sed 's/^  //' > deployments/arc-${NETWORK}.json

  # then carry the addresses and their deploy blocks into every reader:
  pnpm wire:${NETWORK}
CMD
