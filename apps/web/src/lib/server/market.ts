/**
 * One market for `/m/[id]` and `/api/markets/[id]`: `@hunch-rh/client`'s `readMarket` (every
 * position, the quote inputs, and after the bell the two proven rounds with `preview`), cached
 * 5 s and tagged so a confirmed bet can expire it at once. Entry times and transaction links come
 * from logs as an enhancement and degrade to nothing; a market's log scan starts at the block
 * before it opened (found once, cached a week), so its cost does not grow with the venue's age.
 */

import { MARKET_STATUS, blockBefore, readMarket, type MarketDetail } from '@hunch-rh/client';

import { readDeployment } from '@/lib/deployment';

import { TAG, cachedRead, type Snapshot } from './cache';
import { serverClient } from './client';
import { readActivity, readResolutionLogs, type ActivityData, type ResolutionLog } from './logs';

export const MARKET_REVALIDATE = 5;

export interface MarketBundle {
  /** null when the factory never listed this id. */
  data: MarketDetail | null;
  readAt: number;
  stale: boolean;
  /** Why the latest read failed (redacted), when `stale`. */
  error: string | null;
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

/**
 * The block before a market opened: where its log scan starts. Immutable, so it is found once
 * (a handful of block-header reads) and kept a week. null when it cannot be read: scan from the
 * start block instead.
 */
export async function getOpeningBlock(marketId: bigint, openedAt: number): Promise<bigint | null> {
  const deployment = readDeployment();
  const startBlock = BigInt(deployment.startBlock ?? 0);
  try {
    const snapshot = await cachedRead({
      key: ['opening-block', deployment.contracts.HunchVPM.address, marketId.toString(), String(openedAt)],
      tags: [],
      revalidate: 7 * 86_400,
      read: () => blockBefore(serverClient(), openedAt, startBlock),
    });
    return snapshot.data;
  } catch {
    return null;
  }
}

/** One market's activity as a snapshot (throws `ReadUnavailableError` if logs were never readable). */
export async function getActivitySnapshot(marketId: bigint, settled: boolean, openedAt?: number): Promise<Snapshot<ActivityData>> {
  const deployment = readDeployment();
  const fromBlock = openedAt === undefined ? null : await getOpeningBlock(marketId, openedAt);
  return cachedRead({
    key: ['activity', deployment.contracts.HunchVPM.address, marketId.toString()],
    tags: [TAG.market(marketId), TAG.markets],
    revalidate: settled ? 120 : 20,
    foregroundMs: 4_000,
    read: () => readActivity(serverClient(), deployment, marketId, fromBlock ?? undefined),
  });
}

/** One market's activity, or null when logs cannot be read (the page shows no links). */
export async function getActivity(marketId: bigint, settled: boolean, openedAt?: number): Promise<ActivityData | null> {
  try {
    return (await getActivitySnapshot(marketId, settled, openedAt)).data;
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
    return { data: detail, readAt: snapshot.readAt, stale: snapshot.stale, error: snapshot.error, activity: null, log: null };
  }
  const settled = detail.statusCode !== MARKET_STATUS.Open;
  const [activity, logs] = await Promise.all([getActivity(marketId, settled, detail.openedAt), settled ? getResolutionLogs() : Promise.resolve(null)]);
  const log = logs === null ? null : ([...logs].reverse().find((entry) => entry.marketId === marketId) ?? null);
  return { data: detail, readAt: snapshot.readAt, stale: snapshot.stale, error: snapshot.error, activity, log };
}
