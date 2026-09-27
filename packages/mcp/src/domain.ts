/**
 * The venue's vocabulary, normalized. Tools consume these types and nothing else, so
 * a change in how the data arrives (client call, subgraph query, direct RPC) stops at
 * the reader and never reaches a tool handler.
 *
 * Terms are the paper's and the settler's:
 *   book      per-outcome accepted principal, P_w
 *   vested    stake that has vested INTO that book from the opposing side, V_w
 *   capacity  C_w = κ·P_w, or unbounded
 *   headroom  H_w = C_w − V_w, the room the book still has to accept stake
 */

import { isUnbounded, UNBOUNDED } from "./format.js";

export type MarketStatus = "open" | "resolved" | "voided";

export interface BookState {
  /** Outcome index w, as the settler indexes it. */
  readonly index: number;
  readonly label: string | undefined;
  /** P_w — accepted principal staked on this outcome. */
  readonly principal: bigint;
  /** V_w — accepted stake from the opposing side that has vested into this book. */
  readonly vested: bigint;
  /** C_w — κ·P_w, or the unbounded sentinel. */
  readonly capacity: bigint;
  /** H_w = C_w − V_w. Zero means the next stake against this book is refused. */
  readonly headroom: bigint;
}

export interface MarketState {
  readonly id: string;
  /** The settler holding the escrow. Which rule the market runs under lives here. */
  readonly settler: string | undefined;
  readonly question: string | undefined;
  readonly status: MarketStatus;
  /** κ — capacity coefficient. 30 for binary markets, the sentinel for n-way. */
  readonly kappa: bigint;
  /** The freeze, in unix seconds. Entries at or after it are refused outright. */
  readonly resolutionTime: number;
  /** Π — the accepted pool, the sum of every book's principal. */
  readonly acceptedPool: bigint;
  /** Set once the market is resolved. */
  readonly winner: number | undefined;
  readonly books: readonly BookState[];
}

export interface OddsRow {
  readonly index: number;
  readonly label: string | undefined;
  /** Share of the accepted pool sitting on this outcome, in [0, 1]. */
  readonly impliedProbability: number;
}

/**
 * The outcome a new stake can put the most money on right now.
 *
 * Deliberately not "the book with the largest headroom": stake on an outcome vests into
 * the OPPOSING books, so what binds is the smallest headroom among the others. The two
 * answers name different outcomes in the same market, and only this one sizes an entry.
 */
export interface HeadroomPick {
  readonly index: number;
  readonly label: string | undefined;
  /** The most this outcome can have accepted right now, or the unbounded sentinel. */
  readonly acceptsUpTo: bigint;
}

export interface Counterparty {
  readonly wallet: string;
  readonly outcome: number | undefined;
  readonly stake: bigint | undefined;
  /**
   * This wallet's share of the stake it was counted against, in [0, 1]. In a binary
   * market that is the book it holds; in an n-way one it is every book but the side's,
   * because that is the aggregate the source reports against.
   */
  readonly share: number | undefined;
  readonly agentId: string | undefined;
  readonly humanBacked: boolean | undefined;
  readonly feedbackCount: number | undefined;
  readonly score: number | undefined;
}

export interface TrustSummary {
  readonly counterparties: readonly Counterparty[];
  /** Share of opposing stake held by wallets with an ERC-8004 identity, in [0, 1]. */
  readonly registeredShare: number | undefined;
  /** Share of opposing stake held by wallets backed by a verified human, in [0, 1]. */
  readonly humanBackedShare: number | undefined;
  /** What the source could not answer. An empty list of wallets with no note means zero. */
  readonly notes: readonly string[];
}

/** What a position has earned from stake that arrived after it. */
export interface VestingEarned {
  readonly positionId: string;
  readonly accepted: bigint;
  /**
   * Undefined until the position's vintage is finalized: `accepted` is not fixed before
   * then, so no honest number exists yet. Zero would be a different claim.
   */
  readonly vested: bigint | undefined;
  readonly previewPayout: bigint | undefined;
}

export type ClaimKind =
  /** A winning position on a resolved market. */
  | "payout"
  /** The refused remainder of a partial fill: offered − accepted. */
  | "refund"
  /** A voided market refunds every position at its accepted principal. */
  | "void_refund"
  /** The flooring remainder, claimable only by the residue owner named at creation. */
  | "residue"
  | "unknown";

export interface ClaimableItem {
  readonly kind: ClaimKind;
  readonly amount: bigint;
  readonly marketId: string | undefined;
  /** The index's composite id, for display. NOT what the settler's call takes. */
  readonly positionId: string | undefined;
  readonly outcome: number | undefined;
  readonly settler: string | undefined;
  /** The settler function that pays this item, when the source names it. */
  readonly call: string | undefined;
  /**
   * The argument that call takes: the settler's own numeric position id, or the market
   * id for residue. Reads are addressed by composite id and writes by this number, so
   * the two are carried separately and never substituted for one another.
   */
  readonly argument: string | undefined;
}

export interface ClaimableSummary {
  readonly wallet: string;
  readonly total: bigint;
  readonly items: readonly ClaimableItem[];
}

/** ERC-8004 identity and reputation for one wallet, plus the human-backed flag. */
export interface AgentRecord {
  readonly wallet: string;
  readonly identity: {
    /** In the registry and not burned. A burned identity is not a live one. */
    readonly registered: boolean;
    /** True when the identity NFT has been burned, so `registered` is false for a reason. */
    readonly burned: boolean | undefined;
    readonly agentId: string | undefined;
    readonly name: string | undefined;
    /** tokenURI: the agent card. An off-chain document nothing here resolves. */
    readonly metadataUri: string | undefined;
    readonly registry: string | undefined;
  };
  readonly reputation: {
    readonly feedbackCount: number | undefined;
    /** Feedback that still counts. The registry lets an author revoke an entry. */
    readonly activeFeedbackCount: number | undefined;
    readonly revokedFeedbackCount: number | undefined;
    /** Mean of non-revoked scores, on the registry's own scale. */
    readonly averageScore: number | undefined;
    readonly validationCount: number | undefined;
    readonly lastSeen: number | undefined;
  };
  /** Present only when an AgentBook proof was found; absent is "unknown", not "no". */
  readonly humanBacked: boolean | undefined;
  readonly venue:
    | {
        readonly marketsEntered: number | undefined;
        readonly offered: bigint | undefined;
        readonly acceptedStake: bigint | undefined;
        readonly claimed: bigint | undefined;
        readonly firstSeen: number | undefined;
      }
    | undefined;
  /**
   * What could not be read, in plain words. A half-answered reputation lookup is worth
   * returning — an agent can still act on identity when AgentBook is unreachable — but
   * only if it is told which half is missing.
   */
  readonly notes: readonly string[];
}

// ------------------------------------------------------------------ derivations

/**
 * Implied probabilities straight from accepted principal. This is what the crowd has
 * actually paid, not a quoted price: p_w = P_w / Π.
 */
export function oddsFromBooks(books: readonly BookState[]): OddsRow[] {
  const pool = books.reduce((sum, book) => sum + book.principal, 0n);
  return books.map((book) => ({
    index: book.index,
    label: book.label,
    impliedProbability: pool === 0n ? 0 : Number(book.principal) / Number(pool),
  }));
}

/**
 * The outcome a stake can put the most money on, derived from the book. This is the same
 * question `@hunch-vpm/client`'s `bestHeadroom` answers, computed the same way, so the
 * fallback and the client's own answer name the same outcome rather than disagreeing.
 */
export function bestOutcomeToStake(books: readonly BookState[]): HeadroomPick | undefined {
  let best: HeadroomPick | undefined;
  for (const book of books) {
    const capacity = capacityToAccept(books, book.index);
    if (best === undefined || capacity.amount > best.acceptsUpTo) {
      best = { index: book.index, label: book.label, acceptsUpTo: capacity.amount };
    }
  }
  return best;
}

export interface Capacity {
  /** The most a single stake on this outcome can have accepted right now. */
  readonly amount: bigint;
  /** The opposing book that sets the limit, when one does. */
  readonly limitedBy: number | undefined;
}

/**
 * The most a stake on `outcome` can have accepted right now.
 *
 * This is the number that decides whether an entry lands, and it is NOT the outcome's
 * own headroom. Rule 1 assigns a stake in full to every opposing branch, so stake on
 * `outcome` vests into the *other* books and is limited by what those books can still
 * take: min over w ≠ outcome of H_w. In a binary market, what a stake on YES can have
 * accepted is the headroom of the NO book.
 */
export function capacityToAccept(books: readonly BookState[], outcome: number): Capacity {
  let amount: bigint | undefined;
  let limitedBy: number | undefined;
  for (const book of books) {
    if (book.index === outcome) continue;
    if (isUnbounded(book.headroom)) continue;
    if (amount === undefined || book.headroom < amount) {
      amount = book.headroom;
      limitedBy = book.index;
    }
  }
  // Every opposing book is unbounded (κ → ∞), so nothing rations this outcome.
  return amount === undefined ? { amount: UNBOUNDED, limitedBy: undefined } : { amount, limitedBy };
}

export interface Acceptance {
  readonly outcome: number;
  readonly label: string | undefined;
  readonly offered: bigint;
  readonly accepted: bigint;
  readonly refused: bigint;
  /** The opposing book that does the cutting, when something is cut. */
  readonly limitedBy: number | undefined;
}

/**
 * How much of `offered` on `outcome` would be accepted if it were the only entry in its
 * block. Alone in its vintage the entry's demand D_w equals the offer, so §4.4's
 * rationing ⌊c·H_w/D_w⌋ collapses to H_w and acceptance is min(offered, capacity).
 *
 * An upper bound, not a promise: other entries landing in the same block share the same
 * headroom pro rata, and the headroom moves with every finalized vintage.
 */
export function acceptanceOf(books: readonly BookState[], outcome: number, offered: bigint): Acceptance {
  const own = books.find((book) => book.index === outcome);
  const capacity = capacityToAccept(books, outcome);
  const accepted = offered < capacity.amount ? offered : capacity.amount;
  return {
    outcome,
    label: own?.label,
    offered,
    accepted,
    refused: offered - accepted,
    limitedBy: accepted < offered ? capacity.limitedBy : undefined,
  };
}
