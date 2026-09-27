/**
 * The market page's client-side model: `/api/markets/[id]` JSON revived into bigints, and the
 * quote and position arithmetic the bet panel runs on every keystroke. All of the arithmetic is
 * `@hunch-rh/client`'s exact mirror of the contract; nothing here is approximated.
 */

import {
  DOWN,
  UP,
  accrualPath,
  quoteForMarket,
  replayMarket,
  simFinalize,
  type Book,
  type MarketDetail,
  type Outcome,
  type Quote,
} from '@hunch-rh/client';

import type { BookJson, MarketDetailJson, PositionJson } from '@/lib/api/shapes';

export interface LivePosition {
  id: bigint;
  owner: string;
  outcome: Outcome;
  side: 'UP' | 'DOWN';
  offered: bigint;
  accepted: bigint | null;
  refused: bigint | null;
  accrued: bigint;
  payout: bigint | null;
  classicPayout: bigint | null;
  seed: boolean;
  opener: boolean;
  finalized: boolean;
  refunded: boolean;
  claimed: boolean;
  vintage: bigint;
  settlement: { gross: bigint; fee: bigint; net: bigint; refund: bigint; total: bigint; deliverable: boolean };
  enteredAt: number | null;
  entryTx: string | null;
  payoutTx: string | null;
}

export interface LiveMarket {
  json: MarketDetailJson;
  id: bigint;
  books: [Book, Book];
  kappa: bigint;
  minEntry: bigint;
  maxEntry: bigint;
  feeBps: number;
  vintageBlock: bigint | null;
  l1Block: bigint;
  headroom: { up: bigint; down: bigint };
  pool: { up: bigint; down: bigint; total: bigint };
  positions: LivePosition[];
}

const big = (value: string | null): bigint | null => (value === null ? null : BigInt(value));

function book(b: BookJson): Book {
  return {
    principal: BigInt(b.principal),
    acc: BigInt(b.acc),
    capacity: BigInt(b.capacity),
    vested: BigInt(b.vested),
    demand: BigInt(b.demand),
    live: BigInt(b.live),
  };
}

export function revivePosition(p: PositionJson): LivePosition {
  return {
    id: BigInt(p.id),
    owner: p.owner,
    outcome: p.side === 'UP' ? UP : DOWN,
    side: p.side,
    offered: BigInt(p.offered),
    accepted: big(p.accepted),
    refused: big(p.refused),
    accrued: BigInt(p.accrued),
    payout: big(p.payout),
    classicPayout: big(p.classicPayout),
    seed: p.seed,
    opener: p.opener,
    finalized: p.finalized,
    refunded: p.refunded,
    claimed: p.claimed,
    vintage: BigInt(p.vintage),
    settlement: {
      gross: BigInt(p.settlement.gross),
      fee: BigInt(p.settlement.fee),
      net: BigInt(p.settlement.net),
      refund: BigInt(p.settlement.refund),
      total: BigInt(p.settlement.total),
      deliverable: p.settlement.deliverable,
    },
    enteredAt: p.enteredAt,
    entryTx: p.entryTx,
    payoutTx: p.payoutTx,
  };
}

export function reviveMarket(json: MarketDetailJson): LiveMarket {
  return {
    json,
    id: BigInt(json.market.id),
    books: [book(json.books[0]), book(json.books[1])],
    kappa: BigInt(json.kappa),
    minEntry: BigInt(json.market.limits.minEntry),
    maxEntry: BigInt(json.market.limits.maxEntry),
    feeBps: json.market.limits.feeBps,
    vintageBlock: big(json.vintageBlock),
    l1Block: BigInt(json.head.l1BlockNumber),
    headroom: { up: BigInt(json.headroom.up), down: BigInt(json.headroom.down) },
    pool: { up: BigInt(json.market.pool.up), down: BigInt(json.market.pool.down), total: BigInt(json.market.totals.pool) },
    positions: json.positions.map(revivePosition),
  };
}

/**
 * The quote for `amount` on `outcome`, exactly as the contract will ration it: `quoteForMarket`
 * over the revived books, the open batch and the current Ethereum block.
 */
export function quoteFor(market: LiveMarket, amount: bigint, outcome: Outcome): Quote {
  // quoteForMarket reads only these fields of a MarketDetail.
  const detail = {
    positions: market.positions.map((p) => ({ finalized: p.finalized, outcome: p.outcome, offered: p.offered })),
    books: market.books,
    kappa: market.kappa,
    minEntry: market.minEntry,
    maxEntry: market.maxEntry,
    vintageBlock: market.vintageBlock,
    head: { l1BlockNumber: market.l1Block },
  } as unknown as MarketDetail;
  return quoteForMarket(detail, amount, outcome);
}

export interface MatchState {
  /** `matched`: on chain. `closed`: its batch is closed, so its accepted amount is fixed (shown), and it is written on chain with the next bet. `open`: still collecting bets this Ethereum block. */
  kind: 'matched' | 'closed' | 'open';
  accepted: bigint | null;
  refused: bigint | null;
}

/**
 * Where a position is in matching. A batch closes when Ethereum's block number ticks (about 12
 * seconds); from then its accepted amount is fixed and is computed here exactly (the contract
 * writes the same numbers with the next bet or the keeper's next pass).
 */
export function matchStateOf(market: LiveMarket, position: LivePosition): MatchState {
  if (position.finalized) return { kind: 'matched', accepted: position.accepted, refused: position.refused };
  if (market.vintageBlock === null || market.l1Block <= position.vintage) return { kind: 'open', accepted: null, refused: null };
  const sim = replayMarket(
    market.positions.map((p) => ({ outcome: p.outcome, offered: p.offered, vintage: p.vintage })),
    market.kappa,
  );
  simFinalize(sim);
  const index = market.positions.findIndex((p) => p.id === position.id);
  const simulated = sim.positions[index];
  if (simulated === undefined) return { kind: 'closed', accepted: null, refused: null };
  return { kind: 'closed', accepted: simulated.accepted, refused: simulated.offered - simulated.accepted };
}

export interface AccrualPoint {
  index: number;
  accrued: bigint;
}

/** The position's win payout after its own batch and after every later one: never goes down. */
export function accrualSeries(market: LiveMarket, position: LivePosition): AccrualPoint[] {
  const index = market.positions.findIndex((p) => p.id === position.id);
  if (index < 0 || !position.finalized) return [];
  const finalized = market.positions.filter((p) => p.finalized || p.seed);
  const at = finalized.findIndex((p) => p.id === position.id);
  if (at < 0) return [];
  try {
    return accrualPath(
      finalized.map((p) => ({ outcome: p.outcome, offered: p.offered, vintage: p.vintage })),
      market.kappa,
      at,
    ).map((point, i) => ({ index: i, accrued: point.accrued }));
  } catch {
    return [];
  }
}
