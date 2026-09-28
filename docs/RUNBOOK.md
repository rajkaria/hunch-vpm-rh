# Runbook

Operational actions, who can take them, and exactly how. The keeper is a convenience, never an
authority: every automated action below is one anyone can take by hand.

## Pause new entries and new markets (a bug is suspected)

Fastest: the pauser (the deployer's keystore unless `PAUSER_ADDRESS` named another key) sends one
transaction, no quorum needed:

```bash
cast send <HunchVPM> 'setEntriesPaused(bool)' true --rpc-url $RH_RPC_URL --account hunch-deployer
```

Or the Safe → `HunchVPM.setEntriesPaused(true)`. `enter`, `enterWithAuthorization` and `create`
stop (the keeper stops listing and says so; `/api/health` shows `entries-paused`). Claims,
refunds, resolution, voids, residue and fee sweeps keep working (asserted by test T2.9). Only
the Safe resumes: `setEntriesPaused(false)`. If the pauser key is lost or leaked, the Safe calls
`HunchVPM.setPauser(<new key or 0x0>)`; a leaked pauser key can only pause.

## A feed misbehaves

Safe → `HunchMarketFactory.setFeed(feed, stockToken, ticker, maxStrikeAge, maxFinalAge, false)`,
passing the feed's **same** Stock Token, ticker and bounds (read them with `feeds(feed)`): only
`allowed` changes, so the site keeps labelling the markets already open on it. The keeper stops
listing that ticker. Markets already open settle or void on their own proofs.

## The keeper key leaks

1. Move the seed float out of the keeper wallet first (it is the only thing the key controls).
2. Safe → `HunchMarketFactory.setOpener(oldKeeper, false)`.
3. Generate a new key, `vercel env rm KEEPER_PRIVATE_KEY production`, then
   `vercel env add KEEPER_PRIVATE_KEY production`, redeploy.
4. Safe → `setOpener(newKeeper, true)`; fund the new wallet (ETH for gas, USDG seed float).

A leaked opener key can only list markets with its own money, and it owns the seed legs of the
markets it listed: move them first if you can (`HunchVPM.transferPosition(id, newKeeper)` for each
open seed leg). It cannot touch anyone else's stake, a price or a payout. After rotating, update
`.keeper` in `deployments/robinhood-mainnet.json`, run `pnpm wire` and redeploy (`/api/health`
shows `keeper-key` red until you do), and rotate `CRON_SECRET` and the RPC key too.

## The relayer key leaks (`RELAYER_PRIVATE_KEY`)

It holds only gas money and can only relay bets people signed. Generate a new key, replace it in
Vercel (`vercel env rm RELAYER_PRIVATE_KEY production`, then `vercel env add ...`), redeploy, and
fund the new address with a little ETH. Nothing on chain needs changing.

## A market will not resolve

1. `GET /api/health` shows which check fails.
2. Run `pnpm --filter @hunch-rh/keeper keeper run-once resolve` locally with `RH_RPC_URL` set.
3. `PhaseBoundary` (a feed's aggregator changed phase across a bell): the resolver refuses on
   purpose. Wait for the 72 h settler timeout, then anyone calls `HunchVPM.voidMarket(id)`;
   every position refunds.
4. `OraclePaused` (Robinhood corporate-action flag): the keeper retries (every 2 minutes during
   20:00–21:59 UTC, hourly otherwise) and calls `voidPaused` after 24 h.
5. `BADANSWER` (the Chainlink round in effect at a bell holds an out-of-range price): the keeper
   calls `voidBadAnswer` from the bell + 15 min once two independent reads agree; anyone can
   call it too. Every position refunds.

## Payouts are not arriving

`pnpm --filter @hunch-rh/keeper keeper run-once deliver`. One call per position: a USDG-frozen
address fails alone. Anyone can also call `HunchVPM.claimFor(positionId)`; funds only go to the
owner.

## Keeper balance low

`/api/health` goes red below 0.002 ETH, or when the keeper's USDG plus the seed in its open
markets falls below the float (4 tickers × 2 markets × 20 + 40 = 200 USDG). Top up the keeper address
listed in `deployments/robinhood-mainnet.json` (ETH via Relay or Across; USDG via Across from
USDC on Arbitrum One or Base). Seeds recycle to the keeper as markets settle.

## Judging window

`main` frozen after submission; fixes on a branch; back up `deployments/robinhood-mainnet.json`
and keeper balances before any deploy; re-run the golden path daily; keep the keeper float
funded for twice the window.
