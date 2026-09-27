import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { EarlyVsLate, ILLUSTRATION_PROOF, selectProof } from '@/components/proof/EarlyVsLate';
import type { EarlyVsLateProof } from '@/lib/live/types';

afterEach(cleanup);

const SETTLED: EarlyVsLateProof = {
  kind: 'weekly',
  question: 'Will TSLA finish the week UP? · Tue Sep 29 → Fri Oct 2',
  ticker: 'TSLA',
  winner: 'DOWN',
  windowLabel: 'Tue Sep 29 to Fri Oct 2',
  strike: { answer: 37_174_710_000n, roundId: '18446744073709552983', at: 1_790_688_000, url: null },
  final: { answer: 36_500_000_000n, roundId: '18446744073709553001', at: 1_790_971_000, url: null },
  early: {
    label: '0x1234…abcd',
    side: 'DOWN',
    entryLabel: 'Tue 9:41 am ET',
    stake: 10_000_000n,
    payout: 31_200_000n,
    multiplePpm: 3_120_000n,
    txUrl: 'https://robinhoodchain.blockscout.com/tx/0xaa',
  },
  late: {
    label: '0x9876…ef01',
    side: 'DOWN',
    entryLabel: 'Fri 3:50 pm ET',
    stake: 20_000_000n,
    payout: 20_400_000n,
    multiplePpm: 1_020_000n,
    txUrl: 'https://robinhoodchain.blockscout.com/tx/0xbb',
  },
  classicMultiplePpm: 1_800_000n,
  marketHref: '/m/7',
};

describe('selectProof', () => {
  it('falls back weekly, then daily, then the worked example', () => {
    const daily: EarlyVsLateProof = { ...SETTLED, kind: 'daily' };
    expect(selectProof({ weekly: SETTLED, daily })).toBe(SETTLED);
    expect(selectProof({ weekly: null, daily })).toBe(daily);
    expect(selectProof({ weekly: null, daily: null })).toBe(ILLUSTRATION_PROOF);
    expect(ILLUSTRATION_PROOF.kind).toBe('illustration');
  });
});

describe('<EarlyVsLate> with the worked example', () => {
  it('renders the illustration fallback with its "Illustration" label', () => {
    render(<EarlyVsLate proof={selectProof({ weekly: null, daily: null })} />);
    expect(screen.getByTestId('illustration-label').textContent).toBe('Illustration');
    expect(screen.getByText('Will NVDA finish the week UP?')).toBeTruthy();
    // The early and the late winner, side by side, with the contract's exact payouts truncated to the cent.
    expect(screen.getByText('Mei')).toBeTruthy();
    expect(screen.getByText('Ben')).toBeTruthy();
    expect(screen.getByText('69.16')).toBeTruthy();
    expect(screen.getByText('56.25')).toBeTruthy();
    // And the ordinary-pool line.
    const caption = screen.getByText(/In an ordinary pool both would have been paid/);
    expect(caption.textContent).toContain('2.12×');
    // No invented transactions for made-up bettors.
    expect(screen.queryByText('Payout transaction')).toBeNull();
  });

  it('never drops the label, whatever else the proof object carries', () => {
    const variants: EarlyVsLateProof[] = [
      ILLUSTRATION_PROOF,
      { ...ILLUSTRATION_PROOF, marketHref: '/m/1' },
      { ...ILLUSTRATION_PROOF, strike: SETTLED.strike, final: SETTLED.final },
      { ...ILLUSTRATION_PROOF, early: { ...ILLUSTRATION_PROOF.early, txUrl: 'https://example.invalid/tx' } },
      { ...ILLUSTRATION_PROOF, question: 'Anything else' },
    ];
    for (const proof of variants) {
      for (const headingLevel of ['h2', 'h3'] as const) {
        const { container, unmount } = render(<EarlyVsLate proof={proof} headingLevel={headingLevel} titleId="t" />);
        const label = within(container).getByTestId('illustration-label');
        expect(label.textContent).toBe('Illustration');
        expect(container.querySelector('figure')?.getAttribute('data-kind')).toBe('illustration');
        // An illustration never links a transaction, even if one was passed in.
        expect(within(container).queryByText('Payout transaction')).toBeNull();
        unmount();
      }
    }
  });

  it('labels a real settled market as such, with its transactions and prices', () => {
    render(<EarlyVsLate proof={SETTLED} />);
    expect(screen.queryByTestId('illustration-label')).toBeNull();
    expect(screen.getByText('Settled weekly market')).toBeTruthy();
    expect(screen.getAllByText('Payout transaction')).toHaveLength(2);
    expect(screen.getByText('371.74')).toBeTruthy();
    expect(screen.getByText('See every bet in this market').getAttribute('href')).toBe('/m/7');
  });
});
