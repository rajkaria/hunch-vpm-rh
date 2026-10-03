/**
 * The web's own checks, added to the keeper's in `/api/health`: what a visitor sees, not only
 * whether the RPC answers. `rpc-head` stayed green while `/m/0` said "Price unavailable" for
 * hours, so these read through the same cache the pages use:
 *
 * - `market-reads`: the venue list and every open market's detail (or the newest market when
 *   none is open) are current. A failure here is the "Price unavailable, retrying" line.
 * - `market-logs`: the newest market's entry times and transaction links can be read
 *   (`eth_getLogs`, which never goes to the keyed RPC). A failure here is a market page without
 *   entry times or links.
 */

import { MARKET_STATUS, type MarketView, type VenueSnapshot } from '@hunch-rh/client';

import { formatDuration } from '@/lib/time';

import { freshWindow, type Snapshot } from './cache';
import type { ActivityData } from './logs';
import { MARKET_REVALIDATE, getActivitySnapshot, getMarketBundle, type MarketBundle } from './market';
import { VENUE_REVALIDATE, getVenue } from './venue';

export interface WebHealthCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface MarketHealthSources {
  venue: () => Promise<Snapshot<VenueSnapshot>>;
  market: (id: bigint) => Promise<MarketBundle>;
  activity: (id: bigint, settled: boolean, openedAt: number) => Promise<Snapshot<ActivityData>>;
  nowSec: () => number;
}

const LIVE: MarketHealthSources = {
  venue: getVenue,
  market: (id) => getMarketBundle(id, { enhance: false }),
  activity: getActivitySnapshot,
  nowSec: () => Math.floor(Date.now() / 1000),
};

/** At most this many market detail reads per health report (each is cached, so usually none hit the RPC). */
export const MAX_HEALTH_MARKETS = 12;

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 240);

function problem(what: string, snapshot: { readAt: number; stale: boolean; error?: string | null }, now: number, window: number): string | null {
  const age = Math.max(0, now - snapshot.readAt);
  if (snapshot.stale) return `${what}: read failing, last good read ${formatDuration(age)} ago${snapshot.error ? ` (${snapshot.error})` : ''}`;
  if (age > window) return `${what}: last read ${formatDuration(age)} ago (current means within ${formatDuration(window)})`;
  return null;
}

async function marketReads(sources: MarketHealthSources): Promise<{ check: WebHealthCheck; newest: MarketView | null }> {
  let venue: Snapshot<VenueSnapshot>;
  try {
    venue = await sources.venue();
  } catch (error) {
    return { check: { name: 'market-reads', ok: false, detail: `the market list cannot be read: ${reasonOf(error)}` }, newest: null };
  }
  const now = sources.nowSec();
  const failures: string[] = [];
  const venueProblem = problem('market list', venue, now, freshWindow(VENUE_REVALIDATE));
  if (venueProblem !== null) failures.push(venueProblem);

  const markets = venue.data.deployed ? venue.data.markets : [];
  const newest = markets.reduce<MarketView | null>((best, m) => (best === null || m.id > best.id ? m : best), null);
  const open = markets.filter((m) => m.statusCode === MARKET_STATUS.Open).slice(0, MAX_HEALTH_MARKETS);
  const targets = open.length > 0 ? open : newest === null ? [] : [newest];
  if (targets.length === 0) {
    return { check: { name: 'market-reads', ok: failures.length === 0, detail: failures[0] ?? 'no market listed yet' }, newest };
  }

  let oldest = 0;
  await Promise.all(
    targets.map(async (m) => {
      const label = `/m/${m.id}`;
      try {
        const bundle = await sources.market(m.id);
        const issue = problem(label, bundle, sources.nowSec(), freshWindow(MARKET_REVALIDATE));
        if (issue !== null) failures.push(issue);
        else oldest = Math.max(oldest, sources.nowSec() - bundle.readAt);
      } catch (error) {
        failures.push(`${label}: never read (${reasonOf(error)})`);
      }
    }),
  );
  const which = open.length > 0 ? `${targets.length} open market${targets.length === 1 ? '' : 's'}` : `newest market (/m/${targets[0]!.id})`;
  const detail = failures.length > 0 ? failures.sort().join('; ') : `${which} read current (oldest ${formatDuration(Math.max(0, oldest))})`;
  return { check: { name: 'market-reads', ok: failures.length === 0, detail }, newest };
}

async function marketLogs(sources: MarketHealthSources, newest: MarketView | null): Promise<WebHealthCheck> {
  if (newest === null) return { name: 'market-logs', ok: true, detail: 'no market listed yet' };
  const label = `/m/${newest.id}`;
  try {
    const snapshot = await sources.activity(newest.id, newest.statusCode !== MARKET_STATUS.Open, newest.openedAt);
    if (snapshot.stale) {
      return { name: 'market-logs', ok: false, detail: `${label} entry times and links: logs read failing${snapshot.error ? ` (${snapshot.error})` : ''}` };
    }
    const entries = Object.keys(snapshot.data.entries).length;
    return { name: 'market-logs', ok: true, detail: `${label} entry times and links read (${entries} entr${entries === 1 ? 'y' : 'ies'})` };
  } catch (error) {
    return { name: 'market-logs', ok: false, detail: `${label} entry times and links: logs never readable (${reasonOf(error)})` };
  }
}

/** `market-reads` and `market-logs`. Never throws. */
export async function marketHealthChecks(sources: MarketHealthSources = LIVE): Promise<WebHealthCheck[]> {
  const { check, newest } = await marketReads(sources);
  return [check, await marketLogs(sources, newest)];
}
