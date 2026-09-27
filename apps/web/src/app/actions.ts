'use server';

/**
 * Read-your-own-writes after a confirmed bet, claim or settlement: expire the cached chain reads
 * for that market (and the wallet's portfolio) so the next read, and a hard refresh, show it.
 * Harmless to call: it only makes the next read fresh. Rate limited per IP.
 */

import { RateLimiter } from '@hunch-rh/keeper';
import { updateTag } from 'next/cache';
import { headers } from 'next/headers';

import { TAG } from '@/lib/server/cache';
import { clientIp } from '@/lib/server/geo';

const limiter = new RateLimiter(30, 60_000);

async function allowed(): Promise<boolean> {
  const ip = clientIp(await headers());
  return ip === null || limiter.take(`refresh:${ip}`);
}

export async function refreshMarket(marketId: string, owner: string | null): Promise<void> {
  if (!/^\d{1,30}$/.test(marketId) || !(await allowed())) return;
  updateTag(TAG.market(marketId));
  updateTag(TAG.venue);
  if (owner !== null && /^0x[0-9a-fA-F]{40}$/.test(owner)) updateTag(TAG.positions(owner));
}

export async function refreshPortfolio(owner: string): Promise<void> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner) || !(await allowed())) return;
  updateTag(TAG.positions(owner));
}
