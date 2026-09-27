'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { NETWORKS, type ContractAddresses, type ChainFacts, type NetworkId } from '@/lib/chain';
import { NETWORK_COOKIE } from '@/lib/network';
import { CHAINS, DEFAULT_NETWORK } from './chains';

/**
 * Which Arc this surface is pointed at, chosen by the viewer rather than baked
 * into the build.
 *
 * The choice is deliberate and sticky, never inferred from the wallet. A venue
 * that quietly follows whatever chain a wallet happens to be on is a venue that
 * will eventually send an approval to the wrong USDC — so the viewer picks,
 * the pick is remembered, and a wallet that disagrees is a *wrong chain* state
 * with a prompt rather than a silent switch.
 *
 * The choice lives in two places on purpose: localStorage for the browser, and
 * a cookie so the server renders the board for the same network. The server
 * passes what it rendered as `initialNetwork`, so the first paint already
 * matches; `NetworkSync` refreshes the server half if the two ever disagree.
 */

interface NetworkContextValue {
  network: NetworkId;
  setNetwork: (network: NetworkId) => void;
  facts: ChainFacts;
  addresses: ContractAddresses;
  chain: (typeof CHAINS)[NetworkId];
  /** True once the stored choice has been read, so nothing renders the wrong one first. */
  hydrated: boolean;
}

const STORAGE_KEY = 'hunch-vpm.network';

/** One year. The choice is a preference, not a session. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function rememberForServer(network: NetworkId) {
  try {
    document.cookie = `${NETWORK_COOKIE}=${network}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
  } catch {
    // No cookies: the server keeps rendering its default, and the toggle still
    // governs everything this browser signs.
  }
}

const NetworkContext = createContext<NetworkContextValue | null>(null);

export function NetworkProvider({
  children,
  initialNetwork,
}: {
  children: React.ReactNode;
  /** The network the server rendered for, so hydration starts where the page already is. */
  initialNetwork?: NetworkId | undefined;
}) {
  const [network, setStored] = useState<NetworkId>(initialNetwork ?? DEFAULT_NETWORK);
  const [hydrated, setHydrated] = useState(false);

  // Read after mount: the server has no localStorage, and rendering the stored
  // choice during SSR would be a hydration mismatch on the most important
  // control on the page.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === 'mainnet' || saved === 'testnet') {
        rememberForServer(saved);
        setStored(saved);
      }
    } catch {
      // Private mode, or storage disabled. The default is a fine answer.
    }
    setHydrated(true);
  }, []);

  const setNetwork = useCallback((next: NetworkId) => {
    // Cookie first: `NetworkSync` refreshes on the state change, and that render must see it.
    rememberForServer(next);
    setStored(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not remembering the choice is survivable; refusing to make it is not.
    }
  }, []);

  const value = useMemo<NetworkContextValue>(
    () => ({
      network,
      setNetwork,
      facts: NETWORKS[network].facts,
      addresses: NETWORKS[network].addresses,
      chain: CHAINS[network],
      hydrated,
    }),
    [network, setNetwork, hydrated],
  );

  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkContextValue {
  const value = useContext(NetworkContext);
  if (value === null) {
    throw new Error('useNetwork must be used inside <NetworkProvider>');
  }
  return value;
}
