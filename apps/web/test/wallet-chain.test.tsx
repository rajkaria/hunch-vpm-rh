import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);

/*
 * The wrong-chain bug, pinned.
 *
 * A wallet on a chain this app does not configure (Robinhood Chain, in the
 * report) was treated as being on Arc: `useChainId()` reads wagmi's config
 * state, which wagmi refuses to move onto an unconfigured chain, so it kept
 * saying 5042002. No prompt appeared and "Approve USDC" sent the approval to
 * 0x3600…0000 on the other chain. The mock below models wagmi exactly that way:
 * `useChainId` stuck on Arc, `useAccount().chainId` telling the truth.
 */

// Any chain id this app does not configure — the report was from Robinhood Chain.
const OTHER_CHAIN = 46630;
const ARC_TESTNET_ID = 5042002;

const wagmi = vi.hoisted(() => ({
  isConnected: true,
  accountChainId: 46630 as number | undefined,
  switchChain: vi.fn(),
  switchChainAsync: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: wagmi.isConnected ? '0xaaaa000000000000000000000000000000001111' : undefined,
    isConnected: wagmi.isConnected,
    chainId: wagmi.isConnected ? wagmi.accountChainId : undefined,
  }),
  // What wagmi really does: never follows the wallet onto an unconfigured chain.
  useChainId: () => 5042002,
  useConnect: () => ({ connect: () => {}, connectors: [], isPending: false, error: null }),
  useDisconnect: () => ({ disconnect: () => {} }),
  useSwitchChain: () => ({
    switchChain: wagmi.switchChain,
    switchChainAsync: wagmi.switchChainAsync,
    isPending: false,
    error: null,
  }),
}));

import { NetworkBanner } from '@/components/wallet/NetworkBanner';
import { NetworkProvider } from '@/lib/wallet/network';
import { chainStatus, switchPromptKey, useWallet } from '@/lib/wallet/useWallet';

const withNetwork = ({ children }: { children: React.ReactNode }) => (
  <NetworkProvider>{children}</NetworkProvider>
);

beforeEach(() => {
  window.localStorage.clear();
  document.cookie = 'hunch-vpm.network=; path=/; max-age=0';
  wagmi.isConnected = true;
  wagmi.accountChainId = OTHER_CHAIN;
  wagmi.switchChain.mockReset();
  wagmi.switchChainAsync.mockReset();
});

describe('chainStatus', () => {
  it('calls an unconfigured chain wrong — the case that shipped broken', () => {
    expect(chainStatus(true, OTHER_CHAIN, ARC_TESTNET_ID)).toEqual({ ready: false, wrongChain: true });
  });

  it('is ready only on the selected chain', () => {
    expect(chainStatus(true, ARC_TESTNET_ID, ARC_TESTNET_ID)).toEqual({ ready: true, wrongChain: false });
    expect(chainStatus(true, 5042, ARC_TESTNET_ID)).toEqual({ ready: false, wrongChain: true });
  });

  it('does not unlock sending for a connection that has not reported a chain', () => {
    expect(chainStatus(true, undefined, ARC_TESTNET_ID).ready).toBe(false);
  });

  it('is neither while disconnected', () => {
    expect(chainStatus(false, OTHER_CHAIN, ARC_TESTNET_ID)).toEqual({ ready: false, wrongChain: false });
  });
});

describe('useWallet', () => {
  it('reads the wallet’s real chain, not wagmi’s last configured one', () => {
    const { result } = renderHook(() => useWallet(), { wrapper: withNetwork });
    expect(result.current.wrongChain).toBe(true);
    expect(result.current.ready).toBe(false);
    expect(result.current.walletChainId).toBe(OTHER_CHAIN);
  });

  it('is ready once the wallet is actually on Arc', () => {
    wagmi.accountChainId = ARC_TESTNET_ID;
    const { result } = renderHook(() => useWallet(), { wrapper: withNetwork });
    expect(result.current.ready).toBe(true);
    expect(result.current.wrongChain).toBe(false);
  });

  it('switches before a send, and says go when the wallet lands on Arc', async () => {
    wagmi.switchChainAsync.mockResolvedValue({ id: ARC_TESTNET_ID });
    const { result } = renderHook(() => useWallet(), { wrapper: withNetwork });
    await expect(result.current.ensureActiveChain()).resolves.toBe(true);
    expect(wagmi.switchChainAsync).toHaveBeenCalledWith({ chainId: ARC_TESTNET_ID });
  });

  it('says stop when the switch is refused, so nothing is sent on the wrong chain', async () => {
    wagmi.switchChainAsync.mockRejectedValue(new Error('User rejected the request.'));
    const { result } = renderHook(() => useWallet(), { wrapper: withNetwork });
    await expect(result.current.ensureActiveChain()).resolves.toBe(false);
  });

  it('does not prompt at all when already on Arc', async () => {
    wagmi.accountChainId = ARC_TESTNET_ID;
    const { result } = renderHook(() => useWallet(), { wrapper: withNetwork });
    await expect(result.current.ensureActiveChain()).resolves.toBe(true);
    expect(wagmi.switchChainAsync).not.toHaveBeenCalled();
  });

  it('can ask a wallet to add testnet, and cannot for mainnet before it has an RPC', () => {
    const testnet = renderHook(() => useWallet(), { wrapper: withNetwork });
    expect(testnet.result.current.canSwitch).toBe(true);
    cleanup();
    window.localStorage.setItem('hunch-vpm.network', 'mainnet');
    const mainnet = renderHook(() => useWallet(), { wrapper: withNetwork });
    expect(mainnet.result.current.chainId).toBe(5042);
    expect(mainnet.result.current.canSwitch).toBe(false);
  });
});

describe('switchPromptKey', () => {
  const base = {
    wrongChain: true,
    canSwitch: true,
    address: '0xAAAA000000000000000000000000000000001111',
    walletChainId: OTHER_CHAIN,
    chainId: ARC_TESTNET_ID,
  };

  it('keys on account, wallet chain and selected chain', () => {
    expect(switchPromptKey(base)).toBe(`0xaaaa000000000000000000000000000000001111:${OTHER_CHAIN}:${ARC_TESTNET_ID}`);
    expect(switchPromptKey({ ...base, walletChainId: 1 })).not.toBe(switchPromptKey(base));
  });

  it('never prompts on the right chain, while disconnected, or where the chain cannot be added', () => {
    expect(switchPromptKey({ ...base, wrongChain: false })).toBeNull();
    expect(switchPromptKey({ ...base, address: null })).toBeNull();
    expect(switchPromptKey({ ...base, canSwitch: false })).toBeNull();
  });
});

describe('NetworkBanner, on a wallet connected elsewhere', () => {
  it('opens the wallet’s switch prompt without being asked', () => {
    render(<NetworkBanner />, { wrapper: withNetwork });
    expect(wagmi.switchChain).toHaveBeenCalledTimes(1);
    expect(wagmi.switchChain).toHaveBeenCalledWith({ chainId: ARC_TESTNET_ID });
    expect(screen.getByText('Wrong network')).toBeTruthy();
  });

  it('asks once — a dismissed prompt does not reopen on every render', () => {
    const view = render(<NetworkBanner />, { wrapper: withNetwork });
    view.rerender(<NetworkBanner />);
    view.rerender(<NetworkBanner />);
    expect(wagmi.switchChain).toHaveBeenCalledTimes(1);
  });

  it('asks again when the wallet moves to yet another wrong chain', () => {
    const view = render(<NetworkBanner />, { wrapper: withNetwork });
    wagmi.accountChainId = 1;
    view.rerender(<NetworkBanner />);
    expect(wagmi.switchChain).toHaveBeenCalledTimes(2);
  });

  it('keeps the manual switch button for anyone who dismissed the prompt', () => {
    render(<NetworkBanner />, { wrapper: withNetwork });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Switch to Arc Testnet/ }));
    });
    expect(wagmi.switchChain).toHaveBeenCalledTimes(2);
  });

  it('says nothing and prompts nothing once the wallet is on Arc', () => {
    wagmi.accountChainId = ARC_TESTNET_ID;
    const { container } = render(<NetworkBanner />, { wrapper: withNetwork });
    expect(container.textContent).toBe('');
    expect(wagmi.switchChain).not.toHaveBeenCalled();
  });
});
