import { DOWN, PREVIEW_STATUS, UP, closingBell, loadDeployment, openingBell, type Deployment } from '@hunch-rh/client';
import type { Hex, PublicClient, WalletClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { NOT_DEPLOYED_NOTE, evaluateHealth, formatReports, keeperUsdgFloor, readKeeperState, runDrill, runJob, type RunContext } from '../src/index.js';
import { FACTORY, FakeChain, KEEPER, deployedDeployment } from '../../client/test/support/fakeChain.js';
import { bruteForce, loadRoundFixture, roundsOf } from '../../client/test/support/roundFixtures.js';

const utc = (y: number, m: number, day: number, h: number, min = 0) => Date.UTC(y, m - 1, day, h, min) / 1000;
const fx = Object.fromEntries(['nvda', 'tsla', 'aapl', 'coin'].map((t) => [t, roundsOf(loadRoundFixture(t))]));

function world(nowSec: number) {
  const d = deployedDeployment();
  const chain = new FakeChain(d, nowSec);
  for (const f of d.feeds) chain.addFeed(f.feed, f.ticker, f.stockToken, fx[f.ticker.toLowerCase()]!);
  return { d, chain };
}

function wallet(): WalletClient & { sent: unknown[] } {
  const sent: unknown[] = [];
  let n = 0;
  return {
    account: { address: KEEPER, type: 'local' },
    sent,
    async writeContract(req: unknown) {
      sent.push(req);
      n++;
      return `0x${n.toString(16).padStart(64, '0')}` as Hex;
    },
  } as unknown as WalletClient & { sent: unknown[] };
}

const ctxOf = (d: Deployment, client: PublicClient, over: Partial<RunContext> = {}): RunContext => ({
  deployment: d,
  publicClient: client,
  corporateActions: [],
  ...over,
});

describe('T9 · runner', () => {
  it('not deployed: a clean no-op with a clear message and no chain reads', async () => {
    const { chain } = world(utc(2026, 10, 5, 12, 0));
    const reports = await runJob('all', ctxOf(loadDeployment({ env: {} }), chain.client(), { dryRun: true }));
    expect(reports.map((r) => r.job)).toEqual(['open', 'resolve', 'deliver']);
    expect(reports.every((r) => r.notes[0] === NOT_DEPLOYED_NOTE && r.actions.length === 0)).toBe(true);
    expect(chain.calls).toBe(0);
  });

  it('open (dry run): plans the seed approval and every market; sends nothing', async () => {
    const { d, chain } = world(utc(2026, 10, 5, 12, 0));
    const [report] = await runJob('open', ctxOf(d, chain.client(), { dryRun: true }));
    expect(report!.dryRun).toBe(true);
    expect(report!.actions.map((a) => `${a.status} ${a.kind}`)).toEqual([
      'planned approve',
      ...Array.from({ length: 8 }, () => 'planned openUpDown'), // 4 tickers × daily + weekly
    ]);
    expect(chain.simulated).toEqual([]);
    expect(formatReports([report!])).toContain('Will NVDA close UP today? · Mon Oct 5');
  });

  it('open (live): approves USDG to the factory (exact) before seeding, then lists each market', async () => {
    const { d, chain } = world(utc(2026, 10, 5, 12, 0));
    chain.usdgBalances.set(KEEPER.toLowerCase(), 1_000_000_000n);
    const w = wallet();
    const [report] = await runJob('open', ctxOf(d, chain.client(), { walletClient: w }));
    expect(report!.actions.every((a) => a.status === 'confirmed')).toBe(true);
    expect(chain.simulated[0]).toMatchObject({ address: d.usdg, functionName: 'approve', args: [FACTORY, 8n * 20_000_000n] });
    expect(chain.simulated.slice(1).map((c) => c.functionName)).toEqual(Array.from({ length: 8 }, () => 'openUpDown'));
    expect(w.sent.length).toBe(9);
  });

  it('open (live): skips the approval when the allowance covers the seeds; pages when the float is short', async () => {
    const { d, chain } = world(utc(2026, 10, 5, 12, 0));
    chain.usdgBalances.set(KEEPER.toLowerCase(), 45_000_000n); // covers 2 markets
    chain.allowances.set(`${KEEPER.toLowerCase()}:${FACTORY.toLowerCase()}`, 10n ** 12n);
    const [report] = await runJob('open', ctxOf(d, chain.client(), { walletClient: wallet() }));
    expect(chain.simulated.map((c) => c.functionName)).toEqual(['openUpDown', 'openUpDown']);
    expect(report!.actions.filter((a) => a.status === 'skipped').length).toBe(6);
    expect(report!.pages[0]).toMatch(/covers 2 of 8 markets/);
  });

  it('open (live): pages instead of sending when the keeper is not an opener', async () => {
    const { d, chain } = world(utc(2026, 10, 5, 12, 0));
    chain.openers.clear();
    chain.usdgBalances.set(KEEPER.toLowerCase(), 1_000_000_000n);
    const [report] = await runJob('open', ctxOf(d, chain.client(), { walletClient: wallet() }));
    expect(chain.simulated).toEqual([]);
    expect(report!.pages[0]).toMatch(/not an opener/);
  });

  it('resolve: proves both rounds from the feed, previews, resolves; STALE needs the independent read', async () => {
    const final = closingBell('2026-09-24');
    const { d, chain } = world(final + 300);
    const nvda = d.feeds[0]!.feed;
    const m = chain.open({ feed: nvda, strikeTime: openingBell('2026-09-24'), finalTime: final });
    chain.enter(m, { owner: KEEPER, outcome: DOWN, amount: 1_000_000n, block: 5n });
    const [report] = await runJob('resolve', ctxOf(d, chain.client(), { dryRun: true }));
    const a = report!.actions[0]!;
    expect(a.kind).toBe('resolve');
    const s = bruteForce(fx.nvda!, BigInt(openingBell('2026-09-24')))!.roundId;
    const f = bruteForce(fx.nvda!, BigInt(final))!.roundId;
    expect(a.detail).toContain(`rounds ${s} → ${f}`);

    // Make the resolver say STALE for those rounds.
    chain.previews.set(`${chain.markets[m]!.specId}:${s}:${f}`, [PREVIEW_STATUS.STALE, 0n, 0n, 0n, 0n]);
    const [early] = await runJob('resolve', ctxOf(d, chain.client(), { dryRun: true }));
    expect(early!.actions[0]).toMatchObject({ kind: 'wait', status: 'skipped' });
    chain.now = final + 1000;
    const [late] = await runJob('resolve', ctxOf(d, chain.client(), { dryRun: true, fallbackClient: chain.client() }));
    expect(late!.actions[0]).toMatchObject({ kind: 'voidStale', status: 'planned' });
  });

  it('deliver: finalizes a past vintage, pushes every winning payout and seed, one call each', async () => {
    const { d, chain } = world(utc(2026, 9, 25, 21, 0));
    const nvda = d.feeds[0]!.feed;
    const settled = chain.open({ feed: nvda, strikeTime: openingBell('2026-09-24'), finalTime: closingBell('2026-09-24') });
    chain.enter(settled, { owner: '0x0000000000000000000000000000000000000A11' as `0x${string}`, outcome: UP, amount: 5_000_000n, block: 10n });
    chain.enter(settled, { owner: '0x0000000000000000000000000000000000000b0B' as `0x${string}`, outcome: DOWN, amount: 5_000_000n, block: 11n });
    chain.l1 = 20n;
    chain.resolve(settled, UP);
    const open = chain.open({ feed: nvda, strikeTime: openingBell('2026-09-25'), finalTime: closingBell('2026-09-28') });
    chain.enter(open, { owner: KEEPER, outcome: UP, amount: 2_000_000n, block: 20n });
    chain.l1 = 21n;
    const [report] = await runJob('deliver', ctxOf(d, chain.client(), { dryRun: true }));
    expect(report!.actions.map((a) => a.kind)).toEqual(['finalizeVintage', 'claimFor', 'claimFor']);
    expect(report!.actions[1]!.target).toMatch(/→ 0x00000000000000000000000000000000000000[Cc]1/); // the seed UP leg back to the opener
  });

  it('plan-drill and open-drill', async () => {
    const { d, chain } = world(utc(2026, 10, 1, 12, 0));
    const plan = await runDrill(ctxOf(d, chain.client()), { plan: true });
    expect(plan.dryRun).toBe(true);
    expect(plan.notes[0]).toBe("Refund drill: NVDA UP from Friday's open to 2:00 am ET Saturday?");
    expect(plan.actions).toEqual([]);
    chain.usdgBalances.set(KEEPER.toLowerCase(), 100_000_000n);
    const live = await runDrill(ctxOf(d, chain.client(), { walletClient: wallet() }), {});
    expect(live.actions.map((a) => `${a.status} ${a.kind}`)).toEqual(['confirmed approve', 'confirmed openUpDown']);
    const sent = chain.simulated[1]!.args[0] as { maxFinalAge: number; finalTime: bigint };
    expect(sent.maxFinalAge).toBe(3600);
    expect(sent.finalTime).toBe(BigInt(utc(2026, 10, 3, 6, 0)));
  });
});

describe('T9 · health', () => {
  it('not deployed: green with a truthful note', async () => {
    const { chain } = world(utc(2026, 10, 5, 12, 0));
    const d = loadDeployment({ env: {} });
    const state = await readKeeperState(chain.client(), d);
    const h = evaluateHealth(state, d);
    expect(h.ok).toBe(true);
    expect(h.checks[0]).toMatchObject({ name: 'deployment', ok: true });
  });

  it('deployed: balances, today’s markets after 13:25 UTC, settlement and delivery lag', async () => {
    const now = utc(2026, 9, 25, 14, 0); // Fri, after the bell
    const { d, chain } = world(now);
    chain.usdgBalances.set(KEEPER.toLowerCase(), keeperUsdgFloor(d));
    let h = evaluateHealth(await readKeeperState(chain.client(), d), d);
    expect(h.checks.find((c) => c.name === 'todays-markets')).toMatchObject({ ok: false });
    expect(h.checks.find((c) => c.name === 'todays-markets')!.detail).toMatch(/NVDA, TSLA, AAPL, COIN/);
    expect(h.checks.find((c) => c.name === 'keeper-usdg')!.ok).toBe(true);
    expect(h.checks.find((c) => c.name === 'keeper-eth')!.ok).toBe(true);
    for (const f of d.feeds) chain.open({ feed: f.feed, strikeTime: openingBell('2026-09-25'), finalTime: closingBell('2026-09-25') });
    // An old market nobody resolved:
    chain.open({ feed: d.feeds[0]!.feed, strikeTime: openingBell('2026-09-24'), finalTime: closingBell('2026-09-24') });
    h = evaluateHealth(await readKeeperState(chain.client(), d), d);
    expect(h.checks.find((c) => c.name === 'todays-markets')!.ok).toBe(true);
    expect(h.checks.find((c) => c.name === 'settlement')).toMatchObject({ ok: false });
    expect(h.ok).toBe(false);
    chain.l1 = 50n;
    chain.resolve(4, UP);
    h = evaluateHealth(await readKeeperState(chain.client(), d), d);
    expect(h.checks.find((c) => c.name === 'settlement')!.ok).toBe(true);
    expect(h.checks.find((c) => c.name === 'delivery')).toMatchObject({ ok: false }); // the seed UP leg is undelivered
    chain.usdgBalances.set(KEEPER.toLowerCase(), 0n);
    expect(evaluateHealth(await readKeeperState(chain.client(), d), d).checks.find((c) => c.name === 'keeper-usdg')!.ok).toBe(false);
  });

  it('keeper-usdg counts the seeds in its markets: wallet + open seeds + undelivered payouts', async () => {
    const now = utc(2026, 9, 25, 15, 0); // Fri, in session
    const { d, chain } = world(now);
    const floor = keeperUsdgFloor(d);
    expect(floor).toBe((4n * 2n + 1n) * 2n * 10_000_000n); // (4 tickers × daily + weekly + drill) × 2 legs × seed
    const usdg = async () => evaluateHealth(await readKeeperState(chain.client(), d), d).checks.find((c) => c.name === 'keeper-usdg')!;
    // Today's four dailies are listed: 80 USDG of seed left the wallet but is still the keeper's.
    const ids = d.feeds.map((f) => chain.open({ feed: f.feed, strikeTime: openingBell('2026-09-25'), finalTime: closingBell('2026-09-25') }));
    chain.usdgBalances.set(KEEPER.toLowerCase(), floor - 80_000_000n);
    let c = await usdg();
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/100\.00 USDG in the wallet \+ 80\.00 in its markets \(floor 180\.00\)/);
    // A market another opener listed is not the keeper's float.
    chain.open({ feed: d.feeds[0]!.feed, strikeTime: openingBell('2026-09-25'), finalTime: closingBell('2026-09-25'), opener: '0x0000000000000000000000000000000000000C0C' });
    expect((await usdg()).detail).toMatch(/\+ 80\.00 in its markets/);
    // Settled, not yet delivered: the winning seed leg still counts (2 × seed: both legs, no bets), the losing leg is gone.
    chain.l1 = 50n;
    chain.resolve(ids[0]!, UP);
    c = await usdg();
    expect(c.detail).toMatch(/\+ 79\.80 in its markets/); // 60 open + the UP leg's 20.00 gross less the 2% fee on its 10.00 gain
    expect(c.ok).toBe(false);
    // The float erodes below the floor: red.
    chain.usdgBalances.set(KEEPER.toLowerCase(), 0n);
    expect((await usdg()).ok).toBe(false);
  });

  it('RPC head age and feed freshness during a session', async () => {
    const now = utc(2026, 9, 25, 15, 0);
    const { d, chain } = world(now);
    const state = await readKeeperState(chain.client(), d);
    expect(evaluateHealth({ ...state, nowSec: now + 120 }, d).checks.find((c) => c.name === 'rpc-head')!.ok).toBe(false);
    const stale = { ...state, feeds: state.feeds.map((f, i) => (i === 0 ? { ...f, updatedAt: now - 100_000 } : f)) };
    const fresh = evaluateHealth(stale, d).checks.find((c) => c.name === 'feed-freshness')!;
    expect(fresh.ok).toBe(false);
    expect(fresh.detail).toMatch(/NVDA/);
  });
});
