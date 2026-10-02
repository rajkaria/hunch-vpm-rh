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
import { formatEther, zeroAddress, type Address, type PublicClient } from 'viem';
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

export const MIN_KEEPER_ETH = 1_000_000_000_000_000n; // 0.001 ETH: two to five days of keeper gas at 0.03 gwei
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

/**
 * Keeper USDG floor: the seed float at its busiest, every enabled market open at once:
 * (Σ enabled families over the live feeds) × 2 legs × seed. It is compared with the wallet plus
 * `keeperUsdgInVenue`, not the wallet alone: seeds locked in open markets are still the keeper's.
 * The refund drill is a one-off the operator funds when they run it.
 */
export function keeperUsdgFloor(d: Deployment): bigint {
  const p = deploymentParams(d);
  const markets = d.feeds.filter((f) => f.pendingFlatRateCheck !== true).reduce((n, f) => n + f.families.length, 0);
  return BigInt(markets) * 2n * p.seedPerLeg;
}

/**
 * USDG the keeper still has in the venue: its positions in open markets at offered principal,
 * and what its settled, undelivered positions would pay now. A market whose positions were
 * not read counts its seed when the keeper opened it and it is still open.
 */
export function keeperUsdgInVenue(s: KeeperState): bigint {
  if (s.keeper === null) return 0n;
  const me = s.keeper.address.toLowerCase();
  let total = 0n;
  for (const m of s.markets) {
    const open = m.statusCode === MARKET_STATUS.Open;
    if (m.positions === null) {
      if (open && m.listing.opener.toLowerCase() === me) total += 2n * m.listing.seedPerLeg;
      continue;
    }
    for (const p of m.positions) {
      if (p.position.owner.toLowerCase() !== me || p.position.claimed) continue;
      total += open ? p.position.offered : p.settlement.total;
    }
  }
  return total;
}

const same = (a: Address | null | undefined, b: Address | null | undefined) =>
  a !== null && a !== undefined && b !== null && b !== undefined && a.toLowerCase() === b.toLowerCase();

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
    checks.push({ name: 'keeper-eth', ok: s.keeper.eth >= MIN_KEEPER_ETH, detail: `${formatEther(s.keeper.eth)} ETH (floor ${formatEther(MIN_KEEPER_ETH)})` });
    const floor = keeperUsdgFloor(d);
    const inVenue = keeperUsdgInVenue(s);
    checks.push({
      name: 'keeper-usdg',
      ok: s.keeper.usdg + inVenue >= floor,
      detail: `${formatUsdg(s.keeper.usdg)} USDG in the wallet + ${formatUsdg(inVenue)} in its markets (floor ${formatUsdg(floor)})`,
    });
  }

  // Who holds the venue's powers (D10 wiring; the Safe's two-step ownership).
  const w = s.wiring;
  if (w !== undefined && w !== null) {
    const owned = same(w.factoryOwner, d.safe) && same(w.factoryPendingOwner, zeroAddress);
    checks.push({
      name: 'ownership',
      ok: owned,
      detail: owned
        ? 'the Safe owns the factory'
        : same(w.factoryPendingOwner, d.safe)
          ? `the Safe has not accepted ownership yet: ${w.factoryOwner ?? 'unreadable'} still owns the factory (execute acceptOwnership() from the Safe)`
          : `factory owner ${w.factoryOwner ?? 'unreadable'}, pending ${w.factoryPendingOwner ?? 'unreadable'}; expected the Safe ${d.safe}`,
    });
    const wired = same(w.settlerFactory, d.contracts.HunchMarketFactory.address) && w.keeperIsOpener !== false;
    checks.push({
      name: 'wiring',
      ok: wired,
      detail: wired
        ? `the settler's only creator is the factory${w.keeperIsOpener === true ? '; the keeper is an opener' : ''}${w.pauser !== null && !same(w.pauser, zeroAddress) ? `; pauser ${w.pauser}` : '; no pauser'}`
        : !same(w.settlerFactory, d.contracts.HunchMarketFactory.address)
          ? `HunchVPM.factory() is ${w.settlerFactory ?? 'unreadable'}, not the factory ${d.contracts.HunchMarketFactory.address}: no market can be listed`
          : 'the keeper is not an opener on the factory (setOpener from the Safe)',
    });
  }
  checks.push({
    name: 'entries-paused',
    ok: !s.entriesPaused,
    detail: s.entriesPaused
      ? 'new bets and new markets are paused (claims, refunds and settlement are not); only the Safe resumes'
      : 'new bets and new markets are open',
  });

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
  options: {
    nowSec?: number;
    corporateActions?: readonly CorporateAction[];
    redact?: (text: string) => string;
    /** The keeper key's address in this environment (default: the deployment JSON's keeper). */
    keeper?: Address | null;
    /** The relayer's address when it is a separate key (RELAYER_PRIVATE_KEY). */
    relayer?: Address | null;
  } = {},
): Promise<HealthReport> {
  const redact = options.redact ?? ((t: string) => t);
  try {
    const keeper = options.keeper ?? null;
    const state = await readKeeperState(client, d, {
      ...(options.nowSec === undefined ? {} : { nowSec: options.nowSec }),
      ...(keeper === null ? {} : { keeper }),
    });
    const report = evaluateHealth(state, d, options.corporateActions ?? []);
    if (!state.deployed) return report;
    if (keeper !== null && !same(keeper, d.keeper)) {
      report.checks.push({
        name: 'keeper-key',
        ok: false,
        detail: `the keeper key here is ${keeper}, the deployment JSON names ${d.keeper}: update .keeper, pnpm wire, redeploy`,
      });
    }
    const relayer = options.relayer ?? null;
    if (relayer !== null && !same(relayer, keeper)) {
      const eth = await client.getBalance({ address: relayer });
      report.checks.push({ name: 'relayer-eth', ok: eth >= MIN_KEEPER_ETH, detail: `${formatEther(eth)} ETH on the relayer ${relayer} (floor 0.002)` });
    }
    report.ok = report.checks.every((c) => c.ok);
    return report;
  } catch (error) {
    return {
      ok: false,
      deployed: false,
      nowSec: options.nowSec ?? Math.floor(Date.now() / 1000),
      checks: [{ name: 'rpc', ok: false, detail: redact(`chain unreadable: ${(error as Error).message.split('\n')[0]}`) }],
    };
  }
}
