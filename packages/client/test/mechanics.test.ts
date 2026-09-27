import { describe, expect, it } from 'vitest';
import {
  DOWN,
  KAPPA_UNBOUNDED,
  MARKET_STATUS,
  SCALE,
  UP,
  accrued,
  classicPayouts,
  feeOnGain,
  formatMultiple,
  formatUsdg,
  headroom,
  quote,
  quoteEntry,
  rollBooks,
  seedClamp,
  settlementOf,
  simCreate,
  simEnter,
  simFinalize,
  simResolve,
  simSettle,
  simVoid,
  simulateMarket,
  workedExample,
  SimRevert,
  type Book,
} from '../src/index.js';

const U = 1_000_000n;

describe('T8 · worked example (docs/spec/02-mechanism.md), exact contract arithmetic', () => {
  const { market, settlement } = workedExample();
  const s = settlement!;
  const byLabel = (label: string) => s.positions.find((p) => p.label === label)!;

  it('replays the accumulator column', () => {
    // A_UP = 1 + 1 + 40/30 + 10/80, A_DOWN = 1 + 2 + 50/80, in fixed point at S = 1e18.
    expect(market.books[UP]!.acc).toBe(3_458_333_333_333_333_333n);
    expect(market.books[DOWN]!.acc).toBe(3_625_000_000_000_000_000n);
    expect(byLabel('Mei').entryAcc).toBe(1n * SCALE);
    expect(byLabel('Dan').entryAcc).toBe(3n * SCALE);
    expect(byLabel('Kim').entryAcc).toBe(3n * SCALE);
    expect(byLabel('Ben').entryAcc).toBe(3_333_333_333_333_333_333n);
    expect(byLabel('Lee').entryAcc).toBe(3_625_000_000_000_000_000n);
  });

  it('pays the table (to the micro-USDG) and conserves the pool', () => {
    expect(s.pool).toBe(170n * U);
    expect(byLabel('Mei').settlement.gross).toBe(69_166_666n);
    expect(byLabel('Ben').settlement.gross).toBe(56_250_000n);
    expect(byLabel('Seed UP').settlement.gross).toBe(44_583_333n);
    for (const loser of ['Dan', 'Kim', 'Lee', 'Seed DOWN']) expect(byLabel(loser).settlement.gross).toBe(0n);
    expect(s.paidOutGross).toBe(169_999_999n);
    expect(s.residue).toBe(1n); // floor dust to the residue owner (P1/P8)
    expect(s.paidOutGross + s.residue).toBe(s.pool);
  });

  it('formats to the cent without ever rounding up', () => {
    expect(formatUsdg(byLabel('Mei').settlement.gross)).toBe('69.16'); // the doc's 69.17 is rounded half-up
    expect(formatUsdg(byLabel('Ben').settlement.gross)).toBe('56.25');
    expect(formatUsdg(byLabel('Seed UP').settlement.gross)).toBe('44.58');
    expect(formatMultiple(byLabel('Mei').settlement.gross, 20n * U)).toBe('3.458×');
    expect(formatMultiple(byLabel('Ben').settlement.gross, 50n * U)).toBe('1.125×');
  });

  it('computes the ordinary-pool counterfactual (170 / 80 = 2.125×)', () => {
    expect(byLabel('Mei').classic).toBe(42_500_000n);
    expect(byLabel('Ben').classic).toBe(106_250_000n);
    expect(byLabel('Seed UP').classic).toBe(21_250_000n);
    expect(byLabel('Dan').classic).toBe(0n);
  });

  it('accrued() equals the claim payout at resolution (D6)', () => {
    for (const p of s.positions.filter((x) => x.outcome === UP)) {
      expect(accrued(p, market.books[UP]!)).toBe(p.settlement.gross);
    }
  });
});

describe('seed clamp (§4.4 creation)', () => {
  it('accepts a symmetric seed in full and opens 290 of first-vintage room per side', () => {
    const sim = simCreate([10n * U, 10n * U], 30n);
    expect(sim.books.map((b) => b.principal)).toEqual([10n * U, 10n * U]);
    expect(headroom(sim.books[DOWN]!)).toBe(290n * U);
    expect(sim.books[UP]!.acc).toBe(SCALE);
  });

  it('clamps an asymmetric seed to κ·min', () => {
    expect(seedClamp([1000n, 10n], 30n)).toEqual([300n, 10n]);
  });

  it('reverts InvalidSeed on a zero leg', () => {
    expect(() => seedClamp([10n, 0n], 30n)).toThrow(SimRevert);
  });
});

describe('Rule 2 rationing and quotes', () => {
  const fresh = () => simCreate([10n * U, 10n * U], 30n).books as [Book, Book];

  it('accepts 290, returns 110 of a 400 entry right after creation (02 §Partial fills)', () => {
    const q = quote({ amount: 400n * U, outcome: UP, books: fresh(), kappa: 30n, minEntry: 0n, maxEntry: 0n });
    expect(q.accepted).toBe(290n * U);
    expect(q.refused).toBe(110n * U);
    expect(q.floorIfWin).toBe(290n * U);
    expect(q.headroom).toBe(290n * U);
    expect(q.problem).toBeNull();
  });

  it('matches the simulator on a partial fill', () => {
    const sim = simCreate([10n * U, 10n * U], 30n);
    const p = simEnter(sim, { outcome: UP, amount: 400n * U, block: 1n });
    simFinalize(sim);
    expect(p.accepted).toBe(290n * U);
  });

  it('enforces the per-entry caps on the offered amount', () => {
    const base = { outcome: UP, books: fresh(), kappa: 30n, minEntry: 1n * U, maxEntry: 100n * U } as const;
    expect(quote({ ...base, amount: 999_999n }).problem).toBe('below-min');
    expect(quote({ ...base, amount: 100n * U + 1n }).problem).toBe('above-max');
    expect(quote({ ...base, amount: 0n }).problem).toBe('zero');
    expect(quote({ ...base, amount: 100n * U }).accepted).toBe(100n * U);
  });

  it('rations pro-rata with demand already queued in the same vintage (single pass)', () => {
    const books = fresh();
    // 200 already queued on UP against DOWN's 290; a new 200 UP entry: D = 400 > 290 → 200·290/400 = 145.
    const q = quote({ amount: 200n * U, outcome: UP, books, openVintageDemand: 200n * U, kappa: 30n, minEntry: 0n, maxEntry: 0n });
    expect(q.accepted).toBe(145n * U);
    const sim = simCreate([10n * U, 10n * U], 30n);
    const a = simEnter(sim, { outcome: UP, amount: 200n * U, block: 1n });
    const b = simEnter(sim, { outcome: UP, amount: 200n * U, block: 1n });
    simFinalize(sim);
    expect(a.accepted).toBe(145n * U);
    expect(b.accepted).toBe(145n * U);
  });

  it('quoteEntry rolls a stale vintage before quoting, and joins a current one', () => {
    const sim = simCreate([10n * U, 10n * U], 30n);
    simEnter(sim, { outcome: UP, amount: 100n * U, block: 7n });
    const books = [{ ...sim.books[0]! }, { ...sim.books[1]! }] as [Book, Book];
    const pending = [{ outcome: UP, offered: 100n * U }];
    const base = { amount: 250n * U, outcome: UP, books, kappa: 30n, minEntry: 0n, maxEntry: 0n, pending, vintageBlock: 7n } as const;

    // Same L1 block: joins the vintage, D = 350 > 290 → 250·290/350.
    expect(quoteEntry({ ...base, l1Block: 7n }).accepted).toBe((250n * U * 290n * U) / (350n * U));
    // Later block: the 100 is finalized first (DOWN vested 110, capacity 300 → room 190).
    const later = quoteEntry({ ...base, l1Block: 8n });
    const rolled = rollBooks(books, pending, 30n);
    expect(headroom(rolled[DOWN])).toBe(190n * U);
    expect(later.accepted).toBe(190n * U);
    // …which is exactly what the contract would do.
    simEnter(sim, { outcome: UP, amount: 250n * U, block: 8n });
    simFinalize(sim);
    expect(sim.positions[sim.positions.length - 1]!.accepted).toBe(190n * U);
  });

  it('never rations against an unbounded book', () => {
    const b: Book = { principal: 1n, acc: 0n, capacity: KAPPA_UNBOUNDED, vested: 0n, demand: 0n, live: 1n };
    const q = quote({ amount: 10n ** 30n, outcome: UP, books: [b, b], kappa: KAPPA_UNBOUNDED, minEntry: 0n, maxEntry: 0n });
    expect(q.accepted).toBe(10n ** 30n);
  });
});

describe('late-entry neutrality (P4) and monotone accrual (P2)', () => {
  it('a buzzer entry is paid exactly its stake', () => {
    const r = simulateMarket({
      seed: [10n * U, 10n * U],
      kappa: 30n,
      entries: [
        { outcome: DOWN, amount: 30n * U, block: 1n, label: 'early' },
        { outcome: UP, amount: 20n * U, block: 2n, label: 'buzzer' },
      ],
      outcome: 'UP',
    });
    const buzzer = r.settlement!.positions.find((p) => p.label === 'buzzer')!;
    expect(buzzer.settlement.gross).toBe(20n * U);
  });

  it('accrued never decreases as later entries arrive', () => {
    const sim = simCreate([10n * U, 10n * U], 30n);
    const mine = simEnter(sim, { outcome: UP, amount: 20n * U, block: 1n });
    let last = 0n;
    const flow: [number, bigint][] = [[DOWN, 5n], [UP, 7n], [DOWN, 40n], [DOWN, 1n], [UP, 90n], [DOWN, 13n]];
    flow.forEach(([o, a], i) => {
      simEnter(sim, { outcome: o, amount: a * U, block: BigInt(i + 2) });
      simFinalize(sim);
      const now = accrued(mine, sim.books[UP]!);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    });
  });
});

describe('D1 fee and settlement', () => {
  it('takes floor(gain · bps / 1e4) from winners only', () => {
    expect(feeOnGain(69_166_666n, 20_000_000n, 200)).toBe(983_333n);
    expect(feeOnGain(20_000_000n, 20_000_000n, 200)).toBe(0n);
    expect(feeOnGain(0n, 20_000_000n, 200)).toBe(0n);
    const { settlement } = simulateMarket({
      seed: [10n * U, 10n * U],
      kappa: 30n,
      entries: [
        { outcome: UP, amount: 20n * U, block: 1n, label: 'win' },
        { outcome: DOWN, amount: 30n * U, block: 2n, label: 'lose' },
      ],
      outcome: 'UP',
      feeBps: 200,
    });
    const win = settlement!.positions.find((p) => p.label === 'win')!.settlement;
    expect(win.net).toBe(win.gross - win.fee);
    expect(win.fee).toBe(((win.gross - 20n * U) * 200n) / 10_000n);
    const lose = settlement!.positions.find((p) => p.label === 'lose')!.settlement;
    expect(lose).toMatchObject({ gross: 0n, fee: 0n, total: 0n, deliverable: false });
  });

  it('refunds accepted principal on void with no fee, plus any refused remainder', () => {
    const sim = simCreate([10n * U, 10n * U], 30n);
    simEnter(sim, { outcome: UP, amount: 400n * U, block: 1n });
    simVoid(sim, 2n);
    const s = simSettle(sim, 200);
    const big = s.positions[2]!.settlement;
    expect(big).toMatchObject({ gross: 290n * U, fee: 0n, refund: 110n * U, total: 400n * U, deliverable: true });
    expect(s.residue).toBe(0n);
  });

  it('an entry still pending when resolved in the same L1 block refunds in full (contract edge)', () => {
    const sim = simCreate([10n * U, 10n * U], 30n);
    simEnter(sim, { outcome: UP, amount: 5n * U, block: 9n });
    simResolve(sim, UP, 9n); // same block: _rollVintage does not finalize
    const p = sim.positions[2]!;
    const st = settlementOf(p, sim, sim.books[UP]!, 0);
    expect(p.finalized).toBe(false);
    expect(st).toMatchObject({ gross: 0n, refund: 5n * U, total: 5n * U });
  });

  it('settlementOf is zero once claimed and refund-only while open', () => {
    const open = settlementOf(
      { finalized: true, accepted: 5n, entryAcc: 0n, outcome: UP, offered: 9n, refunded: false, claimed: false },
      { status: MARKET_STATUS.Open, winner: 0 },
      null,
      200,
    );
    expect(open).toMatchObject({ gross: 0n, refund: 4n, total: 4n, deliverable: false });
    const claimed = settlementOf(
      { finalized: true, accepted: 5n, entryAcc: 0n, outcome: UP, offered: 9n, refunded: true, claimed: true },
      { status: MARKET_STATUS.Resolved, winner: 0 },
      { acc: SCALE },
      200,
    );
    expect(claimed.total).toBe(0n);
  });
});

describe('classic counterfactual', () => {
  it('refunds everyone when nobody backed the winner, or on void', () => {
    const ps = [{ outcome: DOWN, accepted: 5n }, { outcome: DOWN, accepted: 7n }];
    expect(classicPayouts(ps, UP)).toEqual([5n, 7n]);
    expect(classicPayouts(ps, null)).toEqual([5n, 7n]);
  });
});

describe('replay from on-chain positions', () => {
  it('replayMarket reproduces the books; accrualPath is monotone and ends at the payout', async () => {
    const { replayMarket, accrualPath } = await import('../src/index.js');
    const { market, settlement } = workedExample();
    const entries = market.positions.map((p) => ({ outcome: p.outcome, offered: p.offered, vintage: p.vintage }));
    const replay = replayMarket(entries, 30n);
    simFinalize(replay);
    expect(replay.books.map((b) => b.acc)).toEqual(market.books.map((b) => b.acc));
    const mei = accrualPath(entries, 30n, 2);
    expect(mei[0]).toEqual({ vintage: 1n, accrued: 20_000_000n });
    for (let i = 1; i < mei.length; i++) expect(mei[i]!.accrued).toBeGreaterThanOrEqual(mei[i - 1]!.accrued);
    expect(mei[mei.length - 1]!.accrued).toBe(settlement!.positions[2]!.settlement.gross);
    const seedUp = accrualPath(entries, 30n, 0);
    expect(seedUp[0]).toEqual({ vintage: 0n, accrued: 20_000_000n });
  });
});
