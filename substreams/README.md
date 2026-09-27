# Substreams: Hunch VPM

Market, position and book tables built from the settlers' events, as a Substreams package
with a `db_out` module for a hosted SQL sink.

The point of the vested rule is that a book accepts stake only up to the headroom it has
to cover it, so the series worth indexing is **headroom over time**, not volume over time.
That is what `map_book_deltas` produces. The classic settler is indexed alongside it under
the same schema, so the two rules can be compared on the same market with one query.

---

## Open dependency: a Firehose for Arc

**This package compiles, its decoders are tested, and it cannot stream yet.** Substreams
does not read an RPC endpoint; it reads a Firehose, and a Firehose for Arc has to exist
before `substreams run` or a hosted sink can do anything.

What is true today:

- The modules are written against `substreams-ethereum`, which decodes any EVM chain's
  Firehose blocks. Nothing in this package is chain-specific beyond the contract addresses,
  which are runtime parameters.
- `cargo build --release --target wasm32-unknown-unknown` produces the module, and
  `cargo test` exercises every decoder against synthetic Firehose blocks built from the
  committed ABIs (91 tests).
- `substreams pack substreams.yaml` succeeds. The module graph, the output types and the
  parameters are validated by the real CLI, not just by the compiler.
- Arc testnet is chain id 5042002, mainnet 5042. The Graph's network slugs are
  `arc-testnet` (eip155:5042002) and `arc` (eip155:5042), which is what `network:` in
  `substreams.yaml` is set to.
- **Neither Arc network is in the Firehose network registry.** `substreams` v1.22.0 packs
  this manifest with:

  ```
  ⚠️ Detected Substreams Package warnings:
     • network "arc-testnet" is not a known Firehose network registry ID or alias
  ```

  The same warning appears for `network: arc`, and does not appear for a registered
  network such as `mainnet`. That warning is the open dependency, stated by the tool
  itself. Until it goes away, `make run` has nothing to connect to.

The moment an endpoint exists, nothing here changes except one variable:

```bash
make run \
  ENDPOINT=<the Arc Firehose endpoint> \
  VESTED=0x<settler> CLASSIC=0x<classic settler> \
  FACTORY=0x<factory> RESOLVER=0x<resolver> \
  START=<deployment block> STOP=+10000
```

For a chain with no Firehose, the alternative is a subgraph over an RPC endpoint; this
repository has one of those too. The two are not redundant — a subgraph handler cannot
express the parallel store accounting below — but the subgraph is the path that works on
Arc today.

---

## Hosted sink deploy, in one command

Deployment is `substreams alpha service deploy`, which takes the packed `.spkg`, spins up
a Postgres behind it, applies `schema.sql`, and starts writing. That works because the
manifest declares a `sink:` block naming `db_out` and the DDL file; `substreams pack`
inlines `schema.sql` into the package, so the deploy command and `substreams-sink-sql
setup` both find the schema without being handed it separately. `substreams info` on the
packed file prints it back:

```
Sink config:
----
type: sf.substreams.sink.sql.service.v1.Service
configs:
- schema: (<N> bytes) MD5SUM: <hash> [LOADED_FILE]
```

`<N>` and `<hash>` are `wc -c schema.sql` and `md5sum schema.sql`, which is the check
worth making: it says the DDL inside the package is the DDL in this directory and not a
stale copy. If the whole `Sink config:` section is missing, the package has a `db_out`
module and no sink, and neither deploy path will work — `cargo test` guards that, since
the manifest is parsed by a unit test that fails if the block goes away.

No read frontend (postgraphile, hasura, rest) is enabled: publishing a public API over the
sink database is a deployment decision, not a property of the package.

The only prerequisite is a bearer token, which the Portal API mints from an API key:

```bash
export SUBSTREAMS_API_KEY=<your key>
export SUBSTREAMS_API_TOKEN=$(make token)   # POSTs the key to the Portal auth endpoint

make deploy VESTED=0x... CLASSIC=0x... FACTORY=0x... RESOLVER=0x...
```

`make token` is exactly this, with the JSON unwrapped:

```bash
curl -sS -X POST -H "Content-Type: application/json" \
  -d '{"api_key":"'"$SUBSTREAMS_API_KEY"'"}' \
  https://auth.streamingfast.io/v1/auth/issue
```

`make deploy` runs `make pack` first, so it builds the wasm, packs `hunch-vpm-v0.1.0.spkg`
and ships it in one go. `make deployments` lists what is running. The deploy endpoint is
`DEPLOY_ENDPOINT` in the Makefile — providers other than StreamingFast host the same
service at their own address and their own Portal, and both are one variable.

The same caveat applies as above: the hosted sink schedules the package against a
Firehose, so a hosted deployment for Arc waits on the same missing endpoint. The command
is not hypothetical, the network is.

---

## What it produces

Eight tables, declared in [`schema.sql`](./schema.sql) and written by `db_out`.

| table | grain | what it is for |
| --- | --- | --- |
| `market` | one row per market | lifecycle: created, linked to a spec, resolved or voided |
| `resolution_spec` | one row per spec | the strike, feed, direction and staleness bound a market resolves against |
| `feed_reading` | append-only | what the resolver actually read when it settled or voided |
| `position` | one row per position | owner, outcome, offered stake, vintage, running payout and refund |
| `vintage` | one row per vintage | how many entries it held and which block finalized it |
| `settlement` | append-only | every `Claimed` log, payout and refund separately |
| `residue` | one row per market | the flooring remainder and who swept it |
| `book_delta` | one row per book per block it moved | principal, vested, capacity, **headroom** |

Amounts are `NUMERIC(78, 0)`. They are uint256 on chain and capacity is kappa times
principal, so a market that fits in uint128 still overflows a 64-bit column the moment
kappa multiplies it. USDC on Arc has 6 decimals, so these are integer micro-USDC.

Enums are written as their protobuf names — `SETTLEMENT_RULE_VESTED`,
`MARKET_STATUS_RESOLVED` — not as the integers behind them.

Columns are NULL, never zero, when the event behind them said nothing. Zero is a real
value everywhere in this schema, so writing it in place of "unknown" would be a lie the
sink cannot undo:

- `book_delta.capacity` and `book_delta.headroom` are NULL when kappa is unbounded (the
  prescription for n-way markets: no finite capacity, `unbounded` true, rather than a
  78-digit sentinel in a numeric column), when the rule is classic (which has neither
  vesting nor capacity), and when the market's creation is behind the indexer's start
  block so its kappa was never seen. That last case matters because `headroom = 0` is
  precisely the state in which a book refuses and refunds a stake — a zero there would
  make every book on an unrecognised market read as permanently full.
- `feed_reading` is written by two events that know disjoint things. `Resolved` names the
  market, the winning outcome, the price and the feed's `updatedAt`, and logs no age.
  `VoidedStale` carries a spec id and an age and nothing else — not a market id, not a
  winner. Market 0 exists and outcome 0 can win, so those columns stay NULL on a void.

---

## Module graph

```
  params ─┬─> map_markets ──────> store_markets ─┐
          │        │                             │
          └─> map_positions ──> store_positions ─┤
                   │                             │
                   └─────────────────────────────┴─> store_books
                                                           │
                                   map_book_deltas <───────┘

  db_out <── map_markets, map_positions, map_book_deltas
```

| module | kind | what it does |
| --- | --- | --- |
| `map_markets` | map | `MarketCreated` / `Resolved` / `Voided` from either settler, `MarketOpened` from the factory, and the resolver's `SpecRegistered` / `Resolved` / `VoidedStale` |
| `map_positions` | map | `Entered` / `VintageFinalized` / `Claimed` / `PositionTransferred` / `ResidueClaimed` |
| `store_markets` | store (set) | each market's creation shape — n, kappa, settlement rule |
| `store_positions` | store (set) | the market and outcome behind each position id |
| `store_books` | store (add) | per-outcome principal, vested and capacity |
| `map_book_deltas` | map | headroom over time, derived from the store's deltas and totals |
| `db_out` | map | `sf.substreams.sink.database.v1.DatabaseChanges` |

Two of these need justifying.

`store_markets` exists because only `MarketCreated` carries n and kappa, and the book
accounting needs both on every entry. It holds the creation shape, not the live status;
the live status is a column of the `market` table.

`store_positions` exists because a `Claimed` log carries a position id and nothing else.
To subtract a refund from the right book you have to know which market and which outcome
that position was on, which only its `Entered` log said, in an earlier block.

One wrinkle the code handles explicitly: the creator's seed legs are logged in the *same
transaction* as `MarketCreated`, so a book has to open before any store has seen the
market. `map_positions` scans the block for `MarketCreated` first and stamps n and kappa
onto the entries of that block; `store_books` prefers that hint and falls back to the
store for everything later.

---

## What the books are, and are not

This matters more than anything else in the package, so it is stated plainly here and
again at the top of [`src/books.rs`](./src/books.rs).

**The settler never logs the accepted amount.** `Entered` carries the *offered* stake.
`VintageFinalized` carries only how many entries the vintage held. Acceptance is decided
inside `_finalizeVintage`, by rationing each entry against the headroom its opposing books
had at vintage start, and no event carries the result.

An indexer cannot recompute it, either. The rationing is a read-modify-write of book
state — you need H_w before you can know what was accepted, and you need what was accepted
before you can update H_w — and a Substreams module graph has no cycle to express that in:
a store handler cannot read its own store.

So the books are built on the **offered basis** and corrected to the accepted basis as
evidence arrives. An entry adds its offered amount to its own book's principal and to
every opposing book's vested total. When the position later withdraws its refused
remainder, the `Claimed` log carries that refund — which is exactly `offered − accepted` —
and it is subtracted back out. The consequences:

- **No rationing: exact from the moment of entry.** This is every market with headroom to
  spare, and every market with an unbounded kappa, which is all of them most of the time.
- **Rationing: overstated by the refused amount until that refund is withdrawn, exact
  after.** The `settlement` table shows exactly when each correction landed.
- **Seed legs: never converge.** An asymmetric seed is clamped at creation and the refused
  part is never pulled from the creator, so no refund log is ever emitted for it. A
  symmetric seed — the normal case — is accepted in full and is exact.

Timing follows the same honesty rule. The settler books a vintage lazily, at the first
later transaction that touches the market, so its own books move one or more blocks after
the entries did. These books move at the entry block. The `vintage` table records the
finalizing block of every vintage, so the lag is recoverable rather than lost.

If the settler ever emits the accepted amount — on `Entered`, or per-entry inside
`VintageFinalized` — all three caveats disappear and `store_books` becomes a transcription
instead of a reconstruction. That is the single highest-value event change for indexing.

The classic settler has neither vesting nor capacity: every stake is accepted and the pool
is split at settlement. Its books therefore carry a principal and nothing else, and
`book_delta.rule` says so, rather than inventing columns the contract has no concept of.

---

## Parameters

No address is baked into the manifest — the Arc testnet ones are in `deployments/arc-testnet.json`. Both
block-reading modules take one query-string parameter:

```
vested=0x...&classic=0x...&factory=0x...&resolver=0x...
```

Every key is optional — leave one out and that contract is not indexed. An unknown key is
an error rather than a silent no-op, because a typo in an address key looks exactly like a
chain with no activity on it.

The manifest ships all four as the zero address, which is a working placeholder: it parses,
it matches no log, and the package produces nothing. Pass real addresses with `-p`, or
through the Makefile:

```bash
make run VESTED=0xABC... CLASSIC=0xDEF... FACTORY=0x123... RESOLVER=0x456...
```

One `.spkg` therefore serves testnet, mainnet and a local fork without a rebuild.

---

## Working on it

```bash
make build                  # wasm module, release
make test                   # 91 unit tests, host target
make lint                   # rustfmt + clippy -D warnings
make check                  # lint, test, vendored-proto check, build
make pack                   # hunch-vpm-v0.1.0.spkg
make protogen               # regenerate src/pb after editing proto/hunch_vpm.proto
```

`make build`, `make test` and `make lint` need only a Rust toolchain. `make pack`,
`make run` and `make deploy` additionally need the
[`substreams` CLI](https://github.com/streamingfast/substreams/releases).

### `make lint` against CI

CI's `substreams` job runs four steps: `cargo fmt --check`, `cargo clippy --target
wasm32-unknown-unknown -- -D warnings`, `cargo test`, and `cargo build --release --target
wasm32-unknown-unknown`.

`make lint` is **stricter than that one step**, not identical to it: it passes `--all-targets`,
so clippy also lints the test and benchmark targets, which CI's invocation does not. Both forms
are clean today, so the difference costs nothing right now — but a warning that only appears
under `#[cfg(test)]` fails `make lint` locally and passes CI, which is the confusing direction
for that gap to run. The fix is to add `--all-targets` to the CI step so the two agree;
`.github/workflows/ci.yml` is the file, and it is the only place the two commands can be made
the same.

What CI does **not** run is `make verify-vendored-proto`. That is the one check `make check`
adds on top of CI, so run `make check` before pushing.

### Testing without a Firehose

`src/testkit.rs` builds synthetic Firehose blocks. Event topics come from the committed
ABI JSON rather than from hand-written hashes, so a signature change in a contract shows
up as a failing test here rather than as an indexer that silently stops matching. That is
also how the tests pin down the property the two-settler design rests on: the vested
`Entered` carries a vintage and the classic one does not, so the two have different topic0
and one package can index both.

Two tests keep `db_out` and `schema.sql` from drifting: every column the module writes must
exist in the DDL, and every table the DDL declares must be written by the module. Nothing
in the type system connects a column name string to a `CREATE TABLE`, and a mismatch would
otherwise only surface at the sink.

### Generated code

- `src/abi/` does not exist. `build.rs` runs `substreams-ethereum`'s Abigen over `abi/*.json`
  into `OUT_DIR` on every build, so a checkout is never modified by a build and a stale
  decoder cannot drift from the ABI it came from.
- `src/pb/` **is** committed, and regenerated by `make protogen`. Protobuf codegen needs
  `protoc`; requiring it on every machine that runs `cargo build` — CI and the hosted build
  included — would buy nothing, because the schema changes when a human edits the `.proto`.
  `protogen/` is a small helper crate that ships its own `protoc`, so regenerating needs no
  system install and no `substreams` CLI.
- `abi/*.json` are the `abi` arrays lifted out of the Foundry artifacts in `contracts/out/`.
  Regenerate them with `forge build --root contracts` and re-extract if an event changes.

### Vendored upstream schema

`proto/sink/database_changes.proto` is upstream's, vendored so that `substreams pack` can
resolve `db_out`'s output type without fetching a remote `.spkg`. `make verify-vendored-proto`
generates Rust from the vendored copy and compares its message names, field tags, types and
enum discriminants against the `substreams-database-change` crate the wasm actually encodes
with. It fails if the two ever drift.

---

## Layout

```
substreams.yaml            module graph, params, network
schema.sql                 DDL for the sink, matching db_out
Makefile                   build / pack / run / deploy
abi/                       event ABIs, lifted from the Foundry artifacts
proto/hunch_vpm.proto      the output schema — source of truth for src/pb
proto/sink/                vendored upstream DatabaseChanges schema
protogen/                  regenerates src/pb, ships its own protoc
tools/                     the vendored-proto drift check
build.rs                   Abigen over abi/*.json into OUT_DIR
src/lib.rs                 the six handlers, and nothing else
src/abi.rs                 includes the Abigen output from OUT_DIR
src/pb/                    generated protobuf bindings (committed)
src/log_meta.rs            block / transaction / log provenance for every row
src/markets.rs             market, spec and feed-reading rows
src/positions.rs           position, vintage, settlement and residue rows
src/books.rs               the book accounting, and why it is a reconstruction
src/deltas.rs              headroom rows from the store
src/db.rs                  DatabaseChanges
src/amounts.rs             uint256 arithmetic and the unbounded-kappa sentinel
src/keys.rs                store keys and row ids
src/params.rs              contract addresses from the module parameter
src/testkit.rs             synthetic Firehose blocks (tests only)
```

Handlers are thin on purpose: a `#[substreams::handlers::*]` function is rewritten into an
`extern "C"` entry point and cannot be called from a test, so every one of them decodes its
inputs, calls a plain function, and encodes the result. The store types are reached through
small traits, so the accounting can be tested on the host with an in-memory store.
