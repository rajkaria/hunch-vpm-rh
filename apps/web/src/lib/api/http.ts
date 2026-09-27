/**
 * JSON responses for the API routes: bigints as decimal strings, explicit cache headers.
 * GETs are cached at the edge for a few seconds (the data behind them is cached too); anything
 * per-user or state-changing is `no-store`.
 */

import { toJsonSafe } from '@/lib/codec';

export type CachePolicy = 'none' | { sMaxAge: number; swr?: number };

export function cacheControl(policy: CachePolicy): string {
  if (policy === 'none') return 'no-store';
  return `public, s-maxage=${policy.sMaxAge}, stale-while-revalidate=${policy.swr ?? policy.sMaxAge * 3}`;
}

export function json(body: unknown, init: { status?: number; cache?: CachePolicy; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(toJsonSafe(body)), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheControl(init.cache ?? 'none'),
      ...init.headers,
    },
  });
}

/** An error body: `{ ok: false, error: "<code>", message: "<a sentence for a person>" }` plus extras. */
export function problem(status: number, error: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error, message, ...extra }, { status, cache: 'none' });
}

export const CHAIN_UNAVAILABLE_MESSAGE = 'Market data unavailable, retrying. The chain could not be read just now.';
