// TODO(S7): these are the shapes the S8 components render. Map @hunch-rh/client reads into them.
/**
 * The typed props of every data-driven component on the non-trading pages.
 *
 * Money is `bigint` in USDG's smallest unit (6 decimals) and prices are `bigint` at the feed's
 * 8 decimals, in server components. Anything that crosses into a client island is a string (a
 * bigint cannot be serialised into props), and the type says so.
 */

import type { MarketPhase } from '@/components/market/StatusBadge';
import type { Ticker } from '@/content/tickers';

export type Side = 'UP' | 'DOWN';

/** One Chainlink reading for the price tape. Strings, because the tape is a client island. */
export interface PriceReading {
  ticker: Ticker;
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
  ticker: Ticker;
  family: 'daily' | 'weekly';
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
  ticker: Ticker;
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

/** What `lib/live/venue.ts` (and later @hunch-rh/client) says about the venue right now. */
export interface VenueState {
  status: 'not-deployed' | 'deployed';
  markets: MarketCardData[];
  /** Latest settled market per family with at least one winning non-seed position. */
  settled: { weekly: EarlyVsLateProof | null; daily: EarlyVsLateProof | null };
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
  outcome: Side | 'FLAT';
  strike: RoundRef;
  final: RoundRef;
  resolveTxUrl: string;
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
  /** Why it voided: `stale` (voidStale), `flat`, `paused` or the 72 h timeout. */
  reason: 'stale' | 'flat' | 'paused' | 'timeout';
  voidTxUrl: string;
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
