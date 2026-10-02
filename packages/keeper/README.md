# @hunch-rh/keeper

The Hunch keeper for Robinhood Chain. It is a convenience, never an authority: every action it
takes, anyone can take (resolve with proven rounds, void on proven staleness, deliver claims to
their owners, relay a bettor's own signed entry). If it stops, markets still settle, just later;
after 72 hours anyone can void and refund through the settler.

Every job reads the chain, decides with a pure function, acts, and can run twice without harm.

## CLI

```sh
pnpm --filter @hunch-rh/keeper keeper run-once [open|resolve|deliver|all] [--dry-run] [--now <unix>] [--json]
pnpm --filter @hunch-rh/keeper keeper plan-drill [--ticker NVDA] [--now <unix>]     # read-only
pnpm --filter @hunch-rh/keeper keeper open-drill [--ticker NVDA] [--dry-run]         # lists it with the keeper key
pnpm --filter @hunch-rh/keeper keeper health [--now <unix>] [--json]
```

Before deployment (`deployments/robinhood-mainnet.json` status `not-deployed`) `run-once` reads the
chain head and the v1 Chainlink feeds, says so, and exits 0. `--dry-run` decides and prints every
action without a key and without sending.

Environment (names only; values are never printed, and every log line is scrubbed of the key and
of RPC credentials):

| Variable | Use |
|---|---|
| `KEEPER_PRIVATE_KEY` | Keeper / opener / relayer hot key. Required only to send. |
| `RH_RPC_URL` | Keyed RPC (primary). The public RPC is the fallback transport. |
| `RH_FALLBACK_RPC_URL` | Optional second provider for the independent STALE read (default: the public RPC; never `RH_RPC_URL`). |
| `HUNCH_DEPLOYMENT_JSON` | Full deployment JSON override (fork rehearsals). |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional paging. |

## Jobs

| Job | Decides (pure) | Does |
|---|---|---|
| `open` | `decideOpen({ nowSec, feeds, allowList?, listings, corporateActions, params })` | Before the opening bell on a trading day: today's daily per ticker (strike = today's open, final = today's close, 13:00 ET on early closes). Before the week's first bell: the weekly (first open → last close). Launch-week catch-up: no weekly yet and ≥ 3 sessions left including the next one → a weekly striking at the next open. Skips tickers held back for the FLAT-rate check, feeds not allow-listed, and corporate actions in the window. Never a duplicate (same feed, strike, final). Seed 10 USDG per leg, caps 1–100 USDG, age bounds 0 (feed default). Approves USDG to the factory for exactly the seeds needed, only when the allowance is short. |
| `resolve` | `decideResolve(candidate, nowSec)` | For markets past final + 60 s and unsettled: find both proven rounds, `preview`, then `resolve` (UP/DOWN; FLAT voids inside it); `voidStale` only at ≥ final + 15 min when a second, independent read also says STALE for the same rounds; PAUSED retries and `voidPaused` at ≥ final + 24 h; BADPROOF or a phase boundary pages the operator and is never auto-voided. |
| `deliver` | `decideDeliver({ markets, l1Block, feesAccrued })` | `finalizeVintage` where the open vintage's L1 block has passed; `withdrawRefundFor` refused remainders in open markets; one `claimFor` per position with a non-zero payout or refund (never batched, so a Paxos-frozen owner fails alone); `sweepFees(USDG)` above 5 USDG. |
| drill | `planRefundDrill({ nowSec, feed, params })` | Friday's open → Saturday 06:00 UTC, `maxFinalAge` 1 h: provably stale, so every bet is refunded. CLI only (`plan-drill`, `open-drill`), never cron. |

Stateless by design (serverless crons have no memory): the STALE double-check is two independent
reads in one run, not two runs two minutes apart. Proofs at past bells cannot change, so the second
read only guards against a misbehaving RPC.

## For route handlers (apps/web)

```ts
import { createKeeper } from '@hunch-rh/keeper';

const keeper = createKeeper(process.env);

// /api/cron/[job]  (check Authorization: Bearer ${CRON_SECRET} first)
const reports = await keeper.run(job);                  // 'open' | 'resolve' | 'deliver' | 'all'

// POST /api/relay/enter
const result = await keeper.relay(await req.json(), {
  country: req.headers.get('x-vercel-ip-country'),
  ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
});
return Response.json(result, { status: result.ok ? 200 : result.status });

// GET /api/health
const health = await keeper.health();
return Response.json(health, { status: health.ok ? 200 : 503 });
```

Lower-level exports: `runJob(job, ctx)`, `runDrill(ctx, opts)`, `formatReports(reports)`,
`readKeeperState(client, deployment, opts)`, `relayEnter(body, ctx)`,
`validateRelayRequest(body, ctx)`, `parseRelayRequest(body)`, `chainRelayReads(client, d, relayer?)`,
`walletRelaySender(wallet, client, d)`, `RateLimiter`, `defaultRelayLimiter`,
`checkHealth(client, d, opts)`, `evaluateHealth(state, d, actions)`, `keeperUsdgFloor(d)`,
`makeKeeperClients({ deployment, env, withWallet? })`, `readKeeperKey(env)`, `makeAlerter(env, opts)`,
`loadCorporateActions()`, `corporateActionIn(...)`, and the decision functions above.

## Relay

`POST /api/relay/enter` body (numbers as decimal strings):

```json
{ "from": "0x…", "marketId": "12", "outcome": 0, "amount": "25000000",
  "validAfter": "0", "validBefore": "1790601800", "salt": "0x…32 bytes", "signature": "0x…" }
```

Checked in order: deployed; shape; geo (US, CA, GB, CH refused, 451); rate limit (10 per minute per
IP and per `from`, in memory, per instance, best effort); optional `chainId` / `hunchVpm` domain
fields; 1–100 USDG; validity window (valid now, at least 30 s left, at most 1 h); the EIP-712
signature over USDG's hardcoded domain recovers to `from` (smart wallets go on to the simulation,
where USDG checks ERC-1271); market exists, is open and at least 15 s from its bell; entries not
paused; the market's own caps; `authorizationState(from, nonce)` unused; USDG balance; a simulated
`enterWithAuthorization`. Then it is sent from the keeper key and the tx hash is returned. Errors
come back as `{ ok: false, code, status, message }` with plain-words messages.

## Health

`GET /api/health` is green only if every check passes, all derived from chain state:
`rpc-head` (< 60 s), `keeper-eth` (≥ 0.001 ETH), `keeper-usdg` (wallet + its seeds in open markets + its undelivered
payouts ≥ (tickers × 2 markets + 1 drill) × 2 legs × `seedPerLeg`), `todays-markets` (on a trading day from the opening bell − 5 min), `settlement` (no market
unsettled 30 min after its bell), `delivery` (no deliverable claim 50 min after the bell),
`feed-freshness` (every allow-listed feed younger than 26 h during a regular session). Before
deployment it is green with a "not deployed" note.

## Calendar and corporate actions

NYSE sessions come from `@hunch-rh/client` (`src/calendar/nyse.json`, 2026 and 2027 read from
nyse.com); the keeper keeps no second copy. `calendar/corporate-actions.json` lists announced
actions (schema in its `_comment`); the keeper skips any market whose window overlaps one.

## Tests

`pnpm --filter @hunch-rh/keeper test` (T9): open sets for given ET dates (normal day, holiday,
early close, the DST change on 2026-11-01, weekend, launch-week catch-up, corporate action,
allow-list, idempotency), the refund drill, resolve vs void vs page, deliver batching, every
relay failure (domain, expiry, amount, caps, geo, rate limit, signature, replayed nonce,
balance, simulation), health, the runner end to end against an in-memory chain, key handling
and redaction.
