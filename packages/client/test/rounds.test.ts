import { describe, expect, it } from 'vitest';
import {
  aggregatorRoundOf,
  cachedRoundReader,
  closingBell,
  etDateOf,
  addDays,
  findLastAtOrBefore,
  findResolutionRounds,
  isSaneRound,
  openingBell,
  isTradingDay,
  proxyRoundId,
  type RoundData,
} from '../src/index.js';
import { SeriesReader, TICKERS, bruteForce, loadRoundFixture, roundsOf } from './support/roundFixtures.js';

/**
 * T8r: the round finder against round series CAPTURED from chain 4663 by
 * scripts/capture-rounds.ts (the fixture records its capture time and RPC). Every
 * expectation is a brute-force scan of the same series.
 */

function sampleTimes(rounds: RoundData[]): bigint[] {
  const ts = new Set<bigint>();
  const first = rounds[0]!.updatedAt;
  const last = rounds[rounds.length - 1]!.updatedAt;
  ts.add(0n);
  ts.add(first - 1n);
  ts.add(last + 1n);
  ts.add(last + 10n ** 9n);
  rounds.forEach((r, i) => {
    // Exact-equality boundaries and their neighbours on every 3rd round, plus midpoints.
    if (i % 3 === 0 || i < 12 || i > rounds.length - 12) {
      ts.add(r.updatedAt);
      ts.add(r.updatedAt - 1n);
      ts.add(r.updatedAt + 1n);
    }
    const next = rounds[i + 1];
    if (next !== undefined && i % 5 === 0) ts.add((r.updatedAt + next.updatedAt) / 2n);
  });
  return [...ts].filter((t) => t >= 0n);
}

/** Every NYSE bell (09:30 / 16:00 ET) inside the captured window: the times markets really resolve at. */
function bells(rounds: RoundData[]): bigint[] {
  const out: bigint[] = [];
  let date = etDateOf(Number(rounds[0]!.updatedAt));
  const end = etDateOf(Number(rounds[rounds.length - 1]!.updatedAt) + 7 * 86_400);
  while (date <= end) {
    if (isTradingDay(date)) out.push(BigInt(openingBell(date)), BigInt(closingBell(date)));
    date = addDays(date, 1);
  }
  return out;
}

describe.each(TICKERS)('T8r · %s (captured series)', (ticker) => {
  const fixture = loadRoundFixture(ticker);
  const rounds = roundsOf(fixture);
  const latestId = BigInt(fixture.latestRoundId);

  it('fixture provenance is recorded', () => {
    expect(fixture.rpc).toMatch(/^https:\/\//);
    expect(Date.parse(fixture.capturedAt)).toBeGreaterThan(Date.parse('2026-09-01'));
    expect(rounds.length).toBeGreaterThan(100);
    expect(rounds[rounds.length - 1]!.roundId).toBe(latestId);
  });

  it('agrees with a brute-force scan for many T (boundaries, gaps, before first, after latest)', async () => {
    const times = sampleTimes(rounds);
    let maxReads = 0;
    for (const t of times) {
      const reader = new SeriesReader(rounds, latestId);
      const got = await findLastAtOrBefore(reader, fixture.feed, t);
      const want = bruteForce(rounds, t);
      if (want === null) {
        expect(got.kind, `t=${t}`).toBe('before-first-round');
        continue;
      }
      expect(got.kind, `t=${t}`).toBe('found');
      if (got.kind !== 'found') continue;
      expect(got.round.roundId, `t=${t}`).toBe(want.roundId);
      expect(got.round.updatedAt <= t).toBe(true);
      expect(got.age).toBe(t - want.updatedAt);
      if (got.isLatest) expect(got.round.roundId).toBe(latestId);
      else expect(got.next!.updatedAt > t, `next after t=${t}`).toBe(true);
      expect(got.sane).toBe(isSaneRound(want));
      expect(got.provable).toBe(isSaneRound(want));
      maxReads = Math.max(maxReads, reader.reads);
    }
    // latestRoundData + binary search over the phase + the x+1 read.
    expect(maxReads).toBeLessThanOrEqual(Math.ceil(Math.log2(rounds.length)) + 4);
  });

  it('finds the round in effect at every NYSE bell in the window', async () => {
    const reader = cachedRoundReader(new SeriesReader(rounds, latestId));
    for (const t of bells(rounds)) {
      const got = await findLastAtOrBefore(reader, fixture.feed, t);
      const want = bruteForce(rounds, t);
      if (want === null) expect(got.kind).toBe('before-first-round');
      else {
        expect(got.kind === 'found' && got.round.roundId).toBe(want.roundId);
      }
    }
  });

  it('pairs strike and final rounds for a real session and classifies it', async () => {
    const reader = new SeriesReader(rounds, latestId);
    // The last full trading day inside the capture.
    let date = etDateOf(Number(rounds[rounds.length - 1]!.updatedAt));
    while (!isTradingDay(date) || closingBell(date) > Number(rounds[rounds.length - 1]!.updatedAt)) date = addDays(date, -1);
    const r = await findResolutionRounds(reader, {
      feed: fixture.feed,
      strikeTime: openingBell(date),
      finalTime: closingBell(date),
      maxStrikeAge: 93_600,
      maxFinalAge: 93_600,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.strikeRound).toBe(bruteForce(rounds, BigInt(openingBell(date)))!.roundId);
    expect(r.finalRound).toBe(bruteForce(rounds, BigInt(closingBell(date)))!.roundId);
    expect(r.finalRound >= r.strikeRound).toBe(true);
    const s = bruteForce(rounds, BigInt(openingBell(date)))!;
    const f = bruteForce(rounds, BigInt(closingBell(date)))!;
    const expected = s.roundId === f.roundId || s.answer === f.answer ? 'FLAT' : f.answer > s.answer ? 'UP' : 'DOWN';
    expect(r.expected).toBe(expected);
  });
});

describe('T8r · SPY phase 1 garbage (rounds 1–7 hold 18-decimal answers)', () => {
  const fixture = loadRoundFixture('spy');
  const rounds = roundsOf(fixture);

  it('the captured series really contains the garbage', () => {
    expect(rounds.slice(0, 7).every((r) => r.answer > 10n ** 14n)).toBe(true);
    expect(isSaneRound(rounds[7]!)).toBe(true);
  });

  it('finds such a round but marks it unprovable (the resolver reverts BadProof)', async () => {
    const t = rounds[3]!.updatedAt;
    const got = await findLastAtOrBefore(new SeriesReader(rounds, BigInt(fixture.latestRoundId)), fixture.feed, t);
    expect(got.kind).toBe('found');
    if (got.kind !== 'found') return;
    expect(got.round.roundId).toBe(rounds[3]!.roundId);
    expect(got.sane).toBe(false);
    expect(got.provable).toBe(false);
    const res = await findResolutionRounds(new SeriesReader(rounds, BigInt(fixture.latestRoundId)), {
      feed: fixture.feed,
      strikeTime: t,
      finalTime: rounds[20]!.updatedAt,
    });
    expect(res.ok && res.expected).toBe('BADPROOF');
  });
});

describe('T8r · derived series (transformations of captured data, labelled)', () => {
  const fixture = loadRoundFixture('nvda');
  const all = roundsOf(fixture);
  const latestId = BigInt(fixture.latestRoundId);

  it('skips missing rounds exactly like the brute force, and flags a missing x+1 as unprovable', async () => {
    // Drop every 7th captured round (never the latest) to exercise "No data present".
    const holed = all.filter((r, i) => i % 7 !== 3 || r.roundId === latestId);
    for (const t of sampleTimes(holed).filter((_, i) => i % 4 === 0)) {
      const got = await findLastAtOrBefore(new SeriesReader(holed, latestId), fixture.feed, t);
      const want = bruteForce(holed, t);
      if (want === null) {
        expect(got.kind).toBe('before-first-round');
        continue;
      }
      expect(got.kind === 'found' && got.round.roundId, `t=${t}`).toBe(want.roundId);
      if (got.kind === 'found' && !got.isLatest) {
        const nextPresent = holed.some((r) => r.roundId === got.round.roundId + 1n);
        expect(got.provable).toBe(nextPresent && isSaneRound(want));
      }
    }
  });

  it('reports a phase boundary when t precedes the current phase (never a guess)', async () => {
    const phase2 = roundsOf(fixture, 2n);
    const latest2 = phase2[phase2.length - 1]!.roundId;
    const got = await findLastAtOrBefore(new SeriesReader(phase2, latest2), fixture.feed, all[0]!.updatedAt - 1n);
    expect(got.kind).toBe('phase-boundary');
    const inside = await findLastAtOrBefore(new SeriesReader(phase2, latest2), fixture.feed, all[50]!.updatedAt);
    expect(inside.kind === 'found' && aggregatorRoundOf(inside.round.roundId)).toBe(51n);
    expect(proxyRoundId(2n, 51n) >> 64n).toBe(2n);
  });
});
