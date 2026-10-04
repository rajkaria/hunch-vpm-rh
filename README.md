# Hunch on Robinhood Chain

**Prediction markets on Robinhood Stock Tokens that pay an early call more than a late one,
and stay open until the closing bell.**

Bet UP or DOWN on NVDA, TSLA, AAPL and COIN in USDG on Robinhood Chain. Call it early and you
collect every dollar the other side adds after you; call it at the last second and you get your
stake back. Settled by two Chainlink rounds that nobody can type in, including us. No ETH needed:
a bet is one signature.

`vpm.playhunch.xyz` · chain 4663 · USDG · Chainlink · beta, unaudited

> **Status.** The contracts, keeper and venue are built and tested; see
> [Deployment](#deployment) for what is live. Every public claim about this venue has a receipt in
> [`docs/FACTS.md`](docs/FACTS.md). Nothing here is a claim that something is live unless it
> appears there.

## The problem

In every pool market (a racetrack tote, a sports pool, most onchain prediction markets) the pot
is split at the end, pro rata to stake. A dollar that arrives at 3:59 pm, when the answer is
nearly known, is paid the same multiple as the dollar that took the risk at 9:30 am. So nobody
wants to bet early, late money dilutes the people who were right first, and operators close
betting before the most interesting minutes to stop sniping.

## The rule

Hunch settles with the **Vested Parimutuel** (Karia, Hunch Research, 2nd ed., Sep 2026,
[paper](https://www.playhunch.xyz/vpm-whitepaper)). The moment a stake lands it is paid to the
people already standing on the other side, and it is accepted only up to what they can cover.

| What a bettor sees | Why |
|---|---|
| The earlier you call it, the more you earn: your win payout is your stake plus every opposing dollar that arrives after you | flow vesting (Rule 1) |
| Your win payout can only go up after you bet; nobody arriving later can dilute you | monotone floor (P2, P3) |
| A last-second bet gets its stake back plus whatever the other side adds after it, so markets stay **open until the bell** | late-entry neutrality (P4) |
| Big late bets can be partly filled; the unfilled part comes straight back | capacity matching (Rule 2, κ = 30) |
| Every dollar in is paid out, minus 2% of winners' gains | conservation (P1) |
| Hunch's opening seed cannot lose, so Hunch can open every ticker every day | creation floor (P6) |

**Worked example** ("Will NVDA finish the week UP?", seed 10 / 10 USDG, illustration pinned by
`contracts/test/WorkedExample.t.sol`):

| Bettor | When | Side | Stake | Hunch pays | Ordinary pool pays |
|---|---|---|---:|---:|---:|
| Mei | Tuesday 9:35 am | UP | 20.00 | **69.16** (3.45×) | 42.50 |
| Ben | Friday 3:55 pm | UP | 50.00 | **56.25** (1.12×) | 106.25 |

Mei carried the risk through two days of people betting against her. Ben bet the obvious side
five minutes before the bell. (Amounts floored to the cent; the contract pays Mei 69.166666.)

## How a bet works

1. **Get USDG on Robinhood Chain.** Send USDC from Arbitrum One or Base through
   [Across](https://app.across.to); it arrives as USDG in seconds. No ETH needed.
2. **Pick UP or DOWN** on a daily ("Will TSLA close UP today?") or weekly ("Will NVDA finish the
   week UP?") market. The quote shows what is accepted now and the least you are paid if you win.
3. **Sign once.** Your wallet signs a USDG `ReceiveWithAuthorization` whose nonce binds the
   market, side and amount. Hunch's relayer submits it and pays the gas; it cannot change any of
   them, and only the settler can pull the funds.
4. **The bell settles it.** After 4:00 pm ET anyone can resolve with the two Chainlink rounds in
   effect at the opening and closing bell. Payouts are delivered to owners automatically.

Every market refunds in full if the price did not move (same round), if either price is older
than its bound (26 h) or out of range (not a real price), or if Robinhood pauses the token's
price for a corporate action for more than a day. The rules box on every market says so before you bet.

## Powers

| Who | Can | Cannot |
|---|---|---|
| Safe (guardian of HunchVPM) | pause and resume **new entries and new markets**; name or remove the pauser | pause or block claims, refunds, resolution; move any stake; set any price |
| Pauser (one key the Safe names) | pause **new entries and new markets** | resume them; anything else |
| Safe (owner of factory) | allow-list a feed, its Stock Token and its staleness bounds; add/remove an opener | change a listed market's feed, times, bounds, seed, fee or caps |
| Opener (keeper hot wallet) | list a new market through the factory (the only creator HunchVPM accepts), paying the seed itself; owns the seed legs it paid for | change or close an existing market; touch anyone else's position |
| Anyone | resolve with the two proven rounds; void on proven staleness, a proven out-of-range price or a 24 h oracle pause; relay a bettor's signed entry; deliver claims and refunds to owners; sweep fees to the treasury | choose the outcome; send anyone's funds anywhere but to their owner |
| StockRoundResolver | settle its registered markets per the spec | anything else (it has no owner) |

The Safe is 2 of 3, and at launch the operator holds all three owner keys: treat its powers as one
person's. They are limited to the left column above; no key can move a bettor's stake or set a price.

## Contracts

| Contract | What it does |
|---|---|
| [`HunchVPM`](contracts/src/HunchVPM.sol) | The settler: the paper's reference `VestedParimutuel`, byte for byte, plus ten listed changes (fee on winners' gains, claims delivered to owners by anyone, per-market entry caps, an entries pause, gasless signed entry, views, events, same-block settlement finalize, vintage size cap, and factory-only market creation with a pause-only pauser). [`DIFF.md`](contracts/DIFF.md) is the literal diff; CI fails on any hunk not in the list |
| [`StockRoundResolver`](contracts/src/StockRoundResolver.sol) | UP/DOWN from two proven Chainlink rounds: each must be the last round at or before its bell. FLAT, proven staleness and a proven out-of-range price refund. No owner, no price input |
| [`HunchMarketFactory`](contracts/src/HunchMarketFactory.sol) | Lists a market in one transaction (seed, create, register spec, hand seed legs to the opener) and keeps an on-chain listing table. Owned by the Safe |

What the test suite proves, in [`contracts/test`](contracts/test): the settler equals the
reference on all 118 published conformance vectors and on fuzzed sequences when the fee is zero;
solvency, conservation, exits, pause scope, monotone accrual and signed-entry safety hold under
invariant fuzzing; only the unique "last round at or before T" pair can resolve a market
(property test against a brute-force scan); with entries paused every other function still
works; the whole flow runs against real USDG and real Chainlink feeds on a fork of chain 4663.
Slither runs in CI and every finding is triaged in [`SECURITY.md`](contracts/SECURITY.md).
Measured gas is in [`GAS.md`](contracts/GAS.md).

## Deployment

<!-- deployment:start -->
Network: Robinhood Chain mainnet (chain 4663). Status: **deployed** (2026-10-02T17:56:22Z). Source: `deployments/robinhood-mainnet.json`.

| What | Address |
|---|---|
| HunchVPM | [`0x1c23…3576`](https://robinhoodchain.blockscout.com/address/0x1c23356536eA8E30F53481b971098aC30DA43576) |
| StockRoundResolver | [`0xb333…7721`](https://robinhoodchain.blockscout.com/address/0xb3336ab62cB57841CDEA2CA43d62F2D2c5287721) |
| HunchMarketFactory | [`0x2Edc…6676`](https://robinhoodchain.blockscout.com/address/0x2EdcCA1e40AEACD3ef2d5FcBFEAC5B356e1b6676) |
| Safe (owner, guardian, treasury) | [`0x5866…F336`](https://robinhoodchain.blockscout.com/address/0x5866308Af35fA8AbD67f88d31695aD029143F336) |
| Keeper (opener, relayer) | [`0xEb42…b580`](https://robinhoodchain.blockscout.com/address/0xEb420AD181518814B6E3feb89A9d369Da3F5b580) |
| USDG | [`0x5fc5…d168`](https://robinhoodchain.blockscout.com/address/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) |
| NVDA Chainlink feed · Stock Token | [`0x379E…9F15`](https://robinhoodchain.blockscout.com/address/0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15) · [`0xd060…9EEC`](https://robinhoodchain.blockscout.com/address/0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC) |
| TSLA Chainlink feed · Stock Token | [`0x4A11…7C38`](https://robinhoodchain.blockscout.com/address/0x4A1166a659A55625345e9515b32adECea5547C38) · [`0x322F…3b2d`](https://robinhoodchain.blockscout.com/address/0x322F0929c4625eD5bAd873c95208D54E1c003b2d) |
| AAPL Chainlink feed · Stock Token | [`0x6B22…2cD0`](https://robinhoodchain.blockscout.com/address/0x6B22A786bAa607d76728168703a39Ea9C99f2cD0) · [`0xaF3D…93f9`](https://robinhoodchain.blockscout.com/address/0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9) |
| COIN Chainlink feed · Stock Token | [`0xA3a4…8Ef2`](https://robinhoodchain.blockscout.com/address/0xA3a468A452940B7D6b69991207B508c609a98Ef2) · [`0x6330…450b`](https://robinhoodchain.blockscout.com/address/0x6330D8C3178a418788dF01a47479c0ce7CCF450b) |
<!-- deployment:end -->

`deployments/robinhood-mainnet.json` is the only place an address is written; the web app,
the keeper and the table above are generated from it (`pnpm wire`, checked in CI).

Chain facts: Robinhood Chain mainnet (chain id 4663, Arbitrum Orbit on Ethereum, ArbOS 61),
RPC `https://rpc.mainnet.chain.robinhood.com`, explorer
[robinhoodchain.blockscout.com](https://robinhoodchain.blockscout.com). USDG
`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`. Feeds and Stock Tokens are listed in
[`docs/spec/04-markets-and-resolution.md`](docs/spec/04-markets-and-resolution.md) and were
measured before allow-listing ([`deployments/feeds-4663.json`](deployments/feeds-4663.json)).

## Repository

```
contracts/          Foundry: HunchVPM, StockRoundResolver, HunchMarketFactory, reference/, tests, deploy scripts
packages/client     @hunch-rh/client: chain 4663, ABIs, view-call reads, exact mechanism mirror, round finder, gasless typed data, NYSE calendar
packages/keeper     @hunch-rh/keeper: open, resolve, deliver, relay, health (pure decisions + runner + CLI)
apps/web            the venue (Next.js on Vercel): pages, /api reads, /api/relay/enter, /api/cron/[job]
deployments/        robinhood-mainnet.json (addresses), feeds-4663.json (feed measurements)
docs/               spec/, ARCHITECTURE, OPERATOR (deploy guide), RUNBOOK, FACTS
```

```bash
pnpm install
pnpm verify                      # forge build, forge test, diff and ABI/address drift checks, Slither, typecheck, vitest, next build
pnpm --filter @hunch-rh/web dev  # the venue against mainnet (read-only until deployed)
pnpm rehearse                    # deploy and run a full market on a local fork of chain 4663
```

The contracts are built and measured with **forge 1.8.4**, pinned: `bash scripts/forge.sh`
(or `pnpm forge`) runs that release even when another one is your default, and the gate fails
with the install command (`foundryup --install v1.8.4`) when it is missing. Gas figures and
the D9 ceilings depend on the release: [docs/spec/03-contracts.md](docs/spec/03-contracts.md#how-gas-is-measured-and-the-pinned-toolchain).

Deploying and operating the venue: [`docs/OPERATOR.md`](docs/OPERATOR.md) and
[`docs/RUNBOOK.md`](docs/RUNBOOK.md). Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
Where this goes next: [`VISION.md`](VISION.md).

## Provenance

| Before this build (pre-event, labelled) | Built in this repository |
|---|---|
| The paper, 2nd edition (2026-09-02); the reference `VestedParimutuel.sol`; 118 conformance vectors; the tape replay | `HunchVPM` (D1 to D9) and its differential, invariant and fork suites |
| The Arc venue `hunch-vpm` (2026-09-13): `ClassicParimutuel`, web, client and keeper skeleton, imported as this repository's first commit | `StockRoundResolver` (price-in-effect proofs; FLAT, stale and paused refunds) |
| | `HunchMarketFactory` for USDG and allow-listed feeds; Safe ownership; the Robinhood Chain deploy kit |
| | The stock-market catalogue, NYSE calendar keeper, proof-based auto-void, gasless relay, `/proof`, the early-vs-late proof card, the Robinhood Chain data layer, the country gate, `/start` |

## Eligibility and legal

Stock-price markets are **not offered to persons in the United States, Canada, the United
Kingdom or Switzerland**, the same list Robinhood applies to Stock Tokens. The venue blocks those
countries and asks every bettor to confirm eligibility; the contracts themselves are
permissionless, so the country block is a front-end control. Prediction markets are regulated
as gambling or as binary options in many places: use this only where it is legal for you. This
is beta software and has not been audited. Entries are capped at 100 USDG. Hunch is not
affiliated with Robinhood, Chainlink or Paxos.

## License

MIT
