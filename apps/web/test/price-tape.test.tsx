import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PriceTape } from '@/components/landing/PriceTape';
import { TICKERS } from '@/content/tickers';
import type { PriceSnapshot } from '@/lib/view/types';

const FRIDAY_CLOSE = Date.UTC(2026, 8, 25, 19, 56) / 1000;
const SATURDAY = Date.UTC(2026, 8, 26, 15, 0) / 1000;

// PriceTape takes the server's `now`, then re-reads the client clock on mount: pin that clock
// to the same Saturday, or the ages drift with the real date.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(SATURDAY * 1000);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function snapshot(answer: string | null, status: PriceSnapshot['status']): PriceSnapshot {
  return {
    status,
    readAt: SATURDAY,
    readings: TICKERS.map((ticker) => ({
      ticker: ticker.ticker,
      name: ticker.name,
      feed: ticker.feed,
      answer,
      roundId: answer === null ? null : '1',
      updatedAt: answer === null ? null : FRIDAY_CLOSE,
    })),
  };
}

describe('<PriceTape>', () => {
  it("shows each price with its honest age on a weekend", () => {
    render(<PriceTape initial={snapshot('22566018707', 'live')} now={SATURDAY} />);
    expect(screen.getAllByText('225.66').length).toBeGreaterThanOrEqual(TICKERS.length);
    expect(screen.getAllByText(/Fri 3:56 pm ET/).length).toBeGreaterThanOrEqual(TICKERS.length);
    expect(screen.getByText(/Weekend · resumes Sun 8:00 pm ET/)).toBeTruthy();
  });

  it('degrades to "Price unavailable, retrying", never to a blank', () => {
    render(<PriceTape initial={snapshot(null, 'unavailable')} now={SATURDAY} />);
    expect(screen.getAllByText('Price unavailable, retrying').length).toBeGreaterThan(TICKERS.length);
  });
});
