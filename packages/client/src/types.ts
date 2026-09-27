import type { Address, Hex } from 'viem';

// ---------------------------------------------------------------- entities
//
// These mirror the `hunch-vpm` subgraph's entities after decoding: every
// `BigInt!` has become a `bigint`, every `Bytes!` a checksummable hex string,
// every enum this package's own lower-case spelling. The schema they are
// decoded from is `subgraph/schema.graphql` in this repository; the README
// lists field by field where a name here differs from a name there.

export type MarketStatus = 'Open' | 'Resolved' | 'Voided';

/** Which settlement rule a market runs under. */
export type SettlerKind = 'vested' | 'classic';

/** `above`: outcome 0 wins at or above the strike. `below`: the other way. */
export type FeedDirection = 'above' | 'below';

/**
 * Per-outcome accepted principal and the scalars that govern whether it can
 * take more.
 */
export interface Book {
  /** Index of this outcome within the market, 0-based. */
  outcome: number;
  /** P_w — accepted principal on this outcome. */
  principal: bigint;
  /** V_w — total accepted stake vested INTO this book from the other outcomes. */
  vested: bigint;
  /** C_w — capacity, kappa * P_w. `null` when kappa is unbounded. */
  capacity: bigint | null;
  /** A_w — reward-per-share accumulator, fixed point at `ACC_SCALE`. */
  acc: bigint;
  /**
   * D_w — stake already offered against this book by the market's open
   * vintage, which will ration alongside a new entry in the same block. 0 when
   * no vintage is open. `null` when the read did not ask for the open vintage
   * (`readOpenVintage: false`) or the vintage was too large to read whole.
   */
  demand: bigint | null;
}

/** How a market resolves, as registered on `FeedResolver`. */
export interface ResolutionSpec {
  /** keccak256 of the whole spec — immutable once registered. */
  specId: Hex;
  /** The IPriceOracle adapter the spec reads. */
  oracle: Address;
  /** Adapter-defined feed identifier. */
  feedKey: Hex;
  /** Threshold at 8 decimals, signed. */
  strike: bigint;
  direction: FeedDirection;
  /** Seconds beyond which a reading is too old and the market voids instead. */
  maxStaleness: bigint;
}

export interface Market {
  /** Subgraph id: `<settler>-<marketId>`. */
  id: string;
  /** Which settler holds this market. */
  settler: Address;
  settlerKind: SettlerKind;
  /** The settler's own market index, which is what `enter` takes. */
  marketId: bigint;
  token: Address;
  /** Whoever called `create()`. Under `MarketFactory` that is the factory. */
  creator: Address;
  /** The wallet that opened it through the factory. `null` when it was not. */
  opener: Address | null;
  resolver: Address;
  residueOwner: Address;
  /** |O|, at least 2. */
  outcomeCount: number;
  /** kappa. `null` when unbounded. */
  kappa: bigint | null;
  /**
   * When the market was created, unix seconds. The start of the arrival window
   * whose far end is `resolutionTime`: on a vested market, how much of that
   * window is left is what decides whether a stake still has time to earn.
   */
  createdAt: bigint;
  /** The freeze, unix seconds. Entries at or after it are refused. */
  resolutionTime: bigint;
  /** Seconds after the freeze from which anyone may void. */
  voidTimeout: bigint;
  status: MarketStatus;
  /** The realized outcome, set only when `status` is `Resolved`. */
  winner: number | null;
  /** Pi — the sum of accepted principal across every book. */
  acceptedPool: bigint;
  /** Sum of settlement payouts already claimed. */
  paidOut: bigint;
  /**
   * `acceptedPool - paidOut` on a resolved market, 0 on any other. This is an
   * upper bound on what the residue owner gets until every winning position
   * has claimed — until then it still contains their settlements.
   */
  residue: bigint;
  residueClaimed: boolean;
  /** The reading the market settled on, at 8 decimals. `null` until it does. */
  resolvedPrice: bigint | null;
  /** When the oracle last wrote that reading. */
  priceUpdatedAt: bigint | null;
  /** Age of the reading that voided the market, in seconds. `null` otherwise. */
  voidedStaleAge: bigint | null;
  /**
   * Whether a vintage is buffered and unfinalized, with the block it belongs
   * to. `null` when the read did not ask for the open vintage.
   */
  vintageOpen: boolean | null;
  vintageBlock: bigint | null;
  books: Book[];
  spec: ResolutionSpec | null;
}

export interface Position {
  /** Subgraph id: `<settler>-<positionId>`. */
  id: string;
  /** The settler's own position index, which is what `claim` takes. */
  positionId: bigint;
  owner: Address;
  outcome: number;
  /** c_k — what was staked. */
  offered: bigint;
  /** s_i — what the books had room to accept. Meaningless until `finalized`. */
  accepted: bigint;
  /** offered - accepted: refused for want of headroom, and refundable. */
  refused: bigint;
  /** A_o at entry, used to price what has vested to this position since. */
  entryAcc: bigint;
  /**
   * The block whose vintage this entry joined; 0 is the reserved seed vintage.
   * `null` on a classic market, which does not batch by block at all.
   */
  vintage: bigint | null;
  /** Whether the entry's vintage has been finalized, fixing `accepted`. */
  finalized: boolean;
  /** Whether `offered - accepted` has already been pulled back. */
  refundWithdrawn: boolean;
  /** Whether the settlement claim has been paid. */
  claimed: boolean;
  /**
   * What `claim` would pay if the market settled right now to this position's
   * own outcome. The index computes it under whichever rule the market runs,
   * so it is the settlement figure for a classic market too.
   */
  previewPayout: bigint;
  market: Market;
}

/** An ERC-8004 identity with its aggregated reputation. */
export interface AgentReputation {
  /**
   * The venue wallet this reputation was matched to — the identity's
   * `agentWallet` or, when that is not the address that staked, the wallet
   * holding the identity NFT.
   */
  address: Address;
  /** Holder of the identity NFT. */
  owner: Address;
  /** The address the agent signs and transacts as, when it advertises one. */
  agentWallet: Address | null;
  /** The registry's identity id, when the wallet has one. */
  agentId: bigint | null;
  /** Non-revoked feedback entries — the count the mean is taken over. */
  feedbackCount: number;
  /**
   * Sum of those scores, as the registry's exact decimal string. ERC-8004
   * rescales a score by its own `valueDecimals`, so this is not an integer.
   */
  scoreSum: string;
  /** The registry's mean feedback score on its own scale. `null` when unrated. */
  meanScore: number | null;
}

/** What the index knows, and how far behind the chain it is. */
export interface IndexStatus {
  /** Last block the subgraph has processed. */
  block: bigint;
  hasIndexingErrors: boolean;
}

// ---------------------------------------------------------------- read results

/**
 * What one outcome would do with a stake right now.
 *
 * `bookHeadroom` is this outcome's own room, which is informational. The
 * number that decides whether a stake is refused is `bindingHeadroom`: stake
 * on outcome o vests into the OPPOSING books, so it is accepted only up to the
 * room those books still have.
 */
export interface OutcomeHeadroom {
  outcome: number;
  /** H_o of this outcome's own book. `null` when unbounded. */
  bookHeadroom: bigint | null;
  /**
   * H_w of the opposing book that binds — the one with the least room left
   * once the stake already queued against it is counted. `null` when every
   * opposing book is unbounded. The book with the smallest headroom before
   * demand is still in `opposing`, if you want it.
   */
  bindingHeadroom: bigint | null;
  /** Which opposing book that is, or `null` when none binds. */
  bindingOutcome: number | null;
  /**
   * The largest stake accepted in full if you enter now: `bindingHeadroom`
   * less `competingDemand`, floored at 0. `null` when unbounded.
   */
  maxFullyAccepted: bigint | null;
  /**
   * Stake already offered against the BINDING book in this block's vintage,
   * which will ration alongside yours. 0 when no vintage is open in the
   * current block.
   */
  competingDemand: bigint;
  /** Per opposing book, the room and the queue. */
  opposing: OpposingBookRoom[];
}

export interface OpposingBookRoom {
  outcome: number;
  /** H_w = C_w - V_w, floored at 0. `null` when unbounded. */
  headroom: bigint | null;
  /** D_w already offered against this book in the open vintage of this block. */
  competingDemand: bigint;
  /** max(0, H_w - D_w): what this book alone would accept in full. `null` when unbounded. */
  allowance: bigint | null;
}

export interface BestHeadroom {
  marketId: string;
  status: MarketStatus;
  /** True once no further stake can be accepted, whatever the headroom says. */
  frozen: boolean;
  /**
   * The outcome with the most room, or `null` when the market takes no stake
   * at all right now (frozen, settled, or every outcome fully rationed).
   */
  best: OutcomeHeadroom | null;
  /** Every outcome, in outcome order. */
  outcomes: OutcomeHeadroom[];
  /**
   * Set when the stake queued in the current block could not be read, meaning
   * `maxFullyAccepted` ignores it and is therefore an upper bound rather than
   * a guarantee.
   */
  demandUnknown: boolean;
  index: IndexStatus;
}

export interface OutcomeOdds {
  outcome: number;
  /** P_o — accepted principal backing this outcome. */
  principal: bigint;
  /** P_o / Pi in parts per million, floored. */
  probabilityPpm: bigint;
  /** The same number as a percent string with 4 decimal places. */
  probabilityPercent: string;
  /**
   * Pi / P_o in parts per million: what one unit on this outcome returns in
   * gross terms if it wins and nothing else enters. `null` when P_o is 0.
   */
  decimalOddsPpm: bigint | null;
}

export interface ImpliedOdds {
  marketId: string;
  status: MarketStatus;
  /** Pi — total accepted principal. */
  totalAccepted: bigint;
  /**
   * False when the pool is empty, in which case every probability is 0 and no
   * odds are defined. Flooring also means the probabilities sum to slightly
   * under 1e6 ppm; that gap is the rounding, not a house edge.
   */
  defined: boolean;
  outcomes: OutcomeOdds[];
  index: IndexStatus;
}

export interface Counterparty {
  address: Address;
  /** Accepted principal this wallet holds on the opposing side. */
  principal: bigint;
  /** Its share of the opposing book, in ppm. */
  sharePpm: bigint;
  /** Mean ERC-8004 feedback score, or `null` when the wallet has no reputation. */
  meanScore: number | null;
  feedbackCount: number;
  agentId: bigint | null;
}

/** Who is on the other side if you take `outcome`. */
export interface OpposingSideTrust {
  /** The outcome you would be taking. */
  outcome: number;
  /** Accepted principal on every other outcome. */
  opposingPrincipal: bigint;
  /** Distinct wallets holding it. */
  counterparties: number;
  /** How many of them the reputation registry knows. */
  ratedCounterparties: number;
  /** Mean score across rated wallets, one wallet one vote. `null` when none is rated. */
  meanScore: number | null;
  /** Mean score weighted by accepted principal. `null` when no rated wallet holds principal. */
  principalWeightedMeanScore: number | null;
  /** Principal held by wallets with no reputation at all. */
  unratedPrincipal: bigint;
  /** That principal as a share of the opposing book, in ppm. */
  unratedSharePpm: bigint;
  /** Every counterparty, largest principal first. */
  wallets: Counterparty[];
}

export interface CounterpartyTrust {
  marketId: string;
  /** One entry per outcome: `sides[o]` is who is against you if you take o. */
  sides: OpposingSideTrust[];
  /**
   * Set when no reputation source is configured, in which case every wallet
   * counts as unrated and the scores are all `null`.
   */
  reputationUnavailable: boolean;
  index: IndexStatus;
}

export type PositionState =
  | 'pending-vintage'
  | 'open'
  | 'won'
  | 'lost'
  | 'voided'
  | 'claimed';

export interface VestingEarned {
  positionId: string;
  marketId: string;
  owner: Address;
  outcome: number;
  state: PositionState;
  /** What was staked. */
  offered: bigint;
  /** What the books accepted. Zero and provisional while `state` is pending-vintage. */
  accepted: bigint;
  /** offered - accepted: refused for want of headroom, and refundable. */
  refused: bigint;
  /** Whether that refund has already been pulled. */
  refundWithdrawn: boolean;
  /** A_o at entry. */
  entryAcc: bigint;
  /** A_o now — frozen at the resolution timestamp once the market has settled. */
  currentAcc: bigint;
  /**
   * floor(accepted * (currentAcc - entryAcc) / S): stake that has vested to
   * this position from the opposing books since it entered. `null` until the
   * position's vintage is finalized, because `accepted` is not fixed before
   * then, and `null` on a classic market, where nothing vests at all.
   */
  earned: bigint | null;
  /**
   * What this position pays if its outcome is the one that happens. On a
   * vested market that is `accepted + earned`, which is the settler's own
   * `previewPayout`; on a classic one it is the pool share the index computes.
   */
  payoutIfOutcomeWins: bigint | null;
  /** What `claim` pays right now: 0 while the market is open or lost. */
  claimableNow: bigint;
  index: IndexStatus;
}

export type ClaimReason = 'settlement' | 'voidRefund' | 'refusedRemainder' | 'residue';

/** What each reason contributes to one call's payout. */
export type ClaimBreakdown = Record<ClaimReason, bigint>;

/**
 * One transaction that pays money. There is exactly one item per call the
 * wallet should send, never two items sharing a call: `claim` pays a
 * settlement and any outstanding refused remainder in the same transaction,
 * and sending it twice reverts.
 */
export interface ClaimableItem {
  /** Subgraph id of the position, or of the market for residue. */
  id: string;
  marketId: string;
  /** Total this one call pays. */
  amount: bigint;
  breakdown: ClaimBreakdown;
  /** The settler call that pays it. */
  call: 'claim' | 'withdrawRefund' | 'claimResidue';
  /** Its argument: the settler's position id, or the market id for residue. */
  argument: bigint;
  settler: Address;
}

/**
 * Residue the wallet owns that it cannot sweep yet.
 *
 * `amount` is the residue itself — what is left after every outstanding
 * winning settlement has been paid out — which is knowable in advance because
 * the index publishes each unclaimed winner's payout. `atMostAmount` is the
 * cruder `acceptedPool - paidOut`, which is the residue PLUS those
 * settlements, and is what the settler will transfer if every winner claims
 * first. They differ by other people's money, so they are never conflated.
 */
export interface BlockedResidue {
  marketId: string;
  /** The residue, exactly, unless `isUpperBound` says otherwise. */
  amount: bigint;
  /** `acceptedPool - paidOut`: residue plus every settlement still unclaimed. */
  atMostAmount: bigint;
  /** True when `amount` could not be pinned down and is `atMostAmount` instead. */
  isUpperBound: boolean;
  /** How many winning positions are still outstanding, and why that blocks it. */
  reason: string;
}

export interface Claimable {
  wallet: Address;
  totals: ClaimBreakdown & {
    /** Everything ready to pull, across every reason. */
    total: bigint;
  };
  items: ClaimableItem[];
  /** Residue the wallet owns that is not sweepable yet, and why. */
  blockedResidue: BlockedResidue[];
  index: IndexStatus;
}

export interface BookView {
  outcome: number;
  principal: bigint;
  vested: bigint;
  /** `null` when kappa is unbounded. */
  capacity: bigint | null;
  /** C_w - V_w, floored at 0. `null` when unbounded. */
  headroom: bigint | null;
  /** Share of accepted principal, in ppm. */
  probabilityPpm: bigint;
  probabilityPercent: string;
  decimalOddsPpm: bigint | null;
  /** Largest stake on THIS outcome that would be accepted in full right now. */
  maxFullyAccepted: bigint | null;
  acc: bigint;
  /**
   * Positions on this book with accepted principal that have not claimed — the
   * gate that holds residue back. Counted only for the winning book of a
   * resolved market, which is the only place it decides anything; `null`
   * everywhere else.
   */
  live: number | null;
}

export interface MarketBook {
  marketId: string;
  settler: Address;
  settlerKind: SettlerKind;
  /** The settler's own market index. */
  onChainMarketId: bigint;
  token: Address;
  status: MarketStatus;
  winner: number | null;
  /** `null` when kappa is unbounded. */
  kappa: bigint | null;
  acceptedPool: bigint;
  paidOut: bigint;
  /**
   * What the residue owner is owed: 0 until the market resolves, and an upper
   * bound until every winning position has claimed. `claimable` prices it
   * exactly for the wallet that owns it.
   */
  residue: bigint;
  residueOwner: Address;
  residueClaimed: boolean;
  /**
   * When the market was created, unix seconds — `Market.createdAt` in the
   * index. Together with `resolutionTime` it bounds the arrival window, which
   * is what a vested reader needs to judge how much of that window a stake
   * entering now would still have to earn in. Published rather than derived
   * because nothing else in this response implies it.
   */
  createdAt: bigint;
  resolutionTime: bigint;
  /** Seconds until the freeze, floored at 0. */
  secondsToFreeze: bigint;
  /** True once the freeze has passed: no entry can be accepted. */
  frozen: boolean;
  voidTimeout: bigint;
  /** Unix seconds from which anyone may void an unresolved market. */
  voidableFrom: bigint;
  books: BookView[];
  spec: ResolutionSpec | null;
  /** The reading the market settled on, at 8 decimals. `null` until it does. */
  resolvedPrice: bigint | null;
  /** When the oracle last wrote that reading. */
  priceUpdatedAt: bigint | null;
  /** Age of the reading that voided it, in seconds. `null` unless that is why. */
  voidedStaleAge: bigint | null;
  index: IndexStatus;
}

/** A position with the moment it entered, as the portfolio read returns it. */
export interface OwnedPosition extends Position {
  /** Unix seconds the entry landed. */
  createdAt: bigint;
}

/** Everything one wallet holds or has held. */
export interface WalletPositions {
  wallet: Address;
  /** Newest first. Claimed and unfinalized positions are included. */
  positions: OwnedPosition[];
  index: IndexStatus;
}
