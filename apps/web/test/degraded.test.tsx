import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

/*
 * The four states this surface has to survive: no wallet, wrong chain, no
 * funds, nothing deployed. Each one is a state a real visitor arrives in, and
 * each has to explain itself rather than presenting a dead control.
 */

const wallet = vi.hoisted(() => ({
  current: {
    address: null as string | null,
    ready: false,
    wrongChain: false,
    connecting: false,
    switching: false,
    connectors: [] as unknown[],
    noWallet: true,
    disconnect: () => {},
    switchToActive: () => {},
    ensureActiveChain: async () => true,
    error: null,
    chainName: 'Arc Testnet',
    chainId: 5042002,
    walletChainId: null as number | null,
    canSwitch: true,
  },
}));

vi.mock('@/lib/wallet/useWallet', async (importOriginal) => ({
  // The pure rules (`switchPromptKey`, `truncateAddress`) stay real; only the hook is stubbed.
  ...(await importOriginal<typeof import('@/lib/wallet/useWallet')>()),
  useWallet: () => wallet.current,
}));

import { NetworkBanner } from '@/components/wallet/NetworkBanner';
import { PositionGate } from '@/components/market/PositionGate';
import { buildFixtures } from '@/lib/data/fixtures';
import { NetworkProvider } from '@/lib/wallet/network';

const market = buildFixtures(1_789_000_000n).markets[0]!;

function set(over: Partial<typeof wallet.current>) {
  wallet.current = { ...wallet.current, ...over };
}

describe('NetworkBanner', () => {
  it('says nothing while disconnected — that prompt belongs where the action is', () => {
    set({ address: null, wrongChain: false });
    const { container } = render(<NetworkBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('says nothing when the wallet is already on the right chain', () => {
    set({ address: '0xaaaa000000000000000000000000000000001111', wrongChain: false, ready: true });
    const { container } = render(<NetworkBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('is loud when the wallet is elsewhere, because Arc is in nobody’s wallet by default', () => {
    set({ address: '0xaaaa000000000000000000000000000000001111', wrongChain: true, ready: false });
    render(<NetworkBanner />);
    expect(screen.getByText('Wrong network')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Switch to Arc Testnet/ })).toBeTruthy();
  });
});

describe('PositionGate', () => {
  it('refuses to show anyone a position before it knows who they are', () => {
    // It used to render the fixture wallet's position to every visitor and
    // label it "Your position". That is the one thing it must never do.
    set({ address: null, wrongChain: false });
    render(
      <NetworkProvider>
        <PositionGate market={market} />
      </NetworkProvider>,
    );
    expect(screen.getByText('Connect a wallet to see your position.')).toBeTruthy();
  });

  it('says whose position it is showing when connected on fixtures', () => {
    set({ address: '0xaaaa000000000000000000000000000000001111', wrongChain: false, ready: true });
    render(
      <NetworkProvider>
        <PositionGate market={market} />
      </NetworkProvider>,
    );
    expect(screen.getByText(/belongs to the sample wallet, not to you/)).toBeTruthy();
  });
});
