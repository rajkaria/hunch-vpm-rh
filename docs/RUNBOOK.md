# Runbook

Operational actions, who can take them, and exactly how. The keeper is a convenience, never an
authority: every automated action below is one anyone can take by hand.

## Pause new entries (a bug is suspected)

Safe → `HunchVPM.setEntriesPaused(true)`. Only `enter` and `enterWithAuthorization` stop.
Claims, refunds, resolution, voids, residue and fee sweeps keep working (asserted by test T2.9).
Unpause with `setEntriesPaused(false)`.

## A feed misbehaves

Safe → `HunchMarketFactory.setFeed(feed, stockToken, ticker, maxStrikeAge, maxFinalAge, false)`.
The keeper stops listing that ticker. Markets already open settle or void on their own proofs.

## The keeper key leaks

1. Move the seed float out of the keeper wallet first (it is the only thing the key controls).
2. Safe → `HunchMarketFactory.setOpener(oldKeeper, false)`.
3. Generate a new key, `vercel env rm KEEPER_PRIVATE_KEY production`, then
   `vercel env add KEEPER_PRIVATE_KEY production`, redeploy.
4. Safe → `setOpener(newKeeper, true)`; fund the new wallet (ETH for gas, USDG seed float).

A leaked opener key can only list markets with its own money. It cannot touch a stake, a price
or a payout.

## A market will not resolve

1. `GET /api/health` shows which check fails.
2. Run `pnpm --filter @hunch-rh/keeper keeper run-once resolve` locally with `RH_RPC_URL` set.
3. `PhaseBoundary` (a feed's aggregator changed phase across a bell): the resolver refuses on
   purpose. Wait for the 72 h settler timeout, then anyone calls `HunchVPM.voidMarket(id)`;
   every position refunds.
4. `OraclePaused` (Robinhood corporate-action flag): the keeper retries every 10 minutes and
   calls `voidPaused` after 24 h.

## Payouts are not arriving

`pnpm --filter @hunch-rh/keeper keeper run-once deliver`. One call per position: a USDG-frozen
address fails alone. Anyone can also call `HunchVPM.claimFor(positionId)`; funds only go to the
owner.

## Keeper balance low

`/api/health` goes red below 0.001 ETH, or when the keeper's USDG (wallet plus the seeds in its open
markets) falls below the seed floor: (tickers × 2 + 1 drill) × 2 legs × `seedPerLeg`. Its detail line
shows both parts. Top up the keeper address
listed in `deployments/robinhood-mainnet.json` (ETH via Relay or Across; USDG via Across from
USDC on Arbitrum One or Base). Seeds recycle to the keeper as markets settle.

## Judging window

`main` frozen after submission; fixes on a branch; back up `deployments/robinhood-mainnet.json`
and keeper balances before any deploy; re-run the golden path daily; keep the keeper float
funded for twice the window.
