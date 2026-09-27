# @hunch-vpm/client

Typed reads from The Graph and unsigned writes through viem, for the Vested Parimutuel on Arc.

**This package never holds a private key and never signs anything.** Every write helper returns
unsigned calldata — `{ to, data, value }` — for the caller's own wallet to sign and send. There is
no signing helper here and there will not be one. The venue does not custody either: stake goes
from your wallet into the settler's escrow and comes back to you by pull.

Every read is meant to be a **decision, not a row**. An agent asking "where can I put money" gets
an answer, not a table it has to reduce itself.

## Headroom, for someone who has not read the paper

In a classic parimutuel pool, every unit of stake pays the same multiple whether it arrived in the
first minute or the last. This settler does not work that way. The moment your stake is accepted it
**vests into the opposing books** — it starts paying the people who took the other side, and the
stake that came before yours starts paying you. That only works if the other side can actually
cover what you have just put against them, so each book is given a **capacity**: `C = kappa * P`,
kappa times the principal already backing that outcome. **Headroom** is the room a book has left,
`H = C - V` — its capacity minus everything already vested into it.

The consequence you have to hold on to is this: **the headroom that limits you is not your
outcome's, it is the other outcomes'.** Staking on "yes" vests into the "no" book, so how much of
your stake is accepted depends on how much room "no" has left. If you offer more than that, the
excess is not an error and the transaction does not fail — the books simply **refuse** the excess and
it becomes refundable. `bestHeadroom` exists so you never have to find that out afterwards.

## Install

**This package is not published to npm.** `pnpm add @hunch-vpm/client` answers 404 from the
registry. Publishing has not been done, and until it is, install from a checkout.

Inside this workspace, which is how `agent`, `packages/mcp` and `apps/web` consume it:

```jsonc
// package.json
"dependencies": { "@hunch-vpm/client": "workspace:*" }
```

From a repository of your own, build it once and add it by path:

```bash
pnpm --filter @hunch-vpm/client build          # writes dist/, which is gitignored
cd ../your-product && pnpm add file:../hunch-vpm/packages/client
```

The build is not optional — `files` ships only `dist` and this README, and there is no
`prepare` script, so a `file:` install of an unbuilt checkout resolves to nothing.

## Configuration

```ts
import { createHunchClient, arcTestnet } from '@hunch-vpm/client';

const client = createHunchClient({
  // Either a full endpoint...
  subgraphUrl: 'https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>',
  // ...or a Studio id plus a key, and the client builds that URL for you:
  // subgraphId: '<SUBGRAPH_ID>', apiKey: process.env.GRAPH_API_KEY,
  erc8004SubgraphId: '<ERC8004_SUBGRAPH_ID>',
  chain: arcTestnet,                       // the default
  addresses: { vestedParimutuel: '0x…' },  // merged over the chain's defaults
});
```

The Graph's gateway takes the API key as a **path segment**, not a header:

```
https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>
```

Which means the URL itself is a credential. Keep it server-side, keep it out of logs, and do not
ship it in a browser bundle. `gatewayUrl(apiKey, subgraphId)` is exported if you want to build it
yourself. Errors raised by this package deliberately omit the URL from their message, though it is
still on the error object as `.url` for debugging.

### Chain and address defaults

Arc testnet (`chainId 5042002`, RPC `https://rpc.testnet.arc.io`, explorer
`https://testnet.arcscan.app`) is the default chain. USDC is Arc's **native gas token**, exposed
behind the ERC-20 interface at `0x3600000000000000000000000000000000000000` with 6 decimals.

On Arc testnet every default is real: the ERC-8004 registries, and our own `vestedParimutuel`,
`classicParimutuel`, `marketFactory` and `feedResolver`, carried in from
`deployments/arc-testnet.json` by `pnpm wire:testnet` (the tests pin them to that file). **Arc
mainnet is not deployed**, so its defaults are the zero placeholder, and building calldata against
a placeholder throws rather than producing a transaction to nowhere.

### Reading the open vintage

`readOpenVintage` (default `true`) decides whether a market read also pulls the vintage that is
buffered right now and the entries queued in it. That is what lets the client subtract stake
already offered against the book you need in this block — the difference between "this much will
be accepted" and "this much would be accepted if nobody else were in the same block". It costs one
nested selection per market read. Turn it off and the client sets `demandUnknown: true` on every
read it affects, rather than quietly handing you an upper bound.

## Amounts

Every token amount is a `bigint` in the asset's smallest unit. Nothing is ever converted to a JS
`number` — 10 billion USDC is past `Number.MAX_SAFE_INTEGER`, and a float round-trip silently moves
money. Formatting is done by digit surgery and loses nothing:

```ts
import { formatUsdc, parseUsdc } from '@hunch-vpm/client';

formatUsdc(107_000000n);                        // "107"
formatUsdc(1_500000n, { trailingZeros: true }); // "1.500000"
parseUsdc('1.5');                               // 1500000n
parseUsdc('1.0000005');                         // throws — it will not silently truncate
```

Ratios (probabilities, shares) are integers in **parts per million**, floored. `ppmToPercent` turns
one into a four-decimal percent string.

---

# Reads

The examples below all run against the same market, which is the one in this package's test
fixtures: a binary market with `kappa = 30`, 6 USDC of principal on outcome 0 and 101 USDC on
outcome 1, with 101 USDC vested into book 0 and 6 USDC vested into book 1.

Reads take a **subgraph id** (`<settler>-<index>`); writes take the settler's own numeric index.
`marketBook` reports both.

## `bestHeadroom(marketId)`

Which outcome still has capacity, how much, and the largest stake that would be accepted in full.

```ts
const room = await client.bestHeadroom('0x1111…1111-0');

room.best.outcome;             // 0
room.best.bindingHeadroom;     // 3_024_000000n — book 1's room, which is what caps a stake on 0
room.best.bindingOutcome;      // 1
room.best.maxFullyAccepted;    // 3_024_000000n — offer this or less and none of it is refused
room.outcomes[1].maxFullyAccepted; // 79_000000n — the other direction is far tighter
room.frozen;                   // false
```

`maxFullyAccepted` already accounts for stake queued **in the current block**. Entries that land in
the same block form one *vintage* and ration against each other, so if 50 USDC is already offered
against the book you need, the largest stake that still gets in whole is `headroom - 50`. A vintage
left open by an *earlier* block is not competition — the transaction you send finalizes it first —
and the client does not subtract it.

`bindingOutcome`, `bindingHeadroom` and `competingDemand` all describe the **same** opposing book:
the one with the least room left once its queue is counted, so that
`bindingHeadroom - competingDemand` is `maxFullyAccepted` and the answer can be audited. On a market
with three or more outcomes that is not always the book with the smallest raw headroom — a roomier
book with a long queue can be the tighter one. Every opposing book is in `room.best.opposing` with
its own headroom, queue and allowance if you want to see the whole picture.

`null` means unbounded: with `kappa` unbounded (the prescription for n-way markets) there is no
capacity ceiling and no stake is refused for want of headroom. `best` is `null` when the market
takes no stake at all — frozen, settled, or every outcome fully rationed.

## `impliedOdds(marketId)`

Implied probability per outcome, from **accepted principal**. There is no order book here and
nothing quotes a price; what an outcome's odds mean is arithmetic on the money that is down.

```ts
const odds = await client.impliedOdds('0x1111…1111-0');

odds.totalAccepted;                     // 107_000000n
odds.outcomes[0].probabilityPpm;        // 56_074n
odds.outcomes[0].probabilityPercent;    // "5.6074"
odds.outcomes[0].decimalOddsPpm;        // 17_833333n — 17.833333x gross on a winning unit
odds.defined;                           // false if nothing is staked at all
```

Offered-but-refused stake is excluded: it never became anyone's counterparty and it is refundable,
so counting it would read as conviction that does not exist. The probabilities are floored and so
sum to slightly under 1e6 ppm — that gap is rounding, not a house edge.

## `counterpartyTrust(marketId)`

ERC-8004 reputation of the wallets on the other side, aggregated. `sides[o]` answers "if I take
outcome `o`, who is against me".

```ts
const trust = await client.counterpartyTrust('0x1111…1111-0');
const against = trust.sides[0];

against.opposingPrincipal;    // 101_000000n held on every other outcome
against.counterparties;       // 2 distinct wallets
against.ratedCounterparties;  // 1
against.meanScore;            // 90 — one wallet one vote, over rated wallets only
against.principalWeightedMeanScore; // 90 — weighted by how much each holds
against.unratedSharePpm;      // 9_900n — 0.99% of the money against you is anonymous
against.wallets;              // every counterparty, largest principal first
```

Read `unratedSharePpm` before `meanScore`. A mean of 90 over a side that is 90% wallets the
registry has never heard of is not a signal. A wallet that is *registered but has no feedback* is
reported as unrated (`meanScore: null`), not as a zero — "nobody has vouched for this" and "people
rated this badly" are different statements.

A venue wallet is matched to an ERC-8004 identity by either of the two addresses an identity
carries: `agentWallet`, the address it signs and transacts as, and `owner`, the holder of the
identity NFT. Which one appears as a position owner depends on how the agent is wired, so both are
looked up and `agentWallet` wins if one identity answers to both.

Without `erc8004SubgraphUrl` (or `erc8004SubgraphId` plus `apiKey`) the read still works but every
wallet counts as unrated and `reputationUnavailable` is `true`. Pass `{ reputation }` to swap in
your own lookup — a cache, or a differently-shaped deployment of the standardized schema.

## `vestingEarned(positionId)`

What has already vested to one position.

```ts
const vesting = await client.vestingEarned('0x1111…1111-2');

vesting.accepted;             // 5_000000n — what the books took
vesting.refused;              // 0n — what they did not, refundable
vesting.earned;               // 83_333333n — vested to this position since it entered
vesting.payoutIfOutcomeWins;  // 88_333333n — principal plus that
vesting.state;                // 'open' | 'won' | 'lost' | 'voided' | 'claimed' | 'pending-vintage'
vesting.claimableNow;         // what `claim` or `withdrawRefund` would pay this second
```

A position is priced by two numbers: the principal the books accepted, and the accumulator of its
own outcome at the moment it entered. Everything that vested into that book afterwards is credited
in proportion — `floor(accepted * (A_now - A_entry) / 1e18)` — which is exactly the settler's
`previewPayout` once you add the principal back.

Before the position's vintage is finalized, `earned` and `payoutIfOutcomeWins` are `null`. How much
the books accepted is not fixed until the settler rations that vintage, so there is no honest answer
to give yet.

On a **classic** market `earned` is `null` too — nothing vests there, ever, and a `0` would read as
"nothing has vested yet" on a market where nothing ever will. `payoutIfOutcomeWins` is still
defined: it is the flat pool share the classic rule pays.

## `positions(wallet)`

Everything a wallet holds or has held, across every market, newest first.

```ts
const held = await client.positions('0x2222…2222');

for (const position of held.positions) {
  position.market;     // the market it sits in, decoded in full
  position.createdAt;  // unix seconds the entry landed
  position.finalized;  // whether `accepted` is fixed yet
  position.claimed;    // claimed positions are listed too
}
held.index.block;      // the index head this answer was read at
```

This is the portfolio question, and it is wider than `claimable` on purpose. A wallet with three
live positions and nothing settled has nothing to claim, and an empty claim list reads as money
gone — so nothing is filtered out here: open, unfinalized, settled and claimed positions are all
listed. Use `claimable` for what can be pulled right now, and the rail's `positions` verb when you
want each one priced.

The collection is paged by `id`, which is stable under `skip`, and ordered by entry time once it is
all in; two entries from the same block fall back to the settler's position order.

## `claimable(wallet)`

Everything ready to pull, across every market, with totals.

```ts
const ready = await client.claimable('0x2222…2222');

ready.totals.total;             // 23_666667n
ready.totals.settlement;        // 18_666666n
ready.totals.voidRefund;        // 1_000000n
ready.totals.refusedRemainder;  // 4_000000n
ready.totals.residue;           // 1n

for (const item of ready.items) {
  // one item == one transaction
  const call =
    item.call === 'claim' ? client.claimCalldata({ positionId: item.argument, settler: item.settler })
    : item.call === 'withdrawRefund' ? client.withdrawRefundCalldata({ positionId: item.argument, settler: item.settler })
    : client.claimResidueCalldata({ marketId: item.argument, settler: item.settler });
  // sign and send `call` with your own wallet
}
```

Four different things can be owed and they are reported separately: a settlement on a market that
resolved your way, a refund on a market that voided, the part of a stake the books refused, and
residue if you are a market's named residue owner. There is exactly **one item per transaction** —
`claim` pays a settlement and any outstanding refused remainder together, and sending it twice
reverts, so the client never emits two items for one position.

While a market is still open the only thing pullable is the refused remainder, and `claim` would
revert, so the item names `withdrawRefund` instead.

`blockedResidue` lists residue you own that the settler will not release yet, because a winning
position has not claimed. Two numbers, and they are not the same money:

```ts
ready.blockedResidue[0].atMostAmount; // 18_666667n — everything still unpaid in that market
ready.blockedResidue[0].amount;       // 1n — the residue; the rest is one winner's settlement
ready.blockedResidue[0].isUpperBound; // false
```

Residue is the flooring remainder, `accepted pool - payouts`, and the settler cannot compute it
before the last winner claims. The index can: it publishes each outstanding winner's
`previewPayout`, so `amount` is what is left once they are all paid — the actual residue.
`atMostAmount` is the cruder `acceptedPool - paidOut`, which is that residue plus other people's
settlements and is only what you receive if every winner claims first. `isUpperBound` is `true` in
the one case where the outstanding winners are too many to walk, and `amount` falls back to
`atMostAmount` with the reason saying so.

## `marketBook(marketId)`

The full book. This is the one read that is a table rather than a decision — a UI needs one, and an
agent that disagrees with the client's reduction should be able to see the inputs.

```ts
const book = await client.marketBook('0x1111…1111-0');

book.books[0].principal;        // 6_000000n
book.books[0].vested;           // 101_000000n
book.books[0].capacity;         // 180_000000n   (null when kappa is unbounded)
book.books[0].headroom;         // 79_000000n    — this book's own room
book.books[0].maxFullyAccepted; // 3_024_000000n — what a stake ON outcome 0 needs, i.e. book 1's
book.books[0].probabilityPercent; // "5.6074"

book.secondsToFreeze;  // counts down, floored at 0
book.frozen;           // true once no entry can be accepted
book.voidableFrom;     // resolutionTime + voidTimeout
book.residue;          // 0 until it resolves; an upper bound until the last winner claims
book.books[0].live;    // winners still to claim — only on the winning book of a resolved market
book.spec;             // { oracle, feedKey, strike, direction: 'above' | 'below', maxStaleness }
book.resolvedPrice;    // what it settled on, at 8 decimals
book.voidedStaleAge;   // how old the reading was, when that is why it voided
```

`headroom` and `maxFullyAccepted` on the same book are different numbers and both matter: the first
is what this book can still absorb, the second is what a stake on this outcome can be, which is
governed by the *other* books.

---

# Writes

All of these return `{ to, data, value }` with `value: 0n`. Stake moves through the ERC-20 interface
even though USDC is Arc's gas token, so no call here carries native value. Sign and send them
yourself.

## `enterCalldata`

```ts
// The settler pulls with transferFrom, so an allowance has to exist first.
const approval = client.approveCalldata({ spender: client.config.addresses.vestedParimutuel, amount: 25_000000n });
const entry = client.enterCalldata({ marketId: 0n, outcome: 1, amount: 25_000000n });
```

`marketId` here is the **settler's** index (`marketBook(...).onChainMarketId`), not the subgraph id.
An amount above `maxFullyAccepted` is not rejected — it is accepted in part and the rest becomes
withdrawable — but the helper does reject a zero stake, an out-of-range outcome, and an amount
larger than the uint128 the settler packs positions into.

## `claimCalldata` / `withdrawRefundCalldata`

```ts
client.claimCalldata({ positionId: 12n });          // settlement + any outstanding remainder
client.withdrawRefundCalldata({ positionId: 12n }); // just the remainder, market still open
client.claimResidueCalldata({ marketId: 6n });      // residue owner only, after the last winner claims
```

## `openMarketCalldata`

Opens the market and registers how it resolves, in one transaction — both or neither. A market whose
resolution spec is registered later has a window in which stake can land against rules nobody has
committed to; the factory closes it.

```ts
const open = client.openMarketCalldata({
  seed: [1_000000n, 1_000000n],   // offered per outcome; every leg must be positive
  kappa: 30n,                     // or null for unbounded, the n-way prescription
  resolutionTime: 1_760_000_000n, // the freeze, fixed at creation and never movable
  voidTimeout: 86_400n,           // after this, anyone may void an unresolved market
  residueOwner: '0x2222…2222',
  feed: {
    oracle: client.config.addresses.storkOracle,
    feedKey: '0xbb…bb',           // 32 bytes, adapter-defined
    strike: 300_000000000n,       // 8 decimals — 3000.00000000
    direction: 'above',           // outcome 0 wins at or above the strike
    maxStaleness: 300n,           // a reading older than this voids instead of resolving
  },
});
```

The factory pulls the whole offered seed, keeps what the settler accepts, hands the seed positions
to you and returns the rest — so an asymmetric seed only costs what the capacity rule lets it cost.
Approve the **factory** for the seed total before calling this.

---

## The schema this client queries

Two schemas, both in this repository: `subgraph/schema.graphql` for the venue and
`subgraph-erc8004-arc/schema.graphql` for reputation. They are the contract, and
`test/schema.test.ts` holds this package to it — every document `src/queries.ts` produces is
checked field by field against that SDL, so a selection that could not run fails the suite rather
than the deployment. Read those two files for the authoritative field list; what follows is only
where this package's names differ from theirs, and why.

| in the schema | in this package | why |
| --- | --- | --- |
| `Market.n: Int!` | `Market.outcomeCount` | `n` is the paper's notation, not an API name |
| `specId`, `oracle`, `feedKey`, `strike`, `direction`, `maxStaleness` flat on `Market` | `Market.spec: ResolutionSpec \| null` | either the whole spec is registered or none of it is |
| `MarketStatus` `OPEN` / `RESOLVED` / `VOIDED` | `'Open' \| 'Resolved' \| 'Voided'` | reads better in application code |
| `SettlerKind` `VESTED` / `CLASSIC` | `'vested' \| 'classic'` | same |
| `FeedDirection` `ABOVE` / `BELOW` | `'above' \| 'below'` | same |
| `kappa: -1` with `kappaIsUnbounded: true` | `kappa: null` | a sentinel that survives into arithmetic is a bug waiting to be a wrong number |
| `Book.capacity: -1` with `capacityIsUnbounded: true` | `capacity: null` | same, and the boolean is what the decoder branches on |
| `Position.owner: Agent!` | `owner: Address` | a relation in the schema: selected as `owner { id }`, filtered by that id as a `String` |
| `Position.vintage: Vintage` | `vintage: bigint \| null` | the vintage's block number; `null` on a classic position |
| `Market.openVintage: Vintage` | `vintageOpen`, `vintageBlock`, `Book.demand` | see below |

**There is no `Book.demand` and no `Book.live` in the schema, and this client does not pretend
there is.** Both are reconstructed:

- *Demand.* The settler's `D_w` is transient storage, zeroed the moment a vintage is applied, so
  the index cannot publish it. It is exactly recoverable from the open vintage's entries: an entry
  offering `c` on outcome `o` is demand `c` against every book except `o`, so `D_w` is the
  vintage's total offered less what was offered on `w` itself. If the vintage cannot be read whole
  — more entries than one page holds, or a total that does not add up — `demand` is `null` and
  `demandUnknown` is set, because an understated demand overstates the room.
- *The residue gate.* `claimResidue` reverts while any winning position with accepted principal
  has not claimed. That is a positions query, not a field: `claimable` and `marketBook` count them
  directly, and `claimable` also sums their `previewPayout`, which is what makes the residue
  knowable before they claim rather than only afterwards.

The index publishes `Book.headroom` and `Book.impliedOdds` pre-reduced; this client recomputes both
from `principal`/`vested`/`capacity`, so one source of truth governs a staking decision and a
partially-synced index cannot hand it a derived number computed against a different state. It does
take `Position.previewPayout` and `Market.residue` as given, because those are the settler's own
per-rule arithmetic — `previewPayout` is a pool share on a classic market and a vesting payout on a
vested one, and reimplementing that fork here would be two chances to disagree with the contract
instead of one.

**ERC-8004.** `Agent` is keyed `<caip2>/agent/<agentId>` and has **no** `address` field. An identity
carries two addresses instead: `agentWallet`, the address the agent signs and transacts as, and
`owner`, the holder of the identity NFT. Either can be the wallet that appears as a position owner,
so `counterpartyTrust` asks the registry for both and prefers the `agentWallet` match. Reputation
comes from the registry's own aggregates over non-revoked feedback — `activeFeedbackCount` and
`averageScore`, both `BigDecimal` for the score, because ERC-8004 rescales a score by its own
`valueDecimals` and a mean of 4.6 is a normal value. Pass your own `reputation` lookup if your
deployment shapes any of this differently.

### Index lag

Every read returns `index: { block, hasIndexingErrors }` — the last block the subgraph has
processed. Where the client has to decide whether an open vintage competes with a new entry, it uses
the **index** head rather than the chain head, which makes it conservative about available room
rather than wrong about it.

## Development

```bash
pnpm --filter @hunch-vpm/client typecheck
pnpm --filter @hunch-vpm/client test
pnpm --filter @hunch-vpm/client build
```

Tests run entirely against recorded fixture responses in `test/fixtures/`. The fixture transport
throws on any operation that has no recording, so no test can open a socket and a read that starts
issuing an unrecorded query fails loudly instead of quietly returning a wrong answer.

Fixtures are recorded in the deployed schema's shape — SCREAMING_CASE enums, `-1` sentinels with
their companion booleans, `owner` and `vintage` as relations — because a fixture in a shape the
subgraph does not produce tests nothing. `test/schema.test.ts` is the other half of that: it parses
`subgraph/schema.graphql` and `subgraph-erc8004-arc/schema.graphql` and checks every query document
against them, including the filter types, so a field that moves in either schema fails here first.
