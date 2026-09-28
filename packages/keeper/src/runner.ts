import {
  approveUsdgCall,
  cachedRoundReader,
  callMany,
  claimForCall,
  decodePreview,
  deploymentParams,
  explorerTxUrl,
  feedByTicker,
  finalizeVintageCall,
  findResolutionRounds,
  hunchMarketFactoryAbi,
  isDeployed,
  maybe,
  openUpDownCall,
  resolveCall,
  roundReaderFromClient,
  stockRoundResolverAbi,
  sweepFeesCall,
  voidPausedCall,
  voidStaleCall,
  voidBadAnswerCall,
  withdrawRefundForCall,
  type Deployment,
} from '@hunch-rh/client';
import type { Abi, Address, Hex, PublicClient, WalletClient } from 'viem';
import type { Alerter } from './alerts.js';
import { loadCorporateActions, type CorporateAction } from './calendar.js';
import { readKeeperState, type KeeperMarket, type KeeperState } from './chainState.js';
import { decideDeliver, type DeliverAction } from './decide/deliver.js';
import { decideOpen, planRefundDrill, type OpenPlan } from './decide/open.js';
import { decideResolve, needsConfirmation, needsResolution, type ResolveAction, type ResolveCandidate, type RoundsOutcome } from './decide/resolve.js';
import { shortError } from './relay.js';

/**
 * The thin runner: read the chain once, decide with the pure functions, act. Every job is
 * idempotent and every action is wrapped on its own, so one failure never stops the rest.
 * Dry runs (and runs without a key) decide and report but send nothing.
 */

export type JobName = 'open' | 'resolve' | 'deliver';
export const JOBS: readonly JobName[] = ['open', 'resolve', 'deliver'];

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export function consoleLogger(redact: (text: string) => string = (t) => t): Logger {
  return {
    info: (m) => console.log(redact(m)),
    warn: (m) => console.warn(redact(m)),
    error: (m) => console.error(redact(m)),
  };
}

export interface RunContext {
  deployment: Deployment;
  publicClient: PublicClient;
  /** Independent reader for the STALE / BADANSWER double-check (defaults to publicClient). */
  fallbackClient?: PublicClient;
  /** null/undefined: read-only (every run is then a dry run). */
  walletClient?: WalletClient | null;
  nowSec?: number;
  dryRun?: boolean;
  log?: Logger;
  alerter?: Alerter;
  redact?: (text: string) => string;
  corporateActions?: readonly CorporateAction[];
  /** Cap on transactions per job run (default 100); the rest waits for the next run. */
  maxActions?: number;
  /** Receipt wait per transaction in ms (default 60 s). */
  receiptTimeoutMs?: number;
}

export type ActionStatus = 'planned' | 'confirmed' | 'failed' | 'skipped';

export interface ActionReport {
  job: JobName | 'drill';
  kind: string;
  target: string;
  status: ActionStatus;
  detail: string;
  txHash?: Hex;
  error?: string;
}

export interface JobReport {
  job: JobName | 'drill';
  deployed: boolean;
  dryRun: boolean;
  nowSec: number;
  actions: ActionReport[];
  notes: string[];
  pages: string[];
}

interface Call {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args: readonly unknown[];
}

function isDry(ctx: RunContext): boolean {
  return ctx.dryRun === true || ctx.walletClient === null || ctx.walletClient === undefined;
}

async function execute(ctx: RunContext, report: JobReport, kind: string, target: string, call: Call, detail: string): Promise<ActionReport> {
  const redact = ctx.redact ?? ((t: string) => t);
  const log = ctx.log ?? silentLogger;
  const action: ActionReport = { job: report.job, kind, target, status: 'planned', detail };
  report.actions.push(action);
  if (isDry(ctx)) {
    log.info(`[${report.job}] would ${kind} ${target}: ${detail}`);
    return action;
  }
  const wallet = ctx.walletClient!;
  try {
    const { request } = await ctx.publicClient.simulateContract({ ...call, account: wallet.account } as never);
    const hash = (await wallet.writeContract(request as never)) as Hex;
    action.txHash = hash;
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: ctx.receiptTimeoutMs ?? 60_000 });
    if (receipt.status === 'success') {
      action.status = 'confirmed';
      log.info(`[${report.job}] ${kind} ${target} confirmed ${explorerTxUrl(hash, ctx.deployment.explorer)}`);
    } else {
      action.status = 'failed';
      action.error = 'reverted';
      log.error(`[${report.job}] ${kind} ${target} reverted ${hash}`);
    }
  } catch (error) {
    action.status = 'failed';
    action.error = redact(shortError(error));
    log.error(`[${report.job}] ${kind} ${target} failed: ${action.error}`);
  }
  return action;
}

async function page(ctx: RunContext, report: JobReport, message: string): Promise<void> {
  const redact = ctx.redact ?? ((t: string) => t);
  const m = redact(message);
  report.pages.push(m);
  (ctx.log ?? silentLogger).warn(`[${report.job}] PAGE ${m}`);
  if (ctx.alerter?.enabled === true) await ctx.alerter.page(m);
}

function newReport(job: JobReport['job'], ctx: RunContext, nowSec: number, deployed: boolean): JobReport {
  return { job, deployed, dryRun: isDry(ctx), nowSec, actions: [], notes: [], pages: [] };
}

export const NOT_DEPLOYED_NOTE =
  'Hunch is not deployed on Robinhood Chain yet (deployments/robinhood-mainnet.json status "not-deployed"); nothing to do.';

// ------------------------------------------------------------------ jobs

/** Approve USDG to the factory for `need` (exact, bounded) if the allowance is short. */
async function ensureSeedAllowance(ctx: RunContext, report: JobReport, state: KeeperState, need: bigint): Promise<boolean> {
  const k = state.keeper;
  if (k === null) return false;
  if (k.allowanceToFactory >= need) return true;
  const a = await execute(
    ctx,
    report,
    'approve',
    `USDG → factory ${need}`,
    approveUsdgCall(ctx.deployment, { amount: need, spender: ctx.deployment.contracts.HunchMarketFactory.address }),
    `seed allowance ${need} base units (exact)`,
  );
  return a.status === 'confirmed' || a.status === 'planned';
}

async function sendOpens(ctx: RunContext, report: JobReport, state: KeeperState, plans: OpenPlan[]): Promise<void> {
  const d = ctx.deployment;
  const params = deploymentParams(d);
  if (plans.length === 0) return;
  const perMarket = 2n * params.seedPerLeg;
  let affordable = plans;
  if (!isDry(ctx)) {
    const account = (ctx.walletClient?.account?.address ?? null) as Address | null;
    if (account !== null) {
      const [isOpener] = await callMany(ctx.publicClient, [{ address: d.contracts.HunchMarketFactory.address, abi: hunchMarketFactoryAbi, functionName: 'openers', args: [account] }]);
      if (maybe<boolean>(isOpener) !== true) {
        await page(ctx, report, `keeper ${account} is not an opener on the factory; ask the Safe to setOpener(${account}, true)`);
        for (const p of plans) report.actions.push({ job: report.job, kind: 'openUpDown', target: p.question, status: 'skipped', detail: 'keeper is not an opener' });
        return;
      }
    }
    const balance = state.keeper?.usdg ?? 0n;
    const n = Number(balance / perMarket);
    if (n < plans.length) {
      affordable = plans.slice(0, n);
      await page(ctx, report, `keeper USDG ${balance} covers ${n} of ${plans.length} markets (seed ${perMarket} each); top up the seed float`);
      for (const p of plans.slice(n)) report.actions.push({ job: report.job, kind: 'openUpDown', target: p.question, status: 'skipped', detail: 'not enough USDG for the seed' });
    }
  }
  if (affordable.length === 0) return;
  const ok = await ensureSeedAllowance(ctx, report, state, BigInt(affordable.length) * perMarket);
  if (!ok) {
    await page(ctx, report, 'could not approve USDG to the factory for seeds');
    return;
  }
  for (const p of affordable.slice(0, ctx.maxActions ?? 100)) {
    await execute(ctx, report, 'openUpDown', p.question, openUpDownCall(d, p.params), p.reason);
  }
}

async function runOpen(ctx: RunContext, state: KeeperState): Promise<JobReport> {
  const report = newReport('open', ctx, state.nowSec, true);
  const d = ctx.deployment;
  const decision = decideOpen({
    nowSec: state.nowSec,
    feeds: d.feeds,
    allowList: new Map(state.feeds.map((f) => [f.feed.toLowerCase(), { allowed: f.allowed === true }])),
    listings: state.markets.map((m) => m.listing),
    corporateActions: ctx.corporateActions ?? loadCorporateActions(),
    params: deploymentParams(d),
  });
  for (const s of decision.skipped) report.notes.push(`${s.ticker} ${s.family}: ${s.reason}`);
  if (state.entriesPaused && decision.open.length > 0) {
    // D10: the pause stops `create` too, so every open would revert. /api/health reports the pause.
    report.notes.push('new bets and new markets are paused: not listing (the Safe resumes)');
    for (const p of decision.open) report.actions.push({ job: report.job, kind: 'openUpDown', target: p.question, status: 'skipped', detail: 'venue paused' });
    return report;
  }
  await sendOpens(ctx, report, state, decision.open);
  return report;
}

function roundsOutcome(r: Awaited<ReturnType<typeof findResolutionRounds>>): RoundsOutcome {
  return r.ok ? { ok: true, strikeRound: r.strikeRound, finalRound: r.finalRound } : { ok: false, problem: r.problem };
}

async function previewStatus(client: PublicClient, d: Deployment, specId: Hex, s: bigint, f: bigint): Promise<number | null> {
  const [r] = await callMany(client, [{ address: d.contracts.StockRoundResolver.address, abi: stockRoundResolverAbi, functionName: 'preview', args: [specId, s, f] }]);
  const v = maybe(r);
  return v === null ? null : decodePreview(v).status;
}

/** Build the resolve candidate for one market: rounds + preview (+ the independent read when STALE or BADANSWER). */
export async function resolutionCandidate(ctx: RunContext, m: KeeperMarket, nowSec: number): Promise<ResolveCandidate> {
  const d = ctx.deployment;
  const redact = ctx.redact ?? ((t: string) => t);
  const c: ResolveCandidate = {
    marketId: m.listing.marketId,
    specId: m.listing.specId,
    ticker: m.ticker,
    finalTime: m.listing.finalTime,
    statusCode: m.statusCode,
    settledByResolver: m.settledByResolver,
  };
  if (!needsResolution(c, nowSec)) return c;
  const spec = {
    feed: m.listing.feed,
    strikeTime: m.listing.strikeTime,
    finalTime: m.listing.finalTime,
    maxStrikeAge: m.listing.maxStrikeAge,
    maxFinalAge: m.listing.maxFinalAge,
  };
  try {
    const rounds = await findResolutionRounds(cachedRoundReader(roundReaderFromClient(ctx.publicClient)), spec);
    c.rounds = roundsOutcome(rounds);
    if (rounds.ok) c.preview = await previewStatus(ctx.publicClient, d, c.specId, rounds.strikeRound, rounds.finalRound);
    if (needsConfirmation(c, nowSec)) {
      const other = ctx.fallbackClient ?? ctx.publicClient;
      try {
        const r2 = await findResolutionRounds(roundReaderFromClient(other), spec);
        c.confirm = { rounds: roundsOutcome(r2), preview: r2.ok ? await previewStatus(other, d, c.specId, r2.strikeRound, r2.finalRound) : null };
      } catch {
        c.confirm = null;
      }
    }
  } catch (error) {
    c.error = redact(shortError(error));
  }
  return c;
}

async function runResolve(ctx: RunContext, state: KeeperState): Promise<JobReport> {
  const report = newReport('resolve', ctx, state.nowSec, true);
  const d = ctx.deployment;
  const due = state.markets.filter((m) => needsResolution({ statusCode: m.statusCode, settledByResolver: m.settledByResolver, finalTime: m.listing.finalTime }, state.nowSec));
  if (due.length === 0) report.notes.push('no market is past its final bell and unsettled');
  for (const m of due) {
    const c = await resolutionCandidate(ctx, m, state.nowSec);
    const action: ResolveAction = decideResolve(c, state.nowSec);
    const target = `#${m.listing.marketId} ${m.ticker} ${m.family}`;
    switch (action.kind) {
      case 'resolve':
        await execute(ctx, report, 'resolve', target, resolveCall(d, action), `${action.why} (rounds ${action.strikeRound} → ${action.finalRound})`);
        break;
      case 'voidStale':
        await execute(ctx, report, 'voidStale', target, voidStaleCall(d, action), action.why);
        break;
      case 'voidBadAnswer':
        await execute(ctx, report, 'voidBadAnswer', target, voidBadAnswerCall(d, action), action.why);
        break;
      case 'voidPaused':
        await execute(ctx, report, 'voidPaused', target, voidPausedCall(d, action.specId), action.why);
        break;
      case 'page':
        report.actions.push({ job: 'resolve', kind: 'page', target, status: 'skipped', detail: action.why });
        await page(ctx, report, action.why);
        break;
      default:
        report.actions.push({ job: 'resolve', kind: action.kind, target, status: 'skipped', detail: action.why });
    }
  }
  return report;
}

async function runDeliver(ctx: RunContext, state: KeeperState): Promise<JobReport> {
  const report = newReport('deliver', ctx, state.nowSec, true);
  const d = ctx.deployment;
  const actions: DeliverAction[] = decideDeliver({
    markets: state.markets
      .filter((m) => m.positions !== null)
      .map((m) => ({
        marketId: m.listing.marketId,
        statusCode: m.statusCode,
        pendingCount: m.pendingCount,
        vintageBlock: m.vintageBlock,
        positions: m.positions!.map(({ id, position, settlement }) => ({ id, ...position, settlement })),
      })),
    l1Block: state.head.l1BlockNumber,
    feesAccrued: state.feesAccrued,
  });
  if (actions.length === 0) report.notes.push('nothing to deliver');
  const max = ctx.maxActions ?? 100;
  if (actions.length > max) report.notes.push(`${actions.length - max} more action(s) wait for the next run`);
  for (const a of actions.slice(0, max)) {
    switch (a.kind) {
      case 'finalizeVintage':
        await execute(ctx, report, a.kind, `#${a.marketId}`, finalizeVintageCall(d, a.marketId), a.why);
        break;
      case 'withdrawRefundFor':
        await execute(ctx, report, a.kind, `#${a.marketId}/${a.positionId} → ${a.owner}`, withdrawRefundForCall(d, a.positionId), `${a.why}: ${a.amount}`);
        break;
      case 'claimFor':
        await execute(ctx, report, a.kind, `#${a.marketId}/${a.positionId} → ${a.owner}`, claimForCall(d, a.positionId), `${a.why}: ${a.amount}`);
        break;
      case 'sweepFees':
        await execute(ctx, report, a.kind, 'treasury', sweepFeesCall(d), a.why);
        break;
    }
  }
  const failed = report.actions.filter((x) => x.status === 'failed');
  if (failed.length > 0) await page(ctx, report, `${failed.length} delivery call(s) failed: ${failed.slice(0, 5).map((x) => `${x.target} (${x.error})`).join('; ')}`);
  return report;
}

/** Run one job, or all three in order (open → resolve → deliver) off one chain read each. */
export async function runJob(job: JobName | 'all', ctx: RunContext): Promise<JobReport[]> {
  const jobs = job === 'all' ? JOBS : [job];
  const nowWall = ctx.nowSec ?? Math.floor(Date.now() / 1000);
  if (!isDeployed(ctx.deployment)) {
    return jobs.map((j) => ({ ...newReport(j, ctx, nowWall, false), notes: [NOT_DEPLOYED_NOTE] }));
  }
  const keeper = (ctx.walletClient?.account?.address as Address | undefined) ?? ctx.deployment.keeper;
  const out: JobReport[] = [];
  for (const j of jobs) {
    try {
      const state = await readKeeperState(ctx.publicClient, ctx.deployment, {
        ...(ctx.nowSec === undefined ? {} : { nowSec: ctx.nowSec }),
        keeper,
        withPositions: j === 'deliver',
      });
      out.push(j === 'open' ? await runOpen(ctx, state) : j === 'resolve' ? await runResolve(ctx, state) : await runDeliver(ctx, state));
    } catch (error) {
      const report = newReport(j, ctx, nowWall, true);
      report.notes.push(`could not read the chain: ${(ctx.redact ?? ((t: string) => t))(shortError(error))}`);
      await page(ctx, report, `${j} job could not read the chain`);
      out.push(report);
    }
  }
  return out;
}

/** The refund drill: plan (read-only) or list it through the factory. */
export async function runDrill(ctx: RunContext, options: { ticker?: string; plan?: boolean } = {}): Promise<JobReport> {
  const d = ctx.deployment;
  const planOnly = options.plan === true;
  const run: RunContext = planOnly ? { ...ctx, dryRun: true, walletClient: null } : ctx;
  // Chain time when deployed (so a fork or a rehearsal plans against its own clock).
  let state: KeeperState | null = null;
  if (isDeployed(d)) {
    const keeper = (ctx.walletClient?.account?.address as Address | undefined) ?? d.keeper;
    state = await readKeeperState(ctx.publicClient, d, { ...(ctx.nowSec === undefined ? {} : { nowSec: ctx.nowSec }), keeper, withPositions: false });
  }
  const nowSec = state?.nowSec ?? ctx.nowSec ?? Math.floor(Date.now() / 1000);
  const report = newReport('drill', run, nowSec, isDeployed(d));
  const feed = feedByTicker(d, options.ticker ?? 'NVDA');
  if (feed === undefined) {
    report.notes.push(`unknown ticker ${options.ticker}`);
    return report;
  }
  const plan = planRefundDrill({ nowSec, feed, params: deploymentParams(d), listings: state?.markets.map((m) => m.listing) ?? [] });
  if (!plan.ok) {
    report.notes.push(plan.reason);
    return report;
  }
  const p = plan.plan.params;
  report.notes.push(
    plan.plan.question,
    `feed ${p.feed} · strikeTime ${p.strikeTime} · finalTime ${p.finalTime} (${plan.saturdayUtc}) · maxStrikeAge ${p.maxStrikeAge} (feed default) · maxFinalAge ${p.maxFinalAge} · seed ${p.seedPerLeg}/leg · caps ${p.minEntry}..${p.maxEntry}`,
  );
  if (state === null) {
    report.notes.push(NOT_DEPLOYED_NOTE);
    return report;
  }
  if (planOnly) return report;
  await sendOpens(run, report, state, [plan.plan]);
  return report;
}

/** One line per action for logs and the CLI. */
export function formatReports(reports: readonly JobReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    lines.push(`== ${r.job} · ${r.dryRun ? 'dry run' : 'live'} · now ${new Date(r.nowSec * 1000).toISOString()}${r.deployed ? '' : ' · not deployed'}`);
    for (const n of r.notes) lines.push(`   note: ${n}`);
    for (const a of r.actions) {
      const tail = a.txHash !== undefined ? ` tx ${a.txHash}` : '';
      const err = a.error !== undefined ? ` error ${a.error}` : '';
      lines.push(`   ${a.status.padEnd(9)} ${a.kind} ${a.target}: ${a.detail}${tail}${err}`);
    }
    for (const p of r.pages) lines.push(`   PAGE ${p}`);
    const count = (s: ActionStatus) => r.actions.filter((a) => a.status === s).length;
    lines.push(`   ${r.actions.length} action(s): ${count('planned')} planned · ${count('confirmed')} confirmed · ${count('failed')} failed · ${count('skipped')} skipped`);
  }
  return lines.join('\n');
}
