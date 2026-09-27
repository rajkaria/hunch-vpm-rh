import { describe, expect, it } from 'vitest';

import { hasWalletConnect, WALLETCONNECT_PROJECT_ID, walletConfig } from '../src/lib/wallet/config';

describe('wallet config', () => {
  it('ships the parent product’s project id, which is public by design', () => {
    // Reversed deliberately. A WalletConnect project id is not a secret — it is
    // served in playhunch.xyz's own browser bundle, which is where this one came
    // from — so committing it publishes nothing that was private, and shipping
    // one means mobile wallets work out of the box rather than injected-only.
    // It stays overridable per deployment.
    expect(WALLETCONNECT_PROJECT_ID).toMatch(/^[0-9a-f]{32}$/);
    expect(hasWalletConnect).toBe(true);
  });

  it('still offers an injected connector with no project id set', () => {
    const config = walletConfig();
    expect(config.connectors.length).toBeGreaterThan(0);
    expect(config.connectors.some((connector) => connector.id === 'injected')).toBe(true);
  });

  it('is memoised, so every consumer shares one config', () => {
    expect(walletConfig()).toBe(walletConfig());
  });

  it('carries BOTH Arcs, because the viewer chooses at runtime', () => {
    expect(
      walletConfig()
        .chains.map((chain) => chain.id)
        .sort((a, b) => a - b),
    ).toEqual([5042, 5042002]);
  });
});
