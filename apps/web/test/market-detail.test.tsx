import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BookTable } from '@/components/market/BookTable';
import { HeadroomBar } from '@/components/market/HeadroomBar';
import { PositionPanel } from '@/components/market/PositionPanel';
import { RuleComparator, type WireBook, type WirePosition } from '@/components/market/RuleComparator';
import { buildFixtures } from '@/lib/data/fixtures';
import type { MarketDetail } from '@/lib/data/types';

afterEach(cleanup);

const NOW = 1_789_000_000n;
const market: MarketDetail = buildFixtures(NOW).markets.find((entry) => entry.id === 'eth-3000-sep30')!;

const wireBooks: WireBook[] = market.outcomes.map((outcome) => ({
  outcome: outcome.outcome,
  label: outcome.label,
  tone: outcome.tone,
  principal: outcome.principal.toString(),
  vested: outcome.vested.toString(),
  capacity: outcome.capacity === null ? null : outcome.capacity.toString(),
  demand: outcome.demand.toString(),
  acc: outcome.acc.toString(),
}));

const wirePositions: WirePosition[] = market.positions.map((position) => ({
  positionId: position.positionId.toString(),
  outcome: position.outcome,
  offered: position.offered.toString(),
  accepted: position.accepted.toString(),
  refused: position.refused.toString(),
  entryAcc: position.entryAcc.toString(),
}));

/** The whole rendered text, for assertions that span several elements. */
function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

describe('HeadroomBar', () => {
  it('reports the consumed share as a meter a screen reader can read', () => {
    render(
      <HeadroomBar
        label="Below $3,000"
        tone="down"
        capacity={87_000_000_000n}
        vested={81_000_000_000n}
        constrains="Limits stake on Above $3,000"
      />,
    );
    const meter = screen.getByRole('meter');
    expect(meter.getAttribute('aria-valuenow')).toBe('93.1');
    expect(meter.getAttribute('aria-valuemax')).toBe('100');
    expect(meter.getAttribute('aria-label')).toContain('93.1 percent of capacity used');
  });

  it('states the room left and the ceiling it is left of', () => {
    const { container } = render(
      <HeadroomBar label="Below $3,000" tone="down" capacity={87_000_000_000n} vested={81_000_000_000n} />,
    );
    expect(text(container)).toContain('93.1');
    expect(text(container)).toContain('6,000.00');
    expect(text(container)).toContain('87,000.00');
  });

  it('draws no bar and says why for an unbounded book', () => {
    const { container } = render(<HeadroomBar label="Over $4,500" tone="up" capacity={null} vested={9_000n} />);
    expect(screen.queryByRole('meter')).toBeNull();
    expect(text(container)).toContain('no ceiling');
    expect(text(container)).toContain('nothing is refused for want of room');
  });

  it('paints a full bar rather than overflowing when a book is over its capacity', () => {
    render(<HeadroomBar label="x" tone="neutral" capacity={100n} vested={250n} />);
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('100');
  });
});

describe('BookTable', () => {
  it('separates a book’s own headroom from the room a stake on it actually has', () => {
    render(<BookTable market={market} />);
    const above = screen.getByRole('row', { name: /Above \$3,000/ });
    const cells = within(above).getAllByRole('cell');
    // implied, P, V, C, H, room-for-a-stake
    expect(cells).toHaveLength(6);
    expect(cells[1]!.textContent).toContain('81,000.00'); // its own principal
    expect(cells[4]!.textContent).toContain('2,427,100.00'); // its own headroom, which is enormous
    // …but a stake on it vests into the other book, which has 6,000 left.
    expect(cells[5]!.textContent).toContain('6,000.00');
  });

  it('says unbounded rather than showing a number for an n-way book', () => {
    const nway = buildFixtures(NOW).markets.find((entry) => entry.kappa === null)!;
    const { container } = render(<BookTable market={nway} />);
    expect(text(container)).toContain('unbounded');
  });
});

describe('PositionPanel', () => {
  it('shows offered, accepted and refused as three different numbers', () => {
    const { container } = render(<PositionPanel market={market} />);
    const rendered = text(container);
    expect(rendered).toContain('20,000.00'); // offered
    expect(rendered).toContain('15,000.00'); // accepted
    expect(rendered).toContain('5,000.00'); // refused
    expect(rendered).toContain('refundable now');
  });

  it('states the payout as a condition, never as a balance', () => {
    const { container } = render(<PositionPanel market={market} />);
    expect(text(container)).toContain('If this outcome wins');
  });

  it('renders an empty state instead of nothing when the wallet holds no position', () => {
    const { container } = render(<PositionPanel market={{ ...market, positions: [] }} />);
    expect(text(container)).toContain('You hold nothing in this market.');
  });

  it('quotes the classic settler’s own payout rule on a classic market', () => {
    // The classic books carry A_w = 0 and every entryAcc is 0, so the vested
    // payout rule degenerates to the accepted principal here. A panel that ran
    // it anyway would print 1,000.00 where `claim` pays 3,285.71.
    const settled = buildFixtures(NOW).markets.find((entry) => entry.id === 'link-25-aug20-classic')!;
    render(<PositionPanel market={settled} />);
    // Read the settlement figure itself rather than the whole panel: 1,000.00
    // is also this position's accepted principal, and that stat is correct.
    const figure = screen.getByText('Settlement').nextElementSibling;
    expect(figure?.textContent).toContain('3,285.71');
    expect(figure?.textContent).not.toContain('1,000.00');
  });

  it('shows a pool multiple rather than a vesting one where nothing vests', () => {
    const settled = buildFixtures(NOW).markets.find((entry) => entry.id === 'link-25-aug20-classic')!;
    const { container } = render(<PositionPanel market={settled} />);
    const rendered = text(container);
    expect(rendered).not.toContain('Vested to it');
    expect(rendered).toContain('Pool multiple');
    // 11,500 / 3,500 on the winning book.
    expect(rendered).toContain('3.28x');
  });

  it('does not promise an open classic position that later stake will add to it', () => {
    const open = buildFixtures(NOW).markets.find((entry) => entry.id === 'sol-250-oct07-classic')!;
    const { container } = render(<PositionPanel market={open} />);
    const rendered = text(container);
    expect(open.positions.length).toBeGreaterThan(0);
    expect(rendered).toContain('If this outcome wins');
    expect(rendered).toContain('Nothing vests here');
    expect(rendered).not.toContain('nothing that entered before you can take from it');
  });
});

describe('RuleComparator', () => {
  function renderComparator() {
    return render(
      <RuleComparator books={wireBooks} positions={wirePositions} settlerKind="vested" frozen={false} />,
    );
  }

  it('opens on the wallet’s own position and states the difference as a number', () => {
    const { container } = renderComparator();
    // The wallet's first position is the early contrarian one on "Below".
    expect(text(container)).toContain('Below $3,000');
    expect(text(container)).toContain('The vested rule pays');
    expect(text(container)).toContain('Vested');
    expect(text(container)).toContain('Classic pool');
  });

  it('turns the sign over for the wallet’s late position', () => {
    const { container } = renderComparator();
    const select = screen.getByRole('combobox');
    // The second position is the rationed, late one on "Above".
    fireEvent.change(select, { target: { value: wirePositions[1]!.positionId } });
    expect(text(container)).toContain('The classic rule would pay');
  });

  it('explains a refusal in plain words rather than as an error', () => {
    const { container } = renderComparator();
    fireEvent.click(screen.getByRole('button', { name: 'A stake placed now' }));
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: '0' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '10000' } });

    const rendered = text(container);
    expect(rendered).toContain('Capacity reached');
    expect(rendered).toContain('6,000.00 accepted');
    expect(rendered).toContain('4,000.00 refunded');
    expect(rendered).toContain('Nothing is lost and the transaction does not fail.');
  });

  it('prices a late stake the way each rule would', () => {
    const { container } = renderComparator();
    fireEvent.click(screen.getByRole('button', { name: 'A stake placed now' }));
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: '0' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '10000' } });

    const rendered = text(container);
    // Vested: accepted principal back plus the refund — exactly the offer.
    expect(rendered).toContain('10,000.00');
    // Classic: a share of a pool the stake itself enlarged.
    expect(rendered).toContain('10,318.68');
    expect(rendered).toContain('The classic rule would pay');
    expect(rendered).toContain('318.68 more');
  });

  it('says what the classic rule takes from the people already there', () => {
    const { container } = renderComparator();
    fireEvent.click(screen.getByRole('button', { name: 'A stake placed now' }));
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: '0' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '10000' } });

    const rendered = text(container);
    expect(rendered).toContain('1.03x');
    expect(rendered).toContain('their multiple cannot fall');
  });

  it('accepts a stake in full when the opposing book has the room', () => {
    const { container } = renderComparator();
    fireEvent.click(screen.getByRole('button', { name: 'A stake placed now' }));
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: '0' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '1000' } });

    const rendered = text(container);
    expect(rendered).toContain('All 1,000.00 accepted');
    expect(rendered).toContain('6,000.00 in full');
    expect(rendered).not.toContain('Capacity reached');
  });

  it('tells someone what is wrong with an amount rather than silently truncating it', () => {
    renderComparator();
    fireEvent.click(screen.getByRole('button', { name: 'A stake placed now' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '1.0000005' } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/USDC has 6 decimal places/)).toBeTruthy();
  });

  it('treats an empty box as zero instead of as an error', () => {
    renderComparator();
    fireEvent.click(screen.getByRole('button', { name: 'A stake placed now' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '' } });
    expect(input.getAttribute('aria-invalid')).toBe('false');
  });

  it('offers only the stake calculator when the wallet holds nothing', () => {
    render(<RuleComparator books={wireBooks} positions={[]} settlerKind="vested" frozen={false} />);
    expect(screen.getByRole('button', { name: 'Your position' }).hasAttribute('disabled')).toBe(true);
  });

  it('says a frozen market can take no more stake', () => {
    const { container } = render(
      <RuleComparator books={wireBooks} positions={[]} settlerKind="vested" frozen />,
    );
    expect(text(container)).toContain('no further stake can be accepted');
  });
});
