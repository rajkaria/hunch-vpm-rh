#!/usr/bin/env bash
# The single verification gate. CI runs the same script.
#   forge build → forge test → deployment/ABI drift checks → typecheck → vitest → next build
# A stage whose inputs do not exist yet is skipped with a notice, so the gate is green
# from the first commit and tightens as the repo grows.
set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
run()  { echo "    \$ $*"; if ! "$@"; then echo "    FAILED: $*"; FAIL=1; fi; }

if [ -f contracts/foundry.toml ]; then
  step "contracts: forge build"
  run forge build --root contracts --sizes
  step "contracts: forge test"
  run forge test --root contracts
  if [ -x scripts/diff-reference.sh ]; then
    step "contracts: HunchVPM diff against the reference lists only D1-D9 hunks"
    run bash scripts/diff-reference.sh --check
  fi
  # Slither (Trail of Bits) on src/ minus the vendored reference and mocks; every finding
  # is triaged in contracts/SECURITY.md. Fails only on High. Skipped when not installed.
  SLITHER=""
  if command -v slither >/dev/null 2>&1; then SLITHER="slither"
  elif command -v uvx >/dev/null 2>&1; then SLITHER="uvx --from slither-analyzer slither"; fi
  if [ -n "$SLITHER" ] && [ "${SKIP_SLITHER:-0}" != "1" ]; then
    step "contracts: slither --fail-high"
    run bash -c "cd contracts && $SLITHER . --config-file slither.config.json --fail-high > ../.slither.log 2>&1 || { tail -40 ../.slither.log; exit 1; }"
    # slither's compile step can clean contracts/out; rebuild for the ABI drift check below
    run forge build --root contracts
  else
    echo "==> contracts: slither not installed (or SKIP_SLITHER=1), skipping"
  fi
else
  echo "==> contracts: not scaffolded yet, skipping"
fi

if [ -d node_modules ]; then
  if [ -f scripts/gen-abis.mjs ]; then
    step "abi: packages/client ABIs match contracts/out"
    run pnpm exec node scripts/gen-abis.mjs --check
  fi
  if [ -f scripts/wire-deployment.mjs ]; then
    step "deployments: every reader agrees with deployments/robinhood-mainnet.json"
    run pnpm exec node scripts/wire-deployment.mjs --check
  fi
  step "workspace: typecheck"
  run pnpm -r --if-present typecheck
  step "workspace: test"
  run pnpm -r --if-present test
  step "workspace: build"
  run pnpm -r --if-present build
else
  echo "==> workspace: not installed yet (pnpm install), skipping"
fi

if [ "$FAIL" -ne 0 ]; then
  printf '\n\033[31mVERIFY FAILED\033[0m\n'; exit 1
fi
printf '\n\033[32mVERIFY PASSED\033[0m\n'
