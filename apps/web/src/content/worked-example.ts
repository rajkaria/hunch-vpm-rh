// S7: replace with contracts/fixtures/worked-example.json via @hunch-rh/client
/**
 * The worked example from docs/spec/02-mechanism.md: "Will NVDA finish the week UP?", seed 10/10,
 * five bets, NVDA closes up. It is the only static set of numbers the site is allowed to show,
 * and it is always labelled "Illustration".
 *
 * The numbers are not typed in. They are replayed here from the two rules with the contract's
 * own fixed-point arithmetic (an 18-decimal per-share accumulator, floor division, 6-decimal
 * USDG), and `test/worked-example.test.ts` pins every one of them to the spec's table. So the
 * payouts shown are exactly what the contract would pay, truncated to the cent for display and
 * never rounded up: Mei is paid 69.166666 USDG, shown as 69.16 (the spec's table rounds it to
 * 69.17).
 */

import type { Side } from '@/lib/live/types';

export const SCALE = 10n ** 18n;
const USDG = 1_000_000n;

export interface ExampleBet {
  name: string;
  /** When, in New York time, as the spec writes it. */
  when: string;
  /** Hours after Tuesday's opening bell (9:30 am ET), for drawing the week to scale. */
  hoursIn: number;
  side: Side;
  stake: bigint;
}

export const EXAMPLE = {
  question: 'Will NVDA finish the week UP?',
  ticker: 'NVDA' as const,
  kappa: 30,
  seedPerLeg: 10n * USDG,
  winner: 'UP' as Side,
  /** Tue 9:30 am to Fri 4:00 pm ET is 3 days and 6.5 hours. */
  weekHours: 78.5,
  bets: [
    { name: 'Mei', when: 'Tue 9:35 am', hoursIn: 5 / 60, side: 'UP', stake: 20n * USDG },
    { name: 'Dan', when: 'Tue 12:00 pm', hoursIn: 2.5, side: 'DOWN', stake: 30n * USDG },
    { name: 'Kim', when: 'Thu 11:00 am', hoursIn: 49.5, side: 'DOWN', stake: 40n * USDG },
    { name: 'Ben', when: 'Fri 3:55 pm', hoursIn: 78.5 - 5 / 60, side: 'UP', stake: 50n * USDG },
    { name: 'Lee', when: 'Fri 3:58 pm', hoursIn: 78.5 - 2 / 60, side: 'DOWN', stake: 10n * USDG },
  ] satisfies ExampleBet[],
} as const;

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
 * Rule 1 in the accumulator form: a stake `x` on one side raises the other side's per-share
 * accumulator by `x * SCALE / P_other` (floor). A winning position is paid
 * `s * (SCALE + A_win(T) - entryAcc) / SCALE` (floor). Rule 2 (the cap) never binds here: every
 * bet is far inside the room the other side can cover at 30x its principal.
 */
export function replayWorkedExample(): Replay {
  const seed = EXAMPLE.seedPerLeg;
  let principalUp = seed;
  let principalDown = seed;
  // Opening seed: the two legs are each other's first counterparties.
  let accUp = (seed * SCALE) / principalUp;
  let accDown = (seed * SCALE) / principalDown;

  const entries: { name: string; side: Side; stake: bigint; entryAcc: bigint }[] = [];
  const steps: ReplayStep[] = [{ bet: -1, accUp, accDown, entryAcc: 0n, accruedMei: 0n, accruedBen: 0n }];

  const accrued = (name: string): bigint => {
    const entry = entries.find((candidate) => candidate.name === name);
    if (entry === undefined) return 0n;
    return (entry.stake * (SCALE + accUp - entry.entryAcc)) / SCALE;
  };

  EXAMPLE.bets.forEach((bet, index) => {
    if (bet.side === 'UP') {
      entries.push({ name: bet.name, side: bet.side, stake: bet.stake, entryAcc: accUp });
      accDown += (bet.stake * SCALE) / principalDown;
      principalUp += bet.stake;
    } else {
      entries.push({ name: bet.name, side: bet.side, stake: bet.stake, entryAcc: accDown });
      accUp += (bet.stake * SCALE) / principalUp;
      principalDown += bet.stake;
    }
    steps.push({
      bet: index,
      accUp,
      accDown,
      entryAcc: entries[entries.length - 1]?.entryAcc ?? 0n,
      accruedMei: accrued('Mei'),
      accruedBen: accrued('Ben'),
    });
  });

  const pool = principalUp + principalDown;
  const winningPrincipal = principalUp;
  const pay = (stake: bigint, entryAcc: bigint): bigint => (stake * (SCALE + accUp - entryAcc)) / SCALE;
  const classic = (stake: bigint): bigint => (stake * pool) / winningPrincipal;

  const rows: ReplayRow[] = entries.map((entry) => ({
    ...entry,
    payout: entry.side === 'UP' ? pay(entry.stake, entry.entryAcc) : 0n,
    classic: entry.side === 'UP' ? classic(entry.stake) : 0n,
  }));
  const seedUp: ReplayRow = {
    name: 'Hunch opening seed (UP leg)',
    side: 'UP',
    stake: seed,
    entryAcc: 0n,
    payout: pay(seed, 0n),
    classic: classic(seed),
  };

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
