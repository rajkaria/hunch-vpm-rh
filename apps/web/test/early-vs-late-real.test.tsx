import { DOWN, UP, formatUsdg } from '@hunch-rh/client';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { EarlyVsLate, selectProof } from '@/components/proof/EarlyVsLate';
import type { ActivityData } from '@/lib/server/logs';
import { classicMultipleAfterFee, earlyVsLateFrom } from '@/lib/view/early-vs-late';

import { ALICE, BOB, CAROL, marketFixture } from './fixtures/market';

afterEach(cleanup);

const USDG = 1_000_000n;
const EXPLORER = 'https://robinhoodchain.blockscout.com';
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;

/** Resolved UP: Alice UP early, Bob DOWN, Carol DOWN, Bob UP late (a real-shaped market from the contract mirror). */
function settledUp() {
  return marketFixture({
    outcome: 'UP',
    entries: [
      { outcome: UP, amount: 20n * USDG, block: 101n, owner: ALICE },
      { outcome: DOWN, amount: 30n * USDG, block: 102n, owner: BOB },
      { outcome: DOWN, amount: 40n * USDG, block: 103n, owner: CAROL },
      { outcome: UP, amount: 50n * USDG, block: 104n, owner: BOB },
    ],
    claimed: [2n],
  });
}

const activity: ActivityData = {
  entries: {
    '2': { txHash: hash(2), blockNumber: 2n, timestamp: 1_790_689_000 }, // Tue 9:36 am ET
    '5': { txHash: hash(5), blockNumber: 5n, timestamp: 1_790_711_700 }, // Tue 3:55 pm ET
  },
  claims: { '2': [{ txHash: hash(22), blockNumber: 22n, timestamp: 1_790_713_000, payout: 1n, refund: 0n }] },
  resolved: { txHash: hash(99), blockNumber: 99n, timestamp: 1_790_712_100 },
  voided: null,
};

describe('the proof card from a real settled market', () => {
  it('takes the earliest and the latest winning bets (never the seed), their times, payouts and multiples', () => {
    const market = settledUp();
    const proof = earlyVsLateFrom(market, activity, 'daily', EXPLORER);
    expect(proof).not.toBeNull();
    const winners = market.positions.filter((p) => !p.isSeed && p.side === 'UP');
    const [early, late] = [winners[0]!, winners[winners.length - 1]!];
    expect(early.owner).toBe(ALICE);
    expect(late.owner).toBe(BOB);

    expect(proof!.kind).toBe('daily');
    expect(proof!.winner).toBe('UP');
    expect(proof!.question).toBe('Will NVDA close UP today? · Tue Sep 29');
    expect(proof!.early).toMatchObject({ label: '0x1111…1111', side: 'UP', entryLabel: 'Tue 9:36 am ET', stake: 20n * USDG, txUrl: `${EXPLORER}/tx/${hash(22)}` });
    expect(proof!.late).toMatchObject({ label: '0x2222…2222', entryLabel: 'Tue 3:55 pm ET', stake: 50n * USDG, txUrl: null });

    // Paid is what the contract sends: net of the 2% fee on the gain, floored.
    expect(proof!.early.payout).toBe(early.paidOut);
    expect(proof!.late.payout).toBe(late.settlement.net);
    expect(proof!.early.multiplePpm).toBe((early.paidOut! * 1_000_000n) / (20n * USDG));
    // Early pays more.
    expect(proof!.early.multiplePpm > proof!.late.multiplePpm).toBe(true);
    // The ordinary pool pays every winner the same multiple, after the same fee.
    expect(proof!.classicMultiplePpm).toBe(classicMultipleAfterFee(market.totals.pool, market.books[0].principal, 200));
    expect(proof!.marketHref).toBe('/m/12');
  });

  it('falls back to entry order when the logs cannot be read', () => {
    const proof = earlyVsLateFrom(settledUp(), null, 'weekly', EXPLORER);
    expect(proof!.early.entryLabel).toBe('Bet 1 in entry order');
    expect(proof!.late.entryLabel).toBe('Bet 4 in entry order');
    expect(proof!.early.txUrl).toBeNull();
  });

  it('is null for an open or voided market, or one with no winning bet besides the seed', () => {
    expect(earlyVsLateFrom(marketFixture(), activity, 'daily', EXPLORER)).toBeNull();
    expect(earlyVsLateFrom(marketFixture({ outcome: 'VOID' }), activity, 'daily', EXPLORER)).toBeNull();
    const onlyDown = marketFixture({ outcome: 'UP', entries: [{ outcome: DOWN, amount: 5n * USDG, block: 101n, owner: BOB }] });
    expect(earlyVsLateFrom(onlyDown, activity, 'daily', EXPLORER)).toBeNull();
  });

  it('renders as a settled market (no Illustration label) and never drops the label on fallback', () => {
    const proof = earlyVsLateFrom(settledUp(), activity, 'daily', EXPLORER)!;
    const { container, unmount } = render(<EarlyVsLate proof={selectProof({ weekly: null, daily: proof })} />);
    expect(screen.queryByTestId('illustration-label')).toBeNull();
    expect(container.textContent).toContain('Settled daily market');
    expect(container.textContent).toContain(formatUsdg(proof.early.payout));
    expect(container.textContent).toContain("Both after the market's fee on winnings.");
    unmount();
    render(<EarlyVsLate proof={selectProof({ weekly: null, daily: null })} />);
    expect(screen.getByTestId('illustration-label').textContent).toBe('Illustration');
  });

  it('computes the ordinary pool after the fee, floored', () => {
    expect(classicMultipleAfterFee(170n, 80n, 0)).toBe(2_125_000n);
    // 2.125x gross: the 1.125 gain loses 2%: 2.1025x.
    expect(classicMultipleAfterFee(170n, 80n, 200)).toBe(2_102_500n);
    expect(classicMultipleAfterFee(100n, 100n, 200)).toBe(1_000_000n);
  });
});
