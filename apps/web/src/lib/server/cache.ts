/**
 * Cached chain reads with a last-good fallback.
 *
 * Every read goes through Next's data cache (`unstable_cache`, tagged, time-revalidated), so a
 * page view or an API call costs the RPC nothing while the entry is fresh, and a stale entry is
 * served while it refreshes in the background. The value is stored as exact JSON (bigints
 * included, see `lib/codec.ts`).
 *
 * If a read fails and nothing is cached, the instance's own last good value is returned with its
 * age and `stale: true`, so the page says "Price unavailable, retrying" next to the last numbers
 * rather than showing an empty grid. Only when there has never been a good read does it throw.
 */

import { unstable_cache } from 'next/cache';

import { decode, encode } from '@/lib/codec';

import { redactError } from './client';

export interface Snapshot<T> {
  data: T;
  /** Unix seconds when `data` was read from the chain. */
  readAt: number;
  /** True when this is an older value served because the latest read failed. */
  stale: boolean;
  /** Why the latest read failed (redacted), when `stale`. */
  error: string | null;
}

interface Stored {
  data: unknown;
  readAt: number;
}

const lastGood = new Map<string, Stored>();

const now = (): number => Math.floor(Date.now() / 1000);

export class ReadUnavailableError extends Error {
  constructor(readonly key: string, reason: string) {
    super(`chain read unavailable (${key}): ${reason}`);
    this.name = 'ReadUnavailableError';
  }
}

export interface CachedReadOptions<T> {
  /** Unique key parts (no secrets: they end up in the cache key). */
  key: readonly string[];
  tags: readonly string[];
  /** Seconds before the entry is refreshed. */
  revalidate: number;
  read: () => Promise<T>;
}

async function viaNextCache(options: CachedReadOptions<unknown>): Promise<Stored> {
  const load = async (): Promise<unknown> => encode({ data: await options.read(), readAt: now() });
  const cached = unstable_cache(load, ['hunch-rh', ...options.key], { tags: [...options.tags], revalidate: options.revalidate });
  try {
    return decode<Stored>(await cached());
  } catch (error) {
    // Outside a Next.js request (tests, scripts) there is no data cache: read directly.
    if (error instanceof Error && error.message.includes('incrementalCache missing')) return decode<Stored>(await load());
    throw error;
  }
}

export async function cachedRead<T>(options: CachedReadOptions<T>): Promise<Snapshot<T>> {
  const id = options.key.join(':');
  try {
    const stored = await viaNextCache(options as CachedReadOptions<unknown>);
    lastGood.set(id, stored);
    // An entry far older than its revalidate window means refreshes have been failing.
    const stale = now() - stored.readAt > Math.max(60, options.revalidate * 4);
    return { data: stored.data as T, readAt: stored.readAt, stale, error: null };
  } catch (error) {
    const reason = redactError(error);
    const previous = lastGood.get(id);
    if (previous === undefined) throw new ReadUnavailableError(id, reason);
    console.warn(`[read] ${id} failed, serving the last good value from ${now() - previous.readAt}s ago: ${reason}`);
    return { data: previous.data as T, readAt: previous.readAt, stale: true, error: reason };
  }
}

/** For tests. */
export function clearLastGood(): void {
  lastGood.clear();
}

/** Cache tags. */
export const TAG = {
  venue: 'venue',
  prices: 'prices',
  proof: 'proof',
  market: (id: string | bigint) => `market:${id.toString()}`,
  positions: (owner: string) => `positions:${owner.toLowerCase()}`,
} as const;
