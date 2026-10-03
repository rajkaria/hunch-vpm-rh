/**
 * Cached chain reads with a last-good fallback.
 *
 * Every read goes through Next's data cache (`unstable_cache`, tagged, time-revalidated), so a
 * page view or an API call costs the RPC nothing while the entry is fresh, and a stale entry is
 * served while it refreshes in the background. The value is stored as exact JSON (bigints
 * included, see `lib/codec.ts`).
 *
 * The data cache is stale-while-revalidate: the first request after an idle gap gets the entry
 * from the previous visit, however old, while it refreshes in the background. That is not a failed
 * read, so an entry older than its freshness window (`freshWindow`) is read again in the
 * foreground, sharing the background refresh's chain call, for at most `foregroundMs`. A quiet
 * site therefore never shows hours-old numbers as current, nor calls them "unavailable".
 *
 * `stale: true` means exactly one thing: the latest chain read failed (or took too long), and the
 * newest good value is served with its age and the reason, so the page says "Price unavailable,
 * retrying" next to the last numbers rather than showing an empty grid. Only when there has never
 * been a good read does it throw.
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
const inFlight = new Map<string, Promise<Stored>>();

const now = (): number => Math.floor(Date.now() / 1000);

/** Default cap on a foreground re-read after an idle gap: past it, the page renders the last good value. */
export const FOREGROUND_READ_MS = 6_000;

/** Seconds an entry counts as current: four refresh windows, at least a minute. */
export function freshWindow(revalidate: number): number {
  return Math.max(60, revalidate * 4);
}

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
  /** Cap on the foreground re-read of an entry past its freshness window (default `FOREGROUND_READ_MS`). */
  foregroundMs?: number;
}

/** One chain read per key at a time on this instance: the background refresh and a foreground re-read share it. */
function readOnce(id: string, read: () => Promise<unknown>): Promise<Stored> {
  let pending = inFlight.get(id);
  if (pending === undefined) {
    pending = read()
      .then((data) => {
        const stored = { data, readAt: now() };
        remember(id, stored);
        return stored;
      })
      .finally(() => inFlight.delete(id));
    inFlight.set(id, pending);
  }
  return pending;
}

async function viaNextCache(id: string, options: CachedReadOptions<unknown>): Promise<Stored> {
  const load = async (): Promise<unknown> => encode(await readOnce(id, options.read));
  const cached = unstable_cache(load, ['hunch-rh', ...options.key], { tags: [...options.tags], revalidate: options.revalidate });
  try {
    return decode<Stored>(await cached());
  } catch (error) {
    // Outside a Next.js request (tests, scripts) there is no data cache: read directly.
    if (error instanceof Error && error.message.includes('incrementalCache missing')) return decode<Stored>(await load());
    throw error;
  }
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the chain read took longer than ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function remember(id: string, stored: Stored): void {
  const previous = lastGood.get(id);
  if (previous === undefined || stored.readAt >= previous.readAt) lastGood.set(id, stored);
}

export async function cachedRead<T>(options: CachedReadOptions<T>): Promise<Snapshot<T>> {
  const id = options.key.join(':');
  const opts = options as CachedReadOptions<unknown>;
  let failure: unknown = null;
  try {
    remember(id, await viaNextCache(id, opts));
    // The newest good read this instance knows: the cache entry, or a refresh that already landed.
    const current = lastGood.get(id)!;
    if (now() - current.readAt <= freshWindow(options.revalidate)) {
      return { data: current.data as T, readAt: current.readAt, stale: false, error: null };
    }
    // An entry from before an idle gap: read the chain now rather than call it a failure.
    const fresh = await within(readOnce(id, opts.read), options.foregroundMs ?? FOREGROUND_READ_MS);
    return { data: fresh.data as T, readAt: fresh.readAt, stale: false, error: null };
  } catch (error) {
    failure = error;
  }
  const reason = redactError(failure);
  const previous = lastGood.get(id);
  if (previous === undefined) throw new ReadUnavailableError(id, reason);
  console.warn(`[read] ${id} failed, serving the last good value from ${now() - previous.readAt}s ago: ${reason}`);
  return { data: previous.data as T, readAt: previous.readAt, stale: true, error: reason };
}

/** For tests. */
export function clearLastGood(): void {
  lastGood.clear();
  inFlight.clear();
}

/** Cache tags. */
export const TAG = {
  venue: 'venue',
  /** Every per-market read (the keeper's crons expire it after they settle or pay anything). */
  markets: 'markets',
  prices: 'prices',
  proof: 'proof',
  market: (id: string | bigint) => `market:${id.toString()}`,
  positions: (owner: string) => `positions:${owner.toLowerCase()}`,
} as const;
