#!/usr/bin/env bash
# set-rpc.sh: store the keyed Robinhood Chain RPC (QuickNode or Alchemy) without it landing in
# shell history, a commit or a chat.
#
#   bash scripts/set-rpc.sh            paste the HTTPS URL at the hidden prompt
#   pbpaste | bash scripts/set-rpc.sh  or pipe it from the clipboard
#
# Checks the URL answers chain id 4663 and serves old state (QuickNode's Robinhood endpoints are
# archive), then writes RH_RPC_URL to ./.env and ~/.config/hunch-rh/mainnet.env and sets it in
# Vercel Production as Sensitive. Prints only the host.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -t 0 ]; then
  printf 'Paste the HTTPS endpoint URL (hidden), then Enter: '
  IFS= read -rs url
  printf '\n'
else
  IFS= read -r url
fi
url=$(printf '%s' "$url" | tr -d '[:space:]')
case "$url" in https://*) ;; *) echo "not an https:// URL" >&2; exit 1 ;; esac
host=$(printf '%s' "$url" | sed -E 's#^https://([^/]+).*#\1#' | sed -E 's#^[^.]+\.#***.#')

id=$(cast chain-id --rpc-url "$url" 2>/dev/null || true)
[ "$id" = "4663" ] || { echo "the endpoint answered chain id '${id:-nothing}', expected 4663 (Robinhood Chain mainnet)" >&2; exit 1; }
head=$(cast block-number --rpc-url "$url")
if cast balance --block $((head - 2000000)) --rpc-url "$url" 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 >/dev/null 2>&1; then
  depth="serves state from 2,000,000 blocks ago (archive)"
else
  depth="WARNING: no state from 2,000,000 blocks ago; fork rehearsals need an archive endpoint"
fi

umask 077
mkdir -p "$HOME/.config/hunch-rh"
for f in .env "$HOME/.config/hunch-rh/mainnet.env"; do
  touch "$f"
  chmod 600 "$f"
  grep -vE '^RH_RPC_URL=' "$f" >"$f.tmp" || true
  printf 'RH_RPC_URL=%s\n' "$url" >>"$f.tmp"
  mv "$f.tmp" "$f"
done

if printf '%s' "$url" | vercel env add RH_RPC_URL production --sensitive --force --yes >/dev/null 2>&1; then
  vercel_note="set in Vercel Production (Sensitive)"
else
  vercel_note="NOT set in Vercel: run 'vercel env add RH_RPC_URL production --sensitive'"
fi
printf 'RH_RPC_URL https://%s/…  chain 4663, head %s, %s\n  written to .env and the backup; %s\n' "$host" "$head" "$depth" "$vercel_note"
