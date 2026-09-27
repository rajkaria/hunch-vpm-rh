import type { Address } from 'viem';
import { aggregatorV3Abi } from './abi/external.js';
import { PRICE_SANITY_MAX } from './constants.js';

/**
 * Round finding for `StockRoundResolver` (docs/spec/03-contracts.md §Round finding).
 *
 * "The price in effect at T" is the answer of the last round with `updatedAt ≤ T` of the
 * HIGHEST feed phase that has any round with `updatedAt ≤ T`. Round ids are proxy ids
 * (`roundId = phaseId << 64 | aggregatorRound`); when Chainlink moves a feed to a new
 * aggregator, the old and the new one report in parallel for a while and the proxy then
 * serves both histories, so the phase matters. The resolver accepts round `x` of phase `p`
 * for time `T` iff
 *   - `0 < updatedAt(x) ≤ T` and `0 < answer(x) < 1e14`;
 *   - `p` is at most the proxy's current phase `P` (from `latestRoundData`), at most
 *     `MAX_PHASE_SPAN` below it, and no phase from `p + 1` to `P` has a round at or before T
 *     (each one's first round is absent or after T; else `PhaseBoundary`);
 *   - and `updatedAt(x + 1) > T` (same phase), or `x + 1` does not exist and `x` is the
 *     proxy's latest round, or `x + 1` does not exist, `p < P` and a later phase has printed.
 *
 * `findLastAtOrBefore` returns exactly that round: `latestRoundData`, a binary search of the
 * current phase, and, only when the current phase has no round at or before T, one read per
 * earlier phase (its first round) until the phase that has one, which it searches by
 * galloping from round 1. About log2(rounds) + 2 reads on a single-phase feed. The reader is
 * an interface so tests replay captured round series (never hand-written ones).
 */

export interface RoundData {
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
}

export interface RoundReader {
  latestRoundData(feed: Address): Promise<RoundData>;
  /** The round, or null when it does not exist (the proxy reverts, or `updatedAt == 0`). */
  getRoundData(feed: Address, roundId: bigint): Promise<RoundData | null>;
}

export const PHASE_SHIFT = 64n;
export const AGG_MASK = (1n << 64n) - 1n;

export function phaseOf(roundId: bigint): bigint {
  return roundId >> PHASE_SHIFT;
}

export function aggregatorRoundOf(roundId: bigint): bigint {
  return roundId & AGG_MASK;
}

export function proxyRoundId(phase: bigint, aggregatorRound: bigint): bigint {
  return (phase << PHASE_SHIFT) | aggregatorRound;
}

/** The resolver's sanity band: `0 < answer < 1e14` (8 decimals) and `updatedAt > 0`. */
export function isSaneRound(round: Pick<RoundData, 'answer' | 'updatedAt'>): boolean {
  return round.updatedAt > 0n && round.answer > 0n && round.answer < PRICE_SANITY_MAX;
}

/** Mirrors `StockRoundResolver.MAX_PHASE_SPAN`: a round more than this many phases below the proxy's current phase is refused. */
export const MAX_PHASE_SPAN = 8n;

export type FindResult =
  | {
      kind: 'found';
      /** The round in effect at t: the last round with `updatedAt ≤ t` of the highest phase that has one. */
      round: RoundData;
      /** Round x + 1 in the same phase (null if it does not exist). */
      next: RoundData | null;
      /** x is the proxy's latest round. */
      isLatest: boolean;
      /** The phase of `round`. */
      phase: bigint;
      /** The proxy's current phase (differs from `phase` after an aggregator migration). */
      currentPhase: bigint;
      /** The answer passes the resolver's sanity band (else `resolve` reverts BadAnswer). */
      sane: boolean;
      /** The resolver can verify this round for t now (see the module comment); false while an x + 1 is missing and nothing later has printed. */
      provable: boolean;
      /** t − updatedAt, seconds. */
      age: bigint;
      reads: number;
    }
  | {
      kind: 'before-first-round';
      /** No round of any phase has `updatedAt ≤ t`. */
      reads: number;
    }
  | {
      kind: 'phase-boundary';
      /** The round in effect at t lies more than MAX_PHASE_SPAN phases below the current one: the resolver refuses it (PhaseBoundary). */
      firstRoundOfPhase: RoundData | null;
      reads: number;
    };

class CountingReader {
  reads = 0;
  private readonly memo = new Map<bigint, RoundData | null>();
  constructor(private readonly inner: RoundReader, private readonly feed: Address) {}
  async latest(): Promise<RoundData> {
    this.reads++;
    return this.inner.latestRoundData(this.feed);
  }
  async get(roundId: bigint): Promise<RoundData | null> {
    const hit = this.memo.get(roundId);
    if (hit !== undefined) return hit;
    this.reads++;
    const r = await this.inner.getRoundData(this.feed, roundId);
    const round = r === null || r.updatedAt === 0n ? null : r;
    this.memo.set(roundId, round);
    return round;
  }
}

type Located = { round: RoundData; next: RoundData | null };

/**
 * Find the round of `feed` in effect at `t` (unix seconds): the last round with
 * `updatedAt ≤ t` of the highest phase that has any such round, i.e. exactly the round
 * `StockRoundResolver` accepts. Missing rounds are skipped in the current phase (treated as
 * absent, like the resolver's try/catch). Assumes what the resolver assumes: inside a phase,
 * round ids are consecutive from 1 and `updatedAt` is non-decreasing.
 */
export async function findLastAtOrBefore(reader: RoundReader, feed: Address, t: bigint | number): Promise<FindResult> {
  const T = BigInt(t);
  const r = new CountingReader(reader, feed);
  const latest = await r.latest();
  const current = phaseOf(latest.roundId);
  const lowest = current > MAX_PHASE_SPAN ? current - MAX_PHASE_SPAN : 1n;

  for (let phase = current; phase >= 1n; phase--) {
    if (phase < lowest) {
      // Phases below the resolver's reach: whatever is in effect there, it refuses it.
      return { kind: 'phase-boundary', firstRoundOfPhase: await r.get(proxyRoundId(lowest, 1n)), reads: r.reads };
    }
    let located: Located | null;
    if (phase === current) {
      located = await searchCurrentPhase(r, latest, T);
    } else {
      const first = await r.get(proxyRoundId(phase, 1n));
      located = first !== null && first.updatedAt <= T ? await searchEarlierPhase(r, phase, first, T) : null;
    }
    if (located === null) continue; // no round of this phase is at or before t: look one phase down

    const { round, next } = located;
    const isLatest = round.roundId === latest.roundId;
    const sane = isSaneRound(round);
    let provable = sane;
    if (provable && next !== null) provable = next.updatedAt > T;
    else if (provable && !isLatest) provable = phase < current && (await anyLaterPhasePrinted(r, phase, current));
    return { kind: 'found', round, next, isLatest, phase, currentPhase: current, sane, provable, age: T - round.updatedAt, reads: r.reads };
  }
  return { kind: 'before-first-round', reads: r.reads };
}

/** The current phase: the latest round, or a binary search below it (robust to missing rounds). */
async function searchCurrentPhase(r: CountingReader, latest: RoundData, T: bigint): Promise<Located | null> {
  const phase = phaseOf(latest.roundId);
  const hi0 = aggregatorRoundOf(latest.roundId);
  if (latest.updatedAt !== 0n && latest.updatedAt <= T) return { round: latest, next: null };

  // Invariant: rounds with aggregator id > hi are after t (or missing). Search [lo, hi].
  let lo = 1n;
  let hi = hi0 - 1n;
  let best: RoundData | null = null;
  while (lo <= hi) {
    const mid = lo + (hi - lo) / 2n;
    const probe = await nearestPresent(r, phase, mid, lo, hi);
    if (probe === null) break; // nothing exists in [lo, hi]
    const [id, round] = probe;
    if (round.updatedAt <= T) {
      best = round;
      lo = id + 1n;
    } else {
      hi = id - 1n;
    }
  }
  if (best === null) return null;
  // Round x + 1 in the same phase: the binary search guarantees every existing round after x is after t.
  const nextId = aggregatorRoundOf(best.roundId) + 1n;
  const next = nextId <= hi0 ? (nextId === hi0 ? latest : await r.get(proxyRoundId(phase, nextId))) : null;
  return { round: best, next };
}

/** An earlier phase whose first round is at or before t: gallop from round 1, then bisect. */
async function searchEarlierPhase(r: CountingReader, phase: bigint, first: RoundData, T: bigint): Promise<Located> {
  const inEffect = (x: RoundData | null): x is RoundData => x !== null && x.updatedAt <= T;
  let lo = 1n; // known: present and at or before t
  let loRound = first;
  let hi = 0n; // first id known to be absent or after t
  for (let step = 1n; hi === 0n; step *= 2n) {
    const probe = lo + step;
    const round = await r.get(proxyRoundId(phase, probe));
    if (inEffect(round)) {
      lo = probe;
      loRound = round;
    } else {
      hi = probe;
    }
    if (step >= 1n << 62n) hi = hi === 0n ? lo + 1n : hi; // aggregator ids are 64-bit: stop
  }
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    const round = await r.get(proxyRoundId(phase, mid));
    if (inEffect(round)) {
      lo = mid;
      loRound = round;
    } else {
      hi = mid;
    }
  }
  return { round: loRound, next: await r.get(proxyRoundId(phase, lo + 1n)) };
}

/** Whether any phase in (phase, current] has its first round (what the resolver reads). */
async function anyLaterPhasePrinted(r: CountingReader, phase: bigint, current: bigint): Promise<boolean> {
  for (let q = phase + 1n; q <= current; q++) if ((await r.get(proxyRoundId(q, 1n))) !== null) return true;
  return false;
}

/** The present round nearest to `mid` inside [lo, hi], searching down first, then up. */
async function nearestPresent(
  r: CountingReader,
  phase: bigint,
  mid: bigint,
  lo: bigint,
  hi: bigint,
): Promise<[bigint, RoundData] | null> {
  const at = await r.get(proxyRoundId(phase, mid));
  if (at !== null) return [mid, at];
  for (let step = 1n; mid - step >= lo || mid + step <= hi; step++) {
    if (mid - step >= lo) {
      const down = await r.get(proxyRoundId(phase, mid - step));
      if (down !== null) return [mid - step, down];
    }
    if (mid + step <= hi) {
      const up = await r.get(proxyRoundId(phase, mid + step));
      if (up !== null) return [mid + step, up];
    }
    if (step > 64n) break; // a gap this wide is not a Chainlink feed; stop spending reads
  }
  return null;
}

export interface ResolutionSpecTimes {
  feed: Address;
  strikeTime: bigint | number;
  finalTime: bigint | number;
  maxStrikeAge?: bigint | number;
  maxFinalAge?: bigint | number;
}

export type ResolutionRounds =
  | {
      ok: true;
      strikeRound: bigint;
      finalRound: bigint;
      strike: Extract<FindResult, { kind: 'found' }>;
      final: Extract<FindResult, { kind: 'found' }>;
      /** Off-chain expectation of `preview` (the contract decides; this is for display and sanity). */
      expected: 'UP' | 'DOWN' | 'FLAT' | 'STALE' | 'BADPROOF';
    }
  | {
      ok: false;
      problem: 'before-first-round' | 'phase-boundary';
      which: 'strike' | 'final';
      strike: FindResult;
      final: FindResult | null;
    };

/** Both proven rounds for a spec: the round in effect at the strike bell and at the final bell. */
export async function findResolutionRounds(reader: RoundReader, spec: ResolutionSpecTimes): Promise<ResolutionRounds> {
  const strike = await findLastAtOrBefore(reader, spec.feed, spec.strikeTime);
  if (strike.kind !== 'found') return { ok: false, problem: strike.kind, which: 'strike', strike, final: null };
  const final = await findLastAtOrBefore(reader, spec.feed, spec.finalTime);
  if (final.kind !== 'found') return { ok: false, problem: final.kind, which: 'final', strike, final };

  let expected: 'UP' | 'DOWN' | 'FLAT' | 'STALE' | 'BADPROOF';
  if (!strike.provable || !final.provable) expected = 'BADPROOF';
  else if (
    (spec.maxStrikeAge !== undefined && strike.age > BigInt(spec.maxStrikeAge)) ||
    (spec.maxFinalAge !== undefined && final.age > BigInt(spec.maxFinalAge))
  ) {
    expected = 'STALE';
  } else if (strike.round.roundId === final.round.roundId || strike.round.answer === final.round.answer) expected = 'FLAT';
  else expected = final.round.answer > strike.round.answer ? 'UP' : 'DOWN';

  return { ok: true, strikeRound: strike.round.roundId, finalRound: final.round.roundId, strike, final, expected };
}

/** Minimal client surface the viem reader needs (any viem PublicClient satisfies it). */
export interface ReadContractClient {
  readContract(args: {
    address: Address;
    abi: typeof aggregatorV3Abi;
    functionName: 'latestRoundData' | 'getRoundData';
    args?: readonly [bigint];
  }): Promise<unknown>;
}

function toRound(v: unknown): RoundData {
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = v as readonly [bigint, bigint, bigint, bigint, bigint];
  return { roundId, answer, startedAt, updatedAt, answeredInRound };
}

/** A `RoundReader` over a viem public client. A reverting `getRoundData` reads as a missing round. */
export function roundReaderFromClient(client: ReadContractClient): RoundReader {
  return {
    async latestRoundData(feed) {
      return toRound(await client.readContract({ address: feed, abi: aggregatorV3Abi, functionName: 'latestRoundData' }));
    },
    async getRoundData(feed, roundId) {
      try {
        const round = toRound(await client.readContract({ address: feed, abi: aggregatorV3Abi, functionName: 'getRoundData', args: [roundId] }));
        return round.updatedAt === 0n ? null : round;
      } catch (error) {
        if (isMissingRoundError(error)) return null;
        throw error;
      }
    },
  };
}

/** A revert ("No data present", or any execution revert) means the round is absent; transport errors are not. */
function isMissingRoundError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /revert|No data present|execution reverted|ContractFunctionExecutionError/i.test(text) && !/timeout|fetch failed|HTTP request failed|429/i.test(text);
}

/** Memoizes `getRoundData` (rounds never change once written) and dedupes concurrent reads. */
export function cachedRoundReader(inner: RoundReader): RoundReader {
  const cache = new Map<string, Promise<RoundData | null>>();
  return {
    latestRoundData: (feed) => inner.latestRoundData(feed),
    getRoundData(feed, roundId) {
      const key = `${feed.toLowerCase()}:${roundId}`;
      let hit = cache.get(key);
      if (hit === undefined) {
        hit = inner.getRoundData(feed, roundId);
        cache.set(key, hit);
        hit.catch(() => cache.delete(key));
      }
      return hit;
    },
  };
}
