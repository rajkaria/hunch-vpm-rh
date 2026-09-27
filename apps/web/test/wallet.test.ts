import { CHAIN_ID } from '@hunch-rh/client';
import { describe, expect, it, vi } from 'vitest';

const track = vi.fn();
vi.mock('@vercel/analytics', () => ({ track: (...args: unknown[]) => track(...args) }));

import { cleanProps, trackEvent } from '@/lib/wallet/analytics';
import { buildConnectors } from '@/lib/wallet/connectors';
import { E2E_ENABLED, e2eAccounts } from '@/lib/wallet/env';
import { describeWalletError, isUnknownChain, isUserRejection } from '@/lib/wallet/errors';
import { readEligible, writeEligible } from '@/lib/wallet/eligibility';
import { addThenSwitch, CHAIN_ID_HEX, type Eip1193 } from '@/lib/wallet/switch';

/** Instantiate each connector factory against a minimal config and read its type. */
const FAKE_CONFIG = { chains: [{ id: CHAIN_ID, rpcUrls: { default: { http: ['http://127.0.0.1:1'] } } }], emitter: { emit() {}, on() {}, off() {} }, storage: null, transports: {} };
const types = (connectors: ReturnType<typeof buildConnectors>): string[] =>
  connectors.map((factory) => (factory as unknown as (config: unknown) => { type: string })(FAKE_CONFIG).type);

describe('the E2E mock wallet', () => {
  it('is off by default: a build without NEXT_PUBLIC_E2E=1 has no mock connector', () => {
    expect(process.env.NEXT_PUBLIC_E2E).not.toBe('1');
    expect(E2E_ENABLED).toBe(false);
    expect(types(buildConnectors())).not.toContain('mock');
  });

  it('is first in the list only when asked for', () => {
    expect(types(buildConnectors({ e2e: true }))[0]).toBe('mock');
  });

  it('uses anvil’s unlocked default accounts unless given others', () => {
    expect(e2eAccounts(undefined)[0]).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(e2eAccounts('0x70997970C51812dc3A010C7d01b50e0d17dc79C8, not-an-address')).toEqual(['0x70997970C51812dc3A010C7d01b50e0d17dc79C8']);
  });
});

describe('connectors', () => {
  it('offers browser wallets and Coinbase Wallet, and WalletConnect only with a project id', () => {
    expect(types(buildConnectors({ walletConnectProjectId: '' }))).toEqual(['injected', 'coinbaseWallet']);
    expect(types(buildConnectors({ walletConnectProjectId: 'abc123' }))).toEqual(['injected', 'walletConnect', 'coinbaseWallet']);
  });
});

function provider(handlers: Record<string, (params: unknown) => unknown>): Eip1193 & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request({ method, params }) {
      calls.push(method);
      const handler = handlers[method];
      if (handler === undefined) throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
      return handler(params);
    },
  };
}

describe('add, then switch', () => {
  it('adds Robinhood Chain first, then switches to it', async () => {
    const p = provider({ wallet_addEthereumChain: () => null, wallet_switchEthereumChain: () => null });
    await addThenSwitch(p);
    expect(p.calls).toEqual(['wallet_addEthereumChain', 'wallet_switchEthereumChain']);
    expect(CHAIN_ID_HEX).toBe(`0x${CHAIN_ID.toString(16)}`);
  });

  it('still switches when the wallet refuses to re-add a chain it knows', async () => {
    const p = provider({
      wallet_addEthereumChain: () => {
        throw Object.assign(new Error('already added'), { code: -32603 });
      },
      wallet_switchEthereumChain: () => null,
    });
    await addThenSwitch(p);
    expect(p.calls).toEqual(['wallet_addEthereumChain', 'wallet_switchEthereumChain']);
  });

  it('adds again after a 4902 (unknown chain), then switches', async () => {
    let known = false;
    const p = provider({
      wallet_addEthereumChain: () => {
        if (p.calls.length === 1) throw Object.assign(new Error('flaky'), { code: -32000 });
        known = true;
        return null;
      },
      wallet_switchEthereumChain: () => {
        if (!known) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 });
        return null;
      },
    });
    await addThenSwitch(p);
    expect(p.calls).toEqual(['wallet_addEthereumChain', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain']);
  });

  it('stops when the person declines', async () => {
    const p = provider({
      wallet_addEthereumChain: () => {
        throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      },
      wallet_switchEthereumChain: () => null,
    });
    await expect(addThenSwitch(p)).rejects.toMatchObject({ code: 4001 });
    expect(p.calls).toEqual(['wallet_addEthereumChain']);
  });
});

describe('wallet errors in plain words', () => {
  it('names the problem and the next step', () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection(new Error('User denied transaction signature.'))).toBe(true);
    expect(isUnknownChain({ code: 4902 })).toBe(true);
    expect(isUnknownChain({ cause: { code: 4902 } })).toBe(true);
    expect(describeWalletError({ code: 4001 }).kind).toBe('rejected');
    expect(describeWalletError(new Error('reverted: VintageFull')).kind).toBe('busy');
    expect(describeWalletError({ shortMessage: 'execution reverted', data: { errorName: 'EntriesArePaused' } }).kind).toBe('paused');
    expect(describeWalletError(new Error('The contract function "enter" reverted. Error: Frozen()')).kind).toBe('closed');
    expect(describeWalletError(new Error('ERC20: transfer amount exceeds balance')).kind).toBe('insufficient-usdg');
    expect(describeWalletError(new Error('insufficient funds for gas * price + value')).kind).toBe('insufficient-gas');
    const unknown = describeWalletError(new Error('something odd\nwith a long stack'));
    expect(unknown.kind).toBe('unknown');
    expect(unknown.message).not.toContain('\n');
  });
});

describe('analytics', () => {
  it('drops anything that looks like an address, a hash or an account', () => {
    expect(cleanProps({ side: 'UP', path: 'gasless', owner: 'x', note: '0x1111111111111111111111111111111111111111', ticker: 'NVDA' })).toEqual({
      side: 'UP',
      path: 'gasless',
      ticker: 'NVDA',
    });
    trackEvent('bet_submitted', { side: 'DOWN', address: '0xabc', txHash: '0xdef' });
    expect(track).toHaveBeenCalledWith('bet_submitted', { side: 'DOWN' });
  });
});

describe('eligibility', () => {
  it('is remembered in this browser, and absent storage never throws', () => {
    window.localStorage.clear();
    expect(readEligible()).toBe(false);
    writeEligible(true);
    expect(readEligible()).toBe(true);
    writeEligible(false);
    expect(readEligible()).toBe(false);
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readEligible()).toBe(false);
    spy.mockRestore();
  });
});
