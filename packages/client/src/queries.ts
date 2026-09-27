/**
 * The query documents.
 *
 * Every selection here is written against two schemas that live in this
 * repository: `subgraph/schema.graphql` for the venue and
 * `subgraph-erc8004-arc/schema.graphql` for reputation. Field names, enum
 * spellings and which fields are relations are taken from those files — when
 * one of them changes, this file is the thing that has to change with it.
 *
 * Where the schema's name and this package's name differ (`n` for the outcome
 * count, the flattened resolution spec) the GraphQL side keeps the schema's
 * spelling and `decode.ts` renames it. The wire format follows the index; the
 * entity types follow the reader.
 */

/**
 * Outcome indices are packed into a `uint8` by the settler, so a market has at
 * most 256 books and one page always holds all of them.
 */
const MAX_BOOKS = 256;

/**
 * The Graph refuses `first` above 1000. One vintage is one block's worth of
 * entries on one market, so this is far above anything a block can hold; if it
 * is ever exceeded the decoder reports demand as unknown rather than guessing.
 */
export const VINTAGE_ENTRY_LIMIT = 1000;

const MARKET_FIELDS = `
  id
  settler
  settlerKind
  marketId
  token
  creator
  opener
  resolver
  residueOwner
  n
  kappa
  kappaIsUnbounded
  resolutionTime
  voidTimeout
  status
  winner
  acceptedPool
  paidOut
  residue
  residueClaimed
  createdAt
  specId
  oracle
  feedKey
  strike
  direction
  maxStaleness
  resolvedPrice
  priceUpdatedAt
  voidedStaleAge
  books(first: ${MAX_BOOKS}, orderBy: outcome, orderDirection: asc) {
    outcome
    principal
    vested
    capacity
    capacityIsUnbounded
    acc
  }`;

/**
 * The open vintage, with the entries that are queued in it.
 *
 * The schema has no per-book demand field, because the settler's `D_w` is
 * transient storage that is zeroed the moment the vintage is applied. It is
 * reconstructible exactly: an entry offering `c` on outcome `o` is demand `c`
 * against every book except `o` (`VestedParimutuel.enter`), so the demand on
 * book `w` is the vintage's total offered less what was offered on `w` itself.
 */
const OPEN_VINTAGE_FIELDS = `
  openVintage {
    block
    offered
    entryCount
    entries(first: ${VINTAGE_ENTRY_LIMIT}) {
      outcome
      offered
    }
  }`;

function marketFragment(readOpenVintage: boolean): string {
  return readOpenVintage ? `${MARKET_FIELDS}${OPEN_VINTAGE_FIELDS}` : MARKET_FIELDS;
}

/**
 * `owner` and `vintage` are entity references in the schema, not scalars, so
 * they need a selection set. `vintage` is null on a CLASSIC position: a classic
 * pool has no notion of when a stake arrived.
 */
const POSITION_FIELDS = `
  id
  positionId
  owner { id }
  outcome
  offered
  accepted
  refused
  entryAcc
  vintage { block }
  finalized
  refundWithdrawn
  claimed
  previewPayout`;

const META = `
  _meta {
    block { number }
    hasIndexingErrors
  }`;

export function marketQuery(readOpenVintage: boolean): string {
  return `query Market($id: ID!) {${META}
  market(id: $id) {${marketFragment(readOpenVintage)}
  }
}`;
}

/**
 * One position and the market it belongs to. The open vintage is deliberately
 * not selected: pricing a position never asks what is queued behind it.
 */
export function positionQuery(): string {
  return `query Position($id: ID!) {${META}
  position(id: $id) {${POSITION_FIELDS}
    market {${marketFragment(false)}
    }
  }
}`;
}

/**
 * Positions that actually hold principal on a market. Unfinalized entries have
 * `accepted = 0` and are excluded: they are not yet anybody's counterparty.
 *
 * `market` is a relation, so the filter takes the market's id as a `String`.
 */
export function marketPositionsQuery(): string {
  return `query MarketPositions($market: String!, $first: Int!, $skip: Int!) {
  positions(
    where: { market: $market, accepted_gt: "0" }
    first: $first
    skip: $skip
    orderBy: positionId
    orderDirection: asc
  ) {
    id
    positionId
    owner { id }
    outcome
    accepted
  }
}`;
}

/**
 * The winning positions a resolved market is still waiting on.
 *
 * This is the residue gate, restated as a query: the settler counts positions
 * on the winning book with `accepted > 0` that have not claimed, and refuses
 * `claimResidue` until that count is zero. `previewPayout` is what each of them
 * will take out of the pool, which is what makes the residue exactly knowable
 * before they claim rather than only afterwards.
 */
export function unclaimedWinnersQuery(): string {
  return `query UnclaimedWinners($market: String!, $outcome: Int!, $first: Int!, $skip: Int!) {
  positions(
    where: { market: $market, outcome: $outcome, claimed: false, accepted_gt: "0" }
    first: $first
    skip: $skip
    orderBy: positionId
    orderDirection: asc
  ) {
    id
    positionId
    previewPayout
  }
}`;
}

/** `owner` is a relation to `Agent`, whose id is the lowercase wallet address. */
export function walletPositionsQuery(): string {
  return `query WalletPositions($owner: String!, $first: Int!, $skip: Int!) {${META}
  positions(
    where: { owner: $owner, claimed: false }
    first: $first
    skip: $skip
    orderBy: id
    orderDirection: asc
  ) {${POSITION_FIELDS}
    market {${marketFragment(false)}
    }
  }
}`;
}

/**
 * Everything a wallet holds or has held, claimed positions included: the
 * portfolio question, where `walletPositionsQuery` is the claims one. Paged by
 * `id`, which is stable under `skip`; the read orders by `createdAt` itself.
 */
export function ownerPositionsQuery(): string {
  return `query OwnerPositions($owner: String!, $first: Int!, $skip: Int!) {${META}
  positions(
    where: { owner: $owner }
    first: $first
    skip: $skip
    orderBy: id
    orderDirection: asc
  ) {${POSITION_FIELDS}
    createdAt
    market {${marketFragment(false)}
    }
  }
}`;
}

/**
 * Markets whose residue this wallet is named to sweep and has not swept.
 *
 * Deliberately not filtered on `status`: a wallet owns few enough markets that
 * dropping the unresolved ones in `residueFor` costs nothing, and it keeps one
 * enum literal out of a `where` clause.
 */
export function walletResidueQuery(): string {
  return `query WalletResidue($owner: Bytes!, $first: Int!, $skip: Int!) {
  markets(
    where: { residueOwner: $owner, residueClaimed: false }
    first: $first
    skip: $skip
    orderBy: id
    orderDirection: asc
  ) {${marketFragment(false)}
  }
}`;
}

/**
 * Which address on an ERC-8004 identity a venue wallet is matched against.
 *
 * `owner` holds the identity NFT; `agentWallet` is the address the agent signs
 * and transacts as, which is the one that shows up as a position owner when an
 * agent stakes. They are frequently different addresses and either can be the
 * wallet we hold, so the trust read asks for both and merges.
 */
export type AgentIdentityField = 'agentWallet' | 'owner';

/**
 * ERC-8004 reputation from the standardized schema.
 *
 * `activeFeedbackCount` and `averageScore` are the registry's own aggregates
 * over non-revoked feedback, so a trust read never pages feedback entries.
 * `scoreSum` and `averageScore` are `BigDecimal`: ERC-8004 rescales a score by
 * its `valueDecimals`, so a mean of 4.6 is a normal value, not a rounding
 * artifact.
 */
export function agentsQuery(by: AgentIdentityField): string {
  return `query Agents($addresses: [Bytes!]!, $first: Int!, $skip: Int!) {
  agents(where: { ${by}_in: $addresses }, first: $first, skip: $skip, orderBy: id, orderDirection: asc) {
    id
    agentId
    owner
    agentWallet
    feedbackCount
    activeFeedbackCount
    scoreSum
    averageScore
  }
}`;
}
