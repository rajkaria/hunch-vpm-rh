import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DOWN,
  UP,
  accrued,
  classicPayouts,
  formatMultiple,
  formatUsdg,
  simCreate,
  simEnter,
  simFinalize,
  simResolve,
  simSettle,
  simVoid,
  workedExample,
} from '../src/index.js';

/**
 * T8 against the CONTRACT: fixtures exported by Foundry from HunchVPM itself
 * (contracts/test/WorkedExample.t.sol, contracts/test/MechanicsVectors.t.sol). If a file
 * is missing this suite fails loudly: the TS mirror is only trusted while it matches.
 */
const read = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../contracts/fixtures/${name}`, import.meta.url)), 'utf8')) as any;

interface VectorPosition {
  id: string;
  isSeed: boolean;
  outcome: string;
  offered: string;
  accepted: string;
  entryAcc: string;
  accruedBeforeSettle: string;
  payoutGross: string;
  fee: string;
  refund: string;
  netToOwner: string;
}

interface Scenario {
  name: string;
  kappa: string;
  feeBps: string;
  seed: string[];
  entries: { block: string; outcome: string; amount: string }[];
  result: 'UP' | 'DOWN' | 'VOID';
  acceptedPool: string;
  residue: string;
  feesTotal: string;
  books: { principal: string; acc: string; capacity: string; vested: string }[];
  positions: VectorPosition[];
}

describe('T8 · contracts/fixtures/mechanics-vectors.json (exported from HunchVPM)', () => {
  const vectors = read('mechanics-vectors.json') as { suite: string; scenarios: Scenario[] };

  it('has scenarios', () => {
    expect(vectors.scenarios.length).toBeGreaterThanOrEqual(20);
  });

  it.each(vectors.scenarios.map((s) => [s.name, s] as const))('%s', (_name, s) => {
    const sim = simCreate(s.seed.map(BigInt), BigInt(s.kappa));
    for (const e of s.entries) simEnter(sim, { outcome: Number(e.outcome), amount: BigInt(e.amount), block: BigInt(e.block) });
    if (sim.vintageOpen) simFinalize(sim);

    // After the last vintage is finalized, before settlement.
    s.books.forEach((b, w) => {
      expect(sim.books[w]!.principal, `book ${w} principal`).toBe(BigInt(b.principal));
      expect(sim.books[w]!.acc, `book ${w} acc`).toBe(BigInt(b.acc));
      expect(sim.books[w]!.capacity, `book ${w} capacity`).toBe(BigInt(b.capacity));
      expect(sim.books[w]!.vested, `book ${w} vested`).toBe(BigInt(b.vested));
    });
    expect(sim.acceptedPool).toBe(BigInt(s.acceptedPool));
    expect(sim.positions.length).toBe(s.positions.length);
    s.positions.forEach((v, i) => {
      const p = sim.positions[i]!;
      expect(p.vintage === 0n, `#${i} seed`).toBe(v.isSeed);
      expect(p.outcome).toBe(Number(v.outcome));
      expect(p.offered).toBe(BigInt(v.offered));
      expect(p.accepted, `#${i} accepted`).toBe(BigInt(v.accepted));
      expect(p.entryAcc, `#${i} entryAcc`).toBe(BigInt(v.entryAcc));
      expect(accrued(p, sim.books[p.outcome]!), `#${i} accrued`).toBe(BigInt(v.accruedBeforeSettle));
    });

    const lastBlock = s.entries.reduce((m, e) => (BigInt(e.block) > m ? BigInt(e.block) : m), 0n);
    if (s.result === 'VOID') simVoid(sim, lastBlock + 1n);
    else simResolve(sim, s.result === 'UP' ? UP : DOWN, lastBlock + 1n);
    const settled = simSettle(sim, Number(s.feeBps));
    s.positions.forEach((v, i) => {
      const st = settled.positions[i]!.settlement;
      expect(st.gross, `#${i} gross`).toBe(BigInt(v.payoutGross));
      expect(st.fee, `#${i} fee`).toBe(BigInt(v.fee));
      expect(st.refund, `#${i} refund`).toBe(BigInt(v.refund));
      expect(st.total, `#${i} net to owner`).toBe(BigInt(v.netToOwner));
    });
    expect(settled.residue).toBe(BigInt(s.residue));
    expect(settled.fees).toBe(BigInt(s.feesTotal));
  });
});

describe('T8 · contracts/fixtures/worked-example.json (the landing page illustration)', () => {
  const fixture = read('worked-example.json');
  const { market, settlement } = workedExample();

  it('is labelled Illustration and matches the pool and residue', () => {
    expect(fixture.label).toBe('Illustration');
    expect(BigInt(fixture.pool)).toBe(settlement!.pool);
    expect(BigInt(fixture.residue)).toBe(settlement!.residue);
    expect(fixture.winner).toBe('UP');
    expect(BigInt(fixture.kappa)).toBe(30n);
  });

  it('every row: accepted, entry accumulator, accumulators after, VPM and classic payouts, multiple', () => {
    const rows = fixture.rows as {
      who: string;
      side: string;
      stake: string;
      accepted: string;
      positionId: string;
      entryAcc: string;
      accUpAfter: string;
      accDownAfter: string;
      vpmPayout: string;
      vpmPayoutUsdg: string;
      multiple: string;
      classicPayout: string;
    }[];
    expect(rows.length).toBe(settlement!.positions.length);
    // Replay entry by entry to check the "accumulator after" columns.
    const replay = simCreate([10_000_000n, 10_000_000n], 30n);
    rows.forEach((row, i) => {
      const p = settlement!.positions[i]!;
      if (i >= 2) {
        simEnter(replay, { outcome: row.side === 'UP' ? UP : DOWN, amount: BigInt(row.stake), block: BigInt(i) });
        simFinalize(replay);
      }
      expect(replay.books[UP]!.acc, `${row.who} A_UP after`).toBe(BigInt(row.accUpAfter));
      expect(replay.books[DOWN]!.acc, `${row.who} A_DOWN after`).toBe(BigInt(row.accDownAfter));
      expect(p.outcome === UP ? 'UP' : 'DOWN').toBe(row.side);
      expect(p.accepted).toBe(BigInt(row.accepted));
      expect(p.entryAcc).toBe(BigInt(row.entryAcc));
      expect(p.settlement.gross, row.who).toBe(BigInt(row.vpmPayout));
      expect(formatUsdg(p.settlement.gross, { decimals: 6 })).toBe(row.vpmPayoutUsdg);
      expect(p.classic, `${row.who} classic`).toBe(BigInt(row.classicPayout));
      expect(formatMultiple(p.settlement.gross, BigInt(row.stake), { maxDecimals: 4, minDecimals: 4, suffix: '' })).toBe(row.multiple);
    });
    expect(classicPayouts(market.positions, UP).map(String)).toEqual(rows.map((r) => r.classicPayout));
  });
});
