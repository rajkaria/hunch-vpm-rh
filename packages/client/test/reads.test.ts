import { getAddress, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  DOWN,
  MARKET_STATUS,
  UP,
  closingBell,
  loadDeployment,
  openingBell,
  quoteForMarket,
  readListings,
  readMarket,
  readPositionsByOwner,
  readPrices,
  readProof,
  readVenue,
} from '../src/index.js';
import { FakeChain, KEEPER, deployedDeployment } from './support/fakeChain.js';
import { bruteForce, loadRoundFixture, roundsOf } from './support/roundFixtures.js';

const ALICE: Address = getAddress('0x000000000000000000000000000000000000a11c');
const BOB: Address = getAddress('0x0000000000000000000000000000000000000b0b');
const CAROL: Address = getAddress('0x00000000000000000000000000000000000ca201');

const fx = Object.fromEntries(['nvda', 'tsla', 'aapl', 'coin'].map((t) => [t, loadRoundFixture(t)]));
const nvdaRounds = roundsOf(fx.nvda!);

function world() {
  const d = deployedDeployment();
  const nowSec = Date.UTC(2026, 8, 25, 17, 0) / 1000; // Fri 13:00 ET
  const chain = new FakeChain(d, nowSec);
  for (const f of d.feeds) chain.addFeed(f.feed, f.ticker, f.stockToken, roundsOf(fx[f.ticker.toLowerCase()]!));
  const nvda = d.feeds[0]!.feed;
  const tsla = d.feeds[1]!.feed;

  const weekly = chain.open({ feed: nvda, strikeTime: openingBell('2026-09-21'), finalTime: closingBell('2026-09-25') });
  chain.enter(weekly, { owner: ALICE, outcome: UP, amount: 20_000_000n, block: 1001n });
  chain.enter(weekly, { owner: BOB, outcome: DOWN, amount: 30_000_000n, block: 1002n });
  chain.finalize(weekly, 1003n);

  const thu = chain.open({ feed: nvda, strikeTime: openingBell('2026-09-24'), finalTime: closingBell('2026-09-24') });
  const aliceThu = chain.enter(thu, { owner: ALICE, outcome: UP, amount: 5_000_000n, block: 900n });
  chain.enter(thu, { owner: CAROL, outcome: DOWN, amount: 5_000_000n, block: 901n });
  chain.l1 = 950n;
  chain.resolve(thu, UP);

  const tslaThu = chain.open({ feed: tsla, strikeTime: openingBell('2026-09-24'), finalTime: closingBell('2026-09-24') });
  chain.enter(tslaThu, { owner: CAROL, outcome: UP, amount: 2_000_000n, block: 910n });
  chain.l1 = 960n;
  chain.void(tslaThu);

  chain.l1 = 1004n;
  const fri = chain.open({ feed: nvda, strikeTime: openingBell('2026-09-25'), finalTime: closingBell('2026-09-25') });
  chain.enter(fri, { owner: BOB, outcome: UP, amount: 7_000_000n, block: 1004n }); // pending in the current L1 block
  const mon = chain.open({ feed: nvda, strikeTime: openingBell('2026-09-28'), finalTime: closingBell('2026-09-28') });
  return { d, chain, nowSec, ids: { weekly, thu, tslaThu, fri, mon, aliceThu } };
}

describe('readVenue', () => {
  it('assembles every market from views only, newest first, with statuses, questions and prices', async () => {
    const { d, chain, nowSec } = world();
    const v = await readVenue(chain.client(), d);
    expect(v.deployed).toBe(true);
    expect(v.nowSec).toBe(nowSec);
    expect(v.listingCount).toBe(5);
    expect(v.head?.l1BlockNumber).toBe(1004n);
    expect(v.markets.map((m) => m.id)).toEqual([4n, 3n, 2n, 1n, 0n]);
    const byId = new Map(v.markets.map((m) => [m.id, m]));

    const weekly = byId.get(0n)!;
    expect(weekly.status).toBe('Live');
    expect(weekly.family).toBe('weekly');
    expect(weekly.ticker).toBe('NVDA');
    expect(weekly.question).toBe('Will NVDA finish the week UP? · Mon Sep 21 → Fri Sep 25');
    expect(weekly.acceptingBets).toBe(true);
    const strike = bruteForce(nvdaRounds, BigInt(openingBell('2026-09-21')))!;
    expect(weekly.strike).toEqual({ price: strike.answer, roundId: strike.roundId, updatedAt: Number(strike.updatedAt) });
    expect(weekly.live?.roundId).toBe(bruteForce(nvdaRounds, BigInt(nowSec))!.roundId);
    expect(weekly.change?.direction).toMatch(/UP|DOWN|FLAT/);
    expect(weekly.totals).toMatchObject({ pool: 70_000_000n, up: 30_000_000n, down: 50_000_000n - 10_000_000n });
    expect(weekly.totals.upPpm + weekly.totals.downPpm).toBeLessThanOrEqual(1_000_000n);
    expect(weekly.feeBps).toBe(200);
    expect(weekly.rules.text).toContain("Chainlink's NVDA Stock Token price in effect at 9:30 am ET on Monday, September 21");

    expect(byId.get(1n)!.status).toBe('Resolved UP');
    expect(byId.get(1n)!.winner).toBe(UP);
    expect(byId.get(2n)!.status).toBe('Void');
    expect(byId.get(2n)!.ticker).toBe('TSLA');
    expect(byId.get(3n)!.status).toBe('Live');
    expect(byId.get(3n)!.totals.pendingUp).toBe(7_000_000n);
    expect(byId.get(3n)!.headroom.up).toBe(290_000_000n - 7_000_000n);
    const mon = byId.get(4n)!;
    expect(mon.status).toBe('Opens');
    expect(mon.strike).toBeNull();
    expect(mon.question).toBe('Will NVDA close UP today? · Mon Sep 28');

    const active = await readVenue(chain.client(), d, { include: 'active' });
    expect(active.markets.map((m) => m.id)).toEqual([4n, 3n, 0n]);
    chain.entriesPaused = true;
    expect((await readVenue(chain.client(), d, { strikes: false })).markets.every((m) => !m.acceptingBets)).toBe(true);
  });

  it('degrades to the not-deployed state without touching the chain', async () => {
    const { chain } = world();
    const before = chain.calls;
    const v = await readVenue(chain.client(), loadDeployment({ env: {} }));
    expect(v).toMatchObject({ deployed: false, markets: [], listingCount: 0 });
    expect(chain.calls).toBe(before);
    expect(await readListings(chain.client(), loadDeployment({ env: {} }))).toEqual([]);
  });
});

describe('readMarket', () => {
  it('returns positions with settlement, classic column and the resolution panel', async () => {
    const { d, chain, ids } = world();
    const m = (await readMarket(chain.client(), d, BigInt(ids.thu)))!;
    expect(m.status).toBe('Resolved UP');
    expect(m.positions.map((p) => [p.side, p.isSeed, p.isOpener])).toEqual([
      ['UP', true, true],
      ['DOWN', true, true],
      ['UP', false, false],
      ['DOWN', false, false],
    ]);
    const alice = m.positions.find((p) => p.owner === ALICE)!;
    expect(alice.accepted).toBe(5_000_000n);
    expect(alice.settlement.deliverable).toBe(true);
    expect(alice.settlement.net).toBe(alice.settlement.gross - alice.settlement.fee);
    expect(alice.accrued).toBe(alice.settlement.gross);
    expect(alice.classicPayout).toBe((30_000_000n * 5_000_000n) / 15_000_000n);
    const carol = m.positions.find((p) => p.owner === CAROL)!;
    expect(carol.settlement.total).toBe(0n);
    // resolution panel: both rounds proven from the captured series, preview read
    expect(m.resolution?.rounds.ok).toBe(true);
    if (m.resolution?.rounds.ok) {
      expect(m.resolution.rounds.strikeRound).toBe(bruteForce(nvdaRounds, BigInt(openingBell('2026-09-24')))!.roundId);
      expect(m.resolution.rounds.finalRound).toBe(bruteForce(nvdaRounds, BigInt(closingBell('2026-09-24')))!.roundId);
    }
    expect(m.resolution?.preview?.status).toBeGreaterThan(0);
    expect(await readMarket(chain.client(), d, 99n)).toBeNull();
  });

  it('quotes against the open vintage of the current L1 block', async () => {
    const { d, chain, ids } = world();
    for (let i = 0; i < 3; i++) chain.enter(ids.fri, { owner: CAROL, outcome: UP, amount: 100_000_000n, block: 1004n });
    const m = (await readMarket(chain.client(), d, BigInt(ids.fri)))!;
    expect(m.vintageBlock).toBe(1004n);
    expect(m.resolution).toBeNull();
    const pending = m.positions.find((p) => !p.finalized)!;
    expect(pending.accepted).toBeNull();
    // 307 USDG queued on UP in this L1 block: a 100 UP entry is rationed with it: 100·290/407.
    const q = quoteForMarket(m, 100_000_000n, UP);
    expect(q.accepted).toBe((100_000_000n * 290_000_000n) / 407_000_000n);
    expect(q.headroom).toBe(0n);
    // In the next L1 block the queue is finalized first (290 accepted in total), leaving no room on DOWN's book.
    chain.l1 = 1005n;
    const later = (await readMarket(chain.client(), d, BigInt(ids.fri)))!;
    const q2 = quoteForMarket(later, 100_000_000n, UP);
    // 307 rationed to 290 leaves only floor-division dust: 300 − 10 − Σ floor(c·290/307) = 3 micro-USDG.
    expect(q2.accepted).toBe(3n);
    expect(q2.refused).toBe(100_000_000n - 3n);
    // DOWN is not competing with it.
    expect(quoteForMarket(m, 100_000_000n, DOWN).accepted).toBe(100_000_000n);
    expect(quoteForMarket(m, 100_000_001n, DOWN).problem).toBe('above-max');
  });
});

describe('readPositionsByOwner', () => {
  it("finds a wallet's positions across markets with totals", async () => {
    const { d, chain, ids } = world();
    const pf = await readPositionsByOwner(chain.client(), d, ALICE);
    expect(pf.positions.map((p) => p.market.id).sort()).toEqual([0n, 1n]);
    expect(pf.totals.staked).toBe(25_000_000n);
    expect(pf.totals.open).toBe(1);
    const resolved = pf.positions.find((p) => p.market.id === 1n)!;
    expect(pf.totals.deliverable).toBe(resolved.position.settlement.total);
    chain.claim(ids.aliceThu);
    const after = await readPositionsByOwner(chain.client(), d, ALICE);
    expect(after.totals.deliverable).toBe(0n);
    expect(after.totals.paidOut).toBe(resolved.position.settlement.net);
    expect((await readPositionsByOwner(chain.client(), d, '0x0000000000000000000000000000000000000fff')).positions).toEqual([]);
  });
});

describe('readProof', () => {
  it('counts markets, distinct bettors (excluding the opener/keeper/Safe), stake and fees', async () => {
    const { d, chain, ids } = world();
    chain.enter(ids.weekly, { owner: KEEPER, outcome: UP, amount: 3_000_000n, block: 1004n }); // operator bet
    chain.claim(ids.aliceThu);
    const p = await readProof(chain.client(), d, { strikes: false });
    expect(p.counts).toEqual({ marketsOpened: 5, marketsOpen: 3, marketsResolved: 1, marketsVoided: 1, marketsSettled: 2 });
    expect(p.bettors.distinct).toBe(3);
    expect(p.bettors.operatorBets).toBe(1);
    expect(p.bettors.bets).toBe(6);
    expect(p.usdg.staked).toBe(20_000_000n + 30_000_000n + 5_000_000n + 5_000_000n + 2_000_000n + 7_000_000n);
    expect(p.usdg.seeded).toBe(5n * 20_000_000n);
    expect(p.usdg.feesTaken).toBe(chain.feesAccrued);
    expect(p.usdg.feesSwept).toBe(0n);
    expect(p.usdg.paidToBettors).toBeGreaterThan(5_000_000n);
    expect(p.safe).toMatchObject({ threshold: 2 });
    expect(p.markets.length).toBe(5);
    expect(chain.client()).toBeTruthy();
    expect(MARKET_STATUS.Resolved).toBe(1);
  });
});

describe('readPrices', () => {
  it('reads every v1 feed before deployment (landing page tape)', async () => {
    const { chain, nowSec } = world();
    const pre = await readPrices(chain.client(), loadDeployment({ env: {} }));
    expect(pre.deployed).toBe(false);
    expect(pre.rows.map((r) => r.ticker)).toEqual(['NVDA', 'TSLA', 'AAPL', 'COIN']);
    for (const r of pre.rows) {
      expect(r.price).toBe(bruteForce(roundsOf(fx[r.ticker.toLowerCase()]!), BigInt(nowSec))!.answer);
      expect(r.allowListed).toBeNull();
      expect(r.oraclePaused).toBe(false);
      expect(r.ageSec).toBeGreaterThanOrEqual(0);
    }
    expect(pre.rows.find((r) => r.ticker === 'COIN')!.pendingFlatRateCheck).toBe(false); // passed measure-feeds on 2026-09-28
  });

  it('adds allow-list state once deployed', async () => {
    const { d, chain } = world();
    const post = await readPrices(chain.client(), d);
    expect(post.rows.every((r) => r.allowListed === true)).toBe(true);
  });
});
