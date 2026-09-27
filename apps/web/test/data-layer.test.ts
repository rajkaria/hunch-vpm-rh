// @vitest-environment node
import { DOWN, UP } from '@hunch-rh/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decode, encode, toJsonSafe } from '@/lib/codec';
import { marketDetailJson, marketJson, phaseOf } from '@/lib/api/shapes';
import { blockedReason, primaryAction, quoteProblem } from '@/lib/market/bet-flow';
import { matchStateOf, reviveMarket } from '@/lib/market/model';
import { ReadUnavailableError, cachedRead, clearLastGood } from '@/lib/server/cache';
import { gridMarkets, toCard } from '@/lib/server/venue';

import { ALICE, BOB, marketFixture } from './fixtures/market';

const USDG = 1_000_000n;

afterEach(() => {
  clearLastGood();
  vi.restoreAllMocks();
});

describe('bigints across JSON', () => {
  it('round-trips exactly for the cache, and becomes decimal strings for the API', () => {
    const value = { a: 2n ** 200n, b: [1n, { c: -5n }], d: 'x', e: null, f: 3 };
    expect(decode(JSON.parse(JSON.stringify(encode(value))))).toEqual(value);
    expect(toJsonSafe({ a: 1n, m: new Map([[1n, 2n]]), u: undefined })).toEqual({ a: '1', m: [['1', '2']] });
  });
});

describe('API shapes from a real-shaped market', () => {
  it('maps the client view to the documented shape (strings for amounts, words for outcomes)', () => {
    const detail = marketFixture();
    const json = marketDetailJson(detail, { activity: null, log: null, readAt: 1, stale: false });
    expect(json.market).toMatchObject({ id: '12', href: '/m/12', ticker: 'NVDA', family: 'daily', phase: 'live', status: 'Live', winner: null });
    expect(json.market.pool).toEqual({ up: detail.totals.up.toString(), down: detail.totals.down.toString() });
    expect(json.market.limits).toEqual({ minEntry: '1000000', maxEntry: '100000000', feeBps: 200 });
    expect(json.positions).toHaveLength(detail.positions.length);
    expect(json.positions[0]).toMatchObject({ id: '0', seed: true, side: 'UP', opener: true });
    expect(json.positions[2]).toMatchObject({ owner: ALICE, side: 'UP', offered: '20000000', seed: false, payout: null, enteredAt: null });
    expect(json.resolution).toBeNull();
    expect(JSON.stringify(json)).not.toMatch(/"\d+n"/);
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  it('says how a settled market settled', () => {
    const up = marketDetailJson(marketFixture({ outcome: 'UP' }), { activity: null, log: null, readAt: 1, stale: false });
    expect(up.market.phase).toBe('resolved');
    expect(up.resolution).toMatchObject({ outcome: 'UP', reason: null });
    expect(up.positions.find((p) => p.side === 'UP' && !p.seed)?.payout).not.toBeNull();
    const voided = marketDetailJson(marketFixture({ outcome: 'VOID' }), { activity: null, log: null, readAt: 1, stale: false });
    expect(voided.resolution).toMatchObject({ outcome: 'VOID' });
    expect(phaseOf('Resolved DOWN')).toBe('resolved');
  });

  it('a bet whose batch closed shows its fixed accepted amount before the chain writes it', () => {
    const detail = marketFixture({
      kappa: 2n,
      entries: [
        { outcome: UP, amount: 30n * USDG, block: 101n, owner: ALICE },
        { outcome: DOWN, amount: 5n * USDG, block: 101n, owner: BOB },
      ],
      leaveLastPending: true,
    });
    const open = reviveMarket(marketDetailJson(detail, { activity: null, log: null, readAt: 1, stale: false }));
    const alice = open.positions.find((p) => p.owner === ALICE)!;
    expect(matchStateOf(open, alice).kind).toBe('open');
    const closed = reviveMarket(marketDetailJson({ ...detail, head: { ...detail.head, l1BlockNumber: 102n } }, { activity: null, log: null, readAt: 1, stale: false }));
    const state = matchStateOf(closed, closed.positions.find((p) => p.owner === ALICE)!);
    expect(state.kind).toBe('closed');
    // kappa 2, seed 10: the DOWN book had 10 of room, so 10 of Alice's 30 is accepted and 20 comes back.
    expect(state.accepted).toBe(10n * USDG);
    expect(state.refused).toBe(20n * USDG);
  });
});

describe('the landing grid', () => {
  it('shows open markets soonest bell first, then recent settled ones', () => {
    const now = 1_790_700_000;
    const a = { ...marketFixture({ id: 1n }), statusCode: 0, finalTime: now + 5_000 };
    const b = { ...marketFixture({ id: 2n }), statusCode: 0, finalTime: now + 1_000 };
    const c = { ...marketFixture({ id: 3n, outcome: 'UP' }), finalTime: now - 3_600 };
    const d = { ...marketFixture({ id: 4n, outcome: 'UP' }), finalTime: now - 7 * 86_400 };
    expect(gridMarkets([a, b, c, d], now).map((m) => m.id)).toEqual([2n, 1n, 3n]);
    const card = toCard(b);
    expect(card).toMatchObject({ id: '2', href: '/m/2', phase: 'live', acceptingBets: true, maxEntry: 100n * USDG });
    expect(marketJson(b).id).toBe('2');
  });
});

describe('cached reads', () => {
  it('serves the last good value, with its age, when the chain read fails', async () => {
    let fail = false;
    const read = async () => {
      if (fail) throw new Error('rpc down https://rpc.example/v2/SECRETKEY123');
      return { price: 5n };
    };
    const good = await cachedRead({ key: ['t', 'a'], tags: [], revalidate: 15, read });
    expect(good).toMatchObject({ data: { price: 5n }, stale: false, error: null });
    fail = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const degraded = await cachedRead({ key: ['t', 'a'], tags: [], revalidate: 15, read });
    expect(degraded.stale).toBe(true);
    expect(degraded.data).toEqual({ price: 5n });
    expect(degraded.error).not.toContain('SECRETKEY123');
  });

  it('throws only when there has never been a good read', async () => {
    await expect(
      cachedRead({
        key: ['t', 'never'],
        tags: [],
        revalidate: 15,
        read: async () => {
          throw new Error('down');
        },
      }),
    ).rejects.toBeInstanceOf(ReadUnavailableError);
  });
});

describe('the bet panel state machine', () => {
  const gate = { region: 'open' as const, deployed: true, entriesPaused: false, phase: 'live' as const, acceptingBets: true, finalTime: 1_000, nowSec: 0 };

  it('walks connect, then switch, then the bet', () => {
    const base = { blocked: null, phase: { kind: 'idle' as const }, path: 'gasless' as const, formProblem: null };
    expect(primaryAction({ ...base, walletStatus: 'idle', chainId: null }).kind).toBe('connect');
    expect(primaryAction({ ...base, walletStatus: 'disconnected', chainId: null }).label).toBe('Connect');
    expect(primaryAction({ ...base, walletStatus: 'connected', chainId: 1 }).label).toBe('Switch to Robinhood Chain');
    expect(primaryAction({ ...base, walletStatus: 'connected', chainId: 4663 }).label).toBe('Place bet');
    expect(primaryAction({ ...base, walletStatus: 'connected', chainId: 4663, path: 'pay-gas' }).label).toBe('Place bet, paying gas');
    expect(primaryAction({ ...base, walletStatus: 'connected', chainId: 4663, phase: { kind: 'signing' } }).label).toBe('Sign in your wallet');
    expect(primaryAction({ ...base, walletStatus: 'connected', chainId: 4663, phase: { kind: 'busy', attempt: 1 } }).label).toBe('Busy, retrying in a few seconds');
  });

  it('is disabled, with the reason, when a bet cannot be taken', () => {
    expect(blockedReason(gate)).toBeNull();
    expect(blockedReason({ ...gate, deployed: false })?.short).toBe('Opens with the venue launch');
    expect(blockedReason({ ...gate, entriesPaused: true })?.short).toBe('New bets are paused');
    expect(blockedReason({ ...gate, phase: 'frozen' })?.short).toBe('Bets closed at the bell');
    expect(blockedReason({ ...gate, phase: 'resolved' })?.short).toBe('This market has settled');
    expect(blockedReason({ ...gate, nowSec: 990 })?.short).toBe('Bets close at the bell');
    expect(quoteProblem({ offered: 0n, accepted: 0n, refused: 0n, floorIfWin: 0n, headroom: 0n, problem: 'vintage-full' }, { minEntry: 1n, maxEntry: 2n })).toContain('Try again in a few seconds');
  });
});
