import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The reload bug, pinned.
 *
 * A stake sent from the market page showed up under "Your entry" — held in
 * component state from the transaction receipt — and vanished on refresh. The
 * live source renders every market with `positions: []` because the server
 * renders for nobody in particular, and nothing in the browser read the
 * connected wallet's positions back from the index. The position was on chain
 * and indexed the whole time.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wallet = vi.hoisted(() => ({
  current: {
    address: '0x4f18000000000000000000000000000000c0cfe8' as string | null,
    ready: true,
    wrongChain: false,
    connecting: false,
    switching: false,
    connectors: [] as unknown[],
    noWallet: false,
    disconnect: () => {},
    switchToActive: () => {},
    ensureActiveChain: async () => true,
    error: null,
    chainName: 'Arc Testnet',
    chainId: 5042002,
    walletChainId: 5042002 as number | null,
    canSwitch: true,
  },
}));

const router = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock('@/lib/wallet/useWallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/wallet/useWallet')>()),
  useWallet: () => wallet.current,
}));
// The network the page is on reads a live index, as Arc testnet does in production.
vi.mock('@/lib/data/kind', () => ({ dataSourceKinds: { testnet: 'live', mainnet: 'live' } }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('wagmi', () => ({
  useWriteContract: () => ({ writeContract: vi.fn(), isPending: false, error: null, data: undefined }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isLoading: false }),
}));

import { GET } from '@/app/api/positions/route';
import { PositionGate } from '@/components/market/PositionGate';
import { buildFixtures } from '@/lib/data/fixtures';
import {
  awaitingVintage,
  decodePosition,
  encodePositionEntry,
  type ApiPositionEntry,
  type ApiPositions,
} from '@/lib/data/position-wire';
import type { MarketDetail } from '@/lib/data/types';
import { NetworkProvider } from '@/lib/wallet/network';
import { POSITIONS_POLL_MS, nextPositionsPoll } from '@/lib/wallet/positions';

const fixtures = buildFixtures(1_789_000_000n);
// What the live source renders: the market, and no positions, for anyone.
const market: MarketDetail = { ...fixtures.markets.find((entry) => entry.id === 'eth-3000-sep30')!, positions: [] };

function entry(over: Partial<ApiPositionEntry['position']> = {}, marketId = market.id): ApiPositionEntry {
  return {
    market: {
      id: marketId,
      question: market.question,
      subject: market.subject,
      status: 'Open',
      frozen: false,
      settlerKind: 'vested',
      winner: null,
      resolutionTime: market.resolutionTime.toString(),
      outcomes: market.outcomes.map(({ outcome, label, tone }) => ({ outcome, label, tone })),
    },
    position: {
      id: `${marketId}-4`,
      positionId: '4',
      owner: wallet.current.address!,
      outcome: 1,
      offered: '15000000',
      accepted: '15000000',
      refused: '0',
      entryAcc: '0',
      vintage: '61899400',
      finalized: true,
      refundWithdrawn: false,
      claimed: false,
      enteredAt: '1789302897',
      ...over,
    },
  };
}

function serve(entries: ApiPositionEntry[], status = 200) {
  const body: ApiPositions = { source: 'live', network: 'testnet', entries };
  const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NetworkProvider initialNetwork="testnet">
        <PositionGate market={market} />
      </NetworkProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  router.refresh.mockReset();
});

describe('PositionGate on a live network', () => {
  it('shows a position read back from the index, though the server rendered none', async () => {
    const fetchMock = serve([entry()]);
    const { container } = mount();

    await waitFor(() => expect(container.textContent).toContain('#4'));
    expect(container.textContent).toContain('15.00');
    expect(container.textContent).not.toContain('You hold nothing in this market.');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`address=${wallet.current.address}`);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('network=testnet');
  });

  it('says a buffered entry is pending rather than showing it accepted nothing', async () => {
    serve([entry({ accepted: '0', finalized: false })]);
    const { container } = mount();

    await screen.findByText('Vintage open');
    expect(screen.getAllByText('pending')).toHaveLength(2);
    expect(container.textContent).toContain('In, awaiting the books');
    expect(container.textContent).not.toContain('If this outcome wins');
    // Across a reload the button that closes the vintage has to come back too.
    expect(screen.getByRole('button', { name: 'Close the vintage' })).toBeTruthy();
  });

  it('does not claim another market’s position for this one', async () => {
    serve([entry({}, '0xc743940c75619f65f6178b7e49c0c3a0be012eec-1')]);
    mount();
    expect(await screen.findByText('You hold nothing in this market.')).toBeTruthy();
  });

  it('says the read failed, not that the stake is gone, when the index does not answer', async () => {
    serve([], 502);
    mount();
    expect(await screen.findByText('Your position could not be read.')).toBeTruthy();
    expect(screen.queryByText('You hold nothing in this market.')).toBeNull();
  });
});

describe('nextPositionsPoll', () => {
  const data = (entries: ApiPositionEntry[]): ApiPositions => ({ source: 'live', network: 'testnet', entries });
  const now = 1_000_000;

  it('keeps reading while an entry waits for its vintage, so pending turns into a number', () => {
    expect(nextPositionsPoll(data([entry({ finalized: false })]), undefined, now)).toBe(POSITIONS_POLL_MS);
  });

  it('keeps reading until the index has an entry this browser just sent', () => {
    const expectation = { marketId: market.id, positionId: '5', until: now + 60_000 };
    expect(nextPositionsPoll(data([entry()]), expectation, now)).toBe(POSITIONS_POLL_MS);
    expect(nextPositionsPoll(data([entry(), entry({ positionId: '5' })]), expectation, now)).toBe(false);
  });

  it('gives up waiting eventually rather than polling forever', () => {
    const expectation = { marketId: market.id, positionId: '5', until: now - 1 };
    expect(nextPositionsPoll(data([entry()]), expectation, now)).toBe(false);
  });

  it('leaves a settled read alone', () => {
    expect(nextPositionsPoll(data([entry()]), undefined, now)).toBe(false);
    expect(nextPositionsPoll(undefined, undefined, now)).toBe(false);
  });
});

describe('the positions wire format', () => {
  it('round-trips every field the position panel reads', () => {
    const original = fixtures.markets.flatMap((m) => m.positions.map((position) => ({ market: m, position })))[0]!;
    expect(decodePosition(encodePositionEntry(original).position)).toEqual(original.position);
  });

  it('keeps a classic position’s missing vintage missing, never the seed vintage', () => {
    const classic = { ...fixtures.markets[0]!.positions[0]!, vintage: null };
    const wire = encodePositionEntry({ market: fixtures.markets[0]!, position: classic });
    expect(wire.position.vintage).toBeNull();
    expect(decodePosition(wire.position).vintage).toBeNull();
    expect(awaitingVintage({ vintage: null, finalized: false })).toBe(false);
  });

  it('is what /api/positions sends', async () => {
    const response = await GET(new Request(`http://x/api/positions?network=testnet&address=${fixtures.wallet}`));
    const body = (await response.json()) as ApiPositions;
    expect(response.status).toBe(200);
    // Tests run with no subgraph configured, so testnet serves the sample wallet's positions.
    const sent = body.entries[0]?.position;
    expect(sent).toBeDefined();
    expect(typeof sent!.finalized).toBe('boolean');
    expect(typeof sent!.entryAcc).toBe('string');
    expect(typeof sent!.claimed).toBe('boolean');
    expect(typeof sent!.refundWithdrawn).toBe('boolean');
  });
});
