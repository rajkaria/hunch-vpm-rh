import type { Address } from 'viem';
import { DOWN, KAPPA_UNBOUNDED, MARKET_STATUS, SCALE, UP, ZERO_ADDRESS, type MarketStatusCode, type Outcome } from './constants.js';

/**
 * The settler's arithmetic, restated exactly in bigints. Every function mirrors a named
 * piece of `contracts/src/reference/VestedParimutuel.sol` (and HunchVPM's D1 fee and D6
 * views), and the tests hold it to the contract's own numbers
 * (`contracts/fixtures/worked-example.json`, `contracts/fixtures/mechanics-vectors.json`).
 */

// ------------------------------------------------------------------ state shapes

/** `VestedParimutuel.Book` */
export interface Book {
  principal: bigint;
  acc: bigint;
  capacity: bigint;
  vested: bigint;
  demand: bigint;
  live: bigint;
}

/** `VestedParimutuel.Position` */
export interface Position {
  marketId: bigint;
  owner: Address;
  outcome: number;
  finalized: boolean;
  refunded: boolean;
  claimed: boolean;
  vintage: bigint;
  offered: bigint;
  accepted: bigint;
  entryAcc: bigint;
}

/** The parts of `getMarket` settlement depends on. */
export interface MarketCore {
  status: MarketStatusCode | number;
  winner: number;
}

export const emptyBook = (): Book => ({ principal: 0n, acc: 0n, capacity: 0n, vested: 0n, demand: 0n, live: 0n });

// ------------------------------------------------------------------ primitives

/** `_times`: κ·x with the unbounded sentinel (∞·0 = 0, ∞·x = ∞). */
export function timesKappa(kappa: bigint, x: bigint): bigint {
  if (kappa === KAPPA_UNBOUNDED) return x === 0n ? 0n : KAPPA_UNBOUNDED;
  return kappa * x;
}

/** `_addCapacity` */
export function addCapacity(c: bigint, d: bigint): bigint {
  if (c === KAPPA_UNBOUNDED || d === KAPPA_UNBOUNDED) return KAPPA_UNBOUNDED;
  return c + d;
}

/** `_headroom`: H_w = C_w − V_w floored at 0 (KAPPA_UNBOUNDED when unbounded). */
export function headroom(book: Book): bigint {
  if (book.capacity === KAPPA_UNBOUNDED) return KAPPA_UNBOUNDED;
  return book.capacity > book.vested ? book.capacity - book.vested : 0n;
}

/**
 * HunchVPM `accrued(positionId)` (D6): the win payout of a finalized position if its
 * outcome won now, `s·(S + A_o(now) − entryAcc)/S`; 0 if not finalized. `book` is the
 * position's OWN outcome's book. Monotone non-decreasing while the market is open (P2).
 */
export function accrued(position: Pick<Position, 'finalized' | 'accepted' | 'entryAcc'>, book: Pick<Book, 'acc'>): bigint {
  if (!position.finalized || position.accepted === 0n) return 0n;
  return (position.accepted * (SCALE + book.acc - position.entryAcc)) / SCALE;
}

/** `previewPayout`: the gross payout on a resolved market (0 unless resolved, winning and finalized). */
export function previewPayout(
  position: Pick<Position, 'finalized' | 'accepted' | 'entryAcc' | 'outcome'>,
  market: MarketCore,
  winnerBook: Pick<Book, 'acc'>,
): bigint {
  if (market.status !== MARKET_STATUS.Resolved || position.outcome !== market.winner || !position.finalized) return 0n;
  return (position.accepted * (SCALE + winnerBook.acc - position.entryAcc)) / SCALE;
}

/** D1: `fee = floor((payout − accepted) · feeBps / 10_000)` on a winner's gain; 0 when there is no gain. */
export function feeOnGain(gross: bigint, accepted: bigint, feeBps: number | bigint): bigint {
  if (gross <= accepted) return 0n;
  return ((gross - accepted) * BigInt(feeBps)) / 10_000n;
}

export interface Settlement {
  /** Settlement payout before the fee (winner: principal + vested; void: accepted; loser: 0). */
  gross: bigint;
  fee: bigint;
  /** gross − fee: what `Claimed.payout` reports. */
  net: bigint;
  /** Refused remainder still owed (offered − accepted), if not yet withdrawn. */
  refund: bigint;
  /** net + refund: what `claim`/`claimFor` would transfer now. */
  total: bigint;
  /** True when a claim/claimFor would succeed now and move a non-zero amount. */
  deliverable: boolean;
}

/**
 * What `claim` would pay now (HunchVPM D1 semantics). On an open market only the refused
 * remainder can move (through `withdrawRefund`), so `gross = 0` and `deliverable` is
 * false; use `refund` for `withdrawRefundFor`.
 */
export function settlementOf(
  position: Pick<Position, 'finalized' | 'accepted' | 'entryAcc' | 'outcome' | 'offered' | 'refunded' | 'claimed'>,
  market: MarketCore,
  winnerBook: Pick<Book, 'acc'> | null,
  feeBps: number | bigint,
): Settlement {
  const refund = !position.refunded && (position.finalized || market.status !== MARKET_STATUS.Open)
    ? position.offered - position.accepted
    : 0n;
  if (position.claimed) return { gross: 0n, fee: 0n, net: 0n, refund: 0n, total: 0n, deliverable: false };
  if (market.status === MARKET_STATUS.Open) {
    return { gross: 0n, fee: 0n, net: 0n, refund, total: refund, deliverable: false };
  }
  let gross = 0n;
  let fee = 0n;
  if (market.status === MARKET_STATUS.Resolved) {
    if (position.outcome === market.winner && position.accepted > 0n && winnerBook !== null) {
      gross = (position.accepted * (SCALE + winnerBook.acc - position.entryAcc)) / SCALE;
      fee = feeOnGain(gross, position.accepted, feeBps);
    }
  } else {
    gross = position.accepted;
  }
  const net = gross - fee;
  const total = net + refund;
  return { gross, fee, net, refund, total, deliverable: total > 0n };
}

// ------------------------------------------------------------------ quoting

export type QuoteProblem = 'zero' | 'below-min' | 'above-max' | 'no-room';

export interface QuoteInput {
  amount: bigint;
  outcome: Outcome;
  /** `getBook(id, 0)`, `getBook(id, 1)` as they stand at the start of the vintage the entry joins. */
  books: readonly [Book, Book];
  /**
   * Offered stake already queued against the OPPOSING book in the vintage this entry will
   * join (`getBook(id, opposite).demand` when the open vintage is the current L1 block;
   * 0 when the entry starts a new vintage). See `quoteEntry` for the stale-vintage case.
   */
  openVintageDemand?: bigint;
  kappa: bigint;
  /** 0 = no bound. */
  minEntry: bigint;
  /** 0 = no bound. */
  maxEntry: bigint;
}

export interface Quote {
  offered: bigint;
  /** Accepted now: the §4.4 single-pass pro-rata ration against the opposing book's headroom. */
  accepted: bigint;
  /** offered − accepted: comes straight back (withdrawable once the vintage is final). */
  refused: bigint;
  /** If this side wins, the least the bettor is paid (their accepted stake; it only goes up). */
  floorIfWin: bigint;
  /** Largest stake the opposing book accepts in full right now (headroom − queued demand). */
  headroom: bigint;
  /** A reason the entry would revert or be fully refused; null when it would be accepted. */
  problem: QuoteProblem | null;
}

/**
 * Quote an entry exactly as `_finalizeVintage` will ration it, assuming nobody else joins
 * the same vintage after it (later same-vintage entries can only lower the ration).
 */
export function quote(input: QuoteInput): Quote {
  const { amount, outcome } = input;
  const opp = outcome === UP ? DOWN : UP;
  const oppBook = input.books[opp];
  const queued = input.openVintageDemand ?? 0n;
  const h = headroom(oppBook);
  const room = h === KAPPA_UNBOUNDED ? KAPPA_UNBOUNDED : h > queued ? h - queued : 0n;

  let problem: QuoteProblem | null = null;
  if (amount <= 0n) problem = 'zero';
  else if (input.minEntry !== 0n && amount < input.minEntry) problem = 'below-min';
  else if (input.maxEntry !== 0n && amount > input.maxEntry) problem = 'above-max';
  if (problem !== null) {
    return { offered: amount, accepted: 0n, refused: amount > 0n ? amount : 0n, floorIfWin: 0n, headroom: room, problem };
  }
  const accepted = rationed(amount, h, queued + amount);
  return {
    offered: amount,
    accepted,
    refused: amount - accepted,
    floorIfWin: accepted,
    headroom: room,
    problem: accepted === 0n ? 'no-room' : null,
  };
}

/** One entry's §4.4 (iii) cap on one book: `c·H/D` if `D > H`, else `c`. */
export function rationed(offered: bigint, head: bigint, demand: bigint): bigint {
  if (head !== KAPPA_UNBOUNDED && demand > head) return (offered * head) / demand;
  return offered;
}

export interface PendingEntry {
  outcome: number;
  offered: bigint;
}

export interface EntryQuoteInput {
  amount: bigint;
  outcome: Outcome;
  books: readonly [Book, Book];
  kappa: bigint;
  minEntry: bigint;
  maxEntry: bigint;
  /** The market's unfinalized entries (the last `pendingCount` of `marketPositions`). */
  pending: readonly PendingEntry[];
  /** Their vintage (= `positions(pendingId).vintage`), or null when none is open. */
  vintageBlock: bigint | null;
  /** The L1 block number the entry is expected to land in (Multicall3 `getBlockNumber()`). */
  l1Block: bigint;
}

/**
 * `quote`, plus the open-vintage case in full: if the open vintage belongs to an earlier
 * L1 block, the entry's own transaction finalizes it first, so it is rolled here before
 * quoting; if it is the current block, the entry joins it and is rationed together with it.
 */
export function quoteEntry(input: EntryQuoteInput): Quote {
  const opp = input.outcome === UP ? DOWN : UP;
  if (input.pending.length > 0 && input.vintageBlock !== null) {
    if (input.l1Block > input.vintageBlock) {
      const rolled = rollBooks(input.books, input.pending, input.kappa);
      return quote({ ...input, books: rolled, openVintageDemand: 0n });
    }
    const queued = input.pending.filter((p) => p.outcome !== opp).reduce((s, p) => s + p.offered, 0n);
    return quote({ ...input, openVintageDemand: queued });
  }
  return quote({ ...input, openVintageDemand: 0n });
}

/** The books after `_finalizeVintage` of `pending` (binary), without touching the inputs. */
export function rollBooks(books: readonly [Book, Book], pending: readonly PendingEntry[], kappa: bigint): [Book, Book] {
  // On-chain books already carry the open vintage's demand; it is rebuilt from `pending`.
  const sim = simFromBooks(books.map((b) => ({ ...b, demand: 0n })), kappa);
  for (const p of pending) simEnterRaw(sim, p.outcome, p.offered, ZERO_ADDRESS, 1n);
  simFinalize(sim);
  return [sim.books[0]!, sim.books[1]!];
}

// ------------------------------------------------------------------ classic counterfactual

/**
 * The ordinary pool on the same accepted stakes (`ClassicParimutuel`): every winner takes
 * `floor(pool · stake / winningPrincipal)`; losers 0. With no winning stake everyone is
 * refunded. `winner === null` (void) refunds everyone.
 */
export function classicPayouts(positions: readonly { outcome: number; accepted: bigint }[], winner: number | null): bigint[] {
  const pool = positions.reduce((s, p) => s + p.accepted, 0n);
  if (winner === null) return positions.map((p) => p.accepted);
  const winning = positions.filter((p) => p.outcome === winner).reduce((s, p) => s + p.accepted, 0n);
  if (winning === 0n) return positions.map((p) => p.accepted);
  return positions.map((p) => (p.outcome === winner ? (pool * p.accepted) / winning : 0n));
}

// ------------------------------------------------------------------ whole-market simulator

export interface SimPosition extends Position {
  id: number;
  label?: string;
}

export interface SimMarket {
  kappa: bigint;
  books: Book[];
  positions: SimPosition[];
  pending: number[];
  vintageOpen: boolean;
  vintageBlock: bigint;
  acceptedPool: bigint;
  paidOut: bigint;
  status: MarketStatusCode;
  winner: number;
}

export class SimRevert extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SimRevert';
  }
}

function simFromBooks(books: readonly Book[], kappa: bigint): SimMarket {
  return {
    kappa,
    books: books.map((b) => ({ ...b })),
    positions: [],
    pending: [],
    vintageOpen: false,
    vintageBlock: 0n,
    acceptedPool: 0n,
    paidOut: 0n,
    status: MARKET_STATUS.Open,
    winner: 0,
  };
}

/** `_seedClamp`: a_o ← min(offered_o, κ·min_{w≠o} a_w) to a fixed point; InvalidSeed on a zero leg. */
export function seedClamp(offered: readonly bigint[], kappa: bigint): bigint[] {
  const n = offered.length;
  const acc = [...offered];
  let converged = false;
  for (let pass = 0; pass < 64 && !converged; pass++) {
    converged = true;
    for (let o = 0; o < n; o++) {
      let cap = KAPPA_UNBOUNDED;
      for (let w = 0; w < n; w++) {
        if (w === o) continue;
        const c = timesKappa(kappa, acc[w]!);
        if (c < cap) cap = c;
      }
      const next = offered[o]! < cap ? offered[o]! : cap;
      if (next !== acc[o]) {
        acc[o] = next;
        converged = false;
      }
    }
  }
  if (!converged) throw new SimRevert('ClampDidNotConverge');
  if (acc.some((a) => a === 0n)) throw new SimRevert('InvalidSeed');
  return acc;
}

/** `create` + `_seedVintage`: open a market with the seed legs (vintage 0, entryAcc 0). */
export function simCreate(seed: readonly bigint[], kappa: bigint, owner: Address = ZERO_ADDRESS, labels?: readonly string[]): SimMarket {
  if (seed.length < 2) throw new SimRevert('InvalidOutcomes');
  if (kappa < 1n) throw new SimRevert('InvalidKappa');
  const acc = seedClamp(seed, kappa);
  const total = acc.reduce((s, a) => s + a, 0n);
  const sim = simFromBooks([], kappa);
  acc.forEach((a, w) => {
    sim.books.push({
      principal: a,
      capacity: timesKappa(kappa, a),
      vested: total - a,
      acc: ((total - a) * SCALE) / a,
      demand: 0n,
      live: 1n,
    });
    const pos: SimPosition = {
      id: sim.positions.length,
      marketId: 0n,
      owner,
      outcome: w,
      finalized: true,
      refunded: true,
      claimed: false,
      vintage: 0n,
      offered: seed[w]!,
      accepted: a,
      entryAcc: 0n,
    };
    const label = labels?.[w];
    if (label !== undefined) pos.label = label;
    sim.positions.push(pos);
  });
  sim.acceptedPool = total;
  return sim;
}

function simEnterRaw(sim: SimMarket, outcome: number, amount: bigint, owner: Address, block: bigint, label?: string): SimPosition {
  if (!sim.vintageOpen) {
    sim.vintageOpen = true;
    sim.vintageBlock = block;
  }
  const pos: SimPosition = {
    id: sim.positions.length,
    marketId: 0n,
    owner,
    outcome,
    finalized: false,
    refunded: false,
    claimed: false,
    vintage: block,
    offered: amount,
    accepted: 0n,
    entryAcc: 0n,
  };
  if (label !== undefined) pos.label = label;
  sim.positions.push(pos);
  sim.pending.push(pos.id);
  sim.books.forEach((b, w) => {
    if (w !== outcome) b.demand += amount;
  });
  return pos;
}

/** `enter` at L1 block `block` (rolls a vintage from an earlier block first). */
export function simEnter(
  sim: SimMarket,
  entry: { outcome: number; amount: bigint; block: bigint; owner?: Address; label?: string },
): SimPosition {
  if (sim.status !== MARKET_STATUS.Open) throw new SimRevert('NotOpen');
  if (entry.outcome < 0 || entry.outcome >= sim.books.length || entry.amount === 0n) throw new SimRevert('InvalidOutcomes');
  if (sim.vintageOpen && entry.block < sim.vintageBlock) throw new SimRevert('block went backwards');
  simRoll(sim, entry.block);
  return simEnterRaw(sim, entry.outcome, entry.amount, entry.owner ?? ZERO_ADDRESS, entry.block, entry.label);
}

/** `_rollVintage` at L1 block `block`. */
export function simRoll(sim: SimMarket, block: bigint): void {
  if (sim.vintageOpen && block > sim.vintageBlock) simFinalize(sim);
}

/** `_finalizeVintage` exactly: (iii) single-pass rationing, (i) vesting against vintage-start books, (ii) booking. */
export function simFinalize(sim: SimMarket): void {
  const n = sim.books.length;
  const head = sim.books.map(headroom);
  const inflow: bigint[] = new Array<bigint>(n).fill(0n);
  for (const id of sim.pending) {
    const p = sim.positions[id]!;
    const c = p.offered;
    let a = c;
    for (let w = 0; w < n; w++) {
      if (w === p.outcome) continue;
      const d = sim.books[w]!.demand;
      const hw = head[w]!;
      if (hw !== KAPPA_UNBOUNDED && d > hw) {
        const cap = (c * hw) / d;
        if (cap < a) a = cap;
      }
    }
    p.accepted = a;
    for (let w = 0; w < n; w++) if (w !== p.outcome) inflow[w] = inflow[w]! + a;
  }
  sim.books.forEach((b, w) => {
    const f = inflow[w]!;
    if (f > 0n) {
      b.acc += (f * SCALE) / b.principal;
      b.vested += f;
    }
    b.demand = 0n;
  });
  for (const id of sim.pending) {
    const p = sim.positions[id]!;
    const b = sim.books[p.outcome]!;
    p.entryAcc = b.acc;
    p.finalized = true;
    const a = p.accepted;
    if (a > 0n) {
      b.principal += a;
      b.capacity = addCapacity(b.capacity, timesKappa(sim.kappa, a));
      b.live += 1n;
      sim.acceptedPool += a;
    }
  }
  sim.pending = [];
  sim.vintageOpen = false;
}

/** `resolve(marketId, winner)` at L1 block `block`. */
export function simResolve(sim: SimMarket, winner: number, block: bigint): void {
  if (sim.status !== MARKET_STATUS.Open) throw new SimRevert('NotOpen');
  if (winner < 0 || winner >= sim.books.length) throw new SimRevert('InvalidOutcomes');
  simRoll(sim, block);
  sim.status = MARKET_STATUS.Resolved;
  sim.winner = winner;
}

/** `voidMarket(marketId)` at L1 block `block`. */
export function simVoid(sim: SimMarket, block: bigint): void {
  if (sim.status !== MARKET_STATUS.Open) throw new SimRevert('NotOpen');
  simRoll(sim, block);
  sim.status = MARKET_STATUS.Voided;
}

export interface SimSettledPosition extends SimPosition {
  settlement: Settlement;
  /** What the ordinary pool would have paid this position (gross, no fee). */
  classic: bigint;
}

export interface SimSettlement {
  positions: SimSettledPosition[];
  pool: bigint;
  /** Σ gross settlement payouts (residue arithmetic uses gross, as `m.paidOut`). */
  paidOutGross: bigint;
  fees: bigint;
  /** acceptedPool − Σ gross payouts, for a resolved market (0 on void). */
  residue: bigint;
}

/** Claim every position (`claim` semantics with the D1 fee), without mutating `sim`. */
export function simSettle(sim: SimMarket, feeBps: number | bigint = 0): SimSettlement {
  if (sim.status === MARKET_STATUS.Open) throw new SimRevert('NotSettled');
  const winnerBook = sim.status === MARKET_STATUS.Resolved ? sim.books[sim.winner]! : null;
  const classic = classicPayouts(sim.positions, sim.status === MARKET_STATUS.Resolved ? sim.winner : null);
  let paidOutGross = 0n;
  let fees = 0n;
  const positions = sim.positions.map((p, i) => {
    const s = settlementOf(p, sim, winnerBook, feeBps);
    if (sim.status === MARKET_STATUS.Resolved) paidOutGross += s.gross;
    fees += s.fee;
    return { ...p, settlement: s, classic: classic[i]! };
  });
  return {
    positions,
    pool: sim.acceptedPool,
    paidOutGross,
    fees,
    residue: sim.status === MARKET_STATUS.Resolved ? sim.acceptedPool - paidOutGross : 0n,
  };
}

export interface SimEntry {
  outcome: number;
  amount: bigint;
  block: bigint;
  owner?: Address;
  label?: string;
}

export interface SimulateInput {
  seed: readonly bigint[];
  kappa: bigint;
  entries: readonly SimEntry[];
  /** 'UP' | 'DOWN' (or an outcome index) to resolve, 'VOID' to void, null to leave open. */
  outcome: 'UP' | 'DOWN' | 'VOID' | number | null;
  /** L1 block of the resolve/void call (default: one past the last entry's block). */
  settleBlock?: bigint;
  feeBps?: number | bigint;
  seedOwner?: Address;
  seedLabels?: readonly string[];
}

export interface SimulateResult {
  market: SimMarket;
  settlement: SimSettlement | null;
}

/** Seed + entries by block → books/positions (+ settlement), exactly as the contract would. */
export function simulateMarket(input: SimulateInput): SimulateResult {
  const sim = simCreate(input.seed, input.kappa, input.seedOwner ?? ZERO_ADDRESS, input.seedLabels);
  for (const e of input.entries) simEnter(sim, e);
  if (input.outcome === null) return { market: sim, settlement: null };
  const last = input.entries.reduce((m, e) => (e.block > m ? e.block : m), 0n);
  const block = input.settleBlock ?? last + 1n;
  if (input.outcome === 'VOID') simVoid(sim, block);
  else simResolve(sim, input.outcome === 'UP' ? UP : input.outcome === 'DOWN' ? DOWN : input.outcome, block);
  return { market: sim, settlement: simSettle(sim, input.feeBps ?? 0) };
}

// ------------------------------------------------------------------ the worked example (docs/spec/02-mechanism.md)

/**
 * "Will NVDA finish the week UP?", κ = 30, seed 10/10, no fee, UP wins. Illustration only:
 * the landing page must label it "Illustration". Pinned against the contract by
 * `contracts/fixtures/worked-example.json`.
 */
export const WORKED_EXAMPLE = {
  question: 'Will NVDA finish the week UP?',
  kappa: 30n,
  seed: [10_000_000n, 10_000_000n] as const,
  feeBps: 0,
  outcome: 'UP' as const,
  entries: [
    { label: 'Mei', when: 'Tue 09:35', outcome: UP, amount: 20_000_000n, block: 1n },
    { label: 'Dan', when: 'Tue 12:00', outcome: DOWN, amount: 30_000_000n, block: 2n },
    { label: 'Kim', when: 'Thu 11:00', outcome: DOWN, amount: 40_000_000n, block: 3n },
    { label: 'Ben', when: 'Fri 15:55', outcome: UP, amount: 50_000_000n, block: 4n },
    { label: 'Lee', when: 'Fri 15:58', outcome: DOWN, amount: 10_000_000n, block: 5n },
  ],
} as const;

/** The worked example, simulated: seed legs are positions 0 (UP) and 1 (DOWN), then Mei, Dan, Kim, Ben, Lee. */
export function workedExample(): SimulateResult {
  return simulateMarket({
    seed: WORKED_EXAMPLE.seed,
    kappa: WORKED_EXAMPLE.kappa,
    entries: WORKED_EXAMPLE.entries.map((e) => ({ outcome: e.outcome, amount: e.amount, block: e.block, label: e.label })),
    outcome: WORKED_EXAMPLE.outcome,
    feeBps: WORKED_EXAMPLE.feeBps,
    seedLabels: ['Seed UP', 'Seed DOWN'],
  });
}
