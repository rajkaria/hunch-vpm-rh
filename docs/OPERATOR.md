# Operator guide: from zero to live on Robinhood Chain

Everything the operator (the person holding the keys) does to take this repository to a live
venue at `rh.playhunch.xyz`. Four scripts do the work: `make-wallets.sh` (keys and Vercel
secrets), `set-rpc.sh` (the keyed RPC), `go-live.sh` (Safe, deploy, verify, ownership) and the
two fork rehearsals. What stays with you: funding the wallets, choosing the seed, and pushing.
Budget: about 30 minutes plus waiting for funds to bridge.

> Never paste a private key into a chat, a commit, an issue or a command line that lands in
> shell history. The scripts keep keys in `.env` (gitignored, mode 600), a backup at
> `~/.config/hunch-rh/mainnet.env` (mode 600) and Vercel variables marked **Sensitive**, and
> never print them.

## 0. What you need

| Item | Why | Cost |
|---|---|---|
| Foundry (`forge`, `cast`), pnpm 10, `jq`, the Vercel CLI logged in to the project | the scripts | free |
| A QuickNode (or Alchemy) endpoint for Robinhood Chain mainnet | the public RPC keeps only ~10 minutes of history; the keeper, round finding and fork rehearsals need a keyed RPC | free tier / credits |
| ~0.004 ETH on Robinhood Chain | deployer 0.001 (Safe + deploy + ownership: ~0.0003 at 0.03 gwei), keeper 0.003 (listing, relayed bets, payouts: ~0.0002 to 0.0004 a day) | ~$10 |
| 25 USDG on Robinhood Chain (at the recommended 1 USDG seed) | the keeper's seed float: 4 dailies + 4 weeklies + 1 drill market × 2 legs × 1 USDG = 18, plus slack; it recycles at every settlement | ~$25, recycled |
| 5 to 20 USDG in your own betting wallet | the golden path (no ETH needed to bet) | yours |
| A Reown (WalletConnect) project id | optional: phone wallets connect through it; without it the option is hidden | free |

## 1. Wallets and secrets

```bash
bash scripts/make-wallets.sh --vercel
```

It creates five fresh hot wallets and a `CRON_SECRET`, writes them to `.env` and the backup,
prints only the addresses, and sets `KEEPER_PRIVATE_KEY` and `CRON_SECRET` (Sensitive),
`RH_FALLBACK_RPC_URL` and `NEXT_PUBLIC_SITE_URL` in Vercel Production. Rerunning never
replaces a key that exists (a funded wallet is never orphaned).

| Wallet | Job | Needs |
|---|---|---|
| `DEPLOYER` | sends the deploy transactions, creates the Safe and submits its one transaction | 0.001 ETH |
| `KEEPER` | lists markets (pays the seeds), relays signed bets, delivers payouts; its key also lives in Vercel | 0.003 ETH + the seed float |
| `SAFE_OWNER_1..3` | owners of the 2-of-3 Safe: they only sign, the deployer pays the gas | nothing |

Copy `~/.config/hunch-rh/mainnet.env` into a password manager. All three Safe owners are keys
you hold on one machine: the README's powers section must say so. To harden later, import an
owner into MetaMask or Rabby on another device and swap the others out in the Safe app
(<https://app.safe.global>, network Robinhood Chain; hardware and WalletConnect signers are
disabled there on this chain).

## 2. The Safe (owner, guardian, treasury)

`go-live.sh` (step 6) creates it: a 2-of-3 Safe v1.4.1 (SafeProxyFactory + SafeL2, the same
contracts the fork rehearsal uses) with owners 1 to 3, at a CREATE2 address it derives and
cross-checks against the factory, so a rerun finds it. It becomes the owner of the factory, the
guardian of the settler (can pause **new entries** only) and the treasury (receives fees and
rounding residue). `bash scripts/go-live.sh --check` prints its address before anything is sent.

## 3. The keyed RPC

QuickNode dashboard → Create endpoint → **Robinhood Chain** → **Mainnet** → copy the HTTPS URL.
Then, with the URL on the clipboard:

```bash
pbpaste | bash scripts/set-rpc.sh
```

It checks the endpoint answers chain id 4663 and serves old state (archive), writes `RH_RPC_URL`
to `.env` and the backup, and sets it in Vercel Production as Sensitive. It prints only the host.

## 4. Choose the seed, then fund the wallets

The keeper lists every market with `params.seedPerLeg` USDG on each side, from
`deployments/robinhood-mainnet.json`. That number sets the keeper's float and how much one side
can absorb before anyone takes the other side: κ × seed − seed (κ = 30).

| `seedPerLeg` | `maxEntry` | Keeper float (health floor) | One-sided room per market |
|---|---|---|---|
| 1 USDG (recommended for launch) | 25 USDG | 18 USDG (fund 25) | 29 USDG, then grows 30 × every opposite bet |
| 10 USDG (the JSON today) | 100 USDG | 180 USDG (fund 200) | 290 USDG |

Bets beyond the room are refused in part and the remainder is refunded; raise the seed later by
editing the JSON (the factory accepts any seed of at least 1 USDG per listing). To switch to the
recommended launch values:

```bash
jq '.params.seedPerLeg = "1000000" | .params.maxEntry = "25000000"' deployments/robinhood-mainnet.json > /tmp/rh.json \
  && mv /tmp/rh.json deployments/robinhood-mainnet.json && pnpm wire
```

Then fund, from Arbitrum One or Base (seconds, one transaction each):

| To | What | How |
|---|---|---|
| `DEPLOYER` | 0.001 ETH | <https://relay.link/bridge/robinhood> or <https://app.across.to> (ETH → Robinhood Chain) |
| `KEEPER` | 0.003 ETH | same |
| `KEEPER` | 25 USDG (200 at a 10 USDG seed) | <https://app.across.to>: send **USDC** from Arbitrum One or Base to Robinhood Chain; it arrives as **USDG** |
| your own betting wallet | 5 to 20 USDG | same |

`bash scripts/go-live.sh --check` shows every balance against what it needs.

## 5. Rehearse on a fork (no money moves)

```bash
pnpm install
bash scripts/rehearse-fork.sh        # the whole launch and a market's life on a fork: REHEARSAL PASSED
bash scripts/test-go-live.sh         # go-live.sh itself on a fork, run twice: GO-LIVE TEST PASSED
```

`rehearse-fork.sh` forks chain 4663 locally (about 100 seconds), creates a real 2-of-3 Safe,
runs the real deploy script against real USDG, real Chainlink feeds and real Stock Tokens,
accepts ownership from the Safe, lists a market with the JSON's params, places a normal bet and
a gasless signed bet from a wallet holding no ETH, refuses replays, resolves after the bell,
delivers every payout, sweeps fees and claims the residue, and checks every balance to the unit.
`--template <json>` rehearses candidate params before you write them into the mainnet JSON.
`test-go-live.sh` runs `go-live.sh` with anvil's test keys and a deployer holding only 0.001 ETH,
then runs it again and checks nothing changes. Optionally, the fork test suites:
`RH_RPC_URL=$RH_RPC_URL forge test --root contracts --match-path 'test/fork/*'`.

## 6. Go live

```bash
bash scripts/go-live.sh --check      # read-only: balances, the Safe address, the plan
bash scripts/go-live.sh              # do it
```

In order, skipping whatever the chain shows is done (so a rerun resumes):

1. preflight: chain 4663, the deployer's ETH (stops below 0.0006), the keeper's ETH and seed float (warns);
2. the 2-of-3 Safe (step 2 above);
3. `DeployRH --broadcast --slow`, whose own preflight refuses unless the chain id is 4663, the
   Safe has code and a threshold of at least 2, USDG has 6 decimals and its pinned domain, every
   feed has 8 decimals and the expected description, every Stock Token has the expected symbol,
   the deployer holds at least 0.0005 ETH, the keeper is neither the deployer nor the Safe, and
   the JSON still says `not-deployed`. It deploys `StockRoundResolver`, `HunchVPM` (guardian =
   treasury = Safe) and `HunchMarketFactory`, allow-lists NVDA, TSLA, AAPL and COIN with 26 h
   staleness bounds, sets the keeper as opener and starts the two-step ownership transfer. Then
   `post-deploy.sh` reads the receipts, checks the wiring on chain, fills the transactions, L2
   blocks, `startBlock`, `deployedAt` and `gitCommit` into the JSON and runs `pnpm wire`;
4. `verify-contracts.sh` (step 7);
5. the Safe accepts factory ownership (step 8);
6. a read-back: factory owner = Safe, keeper is an opener, settler guardian and treasury = Safe.

If DeployRH stops mid-broadcast: `bash scripts/go-live.sh --resume`.

## 7. Verify the contracts on Blockscout

`go-live.sh` runs `bash scripts/verify-contracts.sh`: it rebuilds each constructor's arguments
from the JSON, checks them against the creation transaction, submits to Blockscout and falls
back to Sourcify for anything Blockscout refuses (its API sits behind a Cloudflare challenge). A
failure there does not stop go-live; rerun it alone (`--verifier blockscout|sourcify`). Then
open each address on <https://robinhoodchain.blockscout.com> and confirm the green badge.

## 8. Accept factory ownership from the Safe

`go-live.sh` does it: owners 1 and 2 sign `acceptOwnership()` (a Safe transaction hash, sorted
signatures) and the deployer submits `execTransaction`. By hand instead: Safe app → New
transaction → Transaction Builder → `HunchMarketFactory` → `acceptOwnership()` → sign with two
owners → execute. Check:

```bash
cast call <FACTORY> "owner()(address)" --rpc-url $RH_RPC_URL     # must print the Safe
```

## 9. Vercel (project `hunch-vpm-rh`, already created and linked to GitHub)

Steps 1 and 3 set these in Production:

| Name | Set by | Type |
|---|---|---|
| `KEEPER_PRIVATE_KEY` | `make-wallets.sh --vercel` | Sensitive |
| `CRON_SECRET` | `make-wallets.sh --vercel` | Sensitive |
| `RH_RPC_URL` | `set-rpc.sh` | Sensitive |
| `RH_FALLBACK_RPC_URL` | `make-wallets.sh --vercel` (the public RPC; the keeper's stale double-check reads it) | Plain |
| `NEXT_PUBLIC_SITE_URL` | `make-wallets.sh --vercel` (`https://rh.playhunch.xyz`) | Plain |

Still yours, all optional: `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (your Reown project id),
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (keeper alerts, Sensitive). Never put a keyed URL in
`NEXT_PUBLIC_RH_RPC_URL`: it ships to browsers. Check with `vercel env ls production`.

## 10. Ship the addresses

`go-live.sh` (through `post-deploy.sh`) already ran `pnpm wire` (README address table and the client's
embedded copy).

```bash
pnpm verify                    # must end with VERIFY PASSED
git add deployments/robinhood-mainnet.json packages/client/src/deployment/embedded.ts README.md \
        contracts/broadcast/DeployRH.s.sol/4663/
git commit -m "deploy: Robinhood Chain mainnet"
git push                       # Vercel builds and deploys main to production
```

## 11. Domain and wallets

1. Vercel → Project `hunch-vpm-rh` → Settings → Domains → add `rh.playhunch.xyz` (the
   `playhunch.xyz` zone's nameservers are at Porkbun, not Vercel: if Vercel shows "Invalid
   Configuration", add a `CNAME` record `rh` → `cname.vercel-dns.com` in Porkbun's DNS panel).
2. <https://cloud.reown.com> → your project → Domain allow-list → add `rh.playhunch.xyz`.

## 12. First markets

The Vercel cron `open` runs every 10 minutes from 12:00 to 13:59 UTC on weekdays and lists
today's daily markets (and the week's weekly markets) before the 09:30 ET bell. To list them
right away instead:

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://rh.playhunch.xyz/api/cron/open
# or locally with the keeper key in your shell env:
pnpm --filter @hunch-rh/keeper keeper run-once open
```

The keeper approves USDG to the factory itself and pays 2 × `seedPerLeg` per market (2 USDG at the
recommended seed); the
seed comes back to it when the market settles.

## 13. Golden path (do this before telling anyone)

| # | Step | Pass when |
|---|---|---|
| 1 | Open the site with a wallet set to another chain | the button reads "Switch to Robinhood Chain"; one click adds and switches |
| 2 | Bet 2 USDG UP on a live daily market **from a wallet holding no ETH** | the signature is relayed; the position shows accepted 2.00 |
| 3 | Hard refresh | same position, same numbers |
| 4 | A second wallet bets 3 USDG DOWN | the first wallet's "if UP wins" amount rises |
| 5 | After the closing bell | a resolve transaction appears (keeper, or the "Resolve it yourself" button) with both round ids |
| 6 | Within 10 minutes | the payout arrives in the winner's wallet; `/portfolio` shows it |
| 7 | Repeat step 2 from a phone through WalletConnect | works |
| 8 | Robinhood Wallet | connects and bets, or `/start` already says it cannot |

## 14. Refund drill (the stale-price proof)

On a Thursday, list the drill market that settles Saturday 06:00 UTC with a 1 hour final
staleness bound (the feeds do not update on Saturdays, so it must refund):

```bash
pnpm --filter @hunch-rh/keeper keeper plan-drill            # prints the parameters
pnpm --filter @hunch-rh/keeper keeper open-drill             # lists it with the keeper key
```

Place a few small labelled bets. On Saturday after 06:15 UTC the keeper calls `voidStale`
and delivers every refund. `/proof` shows the void and the refund transactions.

## 15. Monitoring

1. UptimeRobot or Better Stack (free) → HTTP monitor on
   `https://rh.playhunch.xyz/api/health` every 5 minutes, alert to your phone. It returns 200
   only when every check passes (markets listed, nothing overdue, keeper funded, feeds fresh,
   RPC live).
2. Optional: set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for keeper failure pages.

## 16. Before submitting

1. Record receipts in `docs/FACTS.md` (every public claim needs a transaction or a link).
2. Make the GitHub repository public when you are ready:
   `gh repo edit rajkaria/hunch-vpm-rh --visibility public --accept-visibility-change-consequences`.
3. Freeze `main`; fixes go through branches.
