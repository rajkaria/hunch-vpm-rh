import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarketCard, changePpm, directionVsStrike } from '@/components/market/MarketCard';
import { MarketGrid } from '@/components/market/MarketGrid';
import { NOT_DEPLOYED } from '@/lib/deployment';
import type { MarketCardData } from '@/lib/view/types';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = 1_790_700_000; // Tue Sep 29 2026, 16:40 UTC (12:40 pm ET), inside the session

const LIVE: MarketCardData = {
  id: '12',
  href: '/m/12',
  ticker: 'NVDA',
  family: 'daily',
  question: 'Will NVDA close UP today? · Tue Sep 29',
  phase: 'live',
  strikeTime: 1_790_688_600,
  finalTime: 1_790_712_000,
  strike: { answer: 22_410_000_000n, roundId: '18446744073709552790', at: 1_790_688_012, url: null },
  live: { answer: 22_566_018_707n, updatedAt: 1_790_699_000 },
  pool: { up: 120_000_000n, down: 80_000_000n },
};

describe('direction and change against the strike', () => {
  it('is a word, and FLAT when unchanged', () => {
    expect(directionVsStrike(2n, 1n)).toBe('UP');
    expect(directionVsStrike(1n, 2n)).toBe('DOWN');
    expect(directionVsStrike(5n, 5n)).toBe('FLAT');
    expect(changePpm(22_566_018_707n, 22_410_000_000n)).toBe(6_962n); // +0.69%
    expect(changePpm(1n, 0n)).toBe(0n);
  });
});

describe('<MarketCard>', () => {
  it('renders the outcomes as the words UP and DOWN, never colour alone', () => {
    const { container } = render(<MarketCard market={LIVE} now={NOW} />);
    const card = within(container);
    // The pool split names both sides, and the price row names the direction vs the strike.
    expect(card.getAllByText('UP').length).toBeGreaterThanOrEqual(2);
    expect(card.getAllByText('DOWN').length).toBeGreaterThanOrEqual(1);
    expect(container.textContent).not.toMatch(/\bYES\b|\bNO\b/);
    expect(card.getByText('+0.69%')).toBeTruthy();
  });

  it('shows every number the spec asks for, in mono, with the late-bet line', () => {
    const { container } = render(<MarketCard market={LIVE} now={NOW} />);
    const card = within(container);
    expect(card.getByText('224.10')).toBeTruthy();
    expect(card.getByText('225.66')).toBeTruthy();
    expect(card.getByText('200.00')).toBeTruthy(); // total staked
    expect(card.getByText('120.00')).toBeTruthy();
    expect(card.getByText('80.00')).toBeTruthy();
    expect(card.getByText(/Bet now and you.d collect everything the other side adds from here/)).toBeTruthy();
    expect(card.getByRole('link').getAttribute('href')).toBe('/m/12');
    for (const figure of ['224.10', '225.66', '200.00']) {
      expect(card.getByText(figure).className).toMatch(/\bnum\b/);
    }
  });

  it('before the opening bell says when the strike sets, with a countdown', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_790_686_800 * 1000);
    render(<MarketCard market={{ ...LIVE, phase: 'opens', strike: null }} now={1_790_686_800} />);
    expect(screen.getByText('Sets at 9:30 ET')).toBeTruthy();
    expect(screen.getByText('00:30:00')).toBeTruthy();
  });

  it('a settled card names its winner and drops the call to bet', () => {
    render(<MarketCard market={{ ...LIVE, phase: 'resolved', winner: 'DOWN' }} now={1_790_720_000} />);
    expect(screen.getByText(/Resolved/).textContent).toContain('DOWN');
    expect(screen.queryByText(/Bet now/)).toBeNull();
  });
});

describe('<MarketGrid>', () => {
  it('never invents a market: with none, it shows the launching state', () => {
    render(<MarketGrid markets={[]} deployment={NOT_DEPLOYED} now={NOW} />);
    expect(screen.getByText('Markets open at the next opening bell once the venue is live.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Will .* close UP today/ })).toBeNull();
  });

  it('lists every market it is given', () => {
    render(<MarketGrid markets={[LIVE, { ...LIVE, id: '13', href: '/m/13', ticker: 'TSLA' }]} deployment={NOT_DEPLOYED} now={NOW} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
