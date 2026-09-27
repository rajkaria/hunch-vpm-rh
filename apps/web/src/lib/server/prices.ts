/**
 * The live Chainlink price tape: `@hunch-rh/client`'s `readPrices` (one multicall of
 * `latestRoundData` over the deployment's feeds, before and after launch), cached 15 s.
 *
 * A failed read never empties the tape: it serves the last good snapshot with its age and status
 * `stale-cache`, and the tape says "Price unavailable, retrying". With nothing ever read it says
 * `unavailable` and invents no price.
 */

import { readPrices, type PricesSnapshot } from '@hunch-rh/client';

import { tickerInfo } from '@/content/tickers';
import { readDeployment, type Deployment } from '@/lib/deployment';
import type { PriceReading, PriceSnapshot } from '@/lib/view/types';

import { TAG, cachedRead } from './cache';
import { serverClient } from './client';

export const PRICES_REVALIDATE = 15;

function emptyReadings(deployment: Deployment): PriceReading[] {
  return deployment.feeds.map((feed) => ({
    ticker: feed.ticker,
    name: tickerInfo(feed.ticker)?.name ?? feed.ticker,
    feed: feed.feed,
    answer: null,
    roundId: null,
    updatedAt: null,
  }));
}

/** The client's snapshot as the tape's readings (strings, so the island can poll them as JSON). */
export function toReadings(snapshot: PricesSnapshot): PriceReading[] {
  return snapshot.rows.map((row) => ({
    ticker: row.ticker,
    name: tickerInfo(row.ticker)?.name ?? row.ticker,
    feed: row.feed,
    answer: row.price === null ? null : row.price.toString(),
    roundId: row.roundId === null ? null : row.roundId.toString(),
    updatedAt: row.updatedAt,
  }));
}

export async function getPriceSnapshot(): Promise<{ snapshot: PricesSnapshot; readAt: number; stale: boolean } | null> {
  const deployment = readDeployment();
  try {
    const result = await cachedRead({
      key: ['prices', deployment.feeds.map((feed) => feed.feed).join(',')],
      tags: [TAG.prices],
      revalidate: PRICES_REVALIDATE,
      read: async () => {
        const snapshot = await readPrices(serverClient(), deployment);
        // An answer from no feed at all is a failed read, not a snapshot worth caching.
        if (snapshot.rows.length > 0 && snapshot.rows.every((row) => row.price === null)) throw new Error('no feed answered');
        return snapshot;
      },
    });
    return { snapshot: result.data, readAt: result.readAt, stale: result.stale };
  } catch {
    return null;
  }
}

/** The tape's snapshot. Never throws. */
export async function getPrices(): Promise<PriceSnapshot> {
  const deployment = readDeployment();
  const result = await getPriceSnapshot();
  if (result === null) return { readings: emptyReadings(deployment), readAt: Math.floor(Date.now() / 1000), status: 'unavailable' };
  return { readings: toReadings(result.snapshot), readAt: result.readAt, status: result.stale ? 'stale-cache' : 'live' };
}
