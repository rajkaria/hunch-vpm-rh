/**
 * The worked example from docs/spec/02-mechanism.md: "Will NVDA finish the week UP?", seed 10/10,
 * five bets, NVDA closes up. It is the only static set of numbers the site is allowed to show,
 * and it is always labelled "Illustration".
 *
 * Nothing here is typed in. The bets are `@hunch-rh/client`'s `WORKED_EXAMPLE`, and every number
 * is replayed with the client's exact mirror of the contract (`simCreate` → `simEnter` →
 * `simFinalize` → `simResolve` → `simSettle`), which the client's own tests hold to
 * `contracts/fixtures/worked-example.json`, the file the Foundry test pins to the unit. So the
 * payouts shown are exactly what the contract would pay, truncated to the cent for display and
 * never rounded up: Mei is paid 69.166666 USDG, shown as 69.16 (the spec's table rounds it to
 * 69.17). Only the display details (the time of day in words, and where each bet sits on the
 * week's timeline) are local.
 */

import {
  DOWN,
  SCALE as CLIENT_SCALE,
  UP,
  WORKED_EXAMPLE,
  accrued,
  sideOf,
  simCreate,
  simEnter,
  simFinalize,
  simResolve,
  simSettle,
} from '@hunch-rh/client';

import type { Side } from '@/lib/view/types';

export const SCALE = CLIENT_SCALE;

export interface ExampleBet {
  name: string;
  /** When, in New York time, as the spec writes it. */
  when: string;
  /** Hours after Tuesday's opening bell (9:30 am ET), for drawing the week to scale. */
  hoursIn: number;
  side: Side;
  stake: bigint;
}

/** Display only: the spec's times in words and their place on the Tuesday-to-Friday week. */
const DISPLAY: Record<string, { when: string; hoursIn: number }> = {
  Mei: { when: 'Tue 9:35 am', hoursIn: 5 / 60 },
  Dan: { when: 'Tue 12:00 pm', hoursIn: 2.5 },
  Kim: { when: 'Thu 11:00 am', hoursIn: 49.5 },
  Ben: { when: 'Fri 3:55 pm', hoursIn: 78.5 - 5 / 60 },
  Lee: { when: 'Fri 3:58 pm', hoursIn: 78.5 - 2 / 60 },
};

export const EXAMPLE = {
  question: WORKED_EXAMPLE.question,
  ticker: 'NVDA' as const,
  kappa: Number(WORKED_EXAMPLE.kappa),
  seedPerLeg: WORKED_EXAMPLE.seed[0],
  winner: WORKED_EXAMPLE.outcome as Side,
  /** Tue 9:30 am to Fri 4:00 pm ET is 3 days and 6.5 hours. */
  weekHours: 78.5,
  bets: WORKED_EXAMPLE.entries.map(
    (entry): ExampleBet => ({
      name: entry.label,
      when: DISPLAY[entry.label]?.when ?? entry.when,
      hoursIn: DISPLAY[entry.label]?.hoursIn ?? 0,
      side: sideOf(entry.outcome),
      stake: entry.amount,
    }),
  ),
};

export interface ReplayStep {
  /** Index into `EXAMPLE.bets`, or -1 for the opening seed. */
  bet: number;
  /** Accumulators after this step, 18-decimal fixed point. */
  accUp: bigint;
  accDown: bigint;
  /** The accumulator this position entered at (its own side's, before it landed). */
  entryAcc: bigint;
  /** Mei's and Ben's win payout if UP won right after this step (0 before they bet). */
  accruedMei: bigint;
  accruedBen: bigint;
}

export interface ReplayRow {
  name: string;
  side: Side;
  stake: bigint;
  entryAcc: bigint;
  /** What the contract pays this position when UP wins (0 for DOWN). */
  payout: bigint;
  /** What an ordinary pool would have paid it: stake x pool / winning principal (0 for DOWN). */
  classic: bigint;
}

export interface Replay {
  steps: ReplayStep[];
  rows: ReplayRow[];
  seedUp: ReplayRow;
  pool: bigint;
  winningPrincipal: bigint;
  /** pool / winning principal, in parts per million. */
  classicMultiplePpm: bigint;
}

/**
 * The market, one bet per block (each is its own batch), replayed by the client's contract
 * mirror. Rule 2 (the cap) never binds here: every bet is far inside the room the other side can
 * cover at 30x its principal.
 */
export function replayWorkedExample(): Replay {
  const sim = simCreate([...WORKED_EXAMPLE.seed], WORKED_EXAMPLE.kappa);
  const positionOf = new Map<string, number>();
  const accruedOf = (name: string): bigint => {
    const id = positionOf.get(name);
    if (id === undefined) return 0n;
    const position = sim.positions[id]!;
    return accrued(position, sim.books[position.outcome]!);
  };

  const steps: ReplayStep[] = [
    { bet: -1, accUp: sim.books[UP]!.acc, accDown: sim.books[DOWN]!.acc, entryAcc: 0n, accruedMei: 0n, accruedBen: 0n },
  ];
  WORKED_EXAMPLE.entries.forEach((entry, index) => {
    const position = simEnter(sim, { outcome: entry.outcome, amount: entry.amount, block: entry.block, label: entry.label });
    simFinalize(sim);
    positionOf.set(entry.label, position.id);
    steps.push({
      bet: index,
      accUp: sim.books[UP]!.acc,
      accDown: sim.books[DOWN]!.acc,
      entryAcc: sim.positions[position.id]!.entryAcc,
      accruedMei: accruedOf('Mei'),
      accruedBen: accruedOf('Ben'),
    });
  });

  const last = WORKED_EXAMPLE.entries.reduce((max, entry) => (entry.block > max ? entry.block : max), 0n);
  simResolve(sim, UP, last + 1n);
  const settled = simSettle(sim, WORKED_EXAMPLE.feeBps);

  const row = (id: number, name: string): ReplayRow => {
    const position = settled.positions[id]!;
    return {
      name,
      side: sideOf(position.outcome),
      stake: position.accepted,
      entryAcc: position.entryAcc,
      payout: position.settlement.gross,
      classic: position.classic,
    };
  };

  const rows = WORKED_EXAMPLE.entries.map((entry) => row(positionOf.get(entry.label)!, entry.label));
  const seedUp = row(0, 'Hunch opening seed (UP leg)');
  const pool = settled.pool;
  const winningPrincipal = sim.books[UP]!.principal;
  return {
    steps,
    rows,
    seedUp,
    pool,
    winningPrincipal,
    classicMultiplePpm: (pool * 1_000_000n) / winningPrincipal,
  };
}

export const WORKED = replayWorkedExample();

export function exampleBet(name: string): ExampleBet {
  const bet = EXAMPLE.bets.find((candidate) => candidate.name === name);
  if (bet === undefined) throw new Error(`no worked-example bet named ${name}`);
  return bet;
}

export function exampleRow(name: string): ReplayRow {
  const row = WORKED.rows.find((candidate) => candidate.name === name);
  if (row === undefined) throw new Error(`no worked-example row named ${name}`);
  return row;
}

/** payout / stake in ppm. */
export function multiplePpm(payout: bigint, stake: bigint): bigint {
  return stake === 0n ? 0n : (payout * 1_000_000n) / stake;
}

/** An 18-decimal accumulator as a 4-decimal string, truncated ("3.4583"), as the spec prints it. */
export function formatAcc(value: bigint): string {
  const whole = value / SCALE;
  const fraction = ((value % SCALE) * 10_000n) / SCALE;
  const digits = fraction.toString().padStart(4, '0').replace(/0+$/, '');
  return digits === '' ? `${whole}.0` : `${whole}.${digits}`;
}
