# @hunch-vpm/agent

A demo agent for the Vested Parimutuel. It reads the book through The Graph, decides what
to do with it, and settles in USDC on Arc through a Circle Agent Wallet, paying for its
research with Gateway Nanopayments.

**That is what live mode does. The settlers are deployed to Arc testnet
(`deployments/arc-testnet.json`), but the agent has not run live yet.** Everything
described below has been exercised in dry-run — no key, no network, no contracts — which is
the default and the only mode that works today.

The interesting part is not that it trades. It is that the decision procedure is written
against the mechanism it is trading. A classic parimutuel pays every unit of stake the
same multiple regardless of when it landed, so an agent in one has nothing to think about
except the odds. Here a position is paid

```
s_i * (1 + A_o(T) - A_o(entry))
```

— its principal, plus everything that vested into its book *after* it arrived — and it is
accepted only up to the room the opposing books have to cover it. Both of those facts
change what a good decision looks like, and both of them show up as rules below.

Run it with nothing configured:

```
pnpm --filter @hunch-vpm/agent build
node agent/dist/cli/main.js run
```

No private key, no API key, no deployment, no network. Dry-run is the default and it
drives a full research → decide → enter → monitor → claim loop against fixtures.

---

## The decision procedure

Given one market, the agent's own bankroll and the current time, `decide()` in
[`src/policy/decide.ts`](src/policy/decide.ts) runs these steps in order and returns the
first answer it reaches. It is a pure function: same inputs, same output, no clock and no
I/O of its own. Every outcome it considered comes back in `Decision.candidates`, which is
what the `decide` command prints.

**1. The market must be open.** A resolved or voided market takes no stake.
→ `market-not-open`

**2. The freeze must not have passed.** `VestedParimutuel.enter` reverts `Frozen()` at or
after `resolutionTime`. → `frozen`

**3. The agent must be outside the freeze window.** With fewer than `freezeBufferSeconds`
(default 900) left, it refuses regardless of edge.

> This is the rule that says the agent understands what it is trading. Its payoff above
> principal is `A_o(T) - A_o(entry)` — money that lands *after* it. In the last few minutes
> almost nothing lands after, so a late entry carries the full outcome risk for a return
> close to 1x. In a classic pool this rule would be pointless, because late money and early
> money earn the same multiple. Here it is most of the edge.

→ `inside-freeze-window`

**4. A real share of the arrival window must remain.** The graded version of rule 3:
`vestingOutlook = secondsToFreeze / (resolutionTime - openedAt)` must be at least
`minVestingOutlook` (default 0.1). Assuming arrivals are roughly uniform over the market's
life, the share of total inflow still to come is the share of the window still to run.
→ `vesting-outlook-too-low`

**5. The agent must have its own estimate.** It buys spot and a volatility for the
market's feed and prices the digital itself:
`P(S_T >= K) = Phi((ln(S/K) - sigma^2 t / 2) / (sigma sqrt(t)))`, driftless, then maps it
through the spec's direction exactly the way `FeedResolver.winnerFor` does. If the market
is not binary, or the reading is older than the market's own `maxStaleness` bound, there is
no estimate and the agent abstains rather than guessing. Taking the book's own price as
evidence about the book would make step 6 vacuous. → `no-estimate`

**6. The bankroll must cover a minimum ticket.** → `bankroll-exhausted`

Then, for each outcome `o`:

**7. There must be headroom.** Entering `o` vests the stake into every *other* book, and
`_finalizeVintage` rations the entry by the tightest of them:
`H = min_{w != o} (C_w - V_w)`. If that is zero the stake is refused and refunded — not a
loss, but a round trip that buys nothing, so the agent does not make it. Note the
direction: a full book on the outcome being *entered* is no obstacle at all.
→ `no-headroom`

**8. The trust-weighted edge must clear the threshold.**

- Implied odds come off accepted principal: `q_o = P_o / Pi`.
- Raw edge is `p_o - q_o`.
- Counterparty trust is the principal-weighted ERC-8004 reputation of the books the agent
  is trading *against* — the ones that set the price it is disagreeing with — floored at
  `trustFloor` (default 0.25).
- Effective edge is `rawEdge * trust`, and it must be at least `minEdge` (default 0.03).

> A book held mostly by agents with no reputation is weaker evidence about the true
> probability than the same book held by agents with a record, so the agent requires more
> disagreement before acting on it. The floor exists because ERC-8004 reputation is opt-in
> and young: an unknown counterparty is unknown, not bad, and zeroing the edge against
> every anonymous book would make the agent refuse to trade in the market as it exists
> today. In the fixture set, `xau-2400-anon` is exactly this case — a 5.5-point raw edge
> that survives against trusted holders and does not survive against anonymous ones.

→ `edge-below-threshold`

**9. Size to the headroom that actually exists.** Three multiplicative factors, then two
hard caps:

```
conviction = min(effectiveEdge / edgeSaturation, 1)            how sure
fraction   = maxBankrollFraction * conviction * vestingOutlook  how much of the bankroll
target     = bankroll * fraction
roomCap    = headroom * headroomUtilisation                     how much will be accepted
stake      = min(target, roomCap, maxTicket, bankroll)
```

`headroomUtilisation` is 0.9 rather than 1.0 because headroom is read from an indexer that
lags the chain by at least a block and shrinks whenever anybody else enters. Asking for all
of it is asking for a partial fill. If the result is under `minTicket` the agent abstains
instead of paying for a dust entry. → `below-min-ticket`

**10. Choose.** Among the outcomes that survived: largest effective edge, then the book with
the most room to accept, then the lower outcome index so the answer is stable. If none
survived, the reported reason is the closest miss — `below-min-ticket` over
`edge-below-threshold` over `no-headroom` — so the operator learns which knob was binding.

### One rule that lives in the loop, not in `decide`

The loop does not average into a market it already holds. Sizing happens once, on the
information available then; a second entry in the same market is a second decision wearing
the first one's clothes, and it makes the transcript much harder to read. `decide` stays
per-market and pure; the filter is in [`src/loop.ts`](src/loop.ts).

### The knobs

| Setting | Default | Environment variable |
|---|---|---|
| `minEdge` | 0.03 | `HUNCH_MIN_EDGE` |
| `edgeSaturation` | 0.15 | `HUNCH_EDGE_SATURATION` |
| `freezeBufferSeconds` | 900 | `HUNCH_FREEZE_BUFFER_S` |
| `minVestingOutlook` | 0.1 | `HUNCH_MIN_VESTING_OUTLOOK` |
| `trustFloor` | 0.25 | `HUNCH_TRUST_FLOOR` |
| `maxBankrollFraction` | 0.2 | `HUNCH_MAX_BANKROLL_FRACTION` |
| `headroomUtilisation` | 0.9 | `HUNCH_HEADROOM_UTILISATION` |
| `maxTicket` | 250 USDC | `HUNCH_MAX_TICKET_USDC` |
| `minTicket` | 1 USDC | `HUNCH_MIN_TICKET_USDC` |

A malformed override keeps the default rather than stopping the agent. It does not do so
quietly: every knob above appears in the startup banner with the value that actually took
effect, and any variable whose value could not be read is named on stderr as ignored. A
typo does not look like a correct run.

---

## The loop

```
research -> decide -> enter -> monitor -> claim
```

**research** reads every market and buys one quote per *distinct feed*, not per market: two
markets on the same feed are two questions about one observation, which is both cheaper and
more consistent. A settled market is skipped — the agent does not pay for data it cannot
act on, and does not price a question that is already answered.

**decide** is the procedure above.

**enter** builds an allowance with the client's `approveCalldata()` and the entry with its
`enterCalldata()`, and sends both through the wallet. Acceptance is deliberately left
unknown at this point: vintages finalize lazily, so no entering transaction can know how
much of its offer the books took.

**monitor** reads `vestingEarned(positionId)` and prints the multiple each position has
accrued so far. This is the number that does not exist in a classic pool.

**claim** asks `claimable(wallet)` and sends whichever settler call the indexer says pays:
`claim` for a resolved or voided position, `withdrawRefund` for a remainder the books
refused.

---

## What a run looks like

Trimmed from `node agent/dist/cli/main.js run --rounds 3`, dry-run, 1000 USDC bankroll:

```
--- round 1 -----------------------------------------------

research  5 paid quote(s), 1250 µUSDC (0.00125 USDC) authorized
  market                    pool      headroom  book odds -> own estimate
  btc-72k               10000.00     119900.00  above 42.0%->88.3%   below 58.0%->11.7%
  eth-3200-late          2500.00      25600.00  above 36.0%->100.0%  below 64.0%->0.0%
  sol-180-full           1400.00          0.00  above 50.0%->100.0%  below 50.0%->0.0%
  xau-2400-anon          3000.00      12600.00  above 83.3%->88.8%   below 16.7%->11.2%
  eur-ranked-3way        1400.00     unbounded  3-way market: the digital model prices one threshold
  btc-68k-short          3000.00      43800.00  above 50.0%->100.0%  below 50.0%->0.0%

decide    btc-72k  ENTER outcome 0 for 184.615385 USDC
  86400s to freeze, 92.3% of the arrival window still ahead
  outcome        book      own     edge   trust  eff.edge      headroom       stake  verdict
  above         42.0%    88.3%    46.3%    0.71     32.9%     169100.00  184.615385  chosen
  below         58.0%    11.7%   -46.3%    0.68    -31.5%     119900.00        0.00  edge-below-threshold

decide    eth-3200-late    abstain (inside-freeze-window)   240s to freeze
decide    sol-180-full     abstain (no-headroom)            both books at 0.00 headroom
decide    xau-2400-anon    abstain (edge-below-threshold)   5.5% raw edge * 0.25 trust = 1.4%
decide    eur-ranked-3way  abstain (no-estimate)            3-way market

--- round 3 -----------------------------------------------

monitor
  p1    btc-72k        outcome 0  accepted 184.615385  vested in 18.121706  = 1.0982x if it wins
  p2    btc-68k-short  outcome 0  accepted 180.00      vested in 47.525859  = 1.2640x if it wins

nanopayments  13 authorization(s) for 13 paid quote(s), 3250 µUSDC (0.00325 USDC) total,
              settled in 1 on-chain payment

claim
  p2    payout 227.525859  refund 0.00  confirmed

balance   1000.00 -> 862.910474 USDC
```

Two things worth reading twice. The position entered early on `btc-68k-short` was worth
1.2640x its principal before the market resolved, purely from stake that arrived after it —
that is the mechanism, visible. And thirteen paid research calls cost 3250 USDC base units
(0.00325 USDC, about a third of a cent) in total and settled in one transaction; per-call
on-chain settlement would have been thirteen transactions, each one paying Arc gas to move
250 base units.

---

## Circle Agent Stack

Both integrations sit behind small interfaces in [`src/circle/types.ts`](src/circle/types.ts),
with a live implementation and a dry-run one. Dry-run is the default, needs no key and no
network, and is what the tests and the demo run.

**Custody — Circle Agent Wallets.** The agent holds no private key in either mode. Live
custody is a developer-controlled wallet: the agent has an API key and an entity secret
supplied *already encrypted* (`CIRCLE_ENTITY_SECRET_CIPHERTEXT`), so the raw secret never
enters this process and there is nothing here that could be logged by accident. The
`ConsoleLogger` is additionally constructed with whatever secret values the process holds
and replaces them with `***` before writing anything, as a backstop for errors raised
elsewhere.

**Paid research — Gateway Nanopayments.** One authorization per intel call, one settlement
per loop. A quote is priced at 250 µUSDC. USDC is 6 decimals, so a micro-USDC *is* a USDC
base unit: that is 250 base units, 0.00025 USDC, and the chain can move it perfectly well.
What it cannot do cheaply is move it one payment at a time — Arc gas for a transaction
dwarfs a quarter-thousandth of a dollar by orders of magnitude. Batching the authorizations
into one settlement is what makes a loop that re-reads the feed every round economical at
all, rather than one that reads it once a day and hopes.

`GatewayNanopayments.settle()` clears its outstanding authorizations only after the
settlement call returns, so a failed settle leaves them to be retried on the next loop
rather than dropping them.

---

## Configuration

Nothing below is required in dry-run.

| Variable | Meaning |
|---|---|
| `HUNCH_MODE` | `dry-run` (default) or `live` |
| `HUNCH_CHAIN` | `arc-testnet` (default, chainId 5042002) or `arc` (5042) |
| `HUNCH_SETTLER` | deployed `VestedParimutuel`. Required in live mode |
| `HUNCH_MARKET_IDS` | comma-separated markets to watch. Required in live mode |
| `HUNCH_SUBGRAPH_URL` | subgraph endpoint the client reads |
| `HUNCH_INTEL_URL` | the paid quote endpoint. Required in live mode |
| `HUNCH_RPC_URL` | overrides the chain default |
| `CIRCLE_API_KEY` | Circle API key |
| `CIRCLE_WALLET_ID` | which developer-controlled wallet to use |
| `CIRCLE_ENTITY_SECRET_CIPHERTEXT` | the entity secret, pre-encrypted |
| `GATEWAY_API_KEY`, `GATEWAY_ACCOUNT_ID` | nanopayment channel |
| `HUNCH_DRY_RUN_BANKROLL` | starting balance for the dry-run wallet (default 1000) |
| `HUNCH_DRY_RUN_SEED` | seed for dry-run addresses and hashes |
| `HUNCH_ROUNDS` | rounds per `run` (default 3) |
| `HUNCH_DEMO_TICK_S` | simulated seconds per round in dry-run (default 2700) |

USDC is the stake asset *and* the gas token on Arc, at
`0x3600000000000000000000000000000000000000`, 6 decimals through the ERC-20 interface. The
settler still defaults to the zero address, and live mode refuses to start until
`HUNCH_SETTLER` names a real one. On Arc testnet, from `deployments/arc-testnet.json`:

```sh
HUNCH_SETTLER=0xC743940C75619f65F6178b7e49c0C3A0bE012Eec
HUNCH_MARKET_IDS=0xc743940c75619f65f6178b7e49c0c3a0be012eec-0,0xc743940c75619f65f6178b7e49c0c3a0be012eec-1
HUNCH_SUBGRAPH_URL=https://api.studio.thegraph.com/query/1760242/hunch-vpm-arc-testnet/v0.0.1
```

---

## Commands

```
hunch-agent research        read every market, buy one quote per feed, print the book
hunch-agent decide          the same, plus a decision table per market that has one
hunch-agent run             research -> decide -> enter -> monitor -> claim
hunch-agent claim           settle whatever the resolved markets owe this wallet
```

Flags: `--rounds N`, `--bankroll USDC`, `--fixtures PATH`, `--market ID` (repeatable),
`--live`, `--dry-run`, `--json`.

A market gets a table only when the procedure reached the per-outcome arithmetic. The three
early exits — `market-not-open`, `inside-freeze-window` and `no-estimate` — print the `decide`
header and the subject line and stop, because there is nothing per-outcome to show. On the
committed fixtures that is two of the six markets, so `decide` prints four tables. The table
itself is 105 columns; the widest line either command prints is the closing `nanopayments`
summary at 187, because it carries a full transaction hash.

---

## Layout

```
src/
  domain/       types mirroring the contracts, exact money arithmetic, the digital model
  policy/       the decision procedure and its knobs — pure, no I/O
  intel/        the paid quote providers and the nanopayment meter around them
  circle/       custody and nanopayments: interfaces, dry-run pair, live pair, HTTP
  research/     the ResearchSource and Venue ports, the fixture world, the Graph adapter
  cli/          argument parsing and the four commands
  loop.ts       research -> decide -> enter -> monitor -> claim
  render.ts     results to lines, kept away from the logic
fixtures/
  markets.json  six markets, one per branch of the decision procedure
```

### Design notes

**`@hunch-vpm/client` is bound at runtime, through its factory.** The agent declares the ten
functions it needs in [`src/research/client-binding.ts`](src/research/client-binding.ts) and
resolves the package on first live use. Dry-run therefore works with nothing installed, and
the coupling between the two packages is one readable file rather than an implicit import
graph.

The binding goes through `createHunchClient(config)` and never through the module
namespace. That package exports both shapes under the same names: the factory's methods
take `(marketId, options?)`, while the module-level exports are config-first free functions,
`marketBook(config, marketId, options)`. A namespace would pass any check that only looks
for names present and then be called with the market id where the config belongs, so
`assertClientSurface` refuses one outright and the loader fails by name when no factory is
exported. The config it builds is the package's own: the settler goes in
`addresses.vestedParimutuel`, where the write helpers read it, and the chain is the
package's own chain object picked by id.

The shapes expected back from each call are documented beside their decoders in
[`src/research/graph-source.ts`](src/research/graph-source.ts), and they are the shapes the
client returns today. If its responses move, that file is the only thing to change, and a
mismatch surfaces as an error naming the field rather than as a wrong number. Two places
where the two packages do not line up are handled explicitly rather than papered over:

- The client answers the counterparty question the way the agent asks it — `sides[o]` is
  who is against you if you take `o` — so that figure is carried as
  `MarketSnapshot.opposingTrust` and used as given. Deriving an opposing figure from it
  again would flip it twice and hand each outcome its own side's reputation.
- The market's opening time — the denominator of rule 4's arrival window — is
  `Market.createdAt` in the subgraph and `createdAt` on the client's `MarketBook`; the
  agent calls it `openedAt` and reads either name. A source that publishes neither fails
  by name rather than assuming a window and quietly resizing every stake.
  `test/client-integration.test.ts` decodes a `MarketBook` the client itself builds, from
  the client's own recorded subgraph response, so a field that goes missing on one side of
  this seam fails on the other instead of in a live run.

**Entering is two calls, not one.** `VestedParimutuel.enter` pulls the stake with
`transferFrom`, so the venue sends the client's `approveCalldata` before its
`enterCalldata`, and passes the settler's own market index — not the indexer's
`<settler>-<index>` id — because that is what the contract's signature takes. Claiming
dispatches on what the indexer says pays: `claim` settles a resolved or voided position,
`withdrawRefund` pulls back a refused remainder while the market is still open, and sending
the wrong one reverts.

**`bestHeadroom` and `impliedOdds` are read but not trusted.** The policy recomputes both
from the books it already has. The client's answers are a cross-check: if they disagree, the
indexer is serving two inconsistent views of one market, and that is worth a warning before
staking anything on either. `bestHeadroom` reports two different quantities and both are
checked separately — an outcome's own room `C_o - V_o`, and the binding headroom
`min_{w != o} (C_w - V_w)` that actually rations an entry. Reputation gets the same
treatment for the opposite reason: an unreadable trust response degrades to the trust
floor, because trust discounts the edge rather than gating the read.

**The fixture world is not the contract.** `src/research/fixture-world.ts` models
`VestedParimutuel` for the case where each entry is alone in its vintage, which is what
happens in a simulation with no concurrency. It reproduces Rule 1 (vest into the opposing
books on arrival), Rule 2 (accept only up to their headroom), the accumulator, the payout
formula and `FeedResolver`'s resolution rule. It does not reproduce same-vintage rationing,
and it is not a substitute for the Foundry tests in `contracts/`. It exists so the agent can
be developed and demonstrated against something that behaves like the settler.

---

## Tests

```
pnpm --filter @hunch-vpm/agent test
```

181 tests in 10 files, no network, no key, no fixtures that expire. `test/loop.test.ts` and
`test/cli.test.ts` pass a `fetch` that throws, so any network call in the dry-run path is a
failure rather than a slow test.

Coverage worth naming:

- **`test/decide.test.ts`** — one describe block per step of the procedure, including that
  it refuses to enter with no headroom, refuses inside the freeze window, refuses when the
  arrival window is nearly gone, enters an outcome whose *own* book is full, and reaches
  opposite verdicts on the same book depending only on its holders' ERC-8004 history.
- **`test/fixture-world.test.ts`** — the mechanism itself: a stake vests into the opposing
  books and not its own, an earlier position is paid out of a later one, early money earns
  more than late money, and an over-sized offer is partially accepted with the remainder
  refused rather than the call failing.
- **`test/loop.test.ts`** — the whole loop against the shipped fixtures, asserting the
  balance identity `closing = opening - staked + returned` end to end.
- **`test/graph-source.test.ts`** — the live seam against fixtures shaped like what
  `@hunch-vpm/client` actually returns: that a module namespace is refused even though it
  carries every required name, that counterparty trust keeps its orientation, that the
  venue approves before it enters and passes the settler's own market index, and that a
  missing method or a lossy float integer is reported by name.
- **`test/circle.test.ts`** — the dry-run pair, that the live adapters refuse to construct
  without credentials instead of failing mid-loop, that Circle's decimal-string amounts
  round-trip in both directions, and that the logger scrubs secrets.
