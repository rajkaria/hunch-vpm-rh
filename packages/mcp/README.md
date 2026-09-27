# @hunch-vpm/mcp

An MCP server that puts the Hunch VPM venue in front of any agent that speaks the
protocol — Claude, Cursor, ChatGPT, a custom runtime — without our SDK and without a
line of integration code. Three read-only tools over stdio.

| tool | answers |
|---|---|
| `vpm_market_book` | the book, the headroom, implied odds, time to freeze, and how much of a given stake would actually be accepted |
| `vpm_agent_reputation` | a wallet's ERC-8004 identity and reputation on Arc, plus its AgentBook human-backed flag |
| `vpm_claimable` | everything a wallet can pull right now, with the exact contract call for each item |

The server reads. It never signs, never holds a key and never moves funds. Entering a
market or claiming a payout is a transaction the agent sends from its own wallet.

## The one thing to understand first

This venue is a *vested parimutuel*. Two consequences shape every response:

- **Stake vests on arrival.** A stake vests into the opposing books the moment it lands,
  so early money earns a larger multiple than late money on the same outcome. Arriving
  just before the freeze with the answer is not the free money it is in a classic pool.
- **Stake can be refused.** A book accepts stake only up to its headroom,
  `H = capacity − vested`. Beyond that the entry is not rejected — it is *accepted in
  part*: a smaller amount is taken and the remainder becomes refundable. Sizing without
  checking headroom means discovering the ceiling after the transaction.

And the subtlety that trips up every integration: the ceiling on a stake is **not the
headroom of the outcome being staked**. Stake on YES vests into NO, so what a YES stake
can have accepted is NO's headroom. `vpm_market_book` reports both numbers — `headroom`
per book, and `acceptsStakeUpTo` per outcome, which is the one that decides.

## Install and run

```bash
pnpm install            # at the repository root
pnpm --filter @hunch-vpm/mcp build
pnpm --filter @hunch-vpm/mcp start
```

The server speaks JSON-RPC over stdio and logs only to stderr, because stdout is the
protocol channel.

### In a host's config

```jsonc
{
  "mcpServers": {
    "hunch-vpm": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp/dist/index.js"],
      "env": {
        // Required: the server will not start without a venue subgraph to read.
        "HUNCH_VPM_SUBGRAPH_URL": "https://api.studio.thegraph.com/query/<id>/hunch-vpm/<version>",
        "HUNCH_VPM_ERC8004_SUBGRAPH_URL": "https://api.studio.thegraph.com/query/<id>/erc8004-arc/<version>",
        // The Arc testnet settler, from deployments/arc-testnet.json.
        "HUNCH_VPM_SETTLER_ADDRESS": "0xC743940C75619f65F6178b7e49c0C3A0bE012Eec"
      }
    }
  }
}
```

Pair it with `skills/hunch-vpm/SKILL.md`, which teaches an agent when to reach for each
tool and how to go from research to a signed entry.

## Configuration

Environment variables only: a host launches an MCP server and can set env vars, but
cannot pass flags. Invalid values are collected and reported together at startup, so one
restart fixes all of them.

| variable | default | what it does |
|---|---|---|
| **`HUNCH_VPM_SUBGRAPH_URL`** | **required** | The `hunch-vpm` subgraph. Every tool reads the venue through it, directly or through the client. Set this or `HUNCH_VPM_SUBGRAPH_ID`. |
| `HUNCH_VPM_SUBGRAPH_ID` | unset | Subgraph Studio id, expanded into the gateway URL with `HUNCH_VPM_GRAPH_API_KEY`. An alternative to the URL, not an addition. |
| `HUNCH_VPM_CHAIN_ID` | `5042002` | 5042002 = Arc testnet, 5042 = Arc mainnet. Selects the built-in RPC, explorer and registry addresses. |
| `HUNCH_VPM_RPC_URL` | testnet: `https://rpc.testnet.arc.network` | Overrides the preset. Required on chains with no preset. |
| `HUNCH_VPM_EXPLORER_URL` | testnet: `https://testnet.arcscan.app` | Used to build links in responses. |
| `HUNCH_VPM_SETTLER_ADDRESS` | `0x0000…0000` | `VestedParimutuel`. On Arc testnet set it to `0xC743940C75619f65F6178b7e49c0C3A0bE012Eec` (`deployments/arc-testnet.json`). Left at the zero address, the server treats the venue as undeployed and says so on startup. |
| `HUNCH_VPM_CLASSIC_SETTLER_ADDRESS` | unset | `ClassicParimutuel`, when the side-by-side comparison is deployed. A market on this settler is flagged in the response, since nothing is refused there. |
| `HUNCH_VPM_ERC8004_SUBGRAPH_URL` | unset | The ERC-8004 subgraph on Arc. Source of identity and reputation. |
| `HUNCH_VPM_ERC8004_SUBGRAPH_ID` | unset | The same, as a Studio id plus `HUNCH_VPM_GRAPH_API_KEY`. |
| `HUNCH_VPM_GRAPH_API_KEY` | unset | The Graph gateway key. It becomes a path segment of the gateway URL, so keep it out of logs. |
| `HUNCH_VPM_REQUEST_TIMEOUT_MS` | `10000` | Per-request timeout for this server's own subgraph reads (500–120000). The client has no timeout knob, so it does not apply to reads made through it. |
| `HUNCH_VPM_MAX_POSITION_LOOKUPS` | `25` | Cap on the per-position vesting reads a single `vpm_claimable` call will make. |

`.env.example` carries the same list in copyable form.

`HUNCH_VPM_SUBGRAPH_URL` is not optional: `@hunch-vpm/client` throws when it is
constructed without a subgraph endpoint, so a server without one does not start in a
degraded mode — it does not start. The check is in `loadConfig`, which reports it
alongside every other configuration problem in a single startup message.

The ERC-8004 endpoint is optional. Without it `vpm_agent_reputation` still answers with
the venue half — the AgentBook human-backed flag and what the wallet has done here — and
a `notes` entry naming the variable that would fill in identity and reputation.

## Errors are answers

Every failure comes back as a tool result with `isError: true`, a code and a hint —
never as a transport-level exception. A model that receives `not_configured` with the
name of a missing variable can tell its user what to fix; a model that receives a
JSON-RPC error just sees a broken tool.

| code | meaning |
|---|---|
| `invalid_input` | Arguments did not match the tool's published JSON Schema. |
| `not_configured` | The server is missing configuration this tool needs; the message names it. |
| `upstream_unavailable` | A subgraph or RPC endpoint was unreachable, slow or rate limited. |
| `not_found` | The market, position or wallet does not exist on this chain. |
| `bad_upstream_data` | A data source answered in a shape this server does not understand; the message names the field. |
| `internal` | A bug here. |

Partial answers are preferred to no answer where it is honest to give one: if the
ERC-8004 subgraph is reachable but AgentBook is not, `vpm_agent_reputation` returns the
identity half and a `notes` entry saying which half is missing.

## Integration boundaries

Two boundaries are not verified by the compiler, so both are verified at run time and
pinned by tests:

1. **`@hunch-vpm/client`** (`src/client-loader.ts` and `src/client-surface.ts`,
   normalized in `src/venue-reader.ts`). The package is a workspace dependency imported
   at run time by specifier rather than type-imported, so this server typechecks and
   tests on its own while the client is built in parallel.

   The loader calls the client's factory — `createHunchClient(config)` — and hands it a
   `HunchClientConfig`: `subgraphUrl`, `erc8004SubgraphUrl`, `apiKey`, `chain` and
   `addresses`. That spelling matters, because a config object with different field names
   is accepted silently and every value in it is ignored. A module that exports the six
   reads directly is still accepted, but only after an arity check: the client also
   exports `marketBook(config, marketId)` at module level, and binding those as if they
   were methods would put a market id in the configuration slot.

   Payloads are normalized in one file, which accepts a short list of spellings per field
   and fails with a `bad_upstream_data` result naming the field when it finds none of
   them. Two conventions are handled explicitly there: `null` means unbounded on
   `kappa`, `capacity` and `headroom`, and the indexer's `-1` sentinel means the same
   only when the boolean it publishes beside it says so. Any other negative amount is
   refused rather than carried into a staking decision.

2. **The two subgraph schemas** (`ERC8004_AGENT_QUERY` and `VENUE_AGENT_QUERY` in
   `src/agent-directory.ts`). Both queries are built from field lists checked against
   `subgraph/schema.graphql` and `subgraph-erc8004-arc/schema.graphql` by
   `test/agent-directory.test.ts`. A GraphQL server rejects the whole document for one
   unknown field, so a drifted query does not degrade an answer — it deletes it, which is
   why the binding is a test rather than a comment.

## Development

```bash
pnpm --filter @hunch-vpm/mcp typecheck   # tsc over src and test
pnpm --filter @hunch-vpm/mcp test        # vitest
pnpm --filter @hunch-vpm/mcp build       # tsc to dist/
```

The suite covers each tool handler against fixtures — the happy path, every degraded
path, and the error paths — the normalizers against payloads shaped like the client's
own answers (bigints, `null` for unbounded, composite ids), the two GraphQL queries
against the schema files they were written from, the GraphQL transport against HTTP
failures, GraphQL errors, non-JSON bodies and timeouts, and the server itself end to end
over an in-memory MCP transport.

`test/integration.test.ts` is the one that catches seam failures: it loads a
package-shaped module through the real loader, wraps it in the real reader and runs the
tools through it, so a factory bound by the wrong name or a field spelled the way the
reader wished rather than the way the client writes it fails there rather than in front
of an agent.
