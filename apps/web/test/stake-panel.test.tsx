import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StakePanel } from '@/components/market/StakePanel';
import { buildFixtures } from '@/lib/data/fixtures';
import type { MarketDetail } from '@/lib/data/types';
import { parseUsdcAmount } from '@/lib/units';

afterEach(cleanup);

const NOW = 1_789_000_000n;
const all = buildFixtures(NOW).markets;
const market: MarketDetail = all.find((entry) => entry.id === 'eth-3000-sep30')!;

function amountField() {
  return screen.getByLabelText('Amount');
}

describe('parseUsdcAmount', () => {
  it('treats empty as zero rather than as an error, so a fresh field is quiet', () => {
    expect(parseUsdcAmount('')).toEqual({ value: 0n, problem: null });
    expect(parseUsdcAmount('   ')).toEqual({ value: 0n, problem: null });
  });

  it('parses to smallest units at six decimals', () => {
    expect(parseUsdcAmount('250').value).toBe(250_000_000n);
    expect(parseUsdcAmount('250.50').value).toBe(250_500_000n);
    expect(parseUsdcAmount('0.000001').value).toBe(1n);
  });

  it('rejects more precision than USDC has instead of truncating it', () => {
    // Truncating would change the amount the user is about to sign for.
    const parsed = parseUsdcAmount('1.0000005');
    expect(parsed.value).toBeNull();
    expect(parsed.problem).toMatch(/6 decimal places/);
  });

  it('rejects a negative stake and says why', () => {
    expect(parseUsdcAmount('-5').problem).toBe('A stake cannot be negative.');
  });

  it('rejects text', () => {
    expect(parseUsdcAmount('abc').value).toBeNull();
  });
});

describe('StakePanel', () => {
  it('asks for an amount before it claims anything about acceptance', () => {
    render(<StakePanel market={market} />);
    expect(screen.getByText(/Enter an amount to see what the books would accept/)).toBeTruthy();
    expect(screen.queryByText('If you entered now')).toBeNull();
  });

  // The panel renders EntryFlow by default, which needs a wagmi provider. These
  // cases are about the estimate, so they pass a stub action instead of mounting
  // a wallet — `entry-flow.test.tsx` covers the flow itself.
  const stub = () => null;

  it('reports a full acceptance when the opposing book has room', () => {
    render(<StakePanel market={market} action={stub} />);
    fireEvent.change(amountField(), { target: { value: '10' } });
    expect(screen.getByText('Accepted in full')).toBeTruthy();
  });

  it('reports a partial acceptance, and names the book that bound it', () => {
    // 20,000 offered on "Above" vests into "Below", which has ~6,000 of room.
    render(<StakePanel market={market} action={stub} />);
    fireEvent.change(amountField(), { target: { value: '20000' } });

    expect(screen.getByText('Partly accepted')).toBeTruthy();
    expect(screen.getByText(/is the book that binds it/)).toBeTruthy();

    // The refusal is described as refundable, never as a failure. If this copy
    // ever starts calling it an error, the mechanism will read as broken.
    expect(screen.getByText(/never at risk/)).toBeTruthy();
    expect(screen.queryByText(/error/i)).toBeNull();
    expect(screen.queryByText(/failed/i)).toBeNull();
  });

  it('shows accepted and refused as a pair, both present', () => {
    render(<StakePanel market={market} action={stub} />);
    fireEvent.change(amountField(), { target: { value: '20000' } });
    expect(screen.getByText('Accepted')).toBeTruthy();
    expect(screen.getByText('Refused')).toBeTruthy();
  });

  it('surfaces a bad amount and asserts nothing about acceptance while it stands', () => {
    render(<StakePanel market={market} action={stub} />);
    fireEvent.change(amountField(), { target: { value: '1.0000005' } });
    expect(screen.getByText(/6 decimal places/)).toBeTruthy();
    expect(screen.queryByText('If you entered now')).toBeNull();
  });

  it('warns that the estimate is conditional on the block, not a quote', () => {
    render(<StakePanel market={market} action={stub} />);
    fireEvent.change(amountField(), { target: { value: '10' } });
    // Co-entrants in the same block ration against each other, so a quote is
    // exactly what this cannot be. Saying so is not optional.
    expect(screen.getByText(/An estimate, not a quote/)).toBeTruthy();
    expect(screen.getByText(/same block/)).toBeTruthy();
  });

  it('renders the action slot only once there is an amount to act on', () => {
    const action = () => <span>sign here</span>;
    render(<StakePanel market={market} action={action} />);
    expect(screen.queryByText('sign here')).toBeNull();
    fireEvent.change(amountField(), { target: { value: '10' } });
    expect(screen.getByText('sign here')).toBeTruthy();
  });

  it('refuses entry on a market that has already settled, and says so', () => {
    const settled = all.find((entry) => entry.status !== 'Open');
    if (settled === undefined) return;
    render(<StakePanel market={settled} />);
    expect(screen.getByText(/settled|frozen/i)).toBeTruthy();
    expect((amountField() as HTMLInputElement).disabled).toBe(true);
  });
});
