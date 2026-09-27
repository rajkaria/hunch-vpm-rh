/**
 * GET /api/prices: the latest Chainlink reading for every ticker on the tape.
 *
 * Read-only, no secrets, cached 15 s. The body is a `PriceSnapshot`: answers are 8-decimal
 * integers as strings, times are unix seconds. A failed chain read still answers 200 with the
 * last good snapshot and `status: "stale-cache"` (or `"unavailable"`), because the tape must
 * degrade to "retrying" rather than go blank.
 */

import { json } from '@/lib/api/http';
import { getPrices } from '@/lib/server/prices';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const snapshot = await getPrices();
  return json(snapshot, { cache: { sMaxAge: 15, swr: 45 } });
}
