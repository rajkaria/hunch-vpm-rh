#!/usr/bin/env bash
# Repo-wide verification gate. Every stage is skipped cleanly until it exists,
# so this stays green from the first commit and tightens as the repo grows.
set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
run()  { echo "    \$ $*"; if ! "$@"; then echo "    FAILED: $*"; FAIL=1; fi; }

if [ -f contracts/foundry.toml ]; then
  step "contracts — forge build"
  run forge build --root contracts
  step "contracts — forge test"
  run forge test --root contracts -vv
else
  echo "==> contracts — not scaffolded yet, skipping"
fi

if command -v node >/dev/null && [ -f scripts/wire-deployment.mjs ]; then
  # Four committed files hold the deployed addresses and none imports another.
  # This fails the gate the moment one of them drifts from deployments/.
  step "addresses — every reader agrees with deployments/"
  run node scripts/wire-deployment.mjs --check
fi

if [ -f pnpm-workspace.yaml ] && [ -d node_modules ]; then
  step "workspace — typecheck"
  run pnpm -r --if-present typecheck
  step "workspace — test"
  run pnpm -r --if-present test
  step "workspace — build"
  run pnpm -r --if-present build
else
  echo "==> workspace — not installed yet, skipping"
fi

if [ "$FAIL" -ne 0 ]; then
  printf '\n\033[31mVERIFY FAILED\033[0m\n'; exit 1
fi
printf '\n\033[32mVERIFY PASSED\033[0m\n'
