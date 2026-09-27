# 02 · Mechanism: the Vested Parimutuel, as this venue runs it

Normative source: *The Vested Parimutuel: Settling prediction markets by time priority
of capital at risk* (Karia, Hunch Research, 2nd edition, September 2026),
<https://www.playhunch.xyz/vpm-whitepaper>, §4.6 "Normative summary", conformance suite
1.2.0 (118 vectors, sha256 prefix `ea5a52d3bbcb`). This file restates only what the
product depends on and fixes the venue parameters. If this file and the paper disagree,
the paper wins and this file is wrong.

## The two rules (plain words, then precise)

**Rule 1 — flow vesting.** When a stake lands on outcome `o`, it is paid, immediately and
irrevocably, to the positions already standing on the other outcome(s), pro-rata to
their accepted principal.

**Rule 2 — capacity matching.** A stake is accepted only up to the room the opposing
book has to cover it: a book `w` may absorb at most `κ · P_w` of vested inflow in total
(`P_w` = its accepted principal). Anything beyond that is refused and returned.

Everything else is bookkeeping:

- **Block vintages.** Entries in the same block form one vintage; they are rationed
  together against the headroom as of the vintage start (single pass, pro-rata on
  offered amounts), vest against the vintage-start books, and never vest to each
  other. So transaction ordering inside a block buys nothing. On Robinhood Chain
  `block.number` is the Ethereum block estimate, so a vintage is every entry within one
  ~12 s Ethereum block (L2 blocks are ~100 ms). We keep `block.number` to stay
  byte-equivalent with the reference; the wider batch only strengthens the property.
- **Seed (vintage 0).** A market opens with the creator's stake on every outcome. The
  legs vest into each other. The creator's seed is floored in every branch (P6).
- **Freeze.** A market has a resolution timestamp fixed at creation. Entries at or
  after it are refused. It can never move.
- **Settlement.** A winning position is paid
  `payout = s · (1 + A_ω(T) − A_ω(entry))`: its accepted principal `s`, plus everything
  that vested into its book after it arrived. Losing positions get 0. On void every
  position gets its accepted principal back. The accumulator form is O(1) per entry and
  per claim (§6).

## Properties the product leans on (paper §5)

| Id | Property | Where the product uses it |
|---|---|---|
| P1 | Conservation: payouts sum to the accepted pool (floor rounding residue goes to a named owner) | "Every dollar in is paid out" |
| P2 | Monotone win-branch floor: a position's win payout never decreases after entry | Market page: "Your win payout can only go up" |
| P3 | Invariance of accrued claims: later arrivals cannot revise what you have accrued | "Nobody arriving later can dilute you" |
| P4 | Late-entry neutrality: a buzzer entry pays exactly 1× (λ = 1) | "Open until the bell" |
| P5 | Scale-invariant return, bounded by `1 + κ(1 + ln g)` | κ choice, dust-seeding defence |
| P6 | Creation floor: a creator seeding every outcome recovers the seed in every branch | Hunch can seed every market |

What the mechanism does **not** do (paper §5.1, §14), and we say so on `/how-it-works`:
- It pays for **early risk-bearing**, not for being right per se; information is paid
  only if informed money arrives early.
- The late pool ratio is **not a probability**. The venue must not present live pool
  ratios as odds. We show "what you'd be paid if it settled now", which is exact.
- A late bettor who is right earns ~1×. That is the design, and the copy must say it
  before the bet, not after.
- Hedging near the close is unattractive.

## Venue parameters (v1, binary UP/DOWN)

| Parameter | Value | Why |
|---|---|---|
| Outcomes `n` | 2 (0 = UP, 1 = DOWN) | Binary only in v1; finite κ is a binary instrument (§4.3) |
| λ | 1 | Exact late-entry neutrality; interior λ voids P6 |
| κ | **30** | Paper §13.4: on bursty real flow κ = 9 refused a median 45.9% of gross; κ = 30 a median 0.0%. §15: "run κ at 30 or above even in binary markets" |
| Seed | **10 USDG per leg** (20 per market) | Opens `S(κ − n + 1)` = 290 USDG of first-vintage headroom per side; small enough that bettors, not the seed, capture most early vesting |
| Max entry | **100 USDG** per entry (beta cap, immutable per market) | Guarded beta; bounds a bug's blast radius |
| Min entry | 1 USDG | Dust entries are harmless (P5) but clutter the book |
| Fee | **200 bps of the gain** (`payout − accepted`), winners only, at claim | Business model; zero on principal, refunds, voids, losses |
| Residue owner | Treasury Safe | Floor-division dust (P8 bound) |
| Void timeout | 72 h after the freeze | After this anyone may void and refund |

## Worked example (illustrative arithmetic, κ = 30, seed 10/10, no fee)

"Will NVDA finish the week UP?" Hunch seeds 10 UP / 10 DOWN.

| When | Who | Side | Stake | Accumulator after | Entry accumulator of this position |
|---|---|---|---|---|---|
| open | seed | UP 10 / DOWN 10 | 20 | A_UP = 1.0, A_DOWN = 1.0 | 0 (both legs) |
| Tue 09:35 | Mei | UP | 20 | A_DOWN = 3.0 | A_UP = 1.0 |
| Tue 12:00 | Dan | DOWN | 30 | A_UP = 2.0 | A_DOWN = 3.0 |
| Thu 11:00 | Kim | DOWN | 40 | A_UP = 3.3333 | A_DOWN = 3.0 |
| Fri 15:55 | Ben | UP | 50 | A_DOWN = 3.625 | A_UP = 3.3333 |
| Fri 15:58 | Lee | DOWN | 10 | A_UP = 3.4583 | A_DOWN = 3.625 |

NVDA closes up. Pool = 170 USDG. UP wins.

| Position | Stake | VPM payout | Multiple | Ordinary pool (170 / 80 winning principal = 2.125×) |
|---|---|---|---|---|
| Mei (Tuesday) | 20 | **69.17** | **3.46×** | 42.50 |
| Ben (Friday, 5 min before the bell) | 50 | **56.25** | **1.125×** | 106.25 |
| Seed UP leg | 10 | 44.58 | — | 21.25 |
| Total | | 170.00 | | 170.00 |

Mei called it on Tuesday and carried the risk through two days of people betting
against her: she is paid 3.46×. Ben bet the obvious side five minutes before the bell:
he gets his stake back plus a share of the one opposing bet that came after him. In an
ordinary pool Ben would have taken 106.25 of a 170 pool and Mei 42.50.

A unit test (`test/WorkedExample.t.sol`) pins this table exactly, so the numbers in the
docs and on the landing page cannot drift from the contract.

## Partial fills (Rule 2), how the UI explains them

A book can absorb `κ · P_w` in total. Right after creation the DOWN book (10 USDG of
seed) can absorb 300, of which 10 is already used by the seed's own UP leg, so the first
UP entry can be accepted up to 290. An entry of 400 would be **accepted 290, returned
110**. Because a vintage is finalised by the next block's first transaction, the
returned part is a withdrawable claim from the next Ethereum block (~12 s) on; the keeper pushes it back
automatically (`06-keeper-and-ops.md`), and the position page shows "110 USDG returned
(the other side could only cover 290)". With the 100 USDG per-entry cap and κ = 30,
partial fills should be rare in the beta; the UI still quotes "accepted now: X" from
`headroom()` before the bettor signs.

## Pre-event provenance

The mechanism, the paper, the reference contract `VestedParimutuel.sol`, the conformance
vectors and the tape replay all predate this buildathon (paper 2nd edition 2026-09-02;
Arc testnet venue 2026-09-13). The README labels them as such. What is new in this
build is listed in `09-acceptance.md` §Built during the buildathon.
