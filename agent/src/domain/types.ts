/**
 * The shapes the agent reasons about.
 *
 * These mirror `VestedParimutuel.sol` and `FeedResolver.sol` rather than whatever an
 * indexer happens to return. Everything the settler counts in token units is a `bigint`
 * of USDC base units (6 decimals); everything that is an estimate is a `number`, because
 * an estimate with 18 digits of precision is a lie.
 */

/** `VestedParimutuel.KAPPA_UNBOUNDED` — the sentinel for an n-way market with no cap. */
export const KAPPA_UNBOUNDED = (1n << 256n) - 1n;

export type Hex = `0x${string}`;

export type MarketStatus = "open" | "resolved" | "voided";

/** 0 = "above" wins outcome 0, 1 = "below" wins outcome 0. Matches `FeedResolver.winnerFor`. */
export type FeedDirection = 0 | 1;

/**
 * How a market resolves, copied from `FeedResolver.Spec`. The agent needs the strike and
 * the direction because it prices the question itself rather than buying an opinion.
 */
export interface ResolutionSpec {
  readonly feedKey: string;
  /** Threshold at 8 decimals, the `IPriceOracle` convention. */
  readonly strike8: bigint;
  readonly direction: FeedDirection;
  /** Seconds past which a reading voids the market instead of resolving it. */
  readonly maxStaleness: number;
}

/** One outcome's book: `VestedParimutuel.Book` plus what the indexer knows about its holders. */
export interface BookSnapshot {
  readonly outcome: number;
  readonly label: string;
  /** P_w — accepted principal on w. */
  readonly principal: bigint;
  /** C_w — kappa * P_w, or `KAPPA_UNBOUNDED`. */
  readonly capacity: bigint;
  /** V_w — accepted stake already vested INTO w. */
  readonly vested: bigint;
  /** H_w = C_w - V_w. `KAPPA_UNBOUNDED` when the book cannot run out of room. */
  readonly headroom: bigint;
  /** Distinct position owners with accepted principal on w. */
  readonly holders: number;
  /**
   * Principal-weighted ERC-8004 reputation of THIS book's holders, in [0, 1].
   * 0 means "nobody here has a record", not "everybody here is bad" — see `trustFloor`
   * in the policy.
   *
   * A source that measures the opposing side directly leaves this at 0 and fills
   * `MarketSnapshot.opposingTrust` instead; the policy prefers that when it is set.
   */
  readonly trust: number;
}

export interface MarketSnapshot {
  /** The indexer's id for the market. Every read is addressed by it. */
  readonly marketId: string;
  /**
   * The settler's own market index, which is what `enter` takes. Not interchangeable with
   * `marketId`: the subgraph addresses a market as `<settler>-<index>` and the contract
   * addresses it as the bare index, so a write built from the indexer's string does not
   * encode.
   */
  readonly onChainMarketId: bigint;
  readonly question: string;
  readonly settler: Hex;
  readonly token: Hex;
  readonly status: MarketStatus;
  /** kappa; 30 for binary markets, `KAPPA_UNBOUNDED` for n-way. */
  readonly kappa: bigint;
  /** Unix seconds the market opened — the start of its arrival window. */
  readonly openedAt: number;
  /** Unix seconds of the freeze. `enter` reverts `Frozen()` at or after this. */
  readonly resolutionTime: number;
  /** Pi — sum of accepted principal across all books. */
  readonly acceptedPool: bigint;
  readonly books: readonly BookSnapshot[];
  readonly spec: ResolutionSpec;
  /** Set once the market is resolved. */
  readonly winner: number | undefined;
  /**
   * Per outcome, the trust of the books the agent would be trading AGAINST if it took that
   * outcome — already the opposing figure, in [0, 1].
   *
   * Undefined when the source only knows per-book holder trust (`BookSnapshot.trust`), in
   * which case the policy derives the opposing figure itself. The distinction matters:
   * deriving from a number that is already opposing flips it a second time and hands each
   * outcome its own side's reputation, which is the opposite of what the rule wants.
   */
  readonly opposingTrust: readonly number[] | undefined;
}

export interface PositionSnapshot {
  readonly positionId: string;
  readonly marketId: string;
  readonly owner: Hex;
  readonly outcome: number;
  /** c_k — what was offered at entry. */
  readonly offered: bigint;
  /** s_i — what the books had room to accept. Zero until the vintage is finalized. */
  readonly accepted: bigint;
  /** offered - accepted: refused by headroom, withdrawable, never lost. */
  readonly refused: bigint;
  /** Block number; entries sharing one never vest to each other. */
  readonly vintage: number;
  readonly finalized: boolean;
  /**
   * s_i * (A_o(now) - A_o(entry)) / SCALE — the claim this position has accrued from
   * stake that landed after it. This is the number the whole mechanism is about.
   */
  readonly vestingEarned: bigint;
  readonly claimed: boolean;
}

/** A position that owes this wallet money right now. */
export interface ClaimablePosition {
  /** The indexer's id for the position. */
  readonly positionId: string;
  /** The settler's own position index, which is what `claim` and `withdrawRefund` take. */
  readonly onChainPositionId: bigint;
  readonly marketId: string;
  /** The settlement (or void refund) the call pays. */
  readonly payout: bigint;
  /** Stake the books refused for want of headroom, paid by the same call. */
  readonly refund: bigint;
  /**
   * Which settler call pays it. A refused remainder is withdrawable as soon as the entry's
   * vintage is finalized, before the market settles, and that is a different function from
   * `claim` — sending the wrong one reverts.
   */
  readonly call: "claim" | "withdrawRefund";
  readonly status: MarketStatus;
}

/** The agent's own probability for each outcome, indexed by outcome number. Sums to 1. */
export interface OutcomeEstimate {
  readonly probabilities: readonly number[];
  /** Where it came from, for the audit line in `research` output. */
  readonly basis: string;
  /** Unix seconds of the underlying observation. */
  readonly observedAt: number;
}
