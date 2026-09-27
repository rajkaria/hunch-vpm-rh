# @hunch-vpm/agentkit-tier

Tell an agent backed by a real, unique human apart from an anonymous bot, and tier access on
the difference.

World's AgentKit registers an agent's wallet in AgentBook — `npx @worldcoin/agentkit-cli register
<wallet>` — binding an anonymous but persistent human identifier to that wallet on-chain. A
server then challenges the agent to sign a CAIP-122 message and resolves the wallet through
AgentBook. This package is the resource-server half of that: it verifies the proof, decides which
tier the caller is in, and applies that tier's limits. The core takes headers and returns a typed
result; the framework adapters are thin wrappers over it.

Two chains are in play and they are not the same chain. An agent may sign its proof on World
Chain (eip155:480) or on Base (eip155:8453) — Base matters here because the venue's existing x402
rail already runs there, so no new chain is needed. **The AgentBook lookup always resolves on
World Chain regardless.** Conflating the two produces a verifier that refuses every Base-side
agent, which is why `acceptedChainIds` (caller side) and `AGENT_BOOK_CHAIN_ID` (registry side)
are separate things here.

## Why not just require it

Because a prediction market that only accepts verified humans is a smaller, worse market, and
because "prove a human or go away" is a claim about who is allowed to have an opinion. The
mechanism this venue is built on does not care who you are: stake vests into the opposing books
and is accepted up to the headroom those books have, and that rule is identical for every wallet.

What proving a human buys you is not permission. It is headroom against the abuse controls that
exist because one process can open ten thousand wallets: ten times the request rate, no tier
ceiling on what you can put into a single market, a badge on the leaderboard, and standing in
venue-funded reward distributions, which are the one thing that is meaningless if wallets are not
people.

An anonymous agent reads every market, stakes into every market, is paid out by exactly the same
settlement rule, and appears on the leaderboard. It is slower and smaller. It is not excluded.
`onInvalidProof: 'downgrade'` is the default for the same reason: a client whose proof breaks
keeps working at anonymous limits rather than falling over.

## The tier table

|                 | anonymous                        | human-backed                      |
| --------------- | -------------------------------- | --------------------------------- |
| rate limit      | base (60 req/min by default)     | 10x base                          |
| per-market cap  | small (25 USDC by default)       | full — headroom is the only limit |
| reward eligible | no                               | yes                               |
| leaderboard     | shown, unbadged                  | shown, badged                     |

The 10x relationship is built by construction, not configured twice:
`buildTierPolicies({ baseRequests })` derives the human-backed limit from the base, so the
invariant cannot drift. Caps are in USDC base units (6 decimals), because USDC is the native gas
token on Arc and every amount in this repo is in those units.

`perMarketCap` is a ceiling applied before the stake is submitted at all — a capped offer is
simply a smaller offer, so nothing about settlement changes. What the settler then does with
what is left is its own rule, and `effectiveAcceptance` models both halves:

```ts
import { effectiveAcceptance } from '@hunch-vpm/agentkit-tier';

// One opposing book with room to spare, and nobody else in this vintage.
effectiveAcceptance({
  offered: 100_000_000n,
  opposing: [{ headroom: 900_000_000n, otherDemand: 0n }],
  policy,
});
// anonymous    -> { submitted: 25_000_000n,  accepted: 25_000_000n,  refunded: 75_000_000n, limitedBy: 'tier-cap' }
// human-backed -> { submitted: 100_000_000n, accepted: 100_000_000n, refunded: 0n,          limitedBy: 'offer' }
```

`accepted` is the field that is easy to get wrong. The settler does **not** take
`min(c, H_w)`: when a vintage's joint demand `D_w` on an opposing book exceeds that book's
headroom, every entry in the vintage is cut pro rata, `⌊c · H_w / D_w⌋`, minimised over all
`n-1` opposing books — `VestedParimutuel.sol`, the acceptance loop in `_finalizeVintage`. The two
agree only when one entry is the whole of `D_w`. So `otherDemand` — what everything *else* in the
vintage has offered against that book — is required rather than defaulted:

```ts
// Two agents offering 100 USDC each into a book with 100 USDC of headroom, on the
// human-backed policy so the tier cap does not bind.
effectiveAcceptance({
  offered: 100_000_000n,
  opposing: [{ headroom: 100_000_000n, otherDemand: 100_000_000n }],
  policy,
});
// -> { submitted: 100_000_000n, accepted: 50_000_000n, refunded: 50_000_000n, limitedBy: 'headroom' }
```

Pass `UNBOUNDED_HEADROOM` for a book whose capacity coefficient is unbounded; it is never
rationed. This mirrors the contract, it does not replace it: a client cannot know who else will
land in the same block, so read the result as what happens if the vintage closes with the demand
you passed.

## Wiring it up

```ts
import {
  createAgentTierGate,
  createCachingAgentBook,
  createViemAgentBook,
  InMemoryTierStorage,
} from '@hunch-vpm/agentkit-tier';

const gate = createAgentTierGate({
  domain: 'api.example.com',
  // A viem client pointed at World Chain, and the canonical AgentBook address. There is
  // no default address: see "Configuration" below.
  agentBook: createCachingAgentBook(
    createViemAgentBook({ client: worldChainClient, address: process.env.AGENT_BOOK_ADDRESS }),
  ),
  storage: new InMemoryTierStorage(),
});
```

### Hono

```ts
import { agentTierOf, createHonoAgentTierMiddleware } from '@hunch-vpm/agentkit-tier/hono';

app.use('*', createHonoAgentTierMiddleware(gate));
app.get('/v1/markets', (c) => {
  const { tier, policy } = agentTierOf(c)!;
  return c.json({ tier, perMarketCap: policy.perMarketCap?.toString() ?? null });
});
```

Hono is not a dependency of this package and is not imported by it. The context is described
structurally by the two members the middleware uses, so any Hono version works and so does
anything else with the same shape. The test suite mounts the middleware on a real Hono app and
drives real requests through it, so if the structural types drift out of line with Hono's
`Context`, the build breaks.

### Plain Node / connect / express

```ts
import { agentTierOf, createNodeAgentTierMiddleware } from '@hunch-vpm/agentkit-tier/node';

server.use(createNodeAgentTierMiddleware(gate));
// later: agentTierOf(req)?.tier
```

The decision lives in a WeakMap keyed on the request rather than as a property stamped on it, so
reading it back needs no module augmentation and collides with nothing.

### Anything with a fetch `Request`

```ts
import { createFetchAgentTierGuard } from '@hunch-vpm/agentkit-tier/fetch';

const guard = createFetchAgentTierGuard(gate);
const { decision, response } = await guard(request);
if (response) return response; // 401 or 429, as an RFC 9457 problem document
```

### Core, with no framework at all

```ts
const result = await gate.verifier.verify({ headers, method, path });
// result.tier is 'anonymous' | 'human-backed'; verify never throws for a bad proof
```

## The wire format

One request header, `agentkit`, carrying base64 JSON:

```json
{ "message": "<the signed CAIP-122 message>", "signature": "0x<65 bytes>" }
```

base64url and standard base64 are both read, and raw JSON is accepted too, because a proof you
can paste into curl is a proof you can debug. The header name is configurable via `proofHeader`.

The message is EIP-4361 / CAIP-122:

```
api.example.com wants you to sign in with your Ethereum account:
0x70997970c51812dc3a010c7d01b50e0d17dc79c8

Verify your agent is backed by a real human

URI: https://api.example.com/v1/markets
Version: 1
Chain ID: eip155:480
Nonce: 0f0c1a1e-...
Issued At: 2023-11-14T22:13:20.000Z
Expiration Time: 2023-11-14T22:15:20.000Z
```

Two things about how this is verified are deliberate.

**Signature recovery runs against the message exactly as it arrived**, never against a message
re-rendered from parsed fields. Re-rendering is how a verifier ends up rejecting valid signatures
over a space or a line ending it would have written differently. Parsing is for reading the
claims out; the bytes are checked as they were sent.

**Both chain-line forms are read.** EIP-4361 specifies a bare integer (`Chain ID: 480`);
CAIP-122 and World's own field list specify CAIP-2 (`Chain ID: eip155:480`). An implementer
cannot tell from the documentation which a given client emits, and guessing wrong looks exactly
like a forged proof, so `parseChainId` accepts both.

`buildProof()` is exported for clients that are not using `agentkit.fetch()`, and for tests that
need a real signature. `formatSiweMessage()` and `parseSiweMessage()` are exported so you can
print exactly what should have been signed next to what was.

## Order of checks, and why

1. Header present and unambiguous.
2. The gate's verification budget for this source has room. Nothing below this line runs
   otherwise, and only a request that presented a proof is counted.
3. Envelope decodes; the message inside parses as a CAIP-122 message.
4. Scope: version, domain, chain, URI.
5. Time: lifetime ceiling, staleness, clock skew, `Not Before`, expiry.
6. Signature recovers to the address in the message.
7. AgentBook says that wallet is bound to a live human.
8. Nonce is spent.

Step 2 is the gate's; the rest is the verifier's, and `verifier.verify` on its own does all of
them but that one.

The order is load-bearing. Cheap checks come before expensive ones, so an expired proof costs no
signature recovery, and the registry read comes after the signature, so a proof that recovers to
the wrong address never reaches the RPC. The nonce is spent **last** and only on an otherwise
complete pass, so a proof that fails for any other reason does not burn its nonce — otherwise an
observer could replay a failing request to lock out the legitimate retry.

What that ordering is **not** is a bound on your RPC bill. Anyone can sign with a key they
generated a second ago, so a valid signature costs an attacker nothing and every such request
reaches AgentBook. The ordinary rate limiter cannot bound it either: the bucket a human-backed
caller belongs in is its wallet, which is not known until the proof has been checked, so the
limiter necessarily runs after the expensive work. That is what the gate's `verificationBudget`
is for — it meters proof-presenting requests per source *before* verification, defaulting to the
human-backed limit, which is the tightest bound that never cuts short a caller who turns out to
be entitled to it. Requests carrying no proof are never counted against it, because tiering one
costs nothing. `createCachingAgentBook` helps on top of that, but only for repeated wallets;
rotating keys defeats a cache.

One thing the format cannot give you: a CAIP-122 message has a URI but no HTTP method, so a proof
minted for `/v1/markets/42` is equally valid on a GET and a POST to that path. Single-use nonces
are what stop a captured read proof being replayed as a write; there is no way to bind the method
itself.

## Failure modes

Every one of these has a test. All of them produce `tier: 'anonymous'`; none of them throws.

| code | meaning |
| --- | --- |
| `no_proof_presented` | nothing was sent. The ordinary anonymous caller; `presented` is `false`. |
| `headers_malformed` | the *proof* header arrived twice with conflicting values |
| `proof_malformed` | not base64/JSON, no message, or the message is not a readable CAIP-122 message |
| `proof_unsupported_version` | a `Version` this server does not read |
| `proof_chain_unsupported` | signed on a chain this server does not accept |
| `proof_domain_mismatch` | minted for a different server |
| `proof_uri_mismatch` | the message's URI is not the resource being requested |
| `proof_expired` | past `Expiration Time` |
| `proof_not_yet_valid` | `Issued At` or `Not Before` is ahead of us by more than the skew allowance |
| `proof_stale` | `Issued At` is older than this server accepts, even though it has not expired |
| `proof_lifetime_too_long` | would sit in the nonce store longer than `maxProofLifetimeSeconds` |
| `signature_malformed` | not a 65-byte 0x-hex string, or recovery threw |
| `signature_mismatch` | recovers to a different address than the message names |
| `agentbook_unregistered` | the wallet has no binding |
| `agentbook_revoked` | the binding was revoked |
| `agentbook_unavailable` | the lookup itself failed. Distinct from "no human", and retryable. |
| `nonce_replayed` | this proof was already presented |
| `nonce_store_unavailable` | replay protection cannot be guaranteed, so the privilege is withheld |
| `verification_budget_exhausted` | the gate's per-source budget was spent, so the proof was never read |

Only the proof header can produce `headers_malformed`. Duplicates of any other name are merged
the way a fetch `Headers` merges them, because a client that sends two `accept` values has said
nothing about a proof, and calling that a proof failure means answering 401 to a caller that
presented nothing — which `onInvalidProof: 'reject'` would then do.

`verification_budget_exhausted` is the one code the verifier never produces: the gate raises it,
and it says nothing about the proof, only that this source had already made the server check that
many proofs in the current window. It always comes back as a 429, never a 401, because a 401
would be a claim about a proof this server declined to read.

The nonce rows are the interesting ones. A replay is downgraded rather than rejected by
default, which means a replay attacker gets anonymous limits instead of an error — set
`onInvalidProof: 'reject'` on endpoints where a broken client should be told so. A nonce-store
outage fails closed on the *privilege* and open on the *service*: the request proceeds, at
anonymous limits.

By contrast, a rate-limit counter outage fails fully open — the request proceeds and
`rateLimit.degraded` is `true`. Emit a metric on that field. A gate that is quietly degraded is a
gate that is not there.

## Persistence

Two operations, no database dependency:

```ts
interface TierStorage {
  consumeNonce(key: string, expiresAtMs: number): Promise<'accepted' | 'replayed'>;
  incrementWindow(key: string, windowEndsAtMs: number): Promise<number>;
}
```

`InMemoryTierStorage` implements it for a single process and for tests. It is **not** correct
behind a load balancer: each instance holds its own nonce set, so a proof spent on instance A
replays successfully on instance B. If you run more than one process, implement the interface
against something shared.

The contract a durable implementation has to meet:

- **`consumeNonce` must be atomic.** Two concurrent calls with the same key must produce exactly
  one `'accepted'`. Checking membership and then recording it, as two round trips, is a race: two
  requests carrying the same nonce can both see it unspent before either records it, and both
  pass. `SET key 1 NX PX <ttl>` in Redis, or an insert against a unique constraint, is right.
- **`expiresAtMs` is an absolute wall-clock deadline.** The entry may be dropped at or after it,
  and must not be dropped before it — a spent proof that is forgotten early becomes replayable
  inside its own validity window. This is why proofs have a lifetime ceiling: it bounds how long
  the set has to be retained.
- **`incrementWindow` must be an atomic increment returning the post-increment value**, so the
  first request in a window returns 1. `INCR` plus `PEXPIREAT` on first write, or an upsert with
  `count = count + 1 RETURNING count`.
- **Both must reject, not paper over, a failure.** Returning `'accepted'` when the store is
  unreachable turns an outage into a replay window. The verifier and the gate each have a
  documented response to a rejection; neither can do the right thing if the failure is hidden.
- Keys are opaque strings built by `nonceKey()` and `rateLimitKey()`. The rate-limit key contains
  the window start, so counters never need resetting — they expire.

Rate limiting is a fixed window. A caller can spend two windows' worth across a boundary; that is
the accepted cost of an algorithm needing one atomic increment per request and no per-subject
timer state.

The counter is keyed on the subject alone — `rateLimitKey` never sees a tier, so one subject is
one bucket. Be clear about what that does and does not buy you: the *default* subject resolver
keys a human-backed caller on its wallet and an anonymous one on its address, so a caller that
stops presenting its proof moves from `wallet:0x…` to `ip:…` and gets the anonymous allowance on
top of the human-backed one it has already spent, and the same trick tops up a spent anonymous
bucket by presenting a proof. The cost is bounded — base + 10·base per window rather than 10·base
— and it cannot be fixed inside this package, because a wallet is only known once a proof has
been checked, so nothing keyed on it can also count the requests where the proof is absent. If
you have an identifier that survives both cases, an API key or a mutual-TLS identity, pass it
through `subject` and both tiers share one bucket.

## Configuration

| option | default | notes |
| --- | --- | --- |
| `domain` | — | required; this server's hostname, matched against the message's first line |
| `agentBook` | — | required; a registry reader, see below |
| `storage` | — | required |
| `proofHeader` | `agentkit` | the header AgentKit's client attaches |
| `acceptedChainIds` | `[480, 8453]` | caller-side chains, not the registry's chain |
| `maxProofLifetimeSeconds` | 300 | bounds nonce retention |
| `maxProofAgeSeconds` | 300 | matches AgentKit's own "issuedAt must be recent" default |
| `clockSkewSeconds` | 30 | tolerance for a client clock running ahead |
| `requireUriMatch` | `false` | when a path is supplied the URI is always checked; this governs the case where one is not |
| `onInvalidProof` | `'downgrade'` | `'reject'` answers 401 for a presented-and-broken proof |
| `subject` | wallet, else `x-forwarded-for`, else one shared bucket | see below |
| `enforceRateLimit` | `true` | off for routes that meter themselves; turns the verification budget off too |
| `verificationBudget` | the human-backed limit | proof-presenting requests one source may have verified per window; `null` disables |
| `verificationSubject` | `x-forwarded-for`, else one shared bucket | who the budget is counted against, decided before anything is verified |
| `policies` | `DEFAULT_TIER_POLICIES` | build with `buildTierPolicies` |

`CANONICAL_AGENT_BOOK` is the zero address, an obvious placeholder, and `createViemAgentBook`
throws if you pass it. AgentKit's own verifier defaults to the canonical deployment and exposes a
`contractAddress` override; this package has no such default to fall back on, and a wrong
registry address is worse than no default, because verification would fail for every real agent
and the venue would look like nobody had ever registered.

The default `subject` resolver keys human-backed callers on the wallet, which is unforgeable. For
anonymous callers it falls back to the first hop of `x-forwarded-for` and then to a single shared
bucket named `anonymous:unattributed`. That fallback is only acceptable behind a proxy you
control — supply your own resolver otherwise, or one abusive caller spends everyone's budget. The
same caveat applies to `verificationSubject`, which has nothing but the request to go on.

## Out of scope, and what is not proven

Selfie Check and the IDKit credential flows are not here. This package reads a binding that
AgentKit already wrote; it does not perform verification of a person.

`AGENT_BOOK_ABI` describes the slice of the registry this package reads, and its shape is
inferred from what registration has to store rather than copied from a published artifact. If the
canonical registry's accessor differs, do not patch that constant: implement `AgentBookRegistry`
against the real contract. It is a ten-line function and it keeps the mismatch visible instead of
buried in an ABI.

This verifier has been tested against proofs produced by its own `buildProof()`, with real
secp256k1 signing and real EIP-191 recovery. It has **not** been tested against a proof produced
by AgentKit's own client, because that requires a registered wallet and the sandbox access to
exercise one. What is proven here is the verification logic and its failure behaviour; what is
not proven is byte-level interoperability with AgentKit's client.

## Tests

```
pnpm --filter @hunch-vpm/agentkit-tier test
```

224 tests, no sockets. Signatures are produced with real secp256k1 keys through viem local
accounts and recovered through viem's EIP-191 recovery, so the signature paths are exercised for
real; AgentBook is always a stub, and the clock is hand-cranked so expiry and window rollover are
deterministic rather than timing-dependent. The stub also counts its lookups, which is how the
verification budget is tested for what it actually claims: that a refused request costs no
registry read.
