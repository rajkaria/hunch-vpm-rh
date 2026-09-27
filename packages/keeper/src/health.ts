import {
  DEFAULT_MAX_AGE,
  MARKET_STATUS,
  deploymentParams,
  etDateOf,
  formatDuration,
  formatUsdg,
  isCovered,
  isTradingDay,
  sessionInProgress,
  sessionOn,
  type Deployment,
} from '@hunch-rh/client';
import { formatEther, type PublicClient } from 'viem';
import type { CorporateAction } from './calendar.js';
import { readKeeperState, type KeeperState } from './chainState.js';
import { decideOpen } from './decide/open.js';

/**
 * `/api/health` (docs/spec/06 §Health). Every check is derived from chain state, so a
 * stateless serverless keeper can answer it: 200 only if all checks pass.
 *
 * Stateless substitutes (documented): "last successful open run" becomes "today's markets
 * exist after the opening bell − 5 min"; "settled market with an undelivered claim older
 * than 20 min" is measured from the final bell + 30 min (the settle deadline), i.e. a
 * deliverable claim 50 min after the bell fails; the relayer check is omitted (no state).
 */

export const MIN_KEEPER_ETH = 2_000_000_000_000_000n; // 0.002 ETH
export const RPC_HEAD_MAX_AGE_SEC = 60;
export const SETTLE_DEADLINE_SEC = 30 * 60;
export const DELIVER_DEADLINE_SEC = SETTLE_DEADLINE_SEC + 20 * 60;
export const OPEN_DEADLINE_BEFORE_BELL_SEC = 5 * 60;

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HealthReport {
  ok: boolean;
  deployed: boolean;
  nowSec: number;
  checks: HealthCheck[];
}

/** Keeper USDG floor: tickers × 2 open markets × (2 × seed) + 40 USDG. */
export function keeperUsdgFloor(d: Deployment): bigint {
  const p = deploymentParams(d);
  const tickers = BigInt(d.feeds.filter((f) => f.pendingFlatRateCheck !== true).length);
  return tickers * 2n * 2n * p.seedPerLeg + 40_000_000n;
}

export function evaluateHealth(s: KeeperState, d: Deployment, corporateActions: readonly CorporateAction[] = []): HealthReport {
  const checks: HealthCheck[] = [];
  const now = s.nowSec;
  const headAge = now - s.head.timestamp;
  checks.push({ name: 'rpc-head', ok: headAge < RPC_HEAD_MAX_AGE_SEC, detail: `latest block is ${formatDuration(Math.max(0, headAge))} old` });

  // Feeds: during a regular session, every live feed must be younger than 26 h.
  const today = etDateOf(now);
  const inSession = isCovered(today) && sessionInProgress(now) !== null;
  const stale = s.feeds.filter((f) => (f.allowed ?? true) && (f.updatedAt === null || now - f.updatedAt > DEFAULT_MAX_AGE));
  checks.push({
    name: 'feed-freshness',
    ok: !inSession || stale.length === 0,
    detail: !inSession
      ? 'outside the regular session (feeds are deviation-driven; checked during sessions)'
      : stale.length === 0
        ? 'every feed printed within 26 h'
        : `older than 26 h: ${stale.map((f) => `${f.ticker}${f.updatedAt === null ? ' (unreadable)' : ` (${formatDuration(now - f.updatedAt)})`}`).join(', ')}`,
  });

  if (!s.deployed) {
    checks.unshift({ name: 'deployment', ok: true, detail: 'not deployed yet: nothing to keep' });
    return { ok: checks.every((c) => c.ok), deployed: false, nowSec: now, checks };
  }

  if (s.keeper !== null) {
    checks.push({ name: 'keeper-eth', ok: s.keeper.eth >= MIN_KEEPER_ETH, detail: `${formatEther(s.keeper.eth)} ETH (floor 0.002)` });
    const floor = keeperUsdgFloor(d);
    checks.push({ name: 'keeper-usdg', ok: s.keeper.usdg >= floor, detail: `${formatUsdg(s.keeper.usdg)} USDG (floor ${formatUsdg(floor)})` });
  }

  // Today's markets exist once the opening bell is 5 min away.
  const session = isCovered(today) && isTradingDay(today) ? sessionOn(today) : null;
  if (session !== null && now >= session.open - OPEN_DEADLINE_BEFORE_BELL_SEC) {
    const missing = decideOpen({
      nowSec: session.open - OPEN_DEADLINE_BEFORE_BELL_SEC - 1,
      feeds: d.feeds,
      allowList: new Map(s.feeds.map((f) => [f.feed.toLowerCase(), { allowed: f.allowed === true }])),
      listings: s.markets.map((m) => m.listing),
      corporateActions,
      params: deploymentParams(d),
    }).open.filter((p) => p.family === 'daily');
    checks.push({
      name: 'todays-markets',
      ok: missing.length === 0,
      detail: missing.length === 0 ? `today's daily markets are listed (${today})` : `missing today's daily: ${missing.map((m) => m.ticker).join(', ')}`,
    });
  } else {
    checks.push({ name: 'todays-markets', ok: true, detail: session === null ? `${today} is not a trading day` : 'before the listing deadline' });
  }

  const unsettled = s.markets.filter((m) => m.statusCode === MARKET_STATUS.Open && now > m.listing.finalTime + SETTLE_DEADLINE_SEC);
  checks.push({
    name: 'settlement',
    ok: unsettled.length === 0,
    detail:
      unsettled.length === 0
        ? 'no market is unsettled 30 min past its bell'
        : `unsettled 30 min after the bell: ${unsettled.map((m) => `#${m.listing.marketId} ${m.ticker}`).join(', ')}`,
  });

  const late = s.markets.flatMap((m) =>
    m.statusCode !== MARKET_STATUS.Open && now > m.listing.finalTime + DELIVER_DEADLINE_SEC
      ? (m.positions ?? []).filter((p) => !p.position.claimed && p.settlement.deliverable).map((p) => `#${m.listing.marketId}/${p.id}`)
      : [],
  );
  checks.push({
    name: 'delivery',
    ok: late.length === 0,
    detail: late.length === 0 ? 'every settled payout and refund is delivered' : `undelivered: ${late.slice(0, 20).join(', ')}${late.length > 20 ? ' …' : ''}`,
  });

  return { ok: checks.every((c) => c.ok), deployed: true, nowSec: now, checks };
}

export async function checkHealth(
  client: PublicClient,
  d: Deployment,
  options: { nowSec?: number; corporateActions?: readonly CorporateAction[]; redact?: (text: string) => string } = {},
): Promise<HealthReport> {
  const redact = options.redact ?? ((t: string) => t);
  try {
    const state = await readKeeperState(client, d, options.nowSec === undefined ? {} : { nowSec: options.nowSec });
    return evaluateHealth(state, d, options.corporateActions ?? []);
  } catch (error) {
    return {
      ok: false,
      deployed: false,
      nowSec: options.nowSec ?? Math.floor(Date.now() / 1000),
      checks: [{ name: 'rpc', ok: false, detail: redact(`chain unreadable: ${(error as Error).message.split('\n')[0]}`) }],
    };
  }
}
