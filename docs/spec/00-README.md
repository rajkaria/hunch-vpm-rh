# Hunch on Robinhood Chain · build spec

**Status:** design, 2026-09-28. Nothing here is live until it appears in
`docs/FACTS.md` "Live now" with a receipt.

**What we are building:** prediction markets on Robinhood Stock Tokens (NVDA, TSLA, AAPL
and any ticker with a healthy Chainlink feed), in USDG, on Robinhood Chain mainnet
(chain 4663), settled from Chainlink rounds, using the Vested Parimutuel payout rule so
that an early call is paid more than a late one and markets can stay open until the
closing bell. Served at `vpm.playhunch.xyz`.

## Reading order

| File | For | Contents |
|---|---|---|
| [01-product.md](01-product.md) | everyone | one-liner, problem, personas, market catalogue, what we don't build |
| [02-mechanism.md](02-mechanism.md) | contracts, web, pitch | VPM rules in plain words, properties used, venue parameters, worked example |
| [03-contracts.md](03-contracts.md) | contracts | HunchVPM diff D1–D10, StockRoundResolver, HunchMarketFactory, powers, invariants, gas |
| [04-markets-and-resolution.md](04-markets-and-resolution.md) | contracts, keeper, web | feeds, tickers, session times, round proofs, staleness bounds, calendar |
| [05-web-app.md](05-web-app.md) | web | routes, components, copy rules, data layer, wallets, geo |
| [06-keeper-and-ops.md](06-keeper-and-ops.md) | keeper, ops | cron jobs, void policy, wallets, health, runbook |
| [07-testing.md](07-testing.md) | all | T1–T10, human golden path, claims audit |
| [08-deployment.md](08-deployment.md) | ops | chain facts, addresses, deploy order, verification, env vars, funding routes |
| [09-acceptance.md](09-acceptance.md) | all | definition of done, timing constraint, pre-event vs new |
| [10-risk.md](10-risk.md) | all | risk register |
| [11-vision.md](11-vision.md) | pitch | roadmap, revenue, hypotheses |

## Repository layout (target)

```
hunch-vpm-rh/
  contracts/            Foundry: src/{HunchVPM,StockRoundResolver,HunchMarketFactory}.sol,
                        src/reference/ (vendored, byte-for-byte), test/, script/DeployRH.s.sol,
                        DIFF.md, GAS.md, SECURITY.md, VENDORED.md
  packages/client/      viem reads/writes, rounds finder, mechanics mirror, chain 4663 config
  packages/keeper/      pure decisions + runner (open / resolve / deliver / health)
  apps/web/             Next.js venue (vpm.playhunch.xyz) incl. /api/cron/* and /api/health
  deployments/          robinhood-mainnet.json (single source of addresses for every reader)
  docs/spec/            this spec
  docs/FACTS.md         every public claim with its receipt
  README.md  VISION.md  LICENSE (MIT)
```

`deployments/robinhood-mainnet.json` is the only place addresses are written; the web
app, keeper and README read or are generated from it (`scripts/wire-deployment.mjs
--check` fails CI on drift).

## Glossary (used in these docs, not on the website's first screen)

- **Position**: one bet: owner, outcome, offered, accepted, entry accumulator, vintage.
- **Accepted / refused**: the part of a bet the other side can cover (Rule 2) / the part
  returned.
- **Accrued**: what a position would be paid if its outcome won now; never decreases.
- **Vintage**: all bets in one block; they are rationed together and never vest to each other.
- **Seed**: the opening stake Hunch places on both sides when it lists a market.
- **Strike / final**: the Chainlink prints at the opening and closing bell that decide UP/DOWN.
- **κ (kappa)**: the capacity multiple; a book can absorb at most κ × its principal.
