import { CHAIN_ID, UP, DOWN, USDG_EIP712_DOMAIN, quoteForMarket, type Deployment } from '@hunch-rh/client';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import type { Address, Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const track = vi.fn();
vi.mock('@vercel/analytics', () => ({ track: (...args: unknown[]) => track(...args) }));

import { StakePanel } from '@/components/market/StakePanel';
import { marketDetailJson } from '@/lib/api/shapes';
import { NOT_DEPLOYED } from '@/lib/deployment';
import { quoteFor, reviveMarket } from '@/lib/market/model';
import { WalletPortContext, type WalletPort } from '@/lib/wallet/port';

import { ALICE, marketFixture } from './fixtures/market';

const USDG = 1_000_000n;
const VPM: Address = '0x00000000000000000000000000000000000000bb';
const TX: Hex = `0x${'cd'.repeat(32)}`;
const APPROVE_TX: Hex = `0x${'ef'.repeat(32)}`;

const DEPLOYED: Deployment = {
  ...NOT_DEPLOYED,
  status: 'deployed',
  deployedAt: '2026-10-01T00:00:00Z',
  startBlock: 1,
  contracts: {
    HunchVPM: { address: VPM, deployTx: `0x${'11'.repeat(32)}`, block: 1 },
    StockRoundResolver: { address: '0x00000000000000000000000000000000000000cc', deployTx: `0x${'22'.repeat(32)}`, block: 1 },
    HunchMarketFactory: { address: '0x00000000000000000000000000000000000000dd', deployTx: `0x${'33'.repeat(32)}`, block: 1 },
  },
};

function liveMarket(options: Parameters<typeof marketFixture>[0] = {}) {
  const detail = marketFixture(options);
  return { detail, market: reviveMarket(marketDetailJson(detail, { activity: null, log: null, readAt: detail.head.timestamp, stale: false })) };
}

interface Calls {
  openConnect: ReturnType<typeof vi.fn>;
  switchToRobinhood: ReturnType<typeof vi.fn>;
  signTypedData: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  waitForReceipt: ReturnType<typeof vi.fn>;
  usdgAllowance: ReturnType<typeof vi.fn>;
}

function makeCalls(): Calls {
  return {
    openConnect: vi.fn(),
    switchToRobinhood: vi.fn(),
    signTypedData: vi.fn(async () => `0x${'aa'.repeat(65)}` as Hex),
    write: vi.fn(async (call: { functionName: string }) => (call.functionName === 'approve' ? APPROVE_TX : TX)),
    waitForReceipt: vi.fn(async () => 'success' as const),
    usdgAllowance: vi.fn(async () => 0n),
  };
}

/** A wallet that starts disconnected, connects on another chain, and switches when asked: wagmi, mocked. */
function FakeWallet({ calls, children, start = 'disconnected' }: { calls: Calls; children: ReactNode; start?: 'disconnected' | 'connected' }) {
  const [state, setState] = useState<Pick<WalletPort, 'status' | 'address' | 'chainId' | 'connectorName'>>(
    start === 'connected'
      ? { status: 'connected', address: ALICE, chainId: CHAIN_ID, connectorName: 'Test wallet' }
      : { status: 'disconnected', address: null, chainId: null, connectorName: null },
  );
  const port: WalletPort = {
    ...state,
    openConnect: () => {
      calls.openConnect();
      setState({ status: 'connected', address: ALICE, chainId: 1, connectorName: 'Test wallet' });
    },
    switchToRobinhood: async () => {
      calls.switchToRobinhood();
      setState((s) => ({ ...s, chainId: CHAIN_ID }));
    },
    signTypedData: (typed) => calls.signTypedData(typed) as Promise<Hex>,
    write: (call) => calls.write(call) as Promise<Hex>,
    waitForReceipt: (hash) => calls.waitForReceipt(hash) as Promise<'success' | 'reverted'>,
    usdgBalance: async () => 500n * USDG,
    usdgAllowance: (owner, spender) => calls.usdgAllowance(owner, spender) as Promise<bigint>,
    disconnect: async () => undefined,
  };
  return <WalletPortContext.Provider value={port}>{children}</WalletPortContext.Provider>;
}

function relayResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const primary = (): HTMLButtonElement => screen.getByTestId('primary-action') as HTMLButtonElement;

async function connectSwitchAndConfirmEligibility(): Promise<void> {
  expect(primary().textContent).toBe('Connect');
  fireEvent.click(primary());
  await waitFor(() => expect(primary().textContent).toBe('Switch to Robinhood Chain'));
  fireEvent.click(primary());
  await waitFor(() => expect(primary().textContent).toMatch(/^Place bet/));
  // Eligibility first: the button says why it is disabled.
  expect(primary().disabled).toBe(true);
  expect(screen.getByTestId('primary-reason').textContent).toContain('Confirm where you live');
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() => expect(primary().disabled).toBe(false));
}

beforeEach(() => {
  window.localStorage.clear();
  track.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<StakePanel> gasless path: connect → switch → sign → relayed → confirmed', () => {
  it('signs USDG’s authorization for exactly this market, side and amount, relays it and confirms', async () => {
    const calls = makeCalls();
    const fetchMock = vi.fn(async () => relayResponse(200, { ok: true, txHash: TX, nonce: `0x${'01'.repeat(32)}`, receipt: 'confirmed' }));
    vi.stubGlobal('fetch', fetchMock);
    const onConfirmed = vi.fn();
    const { market, detail } = liveMarket();

    render(
      <FakeWallet calls={calls}>
        <StakePanel market={market} deployment={DEPLOYED} region="open" nowSec={detail.head.timestamp} onConfirmed={onConfirmed} retryWaitMs={1} />
      </FakeWallet>,
    );
    await connectSwitchAndConfirmEligibility();
    expect(calls.openConnect).toHaveBeenCalledTimes(1);
    expect(calls.switchToRobinhood).toHaveBeenCalledTimes(1);

    fireEvent.click(primary());
    await waitFor(() => expect(screen.getByTestId('bet-confirmed')).toBeTruthy());

    // One signature: USDG's hardcoded domain, to = HunchVPM, value = the amount, ~10 minutes valid.
    expect(calls.signTypedData).toHaveBeenCalledTimes(1);
    const typed = calls.signTypedData.mock.calls[0]![0] as { domain: unknown; primaryType: string; message: Record<string, unknown> };
    expect(typed.domain).toEqual(USDG_EIP712_DOMAIN);
    expect(typed.primaryType).toBe('ReceiveWithAuthorization');
    expect(typed.message.from).toBe(ALICE);
    expect(typed.message.to).toBe(VPM);
    expect(typed.message.value).toBe(10n * USDG);
    expect(typed.message.validAfter).toBe(0n);
    const window_ = Number(typed.message.validBefore as bigint) - Math.floor(Date.now() / 1000);
    expect(window_).toBeGreaterThan(500);
    expect(window_).toBeLessThanOrEqual(600);

    // Posted to the relay with the fields the keeper checks.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/relay/enter');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ from: ALICE, marketId: '12', outcome: UP, amount: '10000000', validAfter: '0', chainId: CHAIN_ID, hunchVpm: VPM });
    expect(body.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.nonce).toBeUndefined();

    // Waited for the receipt, then refreshed the market.
    expect(calls.waitForReceipt).toHaveBeenCalledWith(TX);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(calls.write).not.toHaveBeenCalled();
    expect(screen.getByTestId('bet-confirmed').textContent).toContain('10.00');

    // Analytics: the funnel, never an address.
    const events = track.mock.calls.map((call) => call[0]);
    expect(events).toEqual(expect.arrayContaining(['switch_chain', 'bet_submitted', 'bet_confirmed']));
    expect(JSON.stringify(track.mock.calls)).not.toMatch(/0x[0-9a-fA-F]{6,}/);
  });

  it('retries a bet that hit a full batch, automatically, with the same signature', async () => {
    const calls = makeCalls();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(relayResponse(503, { ok: false, error: 'busy', reason: 'simulation-failed', message: 'Busy', next: 'retry', retryAfter: 3 }))
      .mockResolvedValueOnce(relayResponse(200, { ok: true, txHash: TX, nonce: '0x01', receipt: 'confirmed' }));
    vi.stubGlobal('fetch', fetchMock);
    const { market, detail } = liveMarket();
    render(
      <FakeWallet calls={calls} start="connected">
        <StakePanel market={market} deployment={DEPLOYED} region="open" nowSec={detail.head.timestamp} retryWaitMs={1} />
      </FakeWallet>,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(primary().disabled).toBe(false));
    fireEvent.click(primary());
    await waitFor(() => expect(screen.getByTestId('bet-confirmed')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body).toBe((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body);
    expect(calls.signTypedData).toHaveBeenCalledTimes(1);
  });

  it('offers "Pay gas yourself" when the relayer is down', async () => {
    const calls = makeCalls();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        relayResponse(503, { ok: false, error: 'relay_unavailable', reason: 'relayer-unavailable', message: 'Gasless bets are unavailable right now. Use "Pay gas yourself".', next: 'pay-gas' }),
      ),
    );
    const { market, detail } = liveMarket();
    render(
      <FakeWallet calls={calls} start="connected">
        <StakePanel market={market} deployment={DEPLOYED} region="open" nowSec={detail.head.timestamp} retryWaitMs={1} />
      </FakeWallet>,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(primary().disabled).toBe(false));
    fireEvent.click(primary());
    const alert = await screen.findByTestId('bet-error');
    expect(alert.textContent).toContain('Gasless bets are unavailable right now');
    fireEvent.click(within(alert).getByRole('button', { name: 'Pay gas yourself instead' }));
    await waitFor(() => expect(primary().textContent).toBe('Place bet, paying gas'));
  });

  it('says plainly when the person declines in their wallet', async () => {
    const calls = makeCalls();
    calls.signTypedData.mockRejectedValueOnce(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { market, detail } = liveMarket();
    render(
      <FakeWallet calls={calls} start="connected">
        <StakePanel market={market} deployment={DEPLOYED} region="open" nowSec={detail.head.timestamp} />
      </FakeWallet>,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(primary().disabled).toBe(false));
    fireEvent.click(primary());
    expect((await screen.findByTestId('bet-error')).textContent).toContain('You declined in your wallet. Nothing was sent');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(primary().textContent).toBe('Place bet');
  });
});

describe('<StakePanel> pay-gas path: connect → switch → approve → enter → confirmed', () => {
  it('approves exactly the amount, enters, waits for both receipts', async () => {
    const calls = makeCalls();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const onConfirmed = vi.fn();
    const { market, detail } = liveMarket();
    render(
      <FakeWallet calls={calls}>
        <StakePanel market={market} deployment={DEPLOYED} region="open" nowSec={detail.head.timestamp} onConfirmed={onConfirmed} />
      </FakeWallet>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pay gas yourself instead' }));
    fireEvent.click(screen.getByRole('button', { name: 'DOWN' }));
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '25.5' } });
    await connectSwitchAndConfirmEligibility();
    expect(primary().textContent).toBe('Place bet, paying gas');

    fireEvent.click(primary());
    await waitFor(() => expect(screen.getByTestId('bet-confirmed')).toBeTruthy());

    expect(calls.usdgAllowance).toHaveBeenCalledWith(ALICE, VPM);
    expect(calls.write).toHaveBeenCalledTimes(2);
    const [approve, enter] = calls.write.mock.calls.map((call) => call[0] as { functionName: string; args: readonly unknown[]; address: string });
    expect(approve).toMatchObject({ functionName: 'approve', args: [VPM, 25_500_000n] });
    expect(enter).toMatchObject({ functionName: 'enter', address: VPM, args: [12n, DOWN, 25_500_000n] });
    expect(calls.waitForReceipt.mock.calls.map((call) => call[0])).toEqual([APPROVE_TX, TX]);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('bet-confirmed').textContent).toContain('25.50');
  });

  it('skips the approval when the allowance already covers the bet', async () => {
    const calls = makeCalls();
    calls.usdgAllowance.mockResolvedValue(1_000n * USDG);
    vi.stubGlobal('fetch', vi.fn());
    const { market, detail } = liveMarket();
    render(
      <FakeWallet calls={calls} start="connected">
        <StakePanel market={market} deployment={DEPLOYED} region="open" nowSec={detail.head.timestamp} />
      </FakeWallet>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pay gas yourself instead' }));
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(primary().disabled).toBe(false));
    fireEvent.click(primary());
    await waitFor(() => expect(screen.getByTestId('bet-confirmed')).toBeTruthy());
    expect(calls.write).toHaveBeenCalledTimes(1);
    expect((calls.write.mock.calls[0]![0] as { functionName: string }).functionName).toBe('enter');
  });
});

describe('<StakePanel> quote block', () => {
  const cases: { name: string; options: Parameters<typeof marketFixture>[0]; amount: bigint; outcome: 0 | 1 }[] = [
    { name: 'a plain open market, UP', options: {}, amount: 10n * USDG, outcome: UP },
    { name: 'a plain open market, DOWN', options: {}, amount: 99_990_000n, outcome: DOWN },
    { name: 'a tight book (kappa 2): part comes back', options: { kappa: 2n, entries: [] }, amount: 25n * USDG, outcome: UP },
    { name: 'joining an open batch in the same Ethereum block', options: { leaveLastPending: true }, amount: 40n * USDG, outcome: DOWN },
  ];
  for (const c of cases) {
    it(`matches the client's quoteForMarket exactly: ${c.name}`, () => {
      const { market, detail } = liveMarket(c.options);
      expect(quoteFor(market, c.amount, c.outcome)).toEqual(quoteForMarket(detail, c.amount, c.outcome));
    });
  }

  it('shows accepted, what comes back, the floor if it wins and the fee, in plain words', async () => {
    const { market, detail } = liveMarket({ kappa: 2n, entries: [] });
    const expected = quoteForMarket(detail, 25n * USDG, UP);
    expect(expected.accepted).toBe(10n * USDG);
    expect(expected.refused).toBe(15n * USDG);
    render(
      <FakeWallet calls={makeCalls()}>
        <StakePanel market={market} deployment={DEPLOYED} region="open" nowSec={detail.head.timestamp} />
      </FakeWallet>,
    );
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '25' } });
    expect(screen.getByTestId('quote-accepted').textContent).toBe('10.00 USDG');
    expect(screen.getByTestId('quote-refused').textContent).toContain('15.00');
    expect(screen.getByTestId('quote-refused').textContent).toContain('comes straight back');
    expect(screen.getByTestId('quote-floor').textContent).toMatch(/If UP wins, you’re paid at least 10\.00 USDG, and this only goes up as people bet DOWN\./);
    const quote = screen.getByTestId('quote').textContent ?? '';
    expect(quote).toContain('Fee: 2% of winnings only');
    expect(quote).toContain('No ETH needed');
    // The late-bettor rule is said before the bet.
    expect(screen.getByTestId('stake-panel').textContent).toContain(
      'Bet late and you get your stake back plus whatever the other side adds after you. Bet early and you collect more.',
    );
  });

  it('refuses amounts outside the market’s limits, in words', () => {
    const { market, detail } = liveMarket();
    render(
      <FakeWallet calls={makeCalls()}>
        <StakePanel market={market} deployment={DEPLOYED} region="open" nowSec={detail.head.timestamp} />
      </FakeWallet>,
    );
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '100.01' } });
    expect(screen.getByTestId('quote').textContent).toContain('The largest bet is 100.00 USDG.');
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0.5' } });
    expect(screen.getByTestId('quote').textContent).toContain('The smallest bet is 1.00 USDG.');
  });
});

describe('<StakePanel> disabled with the reason', () => {
  it('geo gate: "Not available in your country", and nothing can be sent', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const calls = makeCalls();
    const { market, detail } = liveMarket();
    render(
      <FakeWallet calls={calls} start="connected">
        <StakePanel market={market} deployment={DEPLOYED} region="restricted" nowSec={detail.head.timestamp} />
      </FakeWallet>,
    );
    expect(primary().textContent).toBe('Not available in your country');
    expect(primary().disabled).toBe(true);
    expect(screen.getByTestId('primary-reason').textContent).toContain('United States, Canada, the United Kingdom or Switzerland');
    await act(async () => {
      fireEvent.click(primary());
    });
    expect(calls.signTypedData).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('before deployment, when paused, and after the bell', () => {
    const { market, detail } = liveMarket();
    const { rerender } = render(
      <FakeWallet calls={makeCalls()} start="connected">
        <StakePanel market={market} deployment={NOT_DEPLOYED} region="open" nowSec={detail.head.timestamp} />
      </FakeWallet>,
    );
    expect(primary().textContent).toBe('Opens with the venue launch');

    const paused = liveMarket({ entriesPaused: true });
    rerender(
      <FakeWallet calls={makeCalls()} start="connected">
        <StakePanel market={paused.market} deployment={DEPLOYED} region="open" nowSec={paused.detail.head.timestamp} />
      </FakeWallet>,
    );
    expect(primary().textContent).toBe('New bets are paused');

    rerender(
      <FakeWallet calls={makeCalls()} start="connected">
        <StakePanel market={market} deployment={DEPLOYED} region="open" nowSec={detail.finalTime + 1} />
      </FakeWallet>,
    );
    expect(primary().textContent).toBe('Bets closed at the bell');
    expect(primary().disabled).toBe(true);
  });
});
