import { describe, expect, it } from 'vitest';
import marketEmpty from './fixtures/market-empty.json';
import marketOpen from './fixtures/market-open.json';
import marketUnbounded from './fixtures/market-unbounded.json';
import { PPM } from '../src/units.js';
import { MARKET_A, MARKET_EMPTY, MARKET_UNBOUNDED, testClient } from './support/client.js';

describe('impliedOdds', () => {
  it('derives probability from accepted principal', async () => {
    const { client } = testClient({ market: marketOpen });
    const odds = await client.impliedOdds(MARKET_A);

    expect(odds.defined).toBe(true);
    expect(odds.totalAccepted).toBe(107_000000n);
    // 6 of 107 and 101 of 107.
    expect(odds.outcomes[0]?.probabilityPpm).toBe(56_074n);
    expect(odds.outcomes[0]?.probabilityPercent).toBe('5.6074');
    expect(odds.outcomes[1]?.probabilityPpm).toBe(943_925n);
    expect(odds.outcomes[1]?.probabilityPercent).toBe('94.3925');
  });

  it('floors, so the probabilities sum to just under one', async () => {
    const { client } = testClient({ market: marketOpen });
    const odds = await client.impliedOdds(MARKET_A);
    const sum = odds.outcomes.reduce((total, outcome) => total + outcome.probabilityPpm, 0n);
    expect(sum).toBe(999_999n);
    expect(PPM - sum).toBe(1n);
  });

  it('gives the gross return per unit as decimal odds', async () => {
    const { client } = testClient({ market: marketOpen });
    const odds = await client.impliedOdds(MARKET_A);
    // 107 / 6 = 17.833333x on the thin side, 107 / 101 = 1.059405x on the thick side.
    expect(odds.outcomes[0]?.decimalOddsPpm).toBe(17_833333n);
    expect(odds.outcomes[1]?.decimalOddsPpm).toBe(1_059405n);
  });

  it('splits an n-way market evenly when the books are equal', async () => {
    const { client } = testClient({ market: marketUnbounded });
    const odds = await client.impliedOdds(MARKET_UNBOUNDED);
    expect(odds.outcomes.map((outcome) => outcome.probabilityPpm)).toEqual([333_333n, 333_333n, 333_333n]);
    expect(odds.outcomes.map((outcome) => outcome.decimalOddsPpm)).toEqual([3_000000n, 3_000000n, 3_000000n]);
  });

  it('guards division by zero on an empty pool', async () => {
    const { client } = testClient({ market: marketEmpty });
    const odds = await client.impliedOdds(MARKET_EMPTY);
    expect(odds.defined).toBe(false);
    expect(odds.totalAccepted).toBe(0n);
    for (const outcome of odds.outcomes) {
      expect(outcome.probabilityPpm).toBe(0n);
      expect(outcome.probabilityPercent).toBe('0.0000');
      expect(outcome.decimalOddsPpm).toBeNull();
    }
  });
});
