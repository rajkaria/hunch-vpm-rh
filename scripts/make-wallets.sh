#!/usr/bin/env bash
# make-wallets.sh: create the launch's hot wallets and secrets without ever printing a key.
#
#   bash scripts/make-wallets.sh            create whatever does not exist yet; print the addresses
#   bash scripts/make-wallets.sh --vercel   also push the keeper's secrets to Vercel (Production)
#
# Wallets (fresh, hot, each with one job):
#   DEPLOYER       sends the deploy transactions, creates the Safe and submits Safe transactions:
#                  it pays every operator gas fee (~0.0003 ETH in all at 0.03 gwei)
#   KEEPER         lists markets, relays signed bets, delivers payouts; its key also lives in Vercel
#   SAFE_OWNER_1-3 the 2-of-3 Safe's owners; they only sign, so they never need ETH
# Secret: CRON_SECRET (Vercel sends it as the Bearer token on every cron call).
#
# Keys go to ./.env (gitignored, mode 600) and a backup at ~/.config/hunch-rh/mainnet.env
# (mode 600). A key that exists in either file is never replaced: a rerun must not orphan a
# funded wallet. Copy the backup into a password manager.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=.env
BACKUP_DIR="$HOME/.config/hunch-rh"
BACKUP="$BACKUP_DIR/mainnet.env"
PUSH_VERCEL=0
[ "${1:-}" = "--vercel" ] && PUSH_VERCEL=1

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
touch "$ENV_FILE" "$BACKUP"
chmod 600 "$ENV_FILE" "$BACKUP"
git check-ignore -q "$ENV_FILE" || { echo "refusing: $ENV_FILE is not gitignored" >&2; exit 1; }

value_in() { grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
put() { # name value: into .env and the backup, unless already there
  [ -n "$(value_in "$1" "$ENV_FILE")" ] || printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  [ -n "$(value_in "$1" "$BACKUP")" ] || printf '%s=%s\n' "$1" "$2" >>"$BACKUP"
}
existing() { # name: from .env, else from the backup
  local v
  v=$(value_in "$1" "$ENV_FILE")
  [ -n "$v" ] || v=$(value_in "$1" "$BACKUP")
  printf '%s' "$v"
}

for role in DEPLOYER KEEPER SAFE_OWNER_1 SAFE_OWNER_2 SAFE_OWNER_3; do
  key=$(existing "${role}_PRIVATE_KEY")
  if [ -z "$key" ]; then
    json=$(cast wallet new --json)
    key=$(jq -r '.[0].private_key' <<<"$json")
  fi
  addr=$(cast wallet address --private-key "$key")
  put "${role}_PRIVATE_KEY" "$key"
  put "${role}_ADDRESS" "$addr"
done
secret=$(existing CRON_SECRET)
[ -n "$secret" ] || secret=$(openssl rand -hex 32)
put CRON_SECRET "$secret"

printf '\nWallets (keys in %s and %s, never printed):\n' "$ENV_FILE" "$BACKUP"
for role in DEPLOYER KEEPER SAFE_OWNER_1 SAFE_OWNER_2 SAFE_OWNER_3; do
  printf '  %-13s %s\n' "$role" "$(existing "${role}_ADDRESS")"
done

if [ "$PUSH_VERCEL" = "1" ]; then
  printf '\nVercel (Production):\n'
  vercel_set() { # name value sensitive(1|0)
    local flag=--sensitive
    [ "$3" = "1" ] || flag=--no-sensitive
    if printf '%s' "$2" | vercel env add "$1" production "$flag" --force --yes >/dev/null 2>&1; then
      printf '  %-24s set\n' "$1"
    else
      printf '  %-24s FAILED (run: vercel env add %s production)\n' "$1" "$1"
      return 1
    fi
  }
  vercel_set KEEPER_PRIVATE_KEY "$(existing KEEPER_PRIVATE_KEY)" 1
  vercel_set CRON_SECRET "$(existing CRON_SECRET)" 1
  vercel_set RH_FALLBACK_RPC_URL https://rpc.mainnet.chain.robinhood.com 0
  vercel_set NEXT_PUBLIC_SITE_URL https://vpm.playhunch.xyz 0
fi
