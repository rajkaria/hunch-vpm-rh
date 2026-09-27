import { describe, expect, it } from 'vitest';

import { ARC_MAINNET, ARC_TESTNET } from '../src/lib/chain';
import { USDC_DECIMALS } from '../src/lib/units';
import { ACTIVE_CHAIN, arcMainnetChain, arcTestnetChain } from '../src/lib/wallet/chains';

/*
 * These assert the two facts about Arc that a wallet cannot discover on its own
 * and that are catastrophic to get wrong: native USDC is 18 decimals while the
 * ERC-20 view every stake moves through is 6, and the chain has to carry enough
 * detail to be *added* to a wallet that has never heard of it.
 */
describe('Arc as a viem chain', () => {
  it('declares native USDC at 18 decimals — the native view, not the ERC-20 one', () => {
    // Verified on Arc testnet: balanceOf and eth_getBalance for one holder differ
    // by exactly 10^12. This file asserted 6 until that was checked, which would
    // have had every wallet showing gas off by twelve orders of magnitude.
    for (const chain of [arcTestnetChain, arcMainnetChain]) {
      expect(chain.nativeCurrency.symbol).toBe('USDC');
      expect(chain.nativeCurrency.decimals).toBe(18);
    }
  });

  it('keeps stake amounts on the 6-decimal ERC-20 view', () => {
    // Stake moves through approve/transferFrom on 0x3600…0000, never as native
    // value, so the app's unit for amounts stays 6 even though native is 18.
    expect(USDC_DECIMALS).toBe(6);
  });

  it('keeps the chain ids the rest of the app already uses', () => {
    expect(arcTestnetChain.id).toBe(ARC_TESTNET.id);
    expect(arcMainnetChain.id).toBe(ARC_MAINNET.id);
    expect(arcTestnetChain.id).toBe(5042002);
    expect(arcMainnetChain.id).toBe(5042);
  });

  it('carries an RPC url for testnet, because a wallet cannot add a chain without one', () => {
    expect(arcTestnetChain.rpcUrls.default.http[0]).toMatch(/^https:\/\//);
  });

  it('carries no guessed mainnet RPC — it is configuration until Circle publishes one', () => {
    expect(arcMainnetChain.rpcUrls.default.http).toEqual([]);
  });

  it('declares an explorer for testnet and none for mainnet, matching chain.ts', () => {
    expect(arcTestnetChain.blockExplorers?.default.url).toBe(ARC_TESTNET.explorerUrl);
    // Mainnet's explorer is unverified in this repo, so it is absent rather than guessed.
    expect(ARC_MAINNET.explorerUrl).toBe('');
    expect(arcMainnetChain.blockExplorers).toBeUndefined();
  });

  it('defaults to testnet, so a misconfigured build cannot transact on mainnet', () => {
    expect(ACTIVE_CHAIN.id).toBe(arcTestnetChain.id);
    expect(ACTIVE_CHAIN.testnet).toBe(true);
  });
});
