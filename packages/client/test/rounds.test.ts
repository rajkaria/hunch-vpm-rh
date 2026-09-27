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
  MAX_PHASE_SPAN,
  phaseOf,
  proxyRoundId,
  type RoundData,
} from '../src/index.js';
import {
  SeriesReader,
  TICKERS,
  bruteForce,
  bruteForceInEffect,
  loadRoundFixture,
  proveLikeTheResolver,
  relabel,
  roundsOf,
} from './support/roundFixtures.js';

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

  it('a current phase with nothing at or before t and no earlier phase readable: before-first-round (never a guess)', async () => {
    const phase2 = roundsOf(fixture, 2n);
    const latest2 = phase2[phase2.length - 1]!.roundId;
    const got = await findLastAtOrBefore(new SeriesReader(phase2, latest2), fixture.feed, all[0]!.updatedAt - 1n);
    expect(got.kind).toBe('before-first-round');
    const inside = await findLastAtOrBefore(new SeriesReader(phase2, latest2), fixture.feed, all[50]!.updatedAt);
    expect(inside.kind === 'found' && aggregatorRoundOf(inside.round.roundId)).toBe(51n);
    expect(inside.kind === 'found' && inside.phase).toBe(2n);
    expect(proxyRoundId(2n, 51n) >> 64n).toBe(2n);
  });
});

/**
 * M-1: aggregator migrations. When Chainlink moves a feed to a new aggregator, the new one
 * reports before the proxy confirms it and the old one keeps its rounds (and often keeps
 * printing), so the proxy serves overlapping phases. The finder must return exactly the round
 * the resolver accepts: the last round at or before t of the HIGHEST phase that has one.
 *
 * Every tape below is a TRANSFORMATION of the captured NVDA series (re-labelled into phases,
 * shifted by a few seconds), labelled as such; the expectations are a brute force of the rule
 * and a literal port of the resolver's `_prove`.
 */
describe('T8r · overlapping phases (TRANSFORMED from the captured NVDA series)', () => {
  const fixture = loadRoundFixture('nvda');
  const all = roundsOf(fixture);
  const N = all.length;
  const part = (from: number, to: number) => all.slice(Math.floor(from * N), Math.floor(to * N));

  interface Tape {
    name: string;
    rounds: RoundData[];
  }

  const tapes: Tape[] = [
    {
      // phase 1 until 60%; the new aggregator (phase 2) reported from 40% on, 7 s after each old print
      name: 'migration: new aggregator reported before its confirmation',
      rounds: [...relabel(part(0, 0.6), 1n), ...relabel(part(0.4, 1), 2n, 7n)],
    },
    {
      // the old aggregator keeps printing to the end; the new one printed 50%-70% and is the proxy's now
      name: 'the old aggregator keeps printing after the switch',
      rounds: [...relabel(all, 1n), ...relabel(part(0.5, 0.7), 2n, 5n)],
    },
    {
      // phase 2 only printed at the very end (an hour late); phase 3 reported from 30% on
      name: 'three phases: a late middle aggregator (checking only phase p + 1 is not enough)',
      rounds: [...relabel(part(0, 0.8), 1n), ...relabel(part(0.9, 1), 2n, 3_600n), ...relabel(part(0.3, 1), 3n, 13n)],
    },
    {
      // phase 2 never printed at all (the proxy skipped over it); phase 3 reported from 50% on
      name: 'three phases: a skipped aggregator that never printed',
      rounds: [...relabel(part(0, 0.7), 1n), ...relabel(part(0.5, 1), 3n, 11n)],
    },
    {
      // a clean switch: the new aggregator's first print is after the old one's last
      name: 'a clean switch with no overlap',
      rounds: [...relabel(part(0, 0.5), 1n), ...relabel(part(0.5, 1), 2n, 1n)],
    },
  ];

  function times(rounds: RoundData[]): bigint[] {
    const ts = new Set<bigint>();
    const sorted = [...rounds].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
    ts.add(sorted[0]!.updatedAt - 1n);
    ts.add(sorted[sorted.length - 1]!.updatedAt + 1n);
    sorted.forEach((r, i) => {
      if (i % 7 === 0 || i < 6 || i > sorted.length - 6) {
        ts.add(r.updatedAt);
        ts.add(r.updatedAt - 1n);
        ts.add(r.updatedAt + 1n);
      }
    });
    return [...ts];
  }

  function latestOf(rounds: RoundData[]): bigint {
    const top = rounds.reduce((m, r) => (phaseOf(r.roundId) > m ? phaseOf(r.roundId) : m), 0n);
    return rounds.filter((r) => phaseOf(r.roundId) === top).reduce((m, r) => (r.roundId > m ? r.roundId : m), 0n);
  }

  describe.each(tapes)('$name', ({ rounds }) => {
    const latestId = latestOf(rounds);
    const byId = new Map(rounds.map((r) => [r.roundId, r]));

    it('returns the round in effect (highest phase with a round at or before t), and only it proves', async () => {
      let maxReads = 0;
      let crossPhase = 0;
      for (const t of times(rounds)) {
        const reader = new SeriesReader(rounds, latestId);
        const got = await findLastAtOrBefore(reader, fixture.feed, t);
        const want = bruteForceInEffect(rounds, t);
        maxReads = Math.max(maxReads, reader.reads);
        if (want === null) {
          expect(got.kind, `t=${t}`).toBe('before-first-round');
          continue;
        }
        expect(got.kind, `t=${t}`).toBe('found');
        if (got.kind !== 'found') continue;
        expect(got.round.roundId, `t=${t}`).toBe(want.roundId);
        expect(got.phase).toBe(phaseOf(want.roundId));
        expect(got.currentPhase).toBe(phaseOf(latestId));
        if (got.phase < got.currentPhase) crossPhase++;
        // the finder's verdict is the resolver's verdict
        expect(got.provable, `t=${t}`).toBe(proveLikeTheResolver(byId, latestId, got.round.roundId, t) === 'ok');
        expect(got.provable, `t=${t}`).toBe(isSaneRound(want)); // NVDA's first rounds hold 18-decimal garbage
        // and no other round proves for t (every round of every phase, sampled)
        for (let i = 0; i < rounds.length; i += 5) {
          const x = rounds[i]!.roundId;
          if (x !== want.roundId) expect(proveLikeTheResolver(byId, latestId, x, t), `x=${x} t=${t}`).not.toBe('ok');
        }
      }
      expect(crossPhase, 'the tape exercises a round in an earlier phase than the current one').toBeGreaterThan(0);
      // latest + the current phase's search + one read per phase above + gallop and bisect of one earlier phase
      expect(maxReads).toBeLessThanOrEqual(3 * Math.ceil(Math.log2(N)) + 10);
    });

    it('pairs the strike and final rounds for every session in the tape, in id order', async () => {
      const reader = cachedRoundReader(new SeriesReader(rounds, latestId));
      const first = rounds.reduce((m, r) => (r.updatedAt < m ? r.updatedAt : m), rounds[0]!.updatedAt);
      const last = rounds.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), 0n);
      let date = etDateOf(Number(first));
      const end = etDateOf(Number(last) - 86_400);
      let sessions = 0;
      for (; date <= end; date = addDays(date, 1)) {
        if (isTradingDay(date)) {
          const strikeTime = openingBell(date);
          const finalTime = closingBell(date);
          const res = await findResolutionRounds(reader, { feed: fixture.feed, strikeTime, finalTime });
          const s = bruteForceInEffect(rounds, BigInt(strikeTime));
          const f = bruteForceInEffect(rounds, BigInt(finalTime));
          if (s === null) {
            expect(res.ok).toBe(false);
          } else {
            expect(res.ok).toBe(true);
            if (!res.ok) continue;
            sessions++;
            expect(res.strikeRound).toBe(s.roundId);
            expect(res.finalRound).toBe(f!.roundId);
            expect(res.finalRound >= res.strikeRound, 'the resolver requires finalRound >= strikeRound').toBe(true);
            const expected = !isSaneRound(s) || !isSaneRound(f!)
              ? 'BADPROOF'
              : s.roundId === f!.roundId || s.answer === f!.answer
                ? 'FLAT'
                : f!.answer > s.answer
                  ? 'UP'
                  : 'DOWN';
            expect(res.expected).toBe(expected);
          }
        }
      }
      expect(sessions).toBeGreaterThan(10);
    });
  });

  it('the old aggregator\'s own "last round at or before" is NOT what the finder returns inside the overlap', async () => {
    const { rounds } = tapes[0]!;
    const latestId = latestOf(rounds);
    const byId = new Map(rounds.map((r) => [r.roundId, r]));
    const t = part(0.5, 0.51)[0]!.updatedAt + 3n; // inside the overlap: both phases printed before t
    const oldLast = rounds.filter((r) => phaseOf(r.roundId) === 1n && r.updatedAt <= t).pop()!;
    const got = await findLastAtOrBefore(new SeriesReader(rounds, latestId), fixture.feed, t);
    expect(got.kind === 'found' && got.phase).toBe(2n);
    expect(got.kind === 'found' && got.round.roundId).not.toBe(oldLast.roundId);
    expect(proveLikeTheResolver(byId, latestId, oldLast.roundId, t)).toBe('phaseBoundary');
  });

  it('a round more than MAX_PHASE_SPAN phases below the current one: phase-boundary (the resolver refuses it)', async () => {
    const base = relabel(part(0, 0.5), 1n);
    const end = base[base.length - 1]!.updatedAt;
    const later = (phases: number) =>
      Array.from({ length: phases }, (_, i) => relabel(part(0.9, 0.91), BigInt(i + 2), end - part(0.9, 0.91)[0]!.updatedAt + 3_600n * BigInt(i + 1))).flat();
    const t = base[100]!.updatedAt;
    const within = [...base, ...later(Number(MAX_PHASE_SPAN))]; // current phase = 1 + 8
    const got = await findLastAtOrBefore(new SeriesReader(within, latestOf(within)), fixture.feed, t);
    expect(got.kind === 'found' && got.provable).toBe(true);
    expect(got.kind === 'found' && got.round.roundId).toBe(base[100]!.roundId);
    const beyond = [...base, ...later(Number(MAX_PHASE_SPAN) + 1)]; // current phase = 1 + 9
    const far = await findLastAtOrBefore(new SeriesReader(beyond, latestOf(beyond)), fixture.feed, t);
    expect(far.kind).toBe('phase-boundary');
    const res = await findResolutionRounds(new SeriesReader(beyond, latestOf(beyond)), { feed: fixture.feed, strikeTime: t, finalTime: t + 60n });
    expect(res.ok === false && res.problem).toBe('phase-boundary');
  });

  it('an earlier phase whose next round is missing proves only once a later phase has printed', async () => {
    const old = relabel(part(0, 0.5), 1n);
    const t = old[old.length - 1]!.updatedAt + 60n; // after the old aggregator's last print
    // the proxy moved to phase 2, which has not printed yet: latest is phase 2, round 0
    const empty: RoundData = { roundId: proxyRoundId(2n, 0n), answer: 0n, startedAt: 0n, updatedAt: 0n, answeredInRound: 0n };
    const pending = await findLastAtOrBefore(new SeriesReader([...old, empty], empty.roundId), fixture.feed, t);
    expect(pending.kind === 'found' && pending.round.roundId).toBe(old[old.length - 1]!.roundId);
    expect(pending.kind === 'found' && pending.provable).toBe(false);
    const printed = [...old, ...relabel(part(0.6, 0.7), 2n)];
    const now = await findLastAtOrBefore(new SeriesReader(printed, latestOf(printed)), fixture.feed, t);
    expect(now.kind === 'found' && now.provable).toBe(true);
  });
});
