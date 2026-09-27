# Architecture

Hunch on Robinhood Chain is three contracts, one price source and a keeper that anyone can
replace. Every layer above the contracts is a convenience: if the website and the keeper both
disappeared, every market would still settle from Chainlink rounds and every bettor could
still collect.

```
                ┌──────────────────────────────────────────────────────────────┐
                │  rh.playhunch.xyz  (Next.js on Vercel)                       │
                │  pages · /api reads · /api/relay/enter · /api/cron/[job]     │
                └───────┬───────────────────────┬───────────────────┬──────────┘
                        │ view calls             │ signed bets       │ Vercel Cron
                        │ (@hunch-rh/client)     │ (EIP-3009)        │ (@hunch-rh/keeper)
                        ▼                        ▼                   ▼
   ╔══════════════════════════════════════════════════════════════════════════════╗
   ║  Robinhood Chain mainnet · chain 4663 · Arbitrum Orbit (ArbOS 61) · ETH gas   ║
   ║                                                                              ║
   ║    Safe ── owner ──► HunchMarketFactory ──create──► HunchVPM ◄── bettors      ║
   ║     │                  │  (seed legs to opener)       ▲   enter / signed entry║
   ║     └ guardian/treasury│ register spec                │   claim / claimFor    ║
   ║                        ▼                              │                       ║
   ║                StockRoundResolver ──resolve / void────┘                       ║
   ║                        │ getRoundData · latestRoundData · oraclePaused        ║
   ║                        ▼                                                      ║
   ║      Chainlink stock feeds (NVDA, TSLA, AAPL, COIN) · Robinhood Stock Tokens ║
   ║      USDG (Paxos, 6 decimals, EIP-3009 signed transfers)                     ║
   ╚══════════════════════════════════════════════════════════════════════════════╝
```

## Contracts (`contracts/`)

| Contract | Role | Owner | Deployed |
|---|---|---|---|
| `HunchVPM` | The settler: the paper's reference `VestedParimutuel` plus seven listed changes (fee on winners' gains, claims delivered to owners by anyone, per-market entry caps, an entries-only pause, gasless signed entry, views, events) | none; a guardian address may pause **new entries** only | yes |
| `StockRoundResolver` | Settles UP/DOWN from two proven Chainlink rounds: the price in effect at the opening bell and at the closing bell | none | yes |
| `HunchMarketFactory` | Lists a market in one transaction: pulls the seed, creates the market, registers its spec, hands the seed legs to the opener, keeps an on-chain listing table | the Safe (two-step transfer) | yes |
| `reference/VestedParimutuel` | The paper's reference implementation, byte for byte | — | no, test oracle |
| `ClassicParimutuel` | The ordinary pool rule, for the counterfactual column only | — | no |

`contracts/DIFF.md` holds the literal diff of `HunchVPM` against the reference; CI fails if a
hunk appears that is not one of the seven listed changes. The differential suite proves that
with the fee at zero and no caps, `HunchVPM` and the reference produce identical acceptances,
payouts, refunds and residue on all 118 published vectors and on fuzzed sequences.

### How a market lives

1. **Listing.** Before the opening bell the keeper (an allow-listed opener) calls
   `HunchMarketFactory.openUpDown`: 10 USDG seed on each side, κ = 30, fee 2% of winners'
   gains, entries capped at 1–100 USDG, freeze at the closing bell, void timeout 72 h. The
   resolver registers the spec (feed, Stock Token, strike time, final time, staleness bounds);
   the spec is hashed, so nothing about it can change afterwards.
2. **Entries.** A bettor signs one USDG `ReceiveWithAuthorization` whose nonce binds the
   market, side, amount and a salt (`enterNonce`). Anyone (normally the venue's relayer)
   submits `enterWithAuthorization`; USDG only lets the settler itself pull the funds, and the
   position belongs to the signer. A bettor with ETH can instead `approve` + `enter`.
3. **Matching.** Entries in the same Ethereum block number (the chain's `block.number` is the
   L1 estimate, ~12 s) form one vintage, rationed together and never vesting to each other.
   The next transaction touching the market finalizes the vintage; the keeper pokes
   `finalizeVintage` so accrued payouts and any refused remainder show within seconds.
4. **Resolution.** After the closing bell anyone calls
   `StockRoundResolver.resolve(specId, strikeRound, finalRound)`. The contract checks that
   each round is the last one at or before its bell (`updatedAt ≤ T` and the next round is
   after `T`, or absent and latest), that neither price is older than its bound, and that
   Robinhood has not paused the token's oracle. Higher close: UP. Lower: DOWN. Same round or
   same price: FLAT, which voids and refunds everyone. Proven staleness voids through
   `voidStale`; a corporate-action pause lasting a day voids through `voidPaused`; after 72 h
   anyone may void through the settler directly.
5. **Delivery.** The keeper calls `claimFor` for every position with a payout or refund, one
   transaction each, so a USDG-frozen address fails alone. Funds only ever go to the
   position's owner. Fees accumulate per token and `sweepFees` sends them to the treasury.

## Off-chain packages

| Package | What it is |
|---|---|
| `@hunch-rh/client` | Runtime-agnostic TypeScript: chain 4663 definition, ABIs generated from `contracts/out`, the deployment loader, view-call reads (venue, market, positions, prices, proof), the exact bigint mirror of the mechanism (accrued, quote with open-vintage rationing, classic counterfactual), the round finder, the USDG typed-data builder, the NYSE calendar in America/New_York, and the question/rules templates |
| `@hunch-rh/keeper` | Pure decision functions (open, resolve, deliver, relay validation, health) with a thin runner and a CLI. Every job is idempotent and every action it takes is one anyone can take |
| `apps/web` | The venue: server-rendered pages from cached view calls, client islands for the wallet and the bet panel, `/api` read endpoints, the relay endpoint and the cron endpoints |

The web app enumerates markets with view calls only (`listingCount` → `listings` →
`getMarket` / `getBook` / `marketTerms` → `resolver.getSpec`). Event logs are used for entry
times and transaction links and degrade gracefully, because the public RPC keeps only about
ten minutes of historical state and caps `eth_getLogs`.

## Addresses

`deployments/robinhood-mainnet.json` is the only place an address is written. The client
imports it; `scripts/wire-deployment.mjs --check` fails the gate if the README's address table
drifts from it. Until the operator deploys, its `status` is `not-deployed` and every page says
so.

## Trust and failure

| If this fails | What happens |
|---|---|
| The website | Nothing on-chain changes. Anyone can call `resolve`, `claimFor`, `withdrawRefundFor` from a block explorer |
| The keeper | Markets settle later. The "Resolve it yourself" button and the 72 h timeout remain |
| A Chainlink feed goes quiet | The market refunds on proven staleness (26 h bound, 1 h for the refund drill) |
| Robinhood pauses a token's oracle | Resolution waits; after 24 h the market refunds |
| Paxos freezes a winner's address | That one claim fails; every other claim is independent |
| A bug is suspected | The Safe pauses new entries; claims, refunds and settlement keep working |
