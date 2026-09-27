/**
 * The venue as the landing page, the market grid, the sitemap and `/api/markets` read it:
 * `@hunch-rh/client`'s `readVenue` (view calls only), cached 15 s, with the last good snapshot
 * served (and its age shown) if the chain cannot be read.
 */

import { MARKET_STATUS, readVenue, type MarketView, type VenueSnapshot } from '@hunch-rh/client';

import { readDeployment } from '@/lib/deployment';
import { earlyVsLateFrom } from '@/lib/view/early-vs-late';
import type { EarlyVsLateProof, MarketCardData, VenueState } from '@/lib/view/types';

import { TAG, cachedRead, type Snapshot } from './cache';
import { serverClient } from './client';
import { readActivity } from './logs';
import { getMarketBundle } from './market';

export const VENUE_REVALIDATE = 15;

export async function getVenue(): Promise<Snapshot<VenueSnapshot>> {
  const deployment = readDeployment();
  return cachedRead({
    key: ['venue', deployment.contracts.HunchMarketFactory.address],
    tags: [TAG.venue],
    revalidate: VENUE_REVALIDATE,
    read: () => readVenue(serverClient(), deployment),
  });
}

/** A market as a card on the landing grid. */
export function toCard(m: MarketView): MarketCardData {
  const phase = m.status === 'Opens' ? 'opens' : m.status === 'Live' ? 'live' : m.status === 'Frozen' ? 'frozen' : m.status === 'Void' ? 'void' : 'resolved';
  return {
    id: m.id.toString(),
    href: `/m/${m.id.toString()}`,
    ticker: m.ticker,
    family: m.family,
    question: m.question,
    phase,
    ...(m.winner === null ? {} : { winner: m.winner === 0 ? ('UP' as const) : ('DOWN' as const) }),
    strikeTime: m.strikeTime,
    finalTime: m.finalTime,
    strike: m.strike === null ? null : { answer: m.strike.price, roundId: m.strike.roundId.toString(), at: m.strike.updatedAt, url: null },
    live: m.live === null ? null : { answer: m.live.price, updatedAt: m.live.updatedAt },
    pool: { up: m.totals.up, down: m.totals.down },
    headroom: m.headroom,
    maxEntry: m.maxEntry,
    acceptingBets: m.acceptingBets,
  };
}

const RECENT_SETTLED_SEC = 36 * 3600;

/**
 * The cards the landing grid shows: every market still open (soonest bell first), then markets
 * settled in the last 36 hours (newest first), at most `limit`.
 */
export function gridMarkets(markets: readonly MarketView[], nowSec: number, limit = 12): MarketView[] {
  const open = markets.filter((m) => m.statusCode === MARKET_STATUS.Open).sort((a, b) => a.finalTime - b.finalTime || Number(a.id - b.id));
  const settled = markets
    .filter((m) => m.statusCode !== MARKET_STATUS.Open && nowSec - m.finalTime < RECENT_SETTLED_SEC)
    .sort((a, b) => b.finalTime - a.finalTime);
  return [...open, ...settled].slice(0, limit);
}

/**
 * The proof card for one family: the most recently settled market of that family with at least
 * one winning bet that is not the opening seed. Reads at most three candidates.
 */
async function latestProof(markets: readonly MarketView[], family: 'weekly' | 'daily'): Promise<EarlyVsLateProof | null> {
  const candidates = markets
    .filter((m) => m.family === family && m.statusCode === MARKET_STATUS.Resolved)
    .sort((a, b) => b.finalTime - a.finalTime)
    .slice(0, 3);
  const deployment = readDeployment();
  for (const candidate of candidates) {
    try {
      const bundle = await getMarketBundle(candidate.id);
      if (bundle === null || bundle.data === null) continue;
      let activity = bundle.activity;
      if (activity === null) {
        try {
          activity = await readActivity(serverClient(), deployment, candidate.id);
        } catch {
          activity = null;
        }
      }
      const proof = earlyVsLateFrom(bundle.data, activity, family, deployment.explorer);
      if (proof !== null) return proof;
    } catch {
      // Try the next candidate; the card falls back in the end.
    }
  }
  return null;
}

async function settledProofs(markets: readonly MarketView[]): Promise<VenueState['settled']> {
  const deployment = readDeployment();
  try {
    const snapshot = await cachedRead({
      key: ['proof-card', deployment.contracts.HunchVPM.address],
      tags: [TAG.venue],
      revalidate: 120,
      read: async () => {
        const [weekly, daily] = await Promise.all([latestProof(markets, 'weekly'), latestProof(markets, 'daily')]);
        return { weekly, daily };
      },
    });
    return snapshot.data;
  } catch {
    return { weekly: null, daily: null };
  }
}

/** Everything the landing page needs about the venue. Never throws. */
export async function readVenueState(nowSec: number = Math.floor(Date.now() / 1000)): Promise<VenueState> {
  const deployment = readDeployment();
  const status = deployment.status === 'deployed' ? 'deployed' : 'not-deployed';
  let snapshot: Snapshot<VenueSnapshot>;
  try {
    snapshot = await getVenue();
  } catch {
    return { status, markets: [], settled: { weekly: null, daily: null }, readAt: null, degraded: status === 'deployed' ? 'unavailable' : null };
  }
  if (!snapshot.data.deployed) return { status: 'not-deployed', markets: [], settled: { weekly: null, daily: null }, readAt: null, degraded: null };
  const markets = gridMarkets(snapshot.data.markets, nowSec).map(toCard);
  const settled = await settledProofs(snapshot.data.markets);
  return { status, markets, settled, readAt: snapshot.readAt, degraded: snapshot.stale ? 'stale' : null };
}
