import { MARKET_STATUS, PREVIEW_STATUS, settlementOf, simulateMarket, type Settlement } from '@hunch-rh/client';
import { getAddress, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { SWEEP_THRESHOLD, decideDeliver, decideResolve, needsConfirmation, needsResolution, type DeliverMarket, type ResolveCandidate } from '../src/index.js';

const FINAL = 1_790_971_200;
const specId = `0x${'cd'.repeat(32)}` as Hex;
const base: ResolveCandidate = {
  marketId: 7n,
  specId,
  ticker: 'NVDA',
  finalTime: FINAL,
  statusCode: MARKET_STATUS.Open,
  settledByResolver: false,
};
const rounds = { ok: true as const, strikeRound: 18446744073709552700n, finalRound: 18446744073709552710n };

describe('T9 · resolve vs void vs page', () => {
  it('waits for the bell (+60 s) and skips settled markets', () => {
    expect(decideResolve(base, FINAL + 59).kind).toBe('wait');
    expect(needsResolution(base, FINAL + 59)).toBe(false);
    expect(needsResolution(base, FINAL + 60)).toBe(true);
    expect(decideResolve({ ...base, statusCode: MARKET_STATUS.Resolved }, FINAL + 999).kind).toBe('skip');
    expect(decideResolve({ ...base, settledByResolver: true }, FINAL + 999).kind).toBe('skip');
  });

  it.each([
    [PREVIEW_STATUS.UP, 'UP'],
    [PREVIEW_STATUS.DOWN, 'DOWN'],
    [PREVIEW_STATUS.FLAT, 'FLAT'],
  ])('preview %s → resolve with the proven rounds (%s; FLAT voids inside resolve)', (status, expect_) => {
    const a = decideResolve({ ...base, rounds, preview: status }, FINAL + 120);
    expect(a).toMatchObject({ kind: 'resolve', specId, strikeRound: rounds.strikeRound, finalRound: rounds.finalRound, expect: expect_ });
  });

  it('STALE: waits until +15 min, then voids only when an independent read agrees', () => {
    const stale = { ...base, rounds, preview: PREVIEW_STATUS.STALE };
    expect(decideResolve(stale, FINAL + 600).kind).toBe('wait');
    expect(needsConfirmation(stale, FINAL + 600)).toBe(false);
    expect(needsConfirmation(stale, FINAL + 900)).toBe(true);
    expect(decideResolve(stale, FINAL + 900).kind).toBe('retry'); // no second read yet
    expect(decideResolve({ ...stale, confirm: null }, FINAL + 900).kind).toBe('retry');
    expect(decideResolve({ ...stale, confirm: { rounds, preview: PREVIEW_STATUS.STALE } }, FINAL + 900)).toMatchObject({
      kind: 'voidStale',
      strikeRound: rounds.strikeRound,
      finalRound: rounds.finalRound,
    });
    expect(decideResolve({ ...stale, confirm: { rounds, preview: PREVIEW_STATUS.UP } }, FINAL + 900).kind).toBe('page');
    expect(
      decideResolve({ ...stale, confirm: { rounds: { ...rounds, finalRound: rounds.finalRound + 1n }, preview: PREVIEW_STATUS.STALE } }, FINAL + 900).kind,
    ).toBe('page');
  });

  it('BADANSWER: a garbage price at a bell voids like STALE, only when an independent read agrees', () => {
    const bad = { ...base, rounds, preview: PREVIEW_STATUS.BADANSWER };
    expect(decideResolve(bad, FINAL + 600).kind).toBe('wait');
    expect(needsConfirmation(bad, FINAL + 900)).toBe(true);
    expect(decideResolve(bad, FINAL + 900).kind).toBe('retry');
    expect(decideResolve({ ...bad, confirm: { rounds, preview: PREVIEW_STATUS.BADANSWER } }, FINAL + 900)).toMatchObject({
      kind: 'voidBadAnswer',
      specId,
      strikeRound: rounds.strikeRound,
      finalRound: rounds.finalRound,
    });
    expect(decideResolve({ ...bad, confirm: { rounds, preview: PREVIEW_STATUS.UP } }, FINAL + 900).kind).toBe('page');
    expect(decideResolve({ ...bad, confirm: { rounds, preview: PREVIEW_STATUS.STALE } }, FINAL + 900).kind).toBe('page');
  });

  it('PAUSED: retries, voidPaused only from +24 h', () => {
    const paused = { ...base, rounds, preview: PREVIEW_STATUS.PAUSED };
    expect(decideResolve(paused, FINAL + 3600).kind).toBe('retry');
    expect(decideResolve(paused, FINAL + 86_400)).toMatchObject({ kind: 'voidPaused', specId });
  });

  it('BADPROOF and phase boundaries page the operator and never void', () => {
    expect(decideResolve({ ...base, rounds, preview: PREVIEW_STATUS.BADPROOF }, FINAL + 999_999).kind).toBe('page');
    const pb = decideResolve({ ...base, rounds: { ok: false, problem: 'phase-boundary' } }, FINAL + 999_999);
    expect(pb.kind).toBe('page');
    expect(pb.why).toMatch(/PhaseBoundary/);
    expect(decideResolve({ ...base, rounds: { ok: false, problem: 'before-first-round' } }, FINAL + 999).kind).toBe('page');
  });

  it('read failures and a missing preview retry', () => {
    expect(decideResolve({ ...base, error: 'HTTP request failed' }, FINAL + 999).kind).toBe('retry');
    expect(decideResolve({ ...base, rounds, preview: null }, FINAL + 999).kind).toBe('retry');
    expect(decideResolve({ ...base, rounds, preview: PREVIEW_STATUS.NOT_READY }, FINAL + 999).kind).toBe('retry');
  });
});

const owner = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);

function settledMarket(outcome: 'UP' | 'DOWN' | 'VOID', marketId = 1n): DeliverMarket {
  const { market, settlement } = simulateMarket({
    seed: [10_000_000n, 10_000_000n],
    kappa: 30n,
    entries: [
      { outcome: 0, amount: 20_000_000n, block: 1n, owner: owner(1) },
      { outcome: 1, amount: 30_000_000n, block: 2n, owner: owner(2) },
      { outcome: 0, amount: 50_000_000n, block: 3n, owner: owner(3) },
    ],
    outcome,
    feeBps: 200,
    seedOwner: owner(9),
  });
  return {
    marketId,
    statusCode: market.status,
    pendingCount: 0n,
    vintageBlock: null,
    positions: settlement!.positions.map((p) => ({ ...p, id: BigInt(p.id) + marketId * 100n, settlement: p.settlement })),
  };
}

describe('T9 · deliver', () => {
  it('one claimFor per position with something to deliver (winners and seed legs), losers skipped', () => {
    const actions = decideDeliver({ markets: [settledMarket('UP')], l1Block: 10n, feesAccrued: 0n });
    expect(actions.map((a) => a.kind)).toEqual(['claimFor', 'claimFor', 'claimFor']);
    expect(actions.map((a) => (a.kind === 'claimFor' ? a.owner : null))).toEqual([owner(9), owner(1), owner(3)]);
    for (const a of actions) if (a.kind === 'claimFor') expect(a.amount).toBeGreaterThan(0n);
  });

  it('void: every position is refunded, each in its own call', () => {
    const actions = decideDeliver({ markets: [settledMarket('VOID')], l1Block: 10n, feesAccrued: 0n });
    expect(actions.length).toBe(5);
    expect(new Set(actions.map((a) => (a.kind === 'claimFor' ? a.positionId : -1n))).size).toBe(5);
  });

  it('skips claimed positions and frozen owners (a frozen owner fails alone, never blocks others)', () => {
    const m = settledMarket('UP');
    const claimed = { ...m, positions: m.positions.map((p, i) => (i === 2 ? { ...p, claimed: true, settlement: { ...p.settlement, total: 0n, deliverable: false } } : p)) };
    const actions = decideDeliver({ markets: [claimed], l1Block: 10n, feesAccrued: 0n, skipOwners: new Set([owner(9).toLowerCase()]) });
    expect(actions.map((a) => (a.kind === 'claimFor' ? a.owner : null))).toEqual([owner(3)]);
  });

  it('open markets: finalize a past vintage, then push refused remainders', () => {
    const zero: Settlement = { gross: 0n, fee: 0n, net: 0n, refund: 0n, total: 0n, deliverable: false };
    const open: DeliverMarket = {
      marketId: 5n,
      statusCode: MARKET_STATUS.Open,
      pendingCount: 2n,
      vintageBlock: 41n,
      positions: [
        { id: 50n, owner: owner(4), finalized: true, refunded: false, claimed: false, offered: 100_000_000n, accepted: 90_000_000n, settlement: zero },
        { id: 51n, owner: owner(5), finalized: true, refunded: true, claimed: false, offered: 100_000_000n, accepted: 90_000_000n, settlement: zero },
        { id: 52n, owner: owner(6), finalized: false, refunded: false, claimed: false, offered: 5_000_000n, accepted: 0n, settlement: zero },
      ],
    };
    expect(decideDeliver({ markets: [open], l1Block: 41n, feesAccrued: 0n }).map((a) => a.kind)).toEqual(['withdrawRefundFor']);
    const acts = decideDeliver({ markets: [open], l1Block: 42n, feesAccrued: 0n });
    expect(acts.map((a) => a.kind)).toEqual(['finalizeVintage', 'withdrawRefundFor']);
    expect(acts[1]).toMatchObject({ positionId: 50n, amount: 10_000_000n });
  });

  it('sweeps fees only above 5 USDG, last', () => {
    expect(decideDeliver({ markets: [], l1Block: 1n, feesAccrued: SWEEP_THRESHOLD }).length).toBe(0);
    const a = decideDeliver({ markets: [settledMarket('UP')], l1Block: 1n, feesAccrued: SWEEP_THRESHOLD + 1n });
    expect(a[a.length - 1]).toMatchObject({ kind: 'sweepFees', amount: SWEEP_THRESHOLD + 1n });
  });

  it('is idempotent once everything is claimed', () => {
    const m = settledMarket('UP');
    const done = {
      ...m,
      positions: m.positions.map((p) => ({
        ...p,
        claimed: true,
        refunded: true,
        settlement: settlementOf({ ...p, outcome: 0, entryAcc: 0n, claimed: true }, { status: m.statusCode, winner: 0 }, null, 200),
      })),
    };
    expect(decideDeliver({ markets: [done], l1Block: 10n, feesAccrued: 0n })).toEqual([]);
  });
});
