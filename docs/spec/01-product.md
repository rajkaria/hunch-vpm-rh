# 01 · Product

> Design document. It describes the target. What is actually live is listed in the
> README's "Live now" table and in `docs/FACTS.md`; nothing in this file is a claim
> that something already works.

## One-liner

**Prediction markets on Robinhood Stock Tokens that pay an early call more than a late
one, and stay open until the closing bell.**

Card version (≤ 160 chars):
> Bet on NVDA, TSLA and AAPL in USDG on Robinhood Chain. Call it early, earn more.
> Markets stay open until the bell. Settled by Chainlink, no admin can touch stakes.

## The problem, in plain words

In every pool-based market (a tote at the racetrack, a sports pool, most onchain
prediction markets) the pot is split at the end, pro-rata to stake. So a dollar that
arrives at 3:59 pm, when the answer is nearly known, is paid the **same multiple** as
the dollar that took the risk at 9:30 am. Three things follow, and every pool operator
lives with them:

1. **Nobody wants to bet early.** Waiting is free information. Pools sit thin until
   the last minutes, which is exactly when a new user sees a market and decides whether
   it is alive.
2. **Late money dilutes early money.** When a crowd piles onto the obvious side at the
   end, everyone who called it early is paid less. The person who was right first is
   the one who gets hurt.
3. **Operators close betting early to stop sniping.** The standard fix is a "lock
   window": no bets in the last N minutes or hours. That throws away the most exciting
   part of the market.

Measured on a real tape (779,549 trades across 5,291 resolved markets from Hunch's
four-week paper-money tournament, where most traders were agents deployed by the
participants): under the ordinary pool rule, winners who arrived in the last 10% of a
market's life took a **median 70.1% of the losing pool**. The last winning-side trade
in the final 5% earned a median **1.487×**. Source: *The Vested Parimutuel*, §13.4
(Karia, Hunch Research, 2nd edition, Sep 2026). Always say "paper-money tournament"
and "agents deployed by participants" next to these numbers.

## The solution

Hunch runs the **Vested Parimutuel (VPM)**: the moment a stake lands, it is paid to
the people already standing on the other side, and it is accepted only up to what they
can cover. Consequences a bettor can feel:

| What the bettor sees | Why (paper property) |
|---|---|
| **The earlier you call it, the more you earn.** Your win payout is your stake plus every opposing dollar that arrives *after* you. | Rule 1, P3 |
| **Your win payout can only go up after you bet.** Nobody arriving later can dilute you. | P2 (monotone floor), P3 |
| **A last-second bet gets its stake back and nothing more (1.00×).** Sniping pays nothing, so the market can stay **open until the bell**. | P4, "no lock window" corollary |
| **Big late bets can be partly filled.** The unfilled part comes straight back to you. | Rule 2 (κ cap) |
| **Every dollar in is paid out.** Payouts sum to the pool, minus a 2% fee on winners' gains. | P1 |
| **Hunch's opening seed can't lose.** That is why Hunch can open every ticker every day. | P6 (creation floor) |

## Who it is for

**Primary persona — "Mei", 29, Singapore.** Holds a Robinhood Wallet, follows NVDA and
TSLA, trades crypto on weekends. She has an opinion about NVDA every Monday morning and
no instrument that rewards her for having it *early*: options are expensive and
confusing, and every prediction app pays her the same as the person who copies her on
Friday. She wants a small, capped, one-tap position (5–50 USDG) that pays more because
she called it first.

**Secondary — "the Friday trader".** Arrives late, bets the obvious side. In a normal
pool he would free-ride on Mei. Here he gets his stake back at worst, plus whatever
opposing money arrives after him. He is not harmed; he is simply not paid for
information everybody already had.

**Tertiary — the venue itself (Hunch).** Seeds both sides of every market. Under VPM
the seed is floored in every branch (P6), so seeding is a revolving float, not a
subsidy.

Geography: stock-price markets are **not offered to persons in the United States,
Canada, the United Kingdom or Switzerland** (the same list Robinhood applies to Stock
Tokens). See `05-web-app.md` §Geo and `10-risk.md`.

## The markets (v1 catalogue)

Binary UP/DOWN only. Outcomes are labelled **UP** and **DOWN**, never YES/NO.

| Family | Question | Opens (creation) | Strike | Final reading | Entries close |
|---|---|---|---|---|---|
| **Weekly** | "Will NVDA finish the week UP?" | before the week's first open | Chainlink price in effect at the week's first 09:30 ET | Chainlink price in effect at Friday 16:00 ET | Friday 16:00 ET (the bell) |
| **Daily** | "Will TSLA close UP today?" | before 09:30 ET | Chainlink price in effect at 09:30 ET | Chainlink price in effect at 16:00 ET | 16:00 ET |

"Price in effect at T" = the last Chainlink round at or before T. Robinhood Chain's
equity feeds update on 0.5% moves or once a day, so this can differ from the exchange's
official print by up to about 0.5%, and it is the Stock Token's price (share price ×
`uiMultiplier`). See `04-markets-and-resolution.md`.

- Tickers: NVDA, TSLA, AAPL (+ COIN if its feed passes the flat-rate check). SPY is
  excluded (slow feed, calm index). See `04-markets-and-resolution.md` §Tickers.
- Stake asset: **USDG** only. Minimum 1 USDG, maximum 100 USDG per entry in the beta.
- Fee: **2% of a winner's gain** (payout − principal), taken at claim. No fee on
  principal, refunds, voids, or losing positions.
- Flat (same Chainlink price at both bells) → **void, full refund, no fee**.
- A price older than its bound (26 h) at either bell, or Robinhood pausing the token's
  price for a corporate action for more than a day → **void, full refund, no fee**.
  Nobody can type in a price, including Hunch.
- **No ETH needed.** A bet is one signature over USDG; Hunch relays it and pays the gas.

## Why Robinhood Chain

Stated as a dependency list, not as praise:

- **Robinhood Stock Tokens** give the ticker universe and the audience.
- **Chainlink stock feeds on Robinhood Chain** give a price that no operator types in.
  This is the resolver's only input.
- **USDG** is the chain's native dollar: one asset for stakes and payouts.
- **Robinhood Wallet** supports the chain natively (dapp connection is verified at the
  golden path, `07-testing.md`).
- **USDG supports signed transfers (EIP-3009)**, so bets are gasless signatures, and USDC
  on Arbitrum One or Base arrives as USDG via Across in seconds.
- **Cheap gas** (≈ 0.02 gwei, no L1 data fee at time of check): an entry costs
  ~130k–300k gas, well under a cent, so Hunch can pay every bettor's gas.

## What we deliberately do not build (v1)

- No order book, no AMM, no cash-out before settlement. (A position is transferable
  on-chain; a venue buy-back desk is roadmap, `11-vision.md`.)
- No markets on other chains in this build. One chain, one stablecoin.
- No AI agent in the money path. No LLM anywhere in v1.
- No leverage, no margin, no liquidation.
- No holding of Stock Tokens by the contracts. We only read prices.
- No N-way range markets in v1 (paper §4.3: n-way needs unbounded κ and a published
  minimum seed; roadmap).

## Success criteria for the build (what "done" means to a judge)

1. A judge opens `rh.playhunch.xyz`, sees live markets with a live Chainlink price and
   a countdown to the bell, and can place a bet from a wallet on Robinhood Chain.
2. The home page shows one **settled** weekly market with at least one early and one
   late winning bettor, their USDG payouts side by side, what an ordinary pool would
   have paid each of them, and every transaction linked on the explorer.
3. The `/proof` page shows a market that **voided on a stale feed** and refunded every
   position on-chain, plus the round ids that settled every market.
4. Contracts are verified on Blockscout, owned by a Safe, and the README states each
   privileged power (there are two: list a market, pause new entries) and what no one
   can do (move a stake, set a price, pause claims).
