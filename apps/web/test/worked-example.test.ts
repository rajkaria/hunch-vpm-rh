import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXAMPLE, WORKED, exampleRow, formatAcc, replayWorkedExample } from '@/content/worked-example';
import { formatAmount } from '@/lib/units';

/**
 * The worked example is the only static set of numbers the site may show. It is replayed from
 * the two rules, pinned here to docs/spec/02-mechanism.md, and (once the contracts agent has
 * written it) to contracts/fixtures/worked-example.json, which the Foundry test pins to the unit.
 */
describe('worked example', () => {
  it('replays the spec table: accumulators after every bet', () => {
    const acc = WORKED.steps.map((step) => [formatAcc(step.accUp), formatAcc(step.accDown)]);
    expect(acc).toEqual([
      ['1.0', '1.0'], // open (seed)
      ['1.0', '3.0'], // Mei UP 20
      ['2.0', '3.0'], // Dan DOWN 30
      ['3.3333', '3.0'], // Kim DOWN 40
      ['3.3333', '3.625'], // Ben UP 50
      ['3.4583', '3.625'], // Lee DOWN 10
    ]);
  });

  it('pays what the contract pays, to the unit, and shows it truncated to the cent', () => {
    expect(exampleRow('Mei').payout).toBe(69_166_666n);
    expect(exampleRow('Ben').payout).toBe(56_250_000n);
    expect(WORKED.seedUp.payout).toBe(44_583_333n);
    expect(exampleRow('Dan').payout).toBe(0n);
    // Never rounded up: the spec table's 69.17 is shown as 69.16.
    expect(formatAmount(exampleRow('Mei').payout)).toBe('69.16');
    expect(formatAmount(WORKED.seedUp.payout)).toBe('44.58');
  });

  it('matches the ordinary-pool column', () => {
    expect(WORKED.pool).toBe(170_000_000n);
    expect(WORKED.winningPrincipal).toBe(80_000_000n);
    expect(WORKED.classicMultiplePpm).toBe(2_125_000n);
    expect(exampleRow('Mei').classic).toBe(42_500_000n);
    expect(exampleRow('Ben').classic).toBe(106_250_000n);
    expect(WORKED.seedUp.classic).toBe(21_250_000n);
  });

  it('conserves the pool: payouts plus the floor-rounding leftover equal the pool', () => {
    const paid = WORKED.rows.reduce((sum, row) => sum + row.payout, 0n) + WORKED.seedUp.payout;
    expect(WORKED.pool - paid).toBe(1n);
  });

  it("Mei's win payout only goes up as the week goes on", () => {
    const series = WORKED.steps.slice(1).map((step) => step.accruedMei);
    for (let index = 1; index < series.length; index += 1) {
      expect(series[index]! >= series[index - 1]!).toBe(true);
    }
    expect(series[0]).toBe(20_000_000n);
    expect(series.at(-1)).toBe(69_166_666n);
  });

  it('is deterministic', () => {
    expect(replayWorkedExample()).toEqual(WORKED);
    expect(EXAMPLE.bets.map((bet) => bet.name)).toEqual(['Mei', 'Dan', 'Kim', 'Ben', 'Lee']);
  });

  // Resolved from the package directory vitest runs in (apps/web), or from the repo root.
  const fixturePath =
    [resolve(process.cwd(), '../../contracts/fixtures/worked-example.json'), resolve(process.cwd(), 'contracts/fixtures/worked-example.json')].find(
      (path) => existsSync(path),
    ) ?? 'contracts/fixtures/worked-example.json';
  it.skipIf(!existsSync(fixturePath))('agrees with the Foundry-pinned fixture (contracts/fixtures/worked-example.json)', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      pool: string;
      winningPrincipal: string;
      residue: string;
      rows: { who: string; side: string; stake: string; vpmPayout: string; classicPayout: string; accUpAfter: string; accDownAfter: string }[];
    };
    expect(BigInt(fixture.pool)).toBe(WORKED.pool);
    expect(BigInt(fixture.winningPrincipal)).toBe(WORKED.winningPrincipal);
    expect(BigInt(fixture.residue)).toBe(1n);
    for (const name of ['Mei', 'Ben', 'Dan', 'Kim', 'Lee']) {
      const row = fixture.rows.find((candidate) => candidate.who === name);
      expect(row, name).toBeDefined();
      expect(BigInt(row!.vpmPayout)).toBe(exampleRow(name).payout);
      expect(BigInt(row!.classicPayout)).toBe(exampleRow(name).classic);
    }
    const seedUp = fixture.rows.find((row) => row.who === 'Hunch seed' && row.side === 'UP');
    expect(BigInt(seedUp!.vpmPayout)).toBe(WORKED.seedUp.payout);
    const last = fixture.rows.at(-1)!;
    expect(BigInt(last.accUpAfter)).toBe(WORKED.steps.at(-1)!.accUp);
    expect(BigInt(last.accDownAfter)).toBe(WORKED.steps.at(-1)!.accDown);
  });
});
