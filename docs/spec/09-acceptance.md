# 09 · Acceptance: definition of done, and provenance

A feature is done when its row here has a receipt in `docs/FACTS.md`. Until then the
README lists it under "Built, not yet proven" or not at all.

## Must ship (the three core features)

| # | Feature | Done when (judge-runnable check) |
|---|---|---|
| F1 | **Bet on a live stock market from a wallet on Robinhood Chain** | A wallet with USDG places a bet on `vpm.playhunch.xyz`; the `Entered` event and the USDG transfer are on Blockscout; the position survives a hard refresh; `/portfolio` shows it. Contracts verified on Blockscout. |
| F2 | **Settlement nobody types in** | A market resolves from two Chainlink round ids on chain 4663; the resolve tx shows both rounds and prices; the outcome matches the Stock Token's session per those rounds; payouts arrive to owners via `claimFor` without the bettors doing anything. |
| F3 | **Early beats late, shown with real money** | The landing proof card shows a settled market with at least one early and one late winning bettor who are **not** the operator's wallets, their USDG payouts and multiples side by side, the classic-pool counterfactual, and tx links for every number. |

Plus two safety proofs:
| # | Proof | Done when |
|---|---|---|
| S1 | **Refund on a bad price** | One mainnet market voided through `voidStale`, with the proof rounds and every refund tx on `/proof`. The planned one is the labelled Saturday refund drill (`04-markets-and-resolution.md`), which settles Sat 2026-10-03 06:00 UTC. Any natural FLAT void is shown too. |
| S2 | **Powers are what the README says** | Safe owns the factory and is guardian/treasury; threshold read on-chain; the powers table's "cannot" column is covered by T2.9 and INV-3/4. |

## Timing constraint (why weekly markets start Tuesday)

The submission closes **Sun 2026-10-04 15:59 UTC**. A weekend market (Friday close →
Monday open) cannot settle before that. So:
- **Daily** markets: every trading day from launch (target Tue 2026-09-29; Monday
  2026-09-28 if deployed and golden-pathed before 13:30 UTC). Each settles 20:00 UTC.
- **Weekly** markets: open before Tue 2026-09-29 13:30 UTC, strike at Tuesday's open,
  final at **Fri 2026-10-02 20:00 UTC** (Sat 01:30 IST). This is the F3 hero market.
  Early bettors must be in on Tuesday; late bettors on Friday afternoon ET.
- Refund drill: opened Thursday, settles Sat 2026-10-03 06:00 UTC (11:30 IST), before the video.

## Built during the buildathon (new, this repo) vs before (labelled)

| Before 2026-09-14 (labelled "pre-event" in README) | During the buildathon (this repo's history) |
|---|---|
| The paper, 2nd ed. (2026-09-02); reference `VestedParimutuel.sol`; 118 vectors; tape replay | `HunchVPM` (fee, claimFor, bounds, pause, gasless signed entry, views) + differential suite |
| hunch-vpm Arc venue (2026-09-13): `ClassicParimutuel`, `MarketFactory`, `FeedResolver`, web app, keeper skeleton, client | `StockRoundResolver` (price-in-effect proofs, FLAT/stale/paused voids) |
| Hunch London entry (June): `HunchParimutuelVault` on Arbitrum One (classic pool, different contract) | `HunchMarketFactory` for USDG + allow-listed feeds; Robinhood Chain deployment; Safe ownership |
| | Stock-market catalogue, NYSE calendar keeper, proof-based auto-void, gasless relay, `/proof`, `<EarlyVsLate>`, Robinhood Chain data layer, geo gate, `/start` |

The first commit of the repo imports hunch-vpm at a named commit SHA with the message
`import: hunch-vpm @<sha> (pre-event baseline, Arc venue)`; every later commit is
buildathon work, committed as it lands (no same-minute bursts, no history rewrites).

## FACTS.md skeleton (filled only from receipts)

```
## Live now
| Fact | Receipt |
| HunchVPM deployed + verified | 0x… · Blockscout verified link · deploy tx |
| StockRoundResolver deployed + verified | … |
| HunchMarketFactory deployed + verified, owned by Safe 0x… (threshold n/m) | … |
| Markets opened / settled / voided | factory MarketOpened count; resolver Resolved count; void txs |
| Distinct bettors excluding operator wallets | Blockscout query URL + list |
| USDG staked / paid out | sums of Entered.offered / Claimed(payout+refund) |
| Early vs late (hero market) | market id, positions, payout txs |
| Refund drill | void tx, refund txs |

## Built, not yet proven
## Not built (roadmap)
```
