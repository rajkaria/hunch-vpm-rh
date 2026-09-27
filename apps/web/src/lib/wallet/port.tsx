'use client';

/**
 * What the trading islands need from a wallet, as one interface. The default comes from the
 * lazily loaded wagmi module (`bridge.ts` + `core.ts`); tests supply their own through
 * `WalletPortContext`, so the bet panel's state machine is tested without a browser wallet.
 */

import type { EnterAuthorization } from '@hunch-rh/client';
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Address, Hex } from 'viem';

import { connectModal, loadWallet, rememberedWallet, walletBridge, type WalletSnapshot } from './bridge';
import type { WriteCall } from './core';

export type { WriteCall } from './core';

export interface WalletPort extends WalletSnapshot {
  /** Open the wallet list. The state changes to `connected` when the person picks one. */
  openConnect(): void;
  /** Add Robinhood Chain to the wallet, then switch to it. */
  switchToRobinhood(): Promise<void>;
  signTypedData(typedData: EnterAuthorization): Promise<Hex>;
  /** Simulate, then send from the connected account on chain 4663. */
  write(call: WriteCall): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<'success' | 'reverted'>;
  usdgBalance(owner: Address): Promise<bigint>;
  usdgAllowance(owner: Address, spender: Address): Promise<bigint>;
  disconnect(): Promise<void>;
}

export const WalletPortContext = createContext<WalletPort | null>(null);

export function useWalletSnapshot(): WalletSnapshot {
  return useSyncExternalStore(walletBridge.subscribe, walletBridge.get, walletBridge.getServer);
}

function useDefaultPort(enabled: boolean, autoload: boolean): WalletPort {
  const snapshot = useWalletSnapshot();
  useEffect(() => {
    if (enabled && (autoload || rememberedWallet())) void loadWallet().catch(() => undefined);
  }, [enabled, autoload]);
  return useMemo(
    () => ({
      ...snapshot,
      openConnect: () => connectModal.open(),
      switchToRobinhood: async () => (await loadWallet()).switchToRobinhood(),
      signTypedData: async (typedData) => (await loadWallet()).signTypedData(typedData),
      write: async (call) => (await loadWallet()).write(call),
      waitForReceipt: async (hash) => (await loadWallet()).waitForReceipt(hash),
      usdgBalance: async (owner) => (await loadWallet()).usdgBalance(owner),
      usdgAllowance: async (owner, spender) => (await loadWallet()).usdgAllowance(owner, spender),
      disconnect: async () => (await loadWallet()).disconnect(),
    }),
    [snapshot],
  );
}

/**
 * The wallet for an island. `autoload` loads the wallet code on mount (trading pages); without
 * it the code loads on the first action, or at once if this browser was connected before.
 */
export function useWalletPort(options: { autoload?: boolean } = {}): WalletPort {
  const injected = useContext(WalletPortContext);
  const fallback = useDefaultPort(injected === null, options.autoload === true);
  return injected ?? fallback;
}
