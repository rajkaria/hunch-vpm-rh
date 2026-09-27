'use client';

import { useQuery, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import type { NetworkId } from '@/lib/chain';
import { awaitingVintage, decodePosition, type ApiPositions } from '@/lib/data/position-wire';
import type { PositionView } from '@/lib/data/types';
import { useNetwork } from './network';
import { useWallet } from './useWallet';

/**
 * The connected wallet's positions, read from the index — the one place a
 * position survives a page load.
 *
 * The market page used to know about an entry only through the receipt of the
 * transaction that made it, held in component state. Refresh the page and the
 * stake was gone from view while sitting on chain untouched. Everything that
 * shows "your position" now reads through here, and the portfolio shares the
 * same cache entry, so the two can never disagree about what an address holds.
 */

/** How often to re-read while the index still owes an answer. */
export const POSITIONS_POLL_MS = 4_000;
/** How long an entry the index has not caught up with is waited for. */
const EXPECT_FOR_MS = 120_000;

export function positionsQueryKey(network: NetworkId, address: string | null) {
  return ['positions', network, address] as const;
}

export interface Expectation {
  marketId: string;
  positionId: string;
  /** Epoch milliseconds after which the wait is abandoned. */
  until: number;
}

/**
 * Entries this browser has seen land that the index may not have caught up
 * with. Module state on purpose: it is per browser tab, it outlives the
 * component that sent the transaction, and a reload clears it — by which point
 * the index has long since caught up.
 */
const expected = new Map<string, Expectation>();

function expectationKey(network: NetworkId, address: string): string {
  return `${network}:${address.toLowerCase()}`;
}

/**
 * Whether to read again, and when.
 *
 * Two reasons to keep polling, and both end on their own: an entry is buffered
 * and waiting for its vintage to close, or an entry this browser just sent has
 * not shown up in the index yet. Otherwise the read is left alone.
 */
export function nextPositionsPoll(
  data: ApiPositions | undefined,
  expectation: Expectation | undefined,
  now: number,
): number | false {
  if (data === undefined) return false;
  if (data.entries.some((entry) => awaitingVintage(entry.position))) return POSITIONS_POLL_MS;
  if (expectation !== undefined && now < expectation.until) {
    const seen = data.entries.some(
      (entry) =>
        entry.market.id.toLowerCase() === expectation.marketId.toLowerCase() &&
        entry.position.positionId === expectation.positionId,
    );
    if (!seen) return POSITIONS_POLL_MS;
  }
  return false;
}

/** Tell the positions read that an entry just landed, and re-read it until the index has it. */
export function expectPosition(
  client: QueryClient,
  network: NetworkId,
  address: string,
  marketId: string,
  positionId: bigint,
): void {
  expected.set(expectationKey(network, address), {
    marketId,
    positionId: positionId.toString(),
    until: Date.now() + EXPECT_FOR_MS,
  });
  void client.invalidateQueries({ queryKey: positionsQueryKey(network, address) });
}

/** Re-read after something changed on chain that the index will reflect. */
export function refreshPositions(client: QueryClient, network: NetworkId, address: string): void {
  void client.invalidateQueries({ queryKey: positionsQueryKey(network, address) });
}

export function useWalletPositions({ enabled = true }: { enabled?: boolean } = {}) {
  const wallet = useWallet();
  const { network, hydrated } = useNetwork();
  const address = wallet.address;

  return useQuery({
    // Keyed by network: the same address holds different things on each Arc.
    queryKey: positionsQueryKey(network, address),
    enabled: enabled && address !== null && hydrated,
    queryFn: async (): Promise<ApiPositions> => {
      // `no-store`: the route allows a private five-second cache, which would
      // hand a poll the same stale answer it is polling to get past.
      const response = await fetch(`/api/positions?network=${network}&address=${address ?? ''}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('The index could not be reached.');
      return response.json();
    },
    refetchInterval: (query) =>
      nextPositionsPoll(
        query.state.data,
        address === null ? undefined : expected.get(expectationKey(network, address)),
        Date.now(),
      ),
  });
}

/** One market's slice of the wallet's positions, in entry order. */
export function useMarketPositions(marketId: string, options: { enabled?: boolean } = {}) {
  const query = useWalletPositions(options);
  const positions = useMemo<PositionView[]>(
    () =>
      (query.data?.entries ?? [])
        .filter((entry) => entry.market.id.toLowerCase() === marketId.toLowerCase())
        .map((entry) => decodePosition(entry.position))
        .sort((a, b) => (a.positionId < b.positionId ? -1 : a.positionId > b.positionId ? 1 : 0)),
    [query.data, marketId],
  );
  return { query, positions };
}
