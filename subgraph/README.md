# @hunch-vpm/subgraph

The Graph index for the Hunch VPM contracts on Arc. Four data sources, one schema:

| data source | what it contributes |
| --- | --- |
| `VestedParimutuel` | markets, books, vintages, positions, claims under the vested rule |
| `ClassicParimutuel` | the same shapes under the classic rule, for side-by-side comparison |
| `FeedResolver` | the resolution spec, the price a market settled on, stale-feed voids |
| `MarketFactory` | the wallet that opened a market, which the settler's own logs never name |

The point of this subgraph is that a client never has to reimplement the settlement rule to
draw a book. Headroom, implied odds, vested-to-date, per-vintage rationing and a live payout
preview are all computed in the mappings, in `BigInt`, with every division guarded.

## The derived fields, and what each one means

### `Book.headroom` — the room a book still has to accept stake

`H_w = C_w - V_w`: capacity minus what has already vested into the book, floored at zero.
This is the number that decides whether the next stake is accepted or refused. The settler
clamps it at zero and so does the index, because a book that has taken exactly its capacity
has no room left, not a negative amount of room.

`C_w = kappa * P_w` grows as the book takes principal, and `V_w` grows as stake on the other
outcomes vests in. A book can therefore open room and lose it again within the same market.

For a `CLASSIC` market there is no capacity at all: `ClassicParimutuel.headroom()` returns
`type(uint256).max` for every book, because a classic pool never refuses an offer. Those
books carry `capacityIsUnbounded: true` and the sentinel below.

### The unbounded sentinel — `-1`, never `2^256-1`

`kappa` is unbounded for n-way markets, and the contracts express that as
`type(uint256).max`. A client that renders `BigInt` fields as numbers would turn that into
`1.16e77` and put it on a chart. So wherever the chain says `2^256-1`, this subgraph says
`-1`, which is obviously not an amount and fails loudly instead of quietly:

- `Market.kappa` is `-1` when `Market.kappaIsUnbounded` is true
- `Book.capacity` and `Book.headroom` are `-1` when `Book.capacityIsUnbounded` is true

Always branch on the boolean. Do not test for `-1`.

### `Book.impliedOdds` — odds from accepted principal, not from a quote

`book.principal / market.acceptedPool`, as a `BigDecimal`. It is the share of the pool this
outcome has actually been paid to cover, not a price anyone quoted and not a mid of a book
that may never fill. Zero pool gives zero, not a division error.

Because `acceptedPool` moves on every finalized vintage (vested) and every entry (classic),
every book's share moves with it — including books that did not themselves change — so all
`n` books are rewritten together.

### `Book.vested` — vested-to-date

`V_w`: the total accepted stake that has vested INTO this book from entries on the other
outcomes. It is the numerator of the headroom subtraction and the thing that makes a late
entry worth less than an early one. Always `0` for `CLASSIC`, where nothing vests.

`Book.acc` is the settler's `A_w` reward-per-share accumulator in fixed point at `1e18`. It
is exposed because the payout formula is `s_i * (S + A_w - A_w(tau_i)) / S` and a consumer
that wants to check the index's arithmetic needs both ends of that difference.

### `Vintage.rationed` — the capacity refusal, made visible

`offered - accepted` for all the entries that landed in one block. Entries in the same block
form one vintage, never vest to each other, and are rationed together against the headroom
as it stood at the start of that vintage: each entry's cap on book `w` is
`floor(c * H_w / D_w)` when joint demand `D_w` exceeds `H_w`. `rationed` is what the books
had to turn away. A market with a healthy `rationed` is a market where capacity, not
appetite, is the binding constraint — which is the entire thesis of the mechanism and the
one number a classic pool can never produce.

`Position.refused` is the same quantity per entry, and it is refundable: the stake is
escrowed at entry and the refused remainder is pulled back by `withdrawRefund` or paid
alongside the settlement in `claim`.

Vintages exist only for `VESTED` markets. `Vintage` with block `0` is the reserved seed
vintage: the creator's legs, clamped at creation by the Rule-2 fixed point. A leg the clamp
cut shows up there as rationing before a single outside entry arrives.

### `Position.previewPayout` — what this position is worth right now

What `claim()` would pay if the market settled this second **to the position's own outcome**:

- market `VOIDED` → the accepted principal, which is exactly what a void refunds
- market `RESOLVED` and this is not the winning outcome → `0`
- otherwise, vested: `s_i * (SCALE + A_o - A_o(tau_i)) / SCALE`
- otherwise, classic: `floor(acceptedPool * s_i / P_o)`

On an open market this is the honest "if my side wins" number. It is the field most likely
to be believed, so it is refreshed whenever the books move — every finalized vintage on the
vested settler, every entry on the classic one — and again when the market settles. That
costs one pass over the market's positions each time; the alternative is a preview that
silently goes stale, which is worse.

The two rules are easiest to see against the same market. Seed 1000/1000, kappa 30, then
29000 arrives late on outcome 0:

| | late 29000 | seed leg on the same outcome | pool |
| --- | --- | --- | --- |
| vested | 29000 | 2000 | 31000 |
| classic | 29966 | 1033 | 31000 |

Both exhaust the pool. The vested rule hands the late entry its own principal back and gives
the whole gain to the stake that was there first. `tests/vested.test.ts` and
`tests/classic.test.ts` assert exactly these numbers.

### `Market.residue` — what the residue owner is owed

`acceptedPool - paidOut` on a **`RESOLVED`** market, and `0` on any other. Settlement is a
sum of floors, so a resolved market keeps a few units nobody can claim; the residue owner
named at creation sweeps them with `claimResidue`.

The status gate is not cosmetic. Neither settler adds to `paidOut` outside the resolved
branch of `claim()`, and `claimResidue` reverts `NotSettled` on an open or voided market, so
subtracting unconditionally would report the whole accepted pool as residue on every live
market — and on a voided one, forever, since nothing ever moves `paidOut` again.

The resolved number is exact only once every winning position has claimed; before that it
runs high, because the payouts still to come have not been subtracted yet. Once
`residueClaimed` is true, `residue` is the swept amount the settler itself reported.

### `Agent.realizedPnl`

Realized, not marked: `payout - accepted principal`, summed over positions that have
actually settled. A voided market refunds the accepted principal exactly, so it lands at
zero — **on both settlers**, which takes one translation in the mapping, because they do not
fill the `Claimed` log the same way. `VestedParimutuel.claim()` reports a void as `payout`;
`ClassicParimutuel.claim()` reports the same money as `refund` and leaves `payout` at zero.
Nothing is ever refused on the classic settler, so a `refund` there is never a refused
remainder and `src/classic.ts` passes it through as the settlement return. Taken at face
value it would record a holder refunded in full as having lost their entire stake — on the
settler whose numbers exist to be compared against the vested one.

`totalClaimed` counts settlement only — a refund of refused stake is your own money coming
back, not a return, so it is excluded from both.

`Agent.erc8004Id` and `Agent.agentBookVerified` are declared but are **not** populated by
this subgraph. Neither fact is derivable from settler events: the ERC-8004 registries on Arc
testnet are separate contracts, indexed by the `subgraph-erc8004-arc` package in this repo.
Join on the wallet address, which is the `Agent` id in both.

## How the index stays true to the settlers

**Market and book scalars are read back from the contract**, not accumulated from event
payloads. `MarketCreated` does not carry the token, the residue owner or the void timeout;
`VintageFinalized` carries only an entry count, not the accepted amounts; and no event
anywhere states a book's capacity. Reconstructing those from logs would mean reimplementing
the Rule-2 clamp and the vintage rationing in AssemblyScript and hoping the two stayed in
step. So the mappings call `getMarket`, `getBook` and `positions` instead.

The cost is that a contract read resolves against the state at the **end of the block**. In a
block with several entries, the intermediate snapshots run ahead of the log being handled;
the value written at the last event of each block is exact. Agent, day and protocol
aggregates are accumulated from event payloads and are exact per log.

**Two log-ordering facts the handlers depend on.** Both settlers record the creator's seed
legs and log `Entered` for them *before* they log `MarketCreated`, so the market entity and
its books are created lazily by whichever log arrives first. And the vested settler applies
a vintage lazily: the entries of block *b* are rationed and booked by the first transaction
of a later block that touches the market, so `Position.accepted` is `0` and
`Position.finalized` is `false` until the matching `VintageFinalized` arrives.
`Market.openVintage` points at the vintage that is still buffered.

**`Market.creator` is not the wallet that opened the market.** `MarketFactory.open()` pulls
the opener's USDC and then calls `create()` itself, so the settler's `msg.sender` — and
therefore `creator`, and the `owner` on every seed `Entered` log — is the factory contract.
The opener appears in the settler's own logs only as the recipient of the seed legs, which
the factory transfers over later in the same transaction.

So the index records both. `Market.opener` comes from `MarketOpened`, the one log that
states it, and is null for a market created directly on a settler. And a `PositionTransferred`
**inside the transaction that created the position** is treated as a hand-over rather than a
sale: `totalOffered`, `totalAccepted`, the market link and the day's unique-agent credit all
move to the receiver, and an address left holding nothing that never staked anything of its
own is dropped rather than kept as an agent with a row of zeros. `Position.createdTx` is
stored for exactly this comparison. A transfer in any later transaction is a real change of
hands: only the market link follows it, because `totalOffered` and `totalAccepted` record
what a wallet put at risk, not what it still holds.

**Settlers are static data sources, not factory templates.** A template only begins indexing
at the block *after* the transaction that spawned it, and `MarketFactory` emits
`MarketOpened` in the same transaction as `MarketCreated`, so every seed entry would be
missed. Both settlers are singletons — one contract, many markets — so there is nothing to
spawn anyway. Market and position ids are per settler contract, which is why every entity id
here is namespaced by the settler address.

**One ambiguous log.** `VestedParimutuel` emits the same `Claimed` event for a bare
`withdrawRefund` and for the settling `claim`. A payout above zero, or a refund of exactly
zero, can only come from `claim`; the remaining shape — payout 0 with a refund — is
genuinely ambiguous and is decided by reading the settler's own `claimed` flag. Payout
accrual keys strictly on `payout > 0`, which `withdrawRefund` can never produce, so the money
is counted exactly once regardless. `ClassicParimutuel.withdrawRefund` always reverts, so
there is no ambiguity on that settler and no contract read is paid for.

## Addresses

`arc-testnet` carries the deployed addresses and their deploy blocks as `startBlock`, written by
`pnpm wire:testnet` from `deployments/arc-testnet.json` — never by hand; `pnpm wire:check` fails
the gate if they drift. `arc` (mainnet) is still the zero address, because nothing is deployed
there. Deploy with `pnpm run deploy:testnet`, which goes through `tools/with-network.mjs` so the
committed manifest is restored afterwards. Arc testnet is chain id
`5042002`; the network slug The Graph uses is `arc-testnet` (mainnet is `arc`, chain id
`5042`). USDC is the native gas token at `0x3600000000000000000000000000000000000000` and
has 6 decimals through the ERC-20 interface, so every amount in this schema is in
micro-USDC.

## Working on it

```bash
pnpm codegen     # ABIs + schema -> generated/
pnpm build       # compile the mappings to wasm
pnpm typecheck   # codegen + build, which is what CI runs
pnpm test        # matchstick
```

`pnpm test` downloads a matchstick binary on first run (into `tests/.bin/`, gitignored). The
ABIs in `abis/` are generated from the contracts in this repo:

```bash
cd ../contracts
for c in VestedParimutuel ClassicParimutuel FeedResolver MarketFactory; do
  forge inspect "$c" abi --json > "../subgraph/abis/$c.json"
done
```

Regenerate them after any change to a contract's events or view functions, then re-run
`pnpm codegen` — the mappings will fail to compile if a signature moved, which is the point.

`tsconfig.json` deliberately does not extend the repo's `tsconfig.base.json`: the mappings
are AssemblyScript, not TypeScript, and the base config would reject `i32`, `changetype<T>`
and the graph-ts globals. Type checking for this package is the wasm compile.

## Deploying to Subgraph Studio

1. Create the subgraph at <https://thegraph.com/studio>, choosing **Arc Testnet** as the
   network. Studio gives you a deploy key and a subgraph slug.

2. Authenticate once per machine. The key is written to your graph-cli config, so do not put
   it in a file in this repo:

   ```bash
   npx graph auth <DEPLOY_KEY>
   ```

3. Put the deployed addresses and their deployment blocks in `networks.json`, under
   `arc-testnet`. Do not hand-edit `subgraph.yaml` for this — `graph build --network` reads
   `networks.json` and rewrites the manifest, which keeps testnet and mainnet in one place.

4. Build against the network and deploy:

   ```bash
   pnpm codegen
   npx graph build --network arc-testnet
   npx graph deploy <SUBGRAPH_SLUG> --network arc-testnet
   ```

   The CLI prompts for a version label (`v0.1.0`). Studio then shows sync progress and a
   development query URL of the form
   `https://api.studio.thegraph.com/query/<studio-id>/<slug>/<version>`.

5. To query the published subgraph from an app, use a Graph API key from the same dashboard:

   ```
   https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>
   ```

   Send the key in the URL only from a server; in a browser, proxy it so the key is not
   shipped to the client.

For a local graph-node instead, `graph create --node http://localhost:8020/ hunch-vpm` then
`graph deploy --node http://localhost:8020/ --ipfs http://localhost:5001 hunch-vpm`.

## Queries worth having

Books with their headroom and the odds their accepted principal implies:

```graphql
{
  market(id: "0xSETTLER-0") {
    settlerKind
    status
    acceptedPool
    kappa
    kappaIsUnbounded
    books(orderBy: outcome) {
      outcome
      principal
      vested
      capacity
      capacityIsUnbounded
      headroom
      impliedOdds
    }
  }
}
```

Where capacity actually bound — the blocks whose stake the books had to turn away:

```graphql
{
  vintages(where: { rationed_gt: "0" }, orderBy: block, orderDirection: desc) {
    block
    offered
    accepted
    rationed
    entryCount
    market { id settlerKind }
  }
}
```

One wallet's open positions and what they are worth right now:

```graphql
{
  agent(id: "0xWALLET") {
    realizedPnl
    positions(where: { claimed: false }) {
      market { id status }
      outcome
      offered
      accepted
      refused
      previewPayout
      vintage { block rationed }
    }
  }
}
```

The same market under both settlement rules, which is the comparison the repo exists to
make:

```graphql
{
  markets(where: { specId: "0xSPEC" }) {
    settlerKind
    acceptedPool
    positions(orderBy: createdBlock) {
      createdBlock
      accepted
      previewPayout
    }
  }
}
```
