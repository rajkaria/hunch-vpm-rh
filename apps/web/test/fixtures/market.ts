/**
 * Real-shaped markets for tests: a `MarketDetail` exactly as `readMarket` returns it, built from
 * the client's block-by-block mirror of the contract (`simulateMarket`) instead of a chain, so
 * every number in it is one the contract would hold.
 */

import {
  DOWN,
  KAPPA_UNBOUNDED,
  MARKET_STATUS,
  UP,
  accrued,
  classicPayouts,
  family,
  headroom,
  ppm,
  questionFor,
  rulesBox,
  settlementOf,
  sideOf,
  simFinalize,
  simulateMarket,
  type Book,
  type SimMarket,
  type MarketDetail,
  type PositionView,
  type SimEntry,
} from '@hunch-rh/client';
import type { Address, Hex } from 'viem';

export const SEED_OWNER: Address = '0x00000000000000000000000000000000000000aa';
export const ALICE: Address = '0x1111111111111111111111111111111111111111';
export const BOB: Address = '0x2222222222222222222222222222222222222222';
export const CAROL: Address = '0x3333333333333333333333333333333333333333';
export const FEED: Address = '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15';
export const STOCK: Address = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
export const SPEC: Hex = `0x${'ab'.repeat(32)}`;

/** Tue Sep 29 2026: 9:30 am ET and 4:00 pm ET. */
export const STRIKE_TIME = 1_790_688_600;
export const FINAL_TIME = 1_790_712_000;

const USDG = 1_000_000n;

export interface FixtureOptions {
  id?: bigint;
  seed?: bigint;
  kappa?: bigint;
  entries?: SimEntry[];
  outcome?: 'UP' | 'DOWN' | 'VOID' | null;
  feeBps?: number;
  nowSec?: number;
  /** The Ethereum block the chain is at (defaults to one past the last entry, so every batch is final). */
  l1Block?: bigint;
  /** Leave the last batch pending (as if nobody has entered since). */
  leaveLastPending?: boolean;
  entriesPaused?: boolean;
  strikeTime?: number;
  finalTime?: number;
  claimed?: bigint[];
}

export const DEFAULT_ENTRIES: SimEntry[] = [
  { outcome: UP, amount: 20n * USDG, block: 101n, owner: ALICE },
  { outcome: DOWN, amount: 30n * USDG, block: 102n, owner: BOB },
  { outcome: DOWN, amount: 40n * USDG, block: 103n, owner: CAROL },
  { outcome: UP, amount: 50n * USDG, block: 104n, owner: BOB },
];

export function marketFixture(options: FixtureOptions = {}): MarketDetail {
  const id = options.id ?? 12n;
  const seed = options.seed ?? 10n * USDG;
  const kappa = options.kappa ?? 30n;
  const feeBps = options.feeBps ?? 200;
  const entries = options.entries ?? DEFAULT_ENTRIES;
  const outcome = options.outcome ?? null;
  const strikeTime = options.strikeTime ?? STRIKE_TIME;
  const finalTime = options.finalTime ?? FINAL_TIME;
  const nowSec = options.nowSec ?? (outcome === null ? STRIKE_TIME + 3_600 : FINAL_TIME + 3_600);
  const lastBlock = entries.reduce((max, e) => (e.block > max ? e.block : max), 0n);

  const leavePending = options.leaveLastPending === true && outcome === null;
  const { market: sim } = simulateMarket({
    seed: [seed, seed],
    kappa,
    entries,
    outcome: outcome === null ? null : outcome,
    feeBps,
    seedOwner: SEED_OWNER,
  });
  // simulateMarket leaves the last batch open while the market is open; every batch is final
  // (as the next entry would make it) unless the test asks for the last one to stay open.
  const final = !leavePending && outcome === null ? finalizeCopy(sim) : sim;
  const l1Block = options.l1Block ?? (leavePending ? lastBlock : lastBlock + 1n);

  const statusCode = final.status;
  const winner = statusCode === MARKET_STATUS.Resolved ? final.winner : null;
  const books = [final.books[0]!, final.books[1]!] as [Book, Book];
  const winnerBook = winner === null ? null : books[winner]!;
  const classic = statusCode === MARKET_STATUS.Open ? null : classicPayouts(final.positions, winner);
  const claimed = new Set((options.claimed ?? []).map((x) => x.toString()));

  const positions: PositionView[] = final.positions.map((p, i) => {
    const isClaimed = claimed.has(BigInt(i).toString());
    const settlement = settlementOf({ ...p, claimed: false }, { status: statusCode, winner: final.winner }, winnerBook, feeBps);
    return {
      id: BigInt(i),
      marketId: id,
      owner: p.owner,
      outcome: p.outcome as 0 | 1,
      side: sideOf(p.outcome),
      offered: p.offered,
      accepted: p.finalized ? p.accepted : null,
      refused: p.finalized ? p.offered - p.accepted : null,
      finalized: p.finalized,
      refunded: p.refunded,
      claimed: isClaimed,
      vintage: p.vintage,
      entryAcc: p.entryAcc,
      isSeed: p.vintage === 0n,
      isOpener: p.owner.toLowerCase() === SEED_OWNER.toLowerCase(),
      accrued: accrued(p, books[p.outcome]!),
      settlement: isClaimed ? { gross: 0n, fee: 0n, net: 0n, refund: 0n, total: 0n, deliverable: false } : settlement,
      paidOut: isClaimed ? settlement.net : null,
      classicPayout: classic?.[i] ?? null,
    };
  });

  const room = (b: Book): bigint => {
    const h = headroom(b);
    if (h === KAPPA_UNBOUNDED) return h;
    return h > b.demand ? h - b.demand : 0n;
  };
  const pool = final.acceptedPool;
  const status = statusCode === MARKET_STATUS.Resolved ? (winner === UP ? 'Resolved UP' : 'Resolved DOWN') : statusCode === MARKET_STATUS.Voided ? 'Void' : nowSec >= finalTime ? 'Frozen' : nowSec < strikeTime ? 'Opens' : 'Live';
  const listing = {
    index: 0,
    marketId: id,
    specId: SPEC,
    feed: FEED,
    strikeTime,
    finalTime,
    maxStrikeAge: 93_600,
    maxFinalAge: 93_600,
    seedPerLeg: seed,
    minEntry: 1n * USDG,
    maxEntry: 100n * USDG,
    opener: SEED_OWNER,
    openedAt: strikeTime - 1_800,
  };
  const q = { ticker: 'NVDA', strikeTime, finalTime, maxFinalAge: 93_600 };
  const pending = positions.filter((p) => !p.finalized);
  const strike = nowSec >= strikeTime ? { price: 22_410_000_000n, roundId: 18_446_744_073_709_552_790n, updatedAt: strikeTime - 588 } : null;
  const live = { price: 22_566_018_707n, roundId: 18_446_744_073_709_552_799n, updatedAt: nowSec - 120 };

  return {
    id,
    listing,
    specId: SPEC,
    ticker: 'NVDA',
    feed: FEED,
    stockToken: STOCK,
    family: family(q),
    question: questionFor(q),
    rules: rulesBox({ ...q, maxStrikeAge: 93_600, feeBps }),
    status,
    statusCode,
    winner: winner as 0 | 1 | null,
    settledByResolver: statusCode !== MARKET_STATUS.Open,
    acceptingBets: statusCode === MARKET_STATUS.Open && nowSec < finalTime && options.entriesPaused !== true,
    strikeTime,
    finalTime,
    maxStrikeAge: 93_600,
    maxFinalAge: 93_600,
    voidableAt: finalTime + 259_200,
    strike,
    strikeProblem: null,
    live,
    change: strike === null ? null : { direction: 'UP', bps: 69, text: '+0.69%' },
    kappa,
    books,
    totals: {
      pool,
      up: books[0].principal,
      down: books[1].principal,
      pendingUp: books[1].demand,
      pendingDown: books[0].demand,
      paidOut: 0n,
      upPpm: ppm(books[0].principal, pool),
      downPpm: ppm(books[1].principal, pool),
    },
    headroom: { up: room(books[1]), down: room(books[0]) },
    pendingCount: BigInt(pending.length),
    feeBps,
    minEntry: 1n * USDG,
    maxEntry: 100n * USDG,
    seedPerLeg: seed,
    opener: SEED_OWNER,
    openedAt: strikeTime - 1_800,
    positions,
    head: { blockNumber: 5_000_000n, l1BlockNumber: l1Block, timestamp: nowSec },
    entriesPaused: options.entriesPaused === true,
    vintageBlock: pending.length > 0 ? pending[0]!.vintage : null,
    resolution: null,
  };
}

/** A copy of an open simulated market with its last batch finalized (as the next entry would). */
function finalizeCopy(sim: SimMarket): SimMarket {
  const copy = structuredClone(sim);
  if (copy.vintageOpen) simFinalize(copy);
  return copy;
}
