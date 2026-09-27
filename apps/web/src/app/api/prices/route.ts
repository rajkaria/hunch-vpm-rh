// TODO(S7): replace with @hunch-rh/client readVenue/readPrices (and add the other GET routes).
/**
 * GET /api/prices: the latest Chainlink reading for every ticker on the tape.
 *
 * Read-only, no secrets, cached for 15 s at the edge. The body is a `PriceSnapshot`: answers are
 * 8-decimal integers as strings, times are unix seconds. A failed chain read still answers 200
 * with the last good snapshot and `status: "stale-cache"` (or `"unavailable"`), because the tape
 * must degrade to "retrying" rather than go blank.
 */

import { NextResponse } from 'next/server';

import { readPrices } from '@/lib/live/prices';

export const revalidate = 15;

export async function GET() {
  const snapshot = await readPrices();
  return NextResponse.json(snapshot, {
    headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=45' },
  });
}
