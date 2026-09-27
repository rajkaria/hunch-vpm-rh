/**
 * GET /api/proof: everything the Proof page shows, each counter with the call it came from.
 */

import { json } from '@/lib/api/http';
import { getProof, proofJson } from '@/lib/server/proof';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { view, extras } = await getProof();
  return json(proofJson(view, extras), { cache: { sMaxAge: 60, swr: 180 } });
}
