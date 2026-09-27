/**
 * The wallet's state for every island on a page, without loading any wallet code until it is
 * needed. The wallet module (`core.ts`: wagmi, the connectors, their SDKs) is imported on
 * demand: when someone presses Connect, when a trading page mounts, or when this browser was
 * connected before (so the header can show the address again). Static pages ship none of it.
 */

import type { Address } from 'viem';

import type { WalletCore } from './core';

export type WalletStatus = 'idle' | 'disconnected' | 'connecting' | 'reconnecting' | 'connected';

export interface WalletSnapshot {
  /** `idle`: the wallet code has not loaded yet. */
  status: WalletStatus;
  address: Address | null;
  chainId: number | null;
  connectorName: string | null;
}

export const IDLE: WalletSnapshot = { status: 'idle', address: null, chainId: null, connectorName: null };

let snapshot: WalletSnapshot = IDLE;
const listeners = new Set<() => void>();

export const walletBridge = {
  get(): WalletSnapshot {
    return snapshot;
  },
  getServer(): WalletSnapshot {
    return IDLE;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  set(next: WalletSnapshot): void {
    if (
      next.status === snapshot.status &&
      next.address === snapshot.address &&
      next.chainId === snapshot.chainId &&
      next.connectorName === snapshot.connectorName
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) listener();
  },
};

let loading: Promise<WalletCore> | null = null;

/** Load (once) and start the wallet module. */
export function loadWallet(): Promise<WalletCore> {
  loading ??= import('./core').then((module) => module.startWallet());
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

const REMEMBER = 'hunch-rh.wallet.connected';

/** Whether this browser had a wallet connected here before (so it is worth reconnecting at once). */
export function rememberedWallet(): boolean {
  try {
    return window.localStorage.getItem(REMEMBER) === '1';
  } catch {
    return false;
  }
}

export function rememberWallet(connected: boolean): void {
  try {
    if (connected) window.localStorage.setItem(REMEMBER, '1');
    else window.localStorage.removeItem(REMEMBER);
  } catch {
    // Not remembered: the next visit shows Connect until the wallet code loads.
  }
}

// ------------------------------------------------------------------ the connect list

type ModalListener = (open: boolean) => void;
let modalOpen = false;
const modalListeners = new Set<ModalListener>();

export const connectModal = {
  isOpen(): boolean {
    return modalOpen;
  },
  open(): void {
    void loadWallet();
    modalOpen = true;
    for (const listener of modalListeners) listener(true);
  },
  close(): void {
    modalOpen = false;
    for (const listener of modalListeners) listener(false);
  },
  subscribe(listener: ModalListener): () => void {
    modalListeners.add(listener);
    return () => modalListeners.delete(listener);
  },
};
