# Operator guide: from zero to live on Robinhood Chain

Everything the operator (the person holding the keys) does to take this repository to a live
venue at `rh.playhunch.xyz`. The build never sends a mainnet transaction and never sees a key:
every step that needs a key, money or an outside account is here, in order, with the exact
command. Budget: about 90 minutes, plus waiting for funds to bridge.

> Never paste a private key into a chat, a commit, an issue or a command line that lands in
> shell history. Keys go into an encrypted Foundry keystore, a local `.env` (gitignored), or a
> Vercel environment variable marked **Sensitive**.

## 0. What you need

| Item | Why | Cost |
|---|---|---|
| MetaMask or Rabby (browser) | Safe signers on Robinhood Chain must be injected wallets: Ledger, Trezor and WalletConnect signers are disabled in the Safe app on this chain | free |
| Foundry (`forge`, `cast`) and pnpm 10 | deploy and verify | free |
| An Alchemy (or QuickNode) key for Robinhood Chain mainnet | the public RPC keeps only ~10 minutes of history; the keeper, round finding and fork rehearsals need a keyed RPC | free tier |
| ~0.012 ETH on Robinhood Chain | deployer ~0.003, keeper ~0.009 (gas for listing markets, relaying gasless bets, delivering payouts; about $0.004 per call) | ~$30 |
| ~250 USDG on Robinhood Chain | keeper seed float (4 tickers × daily + weekly × 20 USDG = 160) plus the golden path, the refund drill and a few starter grants | ~$250, recycled |
| A Reown (WalletConnect) project id | phone wallets connect through it | free |

## 1. Create the two hot wallets

The **deployer** sends the three deploy transactions and nothing else. The **keeper** lists
markets, relays signed bets and delivers payouts; its key lives in Vercel.

```bash
cast wallet new                              # prints an address + private key: this is the deployer
cast wallet import hunch-deployer --interactive   # paste that private key; choose a password
cast wallet new                              # a second one: this is the keeper
```

Write down both **addresses**. Keep the keeper's private key for step 9 only (Vercel,
Sensitive). The deployer key now lives only in your encrypted keystore `hunch-deployer`.

## 2. Create the Safe (owner, guardian, treasury)

1. Open <https://app.safe.global>, connect MetaMask or Rabby, choose network **Robinhood Chain**
   (short name `robinhood`; add it in the wallet first if needed: chain id 4663, RPC
   `https://rpc.mainnet.chain.robinhood.com`, explorer `https://robinhoodchain.blockscout.com`).
2. Create a Safe with **2 of 3** owners (recommended; if all three keys are yours, say so in the
   README's powers section, it is still better than one key). The Safe app deploys Safe v1.5.0.
3. Copy the Safe address. It becomes the owner of the factory, the guardian of the settler
   (can pause **new entries** only) and the treasury (receives fees and rounding residue).

A 1-of-1 Safe works too, but the deploy script refuses it unless you pass `ALLOW_1OF1=1`, and
the README must then say so.

## 3. Get a keyed RPC

Alchemy dashboard → create app → chain **Robinhood Chain Mainnet** → copy the HTTPS URL
(`https://robinhood-mainnet.g.alchemy.com/v2/<KEY>`). Put it in the repo's local `.env`
(gitignored), never in a commit:

```bash
cd hunch-vpm-rh
printf 'RH_RPC_URL=%s\n' "$(pbpaste)" >> .env      # after copying the URL
```

## 4. Fund the wallets

Recommended route (seconds, one transaction each), from Arbitrum One or Base:

| To | What | How |
|---|---|---|
| deployer | 0.003 ETH | <https://relay.link/bridge/robinhood> or <https://app.across.to> (ETH → Robinhood Chain) |
| keeper | 0.009 ETH | same |
| keeper | 200 USDG | <https://app.across.to>: send **USDC** from Arbitrum One or Base to Robinhood Chain; it arrives as **USDG** |
| your own betting wallet | 20 USDG | same (for the golden path; no ETH needed to bet) |

Check balances:

```bash
set -a; . ./.env; set +a
cast balance <DEPLOYER_ADDRESS> --rpc-url $RH_RPC_URL --ether
cast call 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 "balanceOf(address)(uint256)" <KEEPER_ADDRESS> --rpc-url $RH_RPC_URL
```

## 5. Rehearse on a fork (no money moves)

```bash
pnpm install
forge build --root contracts
RH_RPC_URL=$RH_RPC_URL bash scripts/rehearse-fork.sh
```

This forks chain 4663 locally (about 75 to 100 seconds), creates a real 2-of-3 Safe, runs the
real deploy script against real USDG, real Chainlink feeds and real Stock Tokens, accepts
ownership from the Safe, lists a market, places a normal bet and a gasless signed bet from a
wallet holding no ETH, refuses replays, resolves after the bell, delivers every payout, sweeps
fees and claims the residue, and checks every balance to the unit. It must end with
`REHEARSAL PASSED`. Then run the fork test suites once with your keyed RPC:

```bash
RH_RPC_URL=$RH_RPC_URL forge test --root contracts --match-path 'test/fork/*'
```

## 6. Deploy to mainnet

```bash
set -a; . ./.env; set +a
export SAFE_ADDRESS=<your Safe>
export KEEPER_ADDRESS=<keeper address>
forge script contracts/script/DeployRH.s.sol:DeployRH \
  --root contracts --rpc-url $RH_RPC_URL \
  --account hunch-deployer --sender <DEPLOYER_ADDRESS> \
  --broadcast --slow
```

Your keystore password is prompted. Right after it finishes:

```bash
bash scripts/post-deploy.sh
```

`post-deploy.sh` reads `contracts/broadcast/DeployRH.s.sol/4663/run-latest.json`, fetches every
receipt, checks each succeeded, reads the wiring back from chain (refusing on any mismatch),
fills the deploy transactions, L2 blocks, `startBlock`, `deployedAt` and `gitCommit` into
`deployments/robinhood-mainnet.json`, and runs `pnpm wire`. Running it twice writes the same
values. If the broadcast is interrupted, rerun the same `forge script` command with `--resume`,
then `post-deploy.sh`.

The script refuses to run unless: the chain id is 4663; `SAFE_ADDRESS` has code and a
threshold of at least 2 (or `ALLOW_1OF1=1`); USDG has 6 decimals; every feed has 8 decimals
and the expected description; every Stock Token has the expected symbol; the deployer holds
at least 0.002 ETH; the keeper is neither the deployer nor the Safe; the deployment JSON still
says `not-deployed`. It prints the predicted addresses, then deploys `StockRoundResolver`, `HunchVPM` (guardian = treasury =
Safe) and `HunchMarketFactory` (owner = deployer for one block), allow-lists NVDA, TSLA, AAPL
(and COIN) with 26 h staleness bounds, sets the keeper as opener, starts the two-step ownership
transfer to the Safe, reads everything back, and writes the addresses, Safe, keeper and each
feed's current aggregator into `deployments/robinhood-mainnet.json` (post-deploy adds the rest).

## 7. Verify the contracts on Blockscout

```bash
bash scripts/verify-contracts.sh
```

It rebuilds each contract's constructor arguments from the deployment JSON, checks them against
the tail of the creation transaction, submits to Blockscout, and falls back to Sourcify for
anything Blockscout refuses (Blockscout's API sits behind a Cloudflare challenge). Options:
`--verifier blockscout|sourcify` forces one; `--print` only prints the commands. Then open each
address on <https://robinhoodchain.blockscout.com> in a browser and confirm the green
"verified" badge.

## 8. Accept factory ownership from the Safe

Safe app → New transaction → Transaction Builder → contract address = `HunchMarketFactory`
(from the deployment JSON) → method `acceptOwnership()` → create, sign with the threshold,
execute. Check:

```bash
cast call <FACTORY> "owner()(address)" --rpc-url $RH_RPC_URL     # must print the Safe
```

## 9. Configure Vercel (project `hunch-vpm-rh`, already created and linked to GitHub)

Set these in Vercel → Project → Settings → Environment Variables (Production, and Preview if
you want previews to read chain data). Secrets are **Sensitive**:

| Name | Value | Type |
|---|---|---|
| `RH_RPC_URL` | your Alchemy URL | Sensitive |
| `KEEPER_PRIVATE_KEY` | the keeper private key from step 1 (0x…) | Sensitive |
| `CRON_SECRET` | `openssl rand -hex 32` | Sensitive |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | your Reown project id | Plain |
| `NEXT_PUBLIC_SITE_URL` | `https://rh.playhunch.xyz` | Plain |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | optional keeper alerts | Sensitive |

Or from the CLI in the repo root: `vercel env add KEEPER_PRIVATE_KEY production` (it prompts
for the value; nothing lands in history).

## 10. Ship the addresses

`post-deploy.sh` already ran `pnpm wire` (README address table and the client's embedded copy).

```bash
pnpm verify                    # must end with VERIFY PASSED
git add deployments/robinhood-mainnet.json packages/client/src/deployment/embedded.ts README.md \
        contracts/broadcast/DeployRH.s.sol/4663/
git commit -m "deploy: Robinhood Chain mainnet"
git push                       # Vercel builds and deploys main to production
```

## 11. Domain and wallets

1. Vercel → Project `hunch-vpm-rh` → Settings → Domains → add `rh.playhunch.xyz` (the
   `playhunch.xyz` zone is already on Vercel, so DNS is automatic).
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

The keeper approves USDG to the factory itself and pays 20 USDG per market (10 per side); the
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
