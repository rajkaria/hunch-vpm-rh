'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';

import { useNetwork } from './network';

export interface WalletState {
  /** The connected address, or null. */
  address: `0x${string}` | null;
  /** Connected AND on the chain this deployment transacts on. */
  ready: boolean;
  /** Connected but on some other chain. The one state that needs a prompt. */
  wrongChain: boolean;
  connecting: boolean;
  switching: boolean;
  /**
   * Connectors that can actually be used right now — not merely registered.
   * wagmi always lists `injected` whether or not a provider exists, and
   * offering it to a browser with no wallet produces a button that does
   * nothing when clicked, which is the worst outcome available.
   */
  connectors: { id: string; name: string; connect: () => void }[];
  /** True when no connector can be used: no injected provider, no WalletConnect. */
  noWallet: boolean;
  disconnect: () => void;
  /** Ask the wallet to switch to — or add — the selected chain. */
  switchToActive: () => void;
  /**
   * Resolve once the wallet is on the selected chain, prompting a switch (or an
   * add) first if it is not. `false` means the wallet refused or could not, and
   * nothing should be sent. Every write goes through this.
   */
  ensureActiveChain: () => Promise<boolean>;
  error: string | null;
  chainName: string;
  /** The chain id the surface is pointed at, which is the viewer's choice. */
  chainId: number;
  /** The chain the wallet is actually on — including chains this app has never heard of. */
  walletChainId: number | null;
  /** Whether a wallet can be asked to add the selected chain (it has a public RPC). */
  canSwitch: boolean;
}

/**
 * One place the whole app reads wallet state from.
 *
 * The distinction that matters here is `ready` versus `wrongChain`. Arc's chain
 * id ships in no wallet, so "connected" is never sufficient on its own — a user
 * is far more likely to arrive connected-but-elsewhere than to arrive correct,
 * and a surface that treats those two as the same state will happily offer to
 * send an approval to whatever token sits at that address on mainnet.
 */
export function useWallet(): WalletState {
  /*
   * The wallet's chain comes from the ACCOUNT, never from `useChainId()`.
   *
   * `useChainId()` reads wagmi's config state, and wagmi deliberately refuses to
   * move that state onto a chain the config does not list ("If chain is not
   * configured, then don't switch over to it" — @wagmi/core createConfig). So a
   * wallet sitting on Robinhood Chain, Base, or anything else reported the last
   * Arc it had seen, `wrongChain` was false, and the approve button sent an
   * approval to 0x3600…0000 on whatever chain the wallet was really on. The
   * account's chain id is the connection's own and has no such filter.
   */
  const { address, isConnected, chainId: accountChainId } = useAccount();
  const { connect, connectors, isPending: connecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const {
    switchChain,
    switchChainAsync,
    isPending: switching,
    error: switchError,
  } = useSwitchChain();

  /*
   * Whether the browser actually has an injected provider. Resolved after mount
   * rather than during render: `window` does not exist on the server, and an
   * extension can inject late enough to miss the first paint, so this re-checks
   * on `eip6963:announceProvider` too.
   */
  const [injectedReady, setInjectedReady] = useState(false);
  useEffect(() => {
    const look = () => {
      if (typeof window !== 'undefined' && (window as { ethereum?: unknown }).ethereum != null) {
        setInjectedReady(true);
      }
    };
    look();
    window.addEventListener('eip6963:announceProvider', look);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    return () => window.removeEventListener('eip6963:announceProvider', look);
  }, []);

  const { chain: selected, facts } = useNetwork();

  const switchToActive = useCallback(() => {
    switchChain({ chainId: selected.id });
  }, [switchChain, selected.id]);

  const status = chainStatus(isConnected, accountChainId, selected.id);

  const ensureActiveChain = useCallback(async () => {
    if (!isConnected) return false;
    if (accountChainId === selected.id) return true;
    try {
      const switched = await switchChainAsync({ chainId: selected.id });
      return switched.id === selected.id;
    } catch {
      // Rejected, or the wallet cannot add the chain. `switchError` carries the
      // message for the UI; the caller only needs to know not to send.
      return false;
    }
  }, [isConnected, accountChainId, selected.id, switchChainAsync]);

  const list = useMemo(
    () =>
      usableConnectors(connectors, injectedReady).map((connector) => ({
        id: connector.id,
        name: connector.label,
        connect: () => connect({ connector: connector.source }),
      })),
    [connectors, connect, injectedReady],
  );

  return {
    address: isConnected && address !== undefined ? address : null,
    ready: status.ready,
    wrongChain: status.wrongChain,
    connecting,
    switching,
    connectors: list,
    noWallet: list.length === 0,
    disconnect: () => disconnect(),
    switchToActive,
    ensureActiveChain,
    error: connectError?.message ?? switchError?.message ?? null,
    chainName: facts.name,
    chainId: selected.id,
    walletChainId: isConnected && accountChainId !== undefined ? accountChainId : null,
    canSwitch: selected.rpcUrls.default.http.length > 0,
  };
}

/**
 * Whether a connection is on the chain this surface transacts on.
 *
 * `walletChainId` must be the connection's own chain id. An unknown chain id is
 * wrong, and so is a missing one: a connected wallet that has not reported a
 * chain has not proven it is on Arc, and "ready" is what unlocks the send buttons.
 *
 * Pure and exported so the rule is testable without a wallet.
 */
export function chainStatus(
  isConnected: boolean,
  walletChainId: number | undefined,
  selectedChainId: number,
): { ready: boolean; wrongChain: boolean } {
  if (!isConnected) return { ready: false, wrongChain: false };
  const ready = walletChainId === selectedChainId;
  return { ready, wrongChain: !ready };
}

/**
 * Whether to open the wallet's switch-network prompt without being asked.
 *
 * Once per (address, wallet chain, selected chain): a visitor who dismisses the
 * prompt is not asked again until something changes — they switch accounts,
 * move the wallet somewhere else, or flip the toggle — because a wallet popup
 * that reopens every render is a site nobody can use. Never when the selected
 * chain cannot be added (mainnet before Circle publishes an RPC), since that
 * prompt could only fail.
 */
export function switchPromptKey(wallet: {
  wrongChain: boolean;
  canSwitch: boolean;
  address: string | null;
  walletChainId: number | null;
  chainId: number;
}): string | null {
  if (!wallet.wrongChain || !wallet.canSwitch || wallet.address === null) return null;
  return `${wallet.address.toLowerCase()}:${wallet.walletChainId ?? 'unknown'}:${wallet.chainId}`;
}

/**
 * Which registered connectors a visitor can actually use.
 *
 * wagmi lists `injected` whether or not the browser has a provider, so a
 * visitor with no wallet is offered a button that does nothing when clicked.
 * Dropping it here is what lets the UI say "no wallet found" instead.
 *
 * Pure and exported so the rule is testable without a browser or a wallet.
 */
export function usableConnectors<T extends { id: string; name: string }>(
  connectors: readonly T[],
  injectedReady: boolean,
): { id: string; label: string; source: T }[] {
  return connectors
    .filter((connector) => connector.id !== 'injected' || injectedReady)
    .map((connector) => ({
      id: connector.id,
      // "Browser wallet" rather than whatever the extension calls itself, so the
      // menu reads consistently whichever wallet is installed.
      label: connector.id === 'injected' ? 'Browser wallet' : connector.name,
      source: connector,
    }));
}

/** `0x1234…abcd`, which is how the product writes an address everywhere else. */
export function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
