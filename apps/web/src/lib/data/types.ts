/**
 * The shapes every page reads.
 *
 * These mirror `@hunch-vpm/client`'s public types field for field wherever the
 * two overlap, and add the handful of things a screen needs that an indexer
 * does not hold — an outcome's human label, the name of a feed behind a feed
 * key, the sampled history a curve is drawn from. They are declared here
 * rather than imported so that this app typechecks and builds against a
 * workspace where the client has not been compiled yet, which is the state of
 * a fresh clone and the state in CI, where `typecheck` runs before `build`.
 * `src/lib/data/live.ts` is the single file that crosses into the real client.
 */

export type MarketStatus = 'Open' | 'Resolved' | 'Voided';

/** Which settlement rule a market runs under. */
export type SettlerKind = 'vested' | 'classic';

/** 0 = above: outcome 0 wins at or above the strike. 1 = below. */
export type FeedDirection = 'above' | 'below';

/** Which accent an outcome carries. Lime is YES/UP, coral is NO/DOWN, and
 *  anything that is neither takes the neutral treatment rather than borrowing
 *  a colour that already means something. */
export type OutcomeTone = 'up' | 'down' | 'neutral';

export interface IndexStatus {
  /** Last block the subgraph has processed. */
  block: bigint;
  hasIndexingErrors: boolean;
  /** Which source produced this read, so the UI can say so out loud. */
  source: 'fixture' | 'live';
}

/** How a market resolves, as registered on `FeedResolver`. */
export interface ResolutionSpec {
  /** keccak256 of the whole spec — immutable once registered. */
  specId: string;
  /** The IPriceOracle adapter the spec reads. */
  oracle: string;
  /** A name for that adapter, for readers who will not recognise the address. */
  oracleName: string;
  /** Adapter-defined feed identifier. */
  feedKey: string;
  /** What that key refers to, in words. */
  feedLabel: string;
  /** Threshold at 8 decimals, signed. */
  strike: bigint;
  direction: FeedDirection;
  /** Seconds beyond which a reading is too old and the market voids instead. */
  maxStaleness: bigint;
  /** The last reading the resolver would see, when the indexer has one. */
  lastPrice: bigint | null;
  /** Unix seconds of that reading. */
  lastUpdatedAt: bigint | null;
}

export interface OutcomeView {
  outcome: number;
  /** "Yes", "No", "Above $4,000" — what a person calls this side. */
  label: string;
  tone: OutcomeTone;
  /** P_w — accepted principal on this outcome. */
  principal: bigint;
  /** V_w — accepted stake vested INTO this book from the other outcomes. */
  vested: bigint;
  /** C_w = kappa * P_w. `null` when kappa is unbounded. */
  capacity: bigint | null;
  /** A_w — reward-per-share accumulator, fixed point at 1e18. */
  acc: bigint;
  /** D_w — offered demand queued against this book in the block's open vintage. */
  demand: bigint;
  /** Unclaimed winning positions, the residue gate. `null` when unpublished. */
  live: number | null;
  /** P_w / Pi in ppm. */
  probabilityPpm: bigint;
}

export interface MarketSummary {
  /** Subgraph id: `<settler>-<marketId>`. */
  id: string;
  /** The settler's own market index, which is what `enter` takes. */
  onChainMarketId: bigint;
  settler: string;
  settlerKind: SettlerKind;
  /** The question, as a person would ask it. */
  question: string;
  /** What it is about, in two or three words: "ETH / USD", "BTC dominance". */
  subject: string;
  status: MarketStatus;
  /** The realized outcome, set only when `status` is `Resolved`. */
  winner: number | null;
  /** kappa. `null` when unbounded. */
  kappa: bigint | null;
  /** Pi — accepted principal across every book. */
  acceptedPool: bigint;
  /** The freeze, unix seconds. Entries at or after it are refused. */
  resolutionTime: bigint;
  /** Seconds until the freeze, floored at 0. */
  secondsToFreeze: bigint;
  /** True once the freeze has passed: no entry can be accepted. */
  frozen: boolean;
  outcomes: OutcomeView[];
}

export interface VestingSample {
  /** Unix seconds. */
  t: bigint;
  /** Per outcome, in outcome order. */
  points: { outcome: number; principal: bigint; acc: bigint; vested: bigint }[];
}

export interface PositionView {
  /** Subgraph id: `<settler>-<positionId>`. */
  id: string;
  /** The settler's own position index, which is what `claim` takes. */
  positionId: bigint;
  owner: string;
  outcome: number;
  /** c_k — what was staked. */
  offered: bigint;
  /** s_i — what the books had room to accept. */
  accepted: bigint;
  /** offered - accepted: refused for want of headroom, and refundable. */
  refused: bigint;
  /** A_o at entry. */
  entryAcc: bigint;
  /**
   * The block whose vintage this entry joined. 0 is the reserved seed vintage.
   * `null` on a classic market, which does not batch entries by block at all.
   */
  vintage: bigint | null;
  finalized: boolean;
  refundWithdrawn: boolean;
  claimed: boolean;
  /** Unix seconds the entry landed. */
  enteredAt: bigint;
}

export interface MarketDetail extends MarketSummary {
  token: string;
  creator: string;
  resolver: string;
  residueOwner: string;
  residueClaimed: boolean;
  /** Pi - paid out: the flooring remainder, once every winner has claimed. */
  residue: bigint;
  paidOut: bigint;
  /** Seconds after the freeze from which anyone may void. */
  voidTimeout: bigint;
  /** Unix seconds from which anyone may void an unresolved market. */
  voidableFrom: bigint;
  /** Whether a vintage is buffered and unfinalized, with the block it belongs to. */
  vintageOpen: boolean;
  vintageBlock: bigint | null;
  spec: ResolutionSpec | null;
  /** Sampled over the market's life, oldest first, for the vesting curve. */
  history: VestingSample[];
  /** The connected wallet's positions in this market, entry order. */
  positions: PositionView[];
  index: IndexStatus;
}

export interface AgentRow {
  address: string;
  /** What the agent calls itself, from its ERC-8004 identity. */
  handle: string;
  /** The registry's identity id, when the wallet has one. */
  agentId: bigint | null;
  /**
   * Whether a human has put their own name behind this agent, and who. A badge,
   * not a score: it says someone is accountable, not that the agent is good.
   */
  humanBacked: boolean;
  backedBy: string | null;
  /** How many feedback entries the reputation registry holds. */
  feedbackCount: number;
  /** Mean feedback score on the registry's 0..100 scale. `null` when unrated. */
  meanScore: number | null;
  marketsEntered: number;
  /** Principal the books accepted from this agent, all time. */
  acceptedPrincipal: bigint;
  /** Principal refused for want of headroom, and refunded. */
  refusedPrincipal: bigint;
  /** Settled profit and loss, which can be negative. */
  realizedPnl: bigint;
  /** Share of settled markets this agent was on the winning side of, in ppm. */
  winRatePpm: bigint | null;
}

export type ClaimReason = 'settlement' | 'voidRefund' | 'refusedRemainder' | 'residue';

export type ClaimBreakdown = Record<ClaimReason, bigint>;

export interface ClaimableItem {
  /** Subgraph id of the position, or of the market for residue. */
  id: string;
  marketId: string;
  /** The question the money came from, so the row means something. */
  question: string;
  /** Total this one call pays. */
  amount: bigint;
  breakdown: ClaimBreakdown;
  /** The settler call that pays it. */
  call: 'claim' | 'withdrawRefund' | 'claimResidue';
  /** Its argument: the settler's position id, or the market id for residue. */
  argument: bigint;
  settler: string;
}

/** One position, with just enough of its market to be read on its own. */
export interface PortfolioEntry {
  market: MarketSummary;
  position: PositionView;
}

export interface ClaimableView {
  wallet: string;
  totals: ClaimBreakdown & { total: bigint };
  items: ClaimableItem[];
  /** Residue the wallet owns that is not sweepable yet, and why not. */
  blockedResidue: { marketId: string; question: string; amount: bigint; reason: string }[];
  index: IndexStatus;
}

/**
 * Everything the pages read. One interface, two implementations: the fixture
 * source that ships with the app and renders every screen with no network and
 * no deployed contracts, and the live source that goes through
 * `@hunch-vpm/client`. Switching between them is one line in
 * `src/lib/data/index.ts`.
 */
export interface DataSource {
  /** Which implementation this is, so pages can label what they are showing. */
  readonly kind: 'fixture' | 'live';
  listMarkets(): Promise<MarketSummary[]>;
  /** `null` when no market carries that id, which the page turns into a 404. */
  getMarket(id: string): Promise<MarketDetail | null>;
  listAgents(): Promise<AgentRow[]>;
  getClaimable(wallet: string): Promise<ClaimableView>;
  /**
   * Every position an address holds, across every market, newest first.
   *
   * Separate from `getClaimable` because the two answer different questions:
   * claimable is what can be *pulled right now*, and most of a portfolio is
   * open stake that cannot. A holder with three live positions and nothing
   * settled would otherwise see an empty page and conclude their money had
   * vanished.
   */
  getPositions(wallet: string): Promise<PortfolioEntry[]>;
  /**
   * The wallet the surface is reading for. `null` when nothing is connected,
   * which every page has to render properly rather than treat as an error.
   */
  currentWallet(): string | null;
}
