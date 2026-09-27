/**
 * GET /api/markets: every market the factory listed, newest first, read with view calls.
 */

import { marketJson } from '@/lib/api/shapes';
import { CHAIN_UNAVAILABLE_MESSAGE, json, problem } from '@/lib/api/http';
import { readDeployment } from '@/lib/deployment';
import { getVenue } from '@/lib/server/venue';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const deployment = readDeployment();
  try {
    const snapshot = await getVenue();
    return json(
      {
        deployed: snapshot.data.deployed,
        status: deployment.status,
        entriesPaused: snapshot.data.entriesPaused,
        markets: snapshot.data.markets.map(marketJson),
        readAt: snapshot.readAt,
        stale: snapshot.stale,
      },
      { cache: { sMaxAge: 15, swr: 45 } },
    );
  } catch {
    return problem(503, 'chain_unavailable', CHAIN_UNAVAILABLE_MESSAGE);
  }
}
