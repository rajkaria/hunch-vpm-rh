# 04 · Markets and resolution

Chain facts in this file come from `research-facts.md` (internal, verified with `cast`
on 2026-09-27); the public copy of every address is `deployments/robinhood-mainnet.json`.

## How the price feeds behave (and why the rules read the way they do)

- Robinhood Chain's equity feeds are Chainlink "US_Equities_24/5" feeds: they aggregate
  overnight, pre-market, regular and post-market trading, and do not update on weekends
  or US market holidays. Observed window on chain: **Sun 20:00 ET → Fri ~20:00 ET**.
- Each feed updates when its price moves **0.5%** from the last report, or on a **24 h
  heartbeat**. 8 decimals.
- So there is almost never a round printed exactly at 9:30 or 4:00 pm ET. Every reading
  in this venue is **"the Chainlink price in effect at time T" = the answer of the last
  round with `updatedAt ≤ T`**. It can differ from the exchange's official print by up
  to about 0.5%, and it is the price of the **Stock Token** (share price ×
  `uiMultiplier`, continuous through dividends and splits). The rules box says both.
- If the price stayed inside Chainlink's 0.5% band for the whole window, the strike and
  final readings are the same round: the market is **FLAT** and refunds everyone.

## Sessions and times

All times are computed in `America/New_York` and stored on-chain as unix seconds in the
spec (hashed into `specId`, immutable). EDT (UTC−4) applies until Sun 2026-11-01
02:00 ET, then EST (UTC−5).

| Term | Definition |
|---|---|
| Opening bell | 09:30:00 ET on a NYSE trading day |
| Closing bell | 16:00:00 ET (13:00:00 ET on early-close days) |
| `strikeTime` | the opening bell of the market's first session |
| `finalTime` | the closing bell of the market's last session (= HunchVPM freeze) |

| Session in the build window | Open (UTC / IST) | Close (UTC / IST) |
|---|---|---|
| Mon 2026-09-28 | 13:30 / 19:00 | 20:00 / Tue 01:30 |
| Tue 2026-09-29 | 13:30 / 19:00 | 20:00 / Wed 01:30 |
| Wed 2026-09-30 | 13:30 / 19:00 | 20:00 / Thu 01:30 |
| Thu 2026-10-01 | 13:30 / 19:00 | 20:00 / Fri 01:30 |
| Fri 2026-10-02 | 13:30 / 19:00 | 20:00 / Sat 01:30 |

No NYSE holiday or early close falls in the window. The keeper's 2026 calendar
(`packages/keeper/calendar/nyse-2026.json`, checked against nyse.com, source URL in the
file): holidays Jan 1, Jan 19, Feb 16, Apr 3, May 25, Jun 19, Jul 3, Sep 7, Nov 26,
Dec 25; early closes (13:00 ET) Nov 27 and Dec 24.

## Tickers (v1)

Allow-listed with `factory.setFeed(feed, stockToken, ticker, maxStrikeAge, maxFinalAge,
true)`. Standard proxies only (not the SVR proxies). All eight-decimal, 24 h heartbeat,
0.5% deviation.

| Ticker | Stock Token (4663) | Chainlink proxy (4663) | Aggregator | v1 |
|---|---|---|---|---|
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` | `0xC9d16E4f2569b9E3ea0468fD85844953713DC2a2` | yes |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | `0x4A1166a659A55625345e9515b32adECea5547C38` | `0x7A6b81ba7FbCB90104d8C496158Cf383cD7233b1` | yes |
| AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0` | `0xBb11A21267cFDb63d4935d99a499133DD1744ACb` | yes |
| COIN | `0x6330D8C3178a418788dF01a47479c0ce7CCF450b` | `0xA3a468A452940B7D6b69991207B508c609a98Ef2` | `0x30398b0B0df82a009bB2D507BC7fE1dc6d3ca294` | if flat-rate check passes |
| SPY | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | `0x319724394D3A0e3669269846abE664Cd621f9f6A` | `0x78BCB218fA04B9b3a278eBc865Ed320BF8DEFBAc` | **no**: in-week gaps up to 24 h; calm index → frequent FLAT |

Look-alike tokens with the same names exist on Blockscout: addresses are hardcoded from
docs.robinhood.com/chain/contracts and cast-checked, never looked up by symbol.

**Feed check before allow-listing** (`scripts/measure-feeds.ts`, output
`deployments/feeds-4663.json`, needs a keyed RPC):
1. `description()`, `decimals() == 8`, answer > 0.
2. Over the last 20 trading days: the largest in-week gap between rounds, and the
   **FLAT rate**: the share of sessions where the round in effect at 09:30 ET equals the
   round in effect at 16:00 ET. Allow-list for daily markets only if FLAT ≤ 25%;
   weekly markets only if the weekly FLAT rate is ≤ 10%.
3. `oraclePaused()` history: count `OraclePaused` events on the Stock Token in the last
   90 days (OPEN item in research-facts).

**Age bounds (v1, weekday windows):** `maxStrikeAge = maxFinalAge = 26 h` (heartbeat
plus 2 h). A reading older than that means the feed missed its heartbeat, and the market
refunds. (Weekend-spanning windows, roadmap: 80 h; holiday weekends: 104 h plus the
calendar.)

## Catalogue for the build window

| Family | Markets | Created (UTC) | strikeTime | finalTime | Seed | Caps |
|---|---|---|---|---|---|---|
| Daily UP/DOWN | one per v1 ticker per trading day from launch | by 13:25 on the day | that day 13:30 | that day 20:00 | 10 / 10 USDG | 1–100 USDG per entry |
| Weekly UP/DOWN (hero) | one per v1 ticker | by Tue 2026-09-29 13:25 | Tue 13:30 | **Fri 2026-10-02 20:00** | 10 / 10 | 1–100 |
| Refund drill | one, labelled | Thu 2026-10-01 | Fri 2026-10-02 13:30 (26 h bound) | **Sat 2026-10-03 06:00** with `maxFinalAge = 1 h` | 10 / 10 | 1–100 |

**Refund drill, why it must refund:** the feeds do not update on Saturdays (last print
Fri ~20:00 ET = Sat 00:00 UTC). At Sat 06:00 UTC the price in effect is ≥ 6 h old, which
violates the market's 1 h final bound, so `voidStale` is provable and every bet,
including the seed, is refunded in full. Question text: *"Refund drill: NVDA UP from
Friday's open to 2:00 am ET Saturday? The price feed does not update on Saturdays, so
this market exists to show that everyone gets their money back when the price can't be
trusted."* The opener's tighter bound is allowed by the factory (bounds can only be
tightened). A few small bets (operator and testers, labelled) make the refunds visible.

From the week of Oct 5 (after the deadline): weekly strike at Monday's open; weekend
markets (Fri close → Mon open, 80 h bound) are added.

Question templates (rendered from the spec, never from free text):
- Daily: `Will {TICKER} close UP today? · {Weekday Mon D}`
- Weekly: `Will {TICKER} finish the week UP? · {Tue Mon D} → {Fri Mon D}`

## Resolution, step by step (keeper and the "Resolve it yourself" button)

1. Wait until `block.timestamp ≥ finalTime` (+ 60 s margin for the keeper).
2. `s = findLastAtOrBefore(feed, strikeTime)`, `f = findLastAtOrBefore(feed, finalTime)`.
3. `preview(specId, s, f)`:
   - UP / DOWN / FLAT → `resolve(specId, s, f)` (FLAT voids inside `resolve`).
   - STALE → after `finalTime + 15 min`, twice 2 min apart → `voidStale(specId, s, f)`.
   - PAUSED → retry every 10 min; at `finalTime + 24 h` → `voidPaused(specId)`.
   - BADPROOF / PhaseBoundary → page the operator; nothing on-chain.
4. The `deliver` job then pushes `claimFor` for every position with a non-zero payout or
   refund, one call per position (a Paxos-frozen address fails alone).

## What a bettor is told (rules box, verbatim template)

> **How this market settles.** The opening price is Chainlink's {TICKER} Stock Token
> price in effect at 9:30 am ET on {date}; the closing price is Chainlink's price in
> effect at 4:00 pm ET on {date}. Chainlink updates this price whenever it moves 0.5%
> (or once a day), so either number can differ from the exchange's official print by up
> to about 0.5%. **UP** wins if the closing price is higher, **DOWN** if it is lower.
> If they are the same, or if either price is more than {age} old at that moment, or if
> Robinhood pauses the token's price for a corporate action for more than a day, every
> bet is refunded in full. Bets are accepted until 4:00 pm ET. The earlier you bet, the
> more of the other side's later money is yours; a bet placed at the last moment gets
> its stake back plus whatever the other side adds after it. Hunch keeps 2% of winnings.
> Nobody at Hunch can set or change a price.
