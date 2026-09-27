/**
 * One market for `/m/[id]` and `/api/markets/[id]`: `@hunch-rh/client`'s `readMarket` (every
 * position, the quote inputs, and after the bell the two proven rounds with `preview`), cached
 * 5 s and tagged so a confirmed bet can expire it at once. Entry times and transaction links come
 * from logs as an enhancement and degrade to nothing.
 */

import { MARKET_STATUS, readMarket, type MarketDetail } from '@hunch-rh/client';

import { readDeployment } from '@/lib/deployment';

import { TAG, cachedRead } from './cache';
import { serverClient } from './client';
import { readActivity, readResolutionLogs, type ActivityData, type ResolutionLog } from './logs';

export const MARKET_REVALIDATE = 5;

export interface MarketBundle {
  /** null when the factory never listed this id. */
  data: MarketDetail | null;
  readAt: number;
  stale: boolean;
  activity: ActivityData | null;
  log: ResolutionLog | null;
}

/** A decimal market id, or null. */
export function parseMarketId(raw: string): bigint | null {
  if (!/^\d{1,30}$/.test(raw)) return null;
  return BigInt(raw);
}

export async function getResolutionLogs(): Promise<ResolutionLog[] | null> {
  const deployment = readDeployment();
  try {
    const snapshot = await cachedRead({
      key: ['resolution-logs', deployment.contracts.StockRoundResolver.address],
      tags: [TAG.proof, TAG.venue],
      revalidate: 60,
      read: () => readResolutionLogs(serverClient(), deployment),
    });
    return snapshot.data;
  } catch {
    return null;
  }
}

export async function getActivity(marketId: bigint, settled: boolean): Promise<ActivityData | null> {
  const deployment = readDeployment();
  try {
    const snapshot = await cachedRead({
      key: ['activity', deployment.contracts.HunchVPM.address, marketId.toString()],
      tags: [TAG.market(marketId), TAG.markets],
      revalidate: settled ? 120 : 20,
      read: () => readActivity(serverClient(), deployment, marketId),
    });
    return snapshot.data;
  } catch {
    return null;
  }
}

/**
 * The market with its enhancements. Throws `ReadUnavailableError` only when the chain has never
 * been readable for it; a later failure serves the last good read with `stale: true`.
 */
export async function getMarketBundle(marketId: bigint, options: { enhance?: boolean } = {}): Promise<MarketBundle> {
  const deployment = readDeployment();
  const snapshot = await cachedRead({
    key: ['market', deployment.contracts.HunchVPM.address, marketId.toString()],
    tags: [TAG.market(marketId), TAG.markets],
    revalidate: MARKET_REVALIDATE,
    read: () => readMarket(serverClient(), deployment, marketId),
  });
  const detail = snapshot.data;
  if (detail === null || options.enhance === false) {
    return { data: detail, readAt: snapshot.readAt, stale: snapshot.stale, activity: null, log: null };
  }
  const settled = detail.statusCode !== MARKET_STATUS.Open;
  const [activity, logs] = await Promise.all([getActivity(marketId, settled), settled ? getResolutionLogs() : Promise.resolve(null)]);
  const log = logs === null ? null : ([...logs].reverse().find((entry) => entry.marketId === marketId) ?? null);
  return { data: detail, readAt: snapshot.readAt, stale: snapshot.stale, activity, log };
}
