/**
 * GET /api/positions?owner=0x…: every position one address holds, across markets, with totals.
 * The address is never logged and never sent to analytics.
 */

import { RateLimiter } from '@hunch-rh/keeper';

import { CHAIN_UNAVAILABLE_MESSAGE, json, problem } from '@/lib/api/http';
import { clientIp } from '@/lib/server/geo';
import { getPortfolio, parseOwner } from '@/lib/server/positions';

export const dynamic = 'force-dynamic';

/** Reading every position is the heaviest read here: 30 a minute per IP, per instance. */
const limiter = new RateLimiter(30, 60_000);

export async function GET(request: Request): Promise<Response> {
  const owner = parseOwner(new URL(request.url).searchParams.get('owner'));
  if (owner === null) return problem(400, 'invalid_request', '`owner` must be an address (0x followed by 40 hex characters).');
  const ip = clientIp(request.headers);
  if (ip !== null && !limiter.take(`ip:${ip}`)) return problem(429, 'rate_limited', 'Too many requests from this connection. Wait a minute and try again.');
  try {
    return json(await getPortfolio(owner), { cache: { sMaxAge: 5, swr: 15 } });
  } catch {
    return problem(503, 'chain_unavailable', CHAIN_UNAVAILABLE_MESSAGE);
  }
}
