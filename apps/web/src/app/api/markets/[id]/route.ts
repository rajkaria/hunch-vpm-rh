/**
 * GET /api/markets/[id]: one market, its headroom per side, every position in entry order, and
 * after the bell the two rounds the finder proved with `preview`. 404 if the factory never listed
 * the id (or before deployment).
 */

import { marketDetailJson } from '@/lib/api/shapes';
import { CHAIN_UNAVAILABLE_MESSAGE, json, problem } from '@/lib/api/http';
import { readDeployment } from '@/lib/deployment';
import { getMarketBundle, parseMarketId } from '@/lib/server/market';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const marketId = parseMarketId(id);
  if (marketId === null) return problem(400, 'invalid_request', 'The market id must be a whole number.');
  if (readDeployment().status !== 'deployed') {
    return problem(404, 'not_found', 'Hunch is not deployed on Robinhood Chain yet, so no market exists.');
  }
  try {
    const bundle = await getMarketBundle(marketId);
    if (bundle.data === null) return problem(404, 'not_found', 'No market with this id was listed by Hunch.');
    return json(marketDetailJson(bundle.data, { activity: bundle.activity, log: bundle.log, readAt: bundle.readAt, stale: bundle.stale }), {
      cache: { sMaxAge: 5, swr: 15 },
    });
  } catch {
    return problem(503, 'chain_unavailable', CHAIN_UNAVAILABLE_MESSAGE);
  }
}
