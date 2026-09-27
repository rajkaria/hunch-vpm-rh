/**
 * The public JSON shapes (documented on /docs/api). Amounts, prices and ids are decimal strings,
 * times are unix seconds, outcomes are the words "UP" and "DOWN". Fields may be added, never
 * renamed or removed.
 *
 * Pure functions from `@hunch-rh/client` view models: the API routes and the market page's
 * client islands both use them, so what the page shows and what the API serves never differ.
 */

import {
  MARKET_STATUS,
  PREVIEW_STATUS_NAME,
  type Book,
  type MarketDetail,
  type MarketPhase as ClientPhase,
  type MarketView,
  type OwnerPortfolio,
  type PositionView,
  type PreviewResult,
  type ResolutionRounds,
} from '@hunch-rh/client';

import type { MarketPhase } from '@/components/market/StatusBadge';
import type { ActivityData, ResolutionLog } from '@/lib/server/logs';

export type SideWord = 'UP' | 'DOWN';

export interface RoundJson {
  /** 8-decimal Chainlink answer. */
  answer: string;
  roundId: string;
  /** The round's `updatedAt`. */
  at: number;
}

export interface MarketJson {
  id: string;
  href: string;
  ticker: string;
  family: 'daily' | 'weekly' | 'drill';
  question: string;
  phase: MarketPhase;
  /** The status in words: Opens · Live · Frozen · Resolved UP · Resolved DOWN · Void. */
  status: ClientPhase;
  winner: SideWord | null;
  strikeTime: number;
  finalTime: number;
  strike: RoundJson | null;
  /** Why the opening price could not be proven yet, when it could not. */
  strikeProblem: string | null;
  /** The feed's latest round. */
  live: RoundJson | null;
  change: { direction: 'UP' | 'DOWN' | 'FLAT'; bps: number; text: string } | null;
  /** Accepted principal per side, seed included. */
  pool: { up: string; down: string };
  totals: { pool: string; up: string; down: string; pendingUp: string; pendingDown: string; paidOut: string };
  /** The largest stake accepted in full right now on each side. */
  headroom: { up: string; down: string };
  limits: { minEntry: string; maxEntry: string; feeBps: number };
  acceptingBets: boolean;
  maxStrikeAge: number;
  maxFinalAge: number;
  /** From this time anyone can refund the market through the settler if it is still unsettled. */
  voidableAt: number;
  seedPerLeg: string;
  opener: string;
  openedAt: number;
  specId: string;
  feed: string;
  stockToken: string;
  rules: { heading: string; segments: { text: string; bold: boolean }[]; text: string };
}

export interface SettlementJson {
  gross: string;
  fee: string;
  net: string;
  refund: string;
  total: string;
  deliverable: boolean;
}

export interface PositionJson {
  id: string;
  marketId: string;
  owner: string;
  side: SideWord;
  offered: string;
  /** null until the position's batch is matched on chain. */
  accepted: string | null;
  refused: string | null;
  /** Paid if its side won now; only goes up while the market is open. */
  accrued: string;
  /** After settlement: what the position is paid for the settlement (net of the fee), or was paid. */
  payout: string | null;
  /** After resolution: what an ordinary pool would have paid (gross). */
  classicPayout: string | null;
  seed: boolean;
  /** Owned by the market's opener (seed legs and the operator's own bets). */
  opener: boolean;
  finalized: boolean;
  refunded: boolean;
  claimed: boolean;
  /** Ethereum block of entry (0 for the opening seed). */
  vintage: string;
  settlement: SettlementJson;
  paidOut: string | null;
  enteredAt: number | null;
  entryTx: string | null;
  payoutTx: string | null;
}

export interface BookJson {
  principal: string;
  acc: string;
  capacity: string;
  vested: string;
  demand: string;
  live: string;
}

export interface FinderJson {
  ok: boolean;
  strikeRound: string | null;
  finalRound: string | null;
  strike: RoundJson | null;
  final: RoundJson | null;
  /** What `preview` is expected to say (the contract decides). */
  expected: 'UP' | 'DOWN' | 'FLAT' | 'STALE' | 'BADPROOF' | null;
  problem: string | null;
}

export interface PreviewJson {
  status: number;
  name: string;
  strikeAnswer: string;
  strikeAt: number;
  finalAnswer: string;
  finalAt: number;
}

export interface ResolutionJson {
  outcome: 'UP' | 'DOWN' | 'FLAT' | 'VOID';
  /** Why a void refunded everyone: flat price, stale price, paused token, or the 72 hour timeout. */
  reason: 'flat' | 'stale' | 'paused' | 'timeout' | null;
  strikeRound: string | null;
  finalRound: string | null;
  tx: string | null;
}

export interface MarketDetailJson {
  market: MarketJson;
  headroom: { up: string; down: string };
  positions: PositionJson[];
  resolution: ResolutionJson | null;
  head: { blockNumber: string; l1BlockNumber: string; timestamp: number };
  entriesPaused: boolean;
  /** The open batch's Ethereum block (null when none is open). */
  vintageBlock: string | null;
  kappa: string;
  books: [BookJson, BookJson];
  /** After the bell: the two rounds the finder proved, and what `preview` says about them. */
  finder: FinderJson | null;
  preview: PreviewJson | null;
  /** Whether entry times and transaction links (read from logs) are included. */
  activity: boolean;
  /** Unix seconds of the chain read, and whether it is an older value served during an outage. */
  readAt: number;
  stale: boolean;
}

// ------------------------------------------------------------------ mapping

export function phaseOf(status: ClientPhase): MarketPhase {
  switch (status) {
    case 'Opens':
      return 'opens';
    case 'Live':
      return 'live';
    case 'Frozen':
      return 'frozen';
    case 'Resolved UP':
    case 'Resolved DOWN':
      return 'resolved';
    case 'Void':
      return 'void';
  }
}

const side = (outcome: number): SideWord => (outcome === 0 ? 'UP' : 'DOWN');

function round(point: { price: bigint; roundId: bigint; updatedAt: number } | null): RoundJson | null {
  return point === null ? null : { answer: point.price.toString(), roundId: point.roundId.toString(), at: point.updatedAt };
}

export function marketJson(m: MarketView): MarketJson {
  return {
    id: m.id.toString(),
    href: `/m/${m.id.toString()}`,
    ticker: m.ticker,
    family: m.family,
    question: m.question,
    phase: phaseOf(m.status),
    status: m.status,
    winner: m.winner === null ? null : side(m.winner),
    strikeTime: m.strikeTime,
    finalTime: m.finalTime,
    strike: round(m.strike),
    strikeProblem: m.strikeProblem,
    live: round(m.live),
    change: m.change,
    pool: { up: m.totals.up.toString(), down: m.totals.down.toString() },
    totals: {
      pool: m.totals.pool.toString(),
      up: m.totals.up.toString(),
      down: m.totals.down.toString(),
      pendingUp: m.totals.pendingUp.toString(),
      pendingDown: m.totals.pendingDown.toString(),
      paidOut: m.totals.paidOut.toString(),
    },
    headroom: { up: m.headroom.up.toString(), down: m.headroom.down.toString() },
    limits: { minEntry: m.minEntry.toString(), maxEntry: m.maxEntry.toString(), feeBps: m.feeBps },
    acceptingBets: m.acceptingBets,
    maxStrikeAge: m.maxStrikeAge,
    maxFinalAge: m.maxFinalAge,
    voidableAt: m.voidableAt,
    seedPerLeg: m.seedPerLeg.toString(),
    opener: m.opener,
    openedAt: m.openedAt,
    specId: m.specId,
    feed: m.feed,
    stockToken: m.stockToken,
    rules: { heading: m.rules.heading, segments: m.rules.segments.map((s) => ({ text: s.text, bold: s.bold })), text: m.rules.text },
  };
}

function settlementJson(p: PositionView): SettlementJson {
  const s = p.settlement;
  return {
    gross: s.gross.toString(),
    fee: s.fee.toString(),
    net: s.net.toString(),
    refund: s.refund.toString(),
    total: s.total.toString(),
    deliverable: s.deliverable,
  };
}

/** What a settled position is (or was) paid for its settlement, net of the fee; null while open. */
export function payoutOf(p: PositionView, statusCode: number): bigint | null {
  if (statusCode === MARKET_STATUS.Open) return null;
  if (p.claimed) return p.paidOut;
  return p.settlement.net;
}

export function positionJson(p: PositionView, statusCode: number, activity: ActivityData | null): PositionJson {
  const id = p.id.toString();
  const entry = activity?.entries[id] ?? null;
  const claims = activity?.claims[id] ?? [];
  const payoutClaim = [...claims].reverse().find((c) => c.payout > 0n) ?? claims[claims.length - 1] ?? null;
  const payout = payoutOf(p, statusCode);
  return {
    id,
    marketId: p.marketId.toString(),
    owner: p.owner,
    side: p.side,
    offered: p.offered.toString(),
    accepted: p.accepted === null ? null : p.accepted.toString(),
    refused: p.refused === null ? null : p.refused.toString(),
    accrued: p.accrued.toString(),
    payout: payout === null ? null : payout.toString(),
    classicPayout: p.classicPayout === null ? null : p.classicPayout.toString(),
    seed: p.isSeed,
    opener: p.isOpener,
    finalized: p.finalized,
    refunded: p.refunded,
    claimed: p.claimed,
    vintage: p.vintage.toString(),
    settlement: settlementJson(p),
    paidOut: p.paidOut === null ? null : p.paidOut.toString(),
    enteredAt: entry?.timestamp ?? null,
    entryTx: entry?.txHash ?? null,
    payoutTx: payoutClaim?.txHash ?? null,
  };
}

function bookJson(b: Book): BookJson {
  return {
    principal: b.principal.toString(),
    acc: b.acc.toString(),
    capacity: b.capacity.toString(),
    vested: b.vested.toString(),
    demand: b.demand.toString(),
    live: b.live.toString(),
  };
}

export function finderJson(rounds: ResolutionRounds): FinderJson {
  if (rounds.ok) {
    return {
      ok: true,
      strikeRound: rounds.strikeRound.toString(),
      finalRound: rounds.finalRound.toString(),
      strike: { answer: rounds.strike.round.answer.toString(), roundId: rounds.strike.round.roundId.toString(), at: Number(rounds.strike.round.updatedAt) },
      final: { answer: rounds.final.round.answer.toString(), roundId: rounds.final.round.roundId.toString(), at: Number(rounds.final.round.updatedAt) },
      expected: rounds.expected,
      problem: null,
    };
  }
  return { ok: false, strikeRound: null, finalRound: null, strike: null, final: null, expected: null, problem: `${rounds.which}: ${rounds.problem}` };
}

export function previewJson(p: PreviewResult): PreviewJson {
  return {
    status: p.status,
    name: PREVIEW_STATUS_NAME[p.status] ?? 'UNKNOWN',
    strikeAnswer: p.strikeAnswer.toString(),
    strikeAt: p.strikeAt,
    finalAnswer: p.finalAnswer.toString(),
    finalAt: p.finalAt,
  };
}

/** The settlement of a settled market, from the resolver's log when available, else from the views. */
export function resolutionJson(m: MarketDetail, log: ResolutionLog | null, activity: ActivityData | null): ResolutionJson | null {
  if (m.statusCode === MARKET_STATUS.Open) return null;
  const rounds = m.resolution?.rounds.ok === true ? m.resolution.rounds : null;
  const tx = log?.txHash ?? activity?.resolved?.txHash ?? activity?.voided?.txHash ?? null;
  const strikeRound = (log?.strikeRound ?? rounds?.strikeRound ?? null)?.toString() ?? null;
  const finalRound = (log?.finalRound ?? rounds?.finalRound ?? null)?.toString() ?? null;
  if (m.statusCode === MARKET_STATUS.Resolved) {
    return { outcome: m.winner === 0 ? 'UP' : 'DOWN', reason: null, strikeRound, finalRound, tx };
  }
  let reason: ResolutionJson['reason'] = null;
  if (!m.settledByResolver) reason = 'timeout';
  else if (log?.kind === 'voided-stale') reason = 'stale';
  else if (log?.kind === 'voided-paused') reason = 'paused';
  else if (log?.kind === 'resolved' && log.outcome === 'FLAT') reason = 'flat';
  else if (rounds?.expected === 'FLAT') reason = 'flat';
  else if (rounds?.expected === 'STALE') reason = 'stale';
  return { outcome: reason === 'flat' ? 'FLAT' : 'VOID', reason, strikeRound: reason === 'paused' || reason === 'timeout' ? null : strikeRound, finalRound: reason === 'paused' || reason === 'timeout' ? null : finalRound, tx };
}

export function marketDetailJson(
  m: MarketDetail,
  extras: { activity: ActivityData | null; log: ResolutionLog | null; readAt: number; stale: boolean },
): MarketDetailJson {
  return {
    market: marketJson(m),
    headroom: { up: m.headroom.up.toString(), down: m.headroom.down.toString() },
    positions: m.positions.map((p) => positionJson(p, m.statusCode, extras.activity)),
    resolution: resolutionJson(m, extras.log, extras.activity),
    head: { blockNumber: m.head.blockNumber.toString(), l1BlockNumber: m.head.l1BlockNumber.toString(), timestamp: m.head.timestamp },
    entriesPaused: m.entriesPaused,
    vintageBlock: m.vintageBlock === null ? null : m.vintageBlock.toString(),
    kappa: m.kappa.toString(),
    books: [bookJson(m.books[0]), bookJson(m.books[1])],
    finder: m.resolution === null ? null : finderJson(m.resolution.rounds),
    preview: m.resolution?.preview == null ? null : previewJson(m.resolution.preview),
    activity: extras.activity !== null,
    readAt: extras.readAt,
    stale: extras.stale,
  };
}

// ------------------------------------------------------------------ portfolio

export interface PortfolioPositionJson extends PositionJson {
  question: string;
  ticker: string;
  href: string;
  phase: MarketPhase;
  status: ClientPhase;
  winner: SideWord | null;
  finalTime: number;
  /** Whether the market is still open (unsettled). */
  open: boolean;
}

export interface PortfolioJson {
  owner: string;
  deployed: boolean;
  positions: PortfolioPositionJson[];
  totals: {
    staked: string;
    /** Σ what each open position is paid if its side wins now. */
    accrued: string;
    /** Σ settlement payouts already sent (net of the fee). */
    paid: string;
    accepted: string;
    /** Σ what claims and refunds would deliver right now. */
    deliverable: string;
    /** Positions in markets that are still open. */
    open: number;
  };
  readAt: number;
  stale: boolean;
}

export function portfolioJson(
  portfolio: OwnerPortfolio,
  extras: { activity: Map<string, ActivityData | null>; readAt: number; stale: boolean },
): PortfolioJson {
  let accruedOpen = 0n;
  const positions = portfolio.positions.map(({ market, position }): PortfolioPositionJson => {
    const open = market.statusCode === MARKET_STATUS.Open;
    if (open) accruedOpen += position.accrued;
    return {
      ...positionJson(position, market.statusCode, extras.activity.get(market.id.toString()) ?? null),
      question: market.question,
      ticker: market.ticker,
      href: `/m/${market.id.toString()}`,
      phase: phaseOf(market.status),
      status: market.status,
      winner: market.winner === null ? null : side(market.winner),
      finalTime: market.finalTime,
      open,
    };
  });
  return {
    owner: portfolio.owner,
    deployed: portfolio.deployed,
    positions,
    totals: {
      staked: portfolio.totals.staked.toString(),
      accrued: accruedOpen.toString(),
      paid: portfolio.totals.paidOut.toString(),
      accepted: portfolio.totals.accepted.toString(),
      deliverable: portfolio.totals.deliverable.toString(),
      open: portfolio.totals.open,
    },
    readAt: extras.readAt,
    stale: extras.stale,
  };
}
