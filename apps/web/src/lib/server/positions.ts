/**
 * One wallet's positions across every market (`/api/positions?owner=`, `/portfolio`):
 * `@hunch-rh/client`'s `readPositionsByOwner`, views only, cached 15 s per owner and tagged so a
 * confirmed bet or claim expires it. Payout transactions are looked up from logs for settled
 * markets, as an enhancement.
 */

import { MARKET_STATUS, readPositionsByOwner, type OwnerPortfolio } from '@hunch-rh/client';
import { getAddress, type Address } from 'viem';

import { portfolioJson, type PortfolioJson } from '@/lib/api/shapes';
import { readDeployment } from '@/lib/deployment';

import { TAG, cachedRead } from './cache';
import { serverClient } from './client';
import type { ActivityData } from './logs';
import { getActivity } from './market';

/** At most this many settled markets are scanned for payout transactions per request. */
const MAX_ACTIVITY_MARKETS = 8;

export function parseOwner(raw: string | null): Address | null {
  if (raw === null || !/^0x[0-9a-fA-F]{40}$/.test(raw.trim())) return null;
  try {
    return getAddress(raw.trim().toLowerCase());
  } catch {
    return null;
  }
}

export async function getPortfolio(owner: Address): Promise<PortfolioJson> {
  const deployment = readDeployment();
  const snapshot = await cachedRead<OwnerPortfolio>({
    key: ['positions', deployment.contracts.HunchVPM.address, owner.toLowerCase()],
    tags: [TAG.positions(owner), TAG.venue, TAG.markets],
    revalidate: 15,
    read: () => readPositionsByOwner(serverClient(), deployment, owner),
  });
  const portfolio = snapshot.data;
  const settled = [
    ...new Map(
      portfolio.positions
        .filter(({ market, position }) => market.statusCode !== MARKET_STATUS.Open && (position.claimed || position.refunded))
        .map(({ market }) => [market.id, market.openedAt] as const),
    ),
  ].slice(0, MAX_ACTIVITY_MARKETS);
  const activity = new Map<string, ActivityData | null>();
  await Promise.all(settled.map(async ([id, openedAt]) => activity.set(id.toString(), await getActivity(id, true, openedAt))));
  return portfolioJson(portfolio, { activity, readAt: snapshot.readAt, stale: snapshot.stale });
}
