import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarketCard, changePpm, directionVsStrike, splitQuestion } from '@/components/market/MarketCard';
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

describe('splitQuestion', () => {
  it('sets the day a market runs apart from its question', () => {
    expect(splitQuestion('Will NVDA close UP today? · Tue Sep 29')).toEqual({ title: 'Will NVDA close UP today?', when: 'Tue Sep 29' });
    expect(splitQuestion('Will TSLA finish the week UP? · Tue Sep 29 → Fri Oct 2')).toEqual({
      title: 'Will TSLA finish the week UP?',
      when: 'Tue Sep 29 → Fri Oct 2',
    });
    expect(splitQuestion('Will NVDA finish the week UP?')).toEqual({ title: 'Will NVDA finish the week UP?', when: null });
  });
});

describe('<MarketCard>', () => {
  it('reads like a Hunch card: tag, clock, question, the day, the split and both sides as tiles', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const { container } = render(<MarketCard market={LIVE} now={NOW} />);
    const card = within(container);
    expect(card.getByText(/NVDA · Daily/)).toBeTruthy();
    expect(card.getByText('Live')).toBeTruthy();
    expect(card.getByText('03:20:00')).toBeTruthy(); // to the 4:00 pm bell
    expect(card.getByRole('heading', { level: 3 }).textContent).toBe('Will NVDA close UP today?');
    expect(card.getByText('Tue Sep 29')).toBeTruthy();
    expect(card.getByText('60%').className).toMatch(/\bnum\b/); // 120 of 200 staked is on UP
    expect(container.querySelector('article')?.getAttribute('aria-label')).toBe(LIVE.question);
  });

  it('says so when nobody has bet yet, and draws an even split rather than an empty bar', () => {
    const { container } = render(<MarketCard market={{ ...LIVE, pool: { up: 0n, down: 0n } }} now={NOW} />);
    expect(within(container).getByText('No bets yet')).toBeTruthy();
    expect(container.querySelector<HTMLElement>('[style*="width"]')?.style.width).toBe('50%');
  });

  it('turns the clock coral in the last hour before the bell', () => {
    const late = LIVE.finalTime - 1_200;
    const { container } = render(<MarketCard market={LIVE} now={late} />);
    expect(within(container).getByText('Live').closest('span.uppercase')?.className).toMatch(/text-coral/);
  });

  it('a paused market takes no bets and says nothing about collecting', () => {
    render(<MarketCard market={{ ...LIVE, acceptingBets: false }} now={NOW} />);
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.queryByText(/Bet now/)).toBeNull();
  });

  it('a frozen market says Chainlink settles it next; a void one says every stake came back', () => {
    const { unmount } = render(<MarketCard market={{ ...LIVE, phase: 'frozen' }} now={1_790_713_000} />);
    expect(screen.getByText('Settling')).toBeTruthy();
    expect(screen.getByText('Closed at 4:00 pm ET. Chainlink settles it next.')).toBeTruthy();
    unmount();
    render(<MarketCard market={{ ...LIVE, phase: 'void' }} now={1_790_720_000} />);
    expect(screen.getByText('Void · refunded')).toBeTruthy();
    expect(screen.getByText('Every stake was refunded in full.')).toBeTruthy();
  });

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

  it('before launch shows one dashed template per ticker, never as a link and never with a number', () => {
    const { container } = render(<MarketGrid markets={[]} deployment={NOT_DEPLOYED} now={NOW} />);
    const board = within(container).getByRole('list', { name: 'The markets planned for launch' });
    const templates = within(board).getAllByRole('listitem');
    expect(templates).toHaveLength(Math.min(4, NOT_DEPLOYED.feeds.filter((feed) => feed.families.length > 0).length));
    expect(within(board).getAllByText('Template')).toHaveLength(templates.length);
    expect(within(board).queryAllByRole('link')).toHaveLength(0);
    expect(board.textContent).not.toMatch(/\d+\.\d{2}/);
  });

  it('lists every market it is given', () => {
    render(<MarketGrid markets={[LIVE, { ...LIVE, id: '13', href: '/m/13', ticker: 'TSLA' }]} deployment={NOT_DEPLOYED} now={NOW} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
