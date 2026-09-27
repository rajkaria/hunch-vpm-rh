import { describe, expect, it } from 'vitest';

import { truncateAddress, usableConnectors } from '../src/lib/wallet/useWallet';

describe('truncateAddress', () => {
  it('writes an address the way the rest of the product does', () => {
    expect(truncateAddress('0x6D2a4c1b9E0f3A8d5C7b2E1f4A9c8B3d6E5f0a42')).toBe('0x6D2a…0a42');
  });

  it('keeps enough of both ends to tell two accounts apart', () => {
    const a = truncateAddress('0xabcdef0000000000000000000000000000001111');
    const b = truncateAddress('0xabcdef0000000000000000000000000000002222');
    expect(a).not.toBe(b);
  });
});

describe('usableConnectors', () => {
  const injected = { id: 'injected', name: 'MetaMask' };
  const wc = { id: 'walletConnect', name: 'WalletConnect' };

  it('drops the injected connector when the browser has no provider', () => {
    // This is the whole point: wagmi registers `injected` unconditionally, and
    // offering it without a provider gives the visitor a dead button.
    expect(usableConnectors([injected], false)).toEqual([]);
  });

  it('keeps it once a provider has announced itself', () => {
    expect(usableConnectors([injected], true).map((c) => c.id)).toEqual(['injected']);
  });

  it('never drops WalletConnect, which needs no injected provider', () => {
    expect(usableConnectors([injected, wc], false).map((c) => c.id)).toEqual(['walletConnect']);
  });

  it('labels an injected wallet generically, so the menu reads the same everywhere', () => {
    expect(usableConnectors([injected], true)[0]?.label).toBe('Browser wallet');
    expect(usableConnectors([wc], true)[0]?.label).toBe('WalletConnect');
  });

  it('carries the original connector through for the caller to connect with', () => {
    expect(usableConnectors([wc], true)[0]?.source).toBe(wc);
  });
});
