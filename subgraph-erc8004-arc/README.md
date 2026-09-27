# subgraph-erc8004-arc

A subgraph that indexes ERC-8004 agent identity, reputation and validation on Arc.

It is Agent0's standardized ERC-8004 schema, retargeted at Arc's registries. Agent0 publishes
that schema for Ethereum, Base, BSC, Polygon and Monad (plus Sepolia and Chapel). Arc has the
three registries deployed but no subgraph, so agent data there was only reachable by reading
contract state one `eth_call` at a time. This package closes that gap without inventing a new
shape for it.

## What became easier

The schema is the deliverable, not the deployment.

A consumer that already queries agent reputation on Base gets Arc agent reputation from the
same query, with no new types, no second code path and no mapping layer. This document runs
against the Base deployment and this one unchanged:

```graphql
query AgentReputation($agent: ID!) {
  agent(id: $agent) {
    name
    owner
    metadataURI
    averageScore
    feedbackCount
    validationCount
    endpoints { protocol uri }
    capabilities { name }
    feedback(where: { revoked: false }, orderBy: createdAt, orderDirection: desc, first: 10) {
      score
      tags
      author
      createdAt
    }
    validations(where: { status: RESPONDED }) {
      request
      response
      status
    }
  }
}
```

Only the endpoint URL changes. A generated GraphQL client keeps one set of types; a reputation
scorer keeps one implementation; a UI that ranks agents can merge Base and Arc results into one
list because `Agent.averageScore` means the same thing on both and ids never collide.

Ids are prefixed with the CAIP-2 chain id for exactly that reason. Agent ids are small integers
that restart from 0 on every chain, so agent `0` exists on Base and on Arc. Unprefixed ids would
collide the moment two chains land in one client-side cache. Here they are
`eip155:8453/agent/0` and `eip155:5042002/agent/0`.

Where the Arc deployment needed more than the standard shape, fields were **added**, never
renamed or removed: `Feedback.value` and `Feedback.valueDecimals` sit next to the standardized
`Feedback.score`, and `Agent.agentWallet` sits next to `Agent.owner`. A cross-chain query that
never asks for them is unaffected.

## Chains covered

| Deployment | Network slug | Chain | Registries |
| --- | --- | --- | --- |
| this package, default build | `arc-testnet` | Arc testnet, chainId 5042002 | live, addresses below |
| this package, `build:arc` | `arc` | Arc mainnet, chainId 5042 | not deployed yet, placeholder |

Arc testnet, confirmed on chain (see *How the ABIs were obtained*):

| Registry | Proxy address | Creation block |
| --- | --- | --- |
| IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | 29241340 |
| ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | 29241344 |
| ValidationRegistry | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | 29241349 |

`startBlock` is each proxy's own creation block, so nothing is missed and no time is wasted
scanning earlier history.

**Arc mainnet has no ERC-8004 registry yet.** The `arc` entry in `networks.json` is
`0x0000000000000000000000000000000000000000` with `startBlock: 0`. That is a deliberate
placeholder, not a real address — a wrong-but-plausible address would be far worse than one
that is visibly unset, and a test asserts it stays zero until someone changes it on purpose.

## Entities

`Registry` is the per-chain row and holds the chain-level aggregates.

`Agent` is one identity NFT. `owner` is the current NFT holder; `agentWallet` is the address the
agent signs as, which the registry stores as reserved metadata and which may differ from the
holder. The registry clears `agentWallet` on every ownership move and on `unsetAgentWallet`,
emitting the reserved key with a zero-length value; this subgraph unsets the field on that,
so the wallet never outlives the ownership that set it and a query after a transfer returns
null rather than the previous owner. `metadataURI` is the agent card (`tokenURI`); it is an
off-chain document and this subgraph does not resolve it.

`Endpoint` and `Capability` are per-agent rows; `CapabilityStat` is the chain-level roll-up of
how many agents advertise a given capability. `AgentMetadata` keeps every metadata entry
verbatim, including keys this mapping does not interpret.

`Feedback` is keyed on `(agent, client, index)` because that is what the registry itself uses:
one client may rate the same agent repeatedly, and revocation names that triple. `FeedbackResponse`
is a reply appended to one feedback entry.

`Validation` covers both halves of the two-step flow in one row, keyed on `requestHash`, because
the registry keys both halves on it. `status` is `REQUESTED` until the validator answers, then
`RESPONDED`. `response` stays null while `REQUESTED` — `0` is a real verdict (the validator
rejected), so null is the only honest way to say "no answer yet".

`Client` and `Validator` are per-chain aggregates over addresses. `RegistryDayData` is a daily
roll-up keyed on UTC midnight.

## Two things about the data that are easy to get wrong

**`Feedback.score` has no fixed scale.** The registry's `giveFeedback` takes an `int128 value`
and a separate `uint8 valueDecimals`; it does not impose a 0-100 range, and it permits negative
values. `score` is `value` rescaled by `valueDecimals`, so one client posting `9` with 1 decimal
and another posting `8700` with 4 decimals come out as `0.9` and `0.87` rather than `9` and
`8700`. That makes scores comparable across clients, but it does not make them comparable across
*tags*: nothing stops one tag being scored 0-1 and another 0-100. Filter by tag before trusting
a mean. `averageScore` is the mean over non-revoked feedback, which is a useful default and a
bad final answer.

**Revocation is a flag, not a delete.** `revokeFeedback` flips `isRevoked` on chain; the row
stays. This subgraph keeps the `Feedback` entity with `revoked: true` and corrects the
aggregates by subtracting the stored score, which keeps revocation O(1) instead of a re-scan.
Query `where: { revoked: false }` when you want the live picture.

## Metadata keys this mapping interprets

The registry imposes no key convention, so every `MetadataSet` entry is stored verbatim as an
`AgentMetadata` row. On top of that, these keys are projected onto the standardized fields:

| Key | Effect |
| --- | --- |
| `agentWallet` | `Agent.agentWallet`, if the value is exactly 20 bytes |
| `name` | `Agent.name` |
| `description` | `Agent.description` |
| `endpoint.<protocol>`, `endpoints.<protocol>` | an `Endpoint` row; protocol is lower-cased |
| `capability.<name>`, `capabilities.<name>` | a `Capability` row with the value attached |
| `capabilities` | comma-separated list, one `Capability` row per entry |

Anything else is still queryable through `Agent.metadata`. Adding a key to this table is a
mapping change, not a schema change.

## How the ABIs were obtained

All three addresses are ERC-1967 proxies. `abis/*.json` were taken from the verified
implementation contracts behind them, read off Arc testnet, so the event signatures in
`subgraph.yaml` are the deployed ones rather than signatures derived from the specification.
They differ from a naive spec reading in ways that matter: feedback carries `int128 value` plus
`uint8 valueDecimals` rather than a 0-100 byte, and `ValidationResponse` carries the agent id
and an indexed `requestHash`.

| Proxy | Implementation |
| --- | --- |
| IdentityRegistry | `0x7274e874CA62410a93Bd8bf61c69d8045E399c02` |
| ReputationRegistry | `0x16e0FA7f7C56B9a767E34B192B51f921BE31dA34` |
| ValidationRegistry | `0xDB31f5d9167f8ebc8B30FbBF814c4d297c2D7F99` |

Because they are proxies, an upgrade can change the events without changing the addresses.
`pnpm test` re-checks the manifest against the committed ABIs; re-pulling the ABIs after an
upgrade is a manual step.

## Layout

```
abis/                   ABIs from the verified implementation contracts
schema.graphql          the standardized schema
subgraph.yaml           manifest, arc-testnet (the committed default)
networks.json           per-network addresses and start blocks
src/                    AssemblyScript mappings
tests/matchstick/       matchstick unit tests for the mappings
tests/node/             vitest conformance tests for the manifest, ABIs and schema
tools/with-network.mjs  runs graph-cli for another network without rewriting the manifest
```

## Working on it

```
pnpm install          # from the repo root; this package is in the pnpm workspace
pnpm codegen          # generate types from schema.graphql and the ABIs
pnpm build            # compile the mappings to wasm (arc-testnet)
pnpm typecheck        # tsc over tests/node
pnpm test             # both suites, which is what CI runs
pnpm test:node        # vitest only: manifest, ABI and schema conformance
pnpm test:matchstick  # matchstick only: the mapping handlers
```

`pnpm test` runs codegen, then vitest, then matchstick, in that order. It is deliberately the
slow script rather than the fast one: `pnpm -r --if-present test` at the repo root invokes
`test` and nothing else, so anything left out of it is not covered in CI. The two suites check
different things and neither replaces the other.

Matchstick covers handler behaviour: rescaling, revocation arithmetic, capability counting,
burn handling, the two-step validation flow, and the out-of-order cases a real chain produces.

The vitest suite covers the things matchstick cannot see. The worst failure mode in a subgraph
is a manifest whose event signature differs from the deployed ABI by one parameter type: it
builds, it deploys, it reports as healthy, and it indexes nothing. That suite asserts every
signature in `subgraph.yaml` appears verbatim in the ABI taken from the verified contract,
that indexed parameters match, that the addresses and start blocks are the confirmed ones,
that every handler named exists, that every entity constructed is declared, and that the
standardized field names are still present.

`graph test` downloads a platform-specific matchstick binary on first run, so `pnpm test`
needs network access on a cold machine. That is the one reason to reach for `pnpm test:node`
instead, and it is not a reason to drop matchstick from `test`: a green CI run that skipped
the handler tests is worse than a slow one.

### Deploying

`graph build --network <name>` rewrites `subgraph.yaml` in place and strips its comments, so
the `build:arc` and `deploy:*` scripts go through `tools/with-network.mjs`, which restores the
committed manifest afterwards. A test asserts the committed manifest still says `arc-testnet`,
which is what catches an accidental commit of a rewritten one.

```
pnpm deploy:arc-testnet
```

The Graph's network slugs are `arc-testnet` (`eip155:5042002`) and `arc` (`eip155:5042`).
Deploying to `arc` is pointless until the registries exist there and `networks.json` stops
being a placeholder.
