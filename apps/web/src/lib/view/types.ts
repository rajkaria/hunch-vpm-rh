/**
 * The typed props of every data-driven component on the non-trading pages.
 *
 * Money is `bigint` in USDG's smallest unit (6 decimals) and prices are `bigint` at the feed's
 * 8 decimals. The server data layer (`lib/server/*`) maps `@hunch-rh/client` reads into them.
 * The price tape is polled by its client island from `/api/prices`, so its readings are strings.
 */

import type { MarketPhase } from '@/components/market/StatusBadge';

export type Side = 'UP' | 'DOWN';

/** One Chainlink reading for the price tape. Strings, because the tape is a client island. */
export interface PriceReading {
  ticker: string;
  name: string;
  feed: string;
  /** Answer at 8 decimals as a decimal integer string, or null if never read. */
  answer: string | null;
  roundId: string | null;
  /** Unix seconds of the round's `updatedAt`. */
  updatedAt: number | null;
}

export interface PriceSnapshot {
  readings: PriceReading[];
  /** Unix seconds when these readings were taken from the chain. */
  readAt: number;
  /**
   * `live`: this read succeeded. `stale-cache`: this read failed and the readings are the last
   * good ones (see `readAt` for their age). `unavailable`: no read has ever succeeded here.
   */
  status: 'live' | 'stale-cache' | 'unavailable';
}

/** A Chainlink round as a proof cites it. */
export interface RoundRef {
  /** Price at 8 decimals. */
  answer: bigint;
  roundId: string;
  /** Unix seconds of the round's `updatedAt`. */
  at: number;
  /** Blockscout (or data.chain.link) link to the round's source. */
  url: string | null;
}

/** One open or recently closed market, as a card on the landing grid. */
export interface MarketCardData {
  id: string;
  href: string;
  ticker: string;
  family: 'daily' | 'weekly' | 'drill';
  question: string;
  phase: MarketPhase;
  winner?: Side;
  /** Unix seconds: the opening bell that sets the strike. */
  strikeTime: number;
  /** Unix seconds: the closing bell (entries close, the final price is read). */
  finalTime: number;
  /** The price in effect at the opening bell, once it has rung. */
  strike: RoundRef | null;
  /** The latest Chainlink price. */
  live: { answer: bigint; updatedAt: number } | null;
  /** Accepted principal per side, USDG units, including the opening seed. */
  pool: { up: bigint; down: bigint };
  /** The largest stake accepted in full right now on each side (null when unknown). */
  headroom?: { up: bigint; down: bigint } | null;
  /** The market's largest single bet. */
  maxEntry?: bigint;
  /** Taking bets right now (open, before the bell, new bets not paused). */
  acceptingBets?: boolean;
}

/** A winning bettor on the proof card. */
export interface ProofBettor {
  /** A short label: a shortened address for real markets, a name for the illustration. */
  label: string;
  side: Side;
  /** When the bet landed, in words ("Tue 9:35 am ET"). */
  entryLabel: string;
  stake: bigint;
  payout: bigint;
  /** payout / stake in parts per million. */
  multiplePpm: bigint;
  /** The payout transaction. Null only for the illustration. */
  txUrl: string | null;
  entryTxUrl?: string | null;
}

/**
 * The home page's proof: a settled market's earliest and latest winning bettors side by side.
 * `illustration` is the worked example from docs/spec/02-mechanism.md and is always labelled so.
 */
export interface EarlyVsLateProof {
  kind: 'weekly' | 'daily' | 'illustration';
  question: string;
  ticker: string;
  winner: Side;
  /** "Tue Sep 29 to Fri Oct 2" or similar. */
  windowLabel: string;
  strike: RoundRef | null;
  final: RoundRef | null;
  early: ProofBettor;
  late: ProofBettor;
  /** What an ordinary pool would have paid every winner: pool / winning principal, in ppm. */
  classicMultiplePpm: bigint;
  /** "See every bet in this market". Null for the illustration. */
  marketHref: string | null;
}

/** What `lib/server/venue.ts` says about the venue right now. */
export interface VenueState {
  status: 'not-deployed' | 'deployed';
  markets: MarketCardData[];
  /** Latest settled market per family with at least one winning non-seed position. */
  settled: { weekly: EarlyVsLateProof | null; daily: EarlyVsLateProof | null };
  /** Unix seconds of the chain read behind `markets` (null when nothing was read). */
  readAt?: number | null;
  /**
   * `stale`: the latest read failed and `markets` are the last good ones (see `readAt`).
   * `unavailable`: no read has succeeded, so there is nothing to show yet.
   */
  degraded?: 'stale' | 'unavailable' | null;
}

// ---------------------------------------------------------------- /proof

export interface ContractRow {
  name: string;
  role: string;
  address: string | null;
  deployTx: string | null;
  /** Whether Blockscout shows verified source. Null when unknown (not yet checked). */
  verified: boolean | null;
}

export interface SafeInfo {
  address: string | null;
  /** Read on-chain (`getThreshold`, `getOwners().length`). Null until read. */
  threshold: number | null;
  owners: number | null;
}

export interface SettledMarketRow {
  id: string;
  href: string;
  question: string;
  /** VOID: refunded because a price was stale, the token was paused, or nobody settled it in 72 hours. */
  outcome: Side | 'FLAT' | 'VOID';
  /** The two rounds that decided it (null only when they could not be read, or for a timeout refund). */
  strike: RoundRef | null;
  final: RoundRef | null;
  /** The settlement transaction (null when the logs could not be read). */
  resolveTxUrl: string | null;
  /** Bets placed (opening seeds excluded). */
  positions: number;
  /** Total USDG paid out (payouts plus refunds), USDG units. */
  totalPaid: bigint;
}

export interface RefundRow {
  owner: string;
  amount: bigint;
  txUrl: string;
  /** Labelled operator or starter-grant wallets (docs/spec/10-risk.md R1). */
  label?: string;
}

export interface RefundDrillData {
  id: string;
  href: string;
  question: string;
  /** `listed`: open, waiting for its Saturday bell. `refunded`: voided on chain. */
  status: 'listed' | 'refunded';
  /** Unix seconds: the bell whose price the drill cannot trust. */
  finalTime: number;
  /** Why it voided: `stale` (voidStale), `bad-answer` (voidBadAnswer), `flat`, `paused` or the 72 h timeout; null while listed. */
  reason: 'stale' | 'bad-answer' | 'flat' | 'paused' | 'timeout' | null;
  voidTxUrl: string | null;
  strike: RoundRef | null;
  final: RoundRef | null;
  refunds: RefundRow[];
}

export interface FeeSweepRow {
  txUrl: string;
  amount: bigint;
  at: number;
}

export interface ProofCounter {
  label: string;
  /** Null when not yet readable (not deployed, or the read failed). */
  value: bigint | null;
  unit: 'count' | 'USDG';
  /** The query or contract call the number came from. */
  sourceUrl: string | null;
  sourceLabel: string;
  note?: string;
}

export interface ProofData {
  status: 'not-deployed' | 'deployed';
  contracts: ContractRow[];
  feeds: ContractRow[];
  safe: SafeInfo;
  counters: ProofCounter[];
  settled: SettledMarketRow[];
  refundDrill: RefundDrillData | null;
  feeSweeps: FeeSweepRow[];
}
