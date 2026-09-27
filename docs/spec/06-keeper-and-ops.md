# 06 · Keeper and operations

The keeper is a convenience, not an authority. Every action it takes, anyone can take
(resolve with proven rounds, void on proven staleness, deliver claims). If it stops,
markets still settle, just later; after 72 h anyone can void and refund.

## Where it runs

`packages/keeper` (pure decision functions + a thin runner), invoked by Next.js route
handlers `apps/web/src/app/api/cron/[job]/route.ts`, scheduled by Vercel Cron in
`vercel.json`. Every route checks `Authorization: Bearer ${CRON_SECRET}`. Every job is
**idempotent**: it reads the chain, decides, acts, and can run twice without harm.

| Job | Schedule (UTC, Vercel Cron) | What it does |
|---|---|---|
| `open` | `*/10 12-13 * * 1-5` | Ensures today's **daily** markets exist for every allow-listed ticker (and Monday's / launch day's **weekly** markets), created before 09:30 ET. Uses the NYSE calendar (`keeper/calendar/nyse-2026.json`: holidays + early closes) and the corporate-action list; skips a ticker with an action in the window. |
| `resolve` | `*/2 20-21 * * 1-5` and `7 * * * *` | For every market past its final time and not settled: find strike/final rounds, `preview`, then `resolve` (FLAT voids inside it), or `voidStale` / `voidPaused` per the policy below. |
| `deliver` | `*/5 * * * *` | For every settled market: `claimFor` each unclaimed position with a non-zero payout or refund, one call per position so a Paxos-frozen address fails alone; `withdrawRefundFor` any refused remainder in open markets once its vintage is final; `sweepFees(usdg)` when accrued > 5 USDG. |
| `relay` | on request (`POST /api/relay/enter`) | Takes a bettor's signed USDG authorization + market/side/amount/salt, checks it off-chain (domain, nonce = `enterNonce`, validity window, 1–100 USDG, market open, geo), simulates, sends `enterWithAuthorization` from the keeper key, returns the tx hash. Rate limit 10/min per IP and per `from`. The bettor can always submit the same call themselves. |
| `health` | on request (`/api/health`) | See below. |

Market-hours arithmetic is done in `America/New_York` with an IANA tz library
(`@date-fns/tz`), never with a fixed offset: EDT (UTC−4) until 2026-11-01, EST after.
For this build's window: open 13:30 UTC, close 20:00 UTC (19:00 / 01:30 IST).

## Void policy (automatic, because it is proof-based)

Unlike hunch-vpm's Arc keeper (whose `allowVoid` defaulted off because its resolver
voided on "latest reading too old"), this resolver only voids when the **proven rounds
in effect at the bells** violate a bound. That cannot be caused by a keeper
retrying through an RPC outage, so the keeper may void automatically, but only:
- after `finalTime + 15 min`, and
- when `preview` returns STALE twice in a row, 2 minutes apart.
`OraclePaused` is retried every 10 min and voided with `voidPaused` only after 24 h.
A `PhaseBoundary` revert is never auto-voided; it pages the operator, and the 72 h
timeout remains the backstop.

## Wallets and funds

| Wallet | Holds | Refill rule |
|---|---|---|
| Keeper / opener / relayer (hot EOA, key only in Vercel env `KEEPER_PRIVATE_KEY`, marked sensitive) | ETH for gas (its own calls, relayed bets, claim deliveries); USDG seed float | Keep ≥ 0.002 ETH and ≥ (tickers × 2 markets × 20 USDG + 40) USDG. Seeds recycle back to it on settlement. Health goes red below the floor. |
| Treasury Safe | fees, residue | Swept automatically; no operational need to spend. |
| Guardian Safe (same Safe) | nothing | Only signs `setEntriesPaused`, `setFeed`, `setOpener`. |

The keeper key is never in the repo, never in chat, never in logs (`redact.ts` from
hunch-vpm keeps redaction). Set with `vercel env add KEEPER_PRIVATE_KEY production`
by the operator.

## Health and alerts

`GET /api/health` returns 200 only if **all** hold, else 503 with the failing checks:

- last successful `open` run < 26 h ago on a trading day (and today's markets exist
  after 13:25 UTC);
- no market past `finalTime + 30 min` still unsettled (unless flagged PhaseBoundary);
- no settled market with an undelivered non-zero claim older than 20 min;
- keeper ETH ≥ 0.002, keeper USDG ≥ floor;
- RPC head block age < 60 s;
- every allow-listed feed's latest round is younger than 26 h on a trading day;
- the relayer (keeper) has served a relayed entry successfully in the last trading day
  or has had none requested.

An external uptime monitor (the operator's choice: UptimeRobot / Better Stack free tier)
polls `/api/health` every 5 min and alerts the operator's phone. Optional: the keeper
posts failures to a Telegram chat if `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set.

## Runbook (kept in the internal folder; summary here)

- **Pause new entries** (bug suspected): Safe → `HunchVPM.setEntriesPaused(true)`. Claims
  and settlement keep working.
- **Feed misbehaving:** Safe → `factory.setFeed(feed, ticker, …, allowed=false)`; the
  keeper stops listing it; existing markets settle or void on their own proofs.
- **Keeper key leaked:** Safe → `factory.setOpener(old, false)`, rotate key in Vercel,
  `setOpener(new, true)`. The leaked key can only list markets with its own money and
  holds the seed float; move the float first.
- **Judging window:** `main` frozen after submission; fixes on a branch; a state backup
  (deployments JSON + keeper balances) before any deploy; the golden path re-run daily;
  keeper float funded for 2× the judging window (Oct 4 → Oct 12 results + buffer).
