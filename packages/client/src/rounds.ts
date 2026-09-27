import type { Address } from 'viem';
import { aggregatorV3Abi } from './abi/external.js';
import { PRICE_SANITY_MAX } from './constants.js';

/**
 * Round finding for `StockRoundResolver` (docs/spec/03-contracts.md §Round finding).
 *
 * "The price in effect at T" is the answer of the LAST round with `updatedAt ≤ T`. The
 * resolver accepts round `x` for time `T` iff
 *   - `0 < updatedAt(x) ≤ T` and `0 < answer(x) < 1e14`, and
 *   - `updatedAt(x + 1) > T`, or round `x + 1` does not exist and `x` is the proxy's
 *     latest round (possible only because resolution runs at or after T),
 * where `x + 1` is taken in the same phase (`roundId = phaseId << 64 | aggregatorRound`).
 *
 * `findLastAtOrBefore` finds that round with `latestRoundData` plus a binary search of
 * `getRoundData` inside the current phase (about log2(rounds) + 2 reads). The reader is an
 * interface so tests replay captured round series (never hand-written ones).
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

export type FindResult =
  | {
      kind: 'found';
      /** The last round with `updatedAt ≤ t`. */
      round: RoundData;
      /** Round x + 1 in the same phase (null if it does not exist). */
      next: RoundData | null;
      /** x is the proxy's latest round. */
      isLatest: boolean;
      /** The answer passes the resolver's sanity band (else `resolve` reverts BadProof). */
      sane: boolean;
      /** The resolver can verify this round for t: sane, and x is the latest or round x + 1 exists and is after t. */
      provable: boolean;
      /** t − updatedAt, seconds. */
      age: bigint;
      reads: number;
    }
  | {
      kind: 'before-first-round';
      /** No round of this feed has `updatedAt ≤ t` (phase 1). */
      reads: number;
    }
  | {
      kind: 'phase-boundary';
      /** The round in effect at t lies in an earlier phase: the resolver cannot prove it (PhaseBoundary). */
      firstRoundOfPhase: RoundData | null;
      reads: number;
    };

class CountingReader {
  reads = 0;
  constructor(private readonly inner: RoundReader, private readonly feed: Address) {}
  async latest(): Promise<RoundData> {
    this.reads++;
    return this.inner.latestRoundData(this.feed);
  }
  async get(roundId: bigint): Promise<RoundData | null> {
    this.reads++;
    const r = await this.inner.getRoundData(this.feed, roundId);
    return r === null || r.updatedAt === 0n ? null : r;
  }
}

/**
 * Find the last round of `feed` with `updatedAt ≤ t` (unix seconds), within the proxy's
 * current phase. Missing rounds are skipped (treated as absent, like the resolver's
 * try/catch). Assumes `updatedAt` is non-decreasing in round id, which Chainlink rounds are.
 */
export async function findLastAtOrBefore(reader: RoundReader, feed: Address, t: bigint | number): Promise<FindResult> {
  const T = BigInt(t);
  const r = new CountingReader(reader, feed);
  const latest = await r.latest();
  const phase = phaseOf(latest.roundId);
  const hi0 = aggregatorRoundOf(latest.roundId);

  if (latest.updatedAt !== 0n && latest.updatedAt <= T) {
    const sane = isSaneRound(latest);
    return { kind: 'found', round: latest, next: null, isLatest: true, sane, provable: sane, age: T - latest.updatedAt, reads: r.reads };
  }

  // Invariant: rounds with aggregator id > hi are after t (or missing). Search [lo, hi].
  let lo = 1n;
  let hi = hi0 - 1n;
  let best: RoundData | null = null;
  let firstSeen: RoundData | null = null;
  while (lo <= hi) {
    const mid = lo + (hi - lo) / 2n;
    const probe = await nearestPresent(r, phase, mid, lo, hi);
    if (probe === null) {
      // Nothing exists in [lo, hi].
      break;
    }
    const [id, round] = probe;
    if (firstSeen === null || id < aggregatorRoundOf(firstSeen.roundId)) firstSeen = round;
    if (round.updatedAt <= T) {
      best = round;
      lo = id + 1n;
    } else {
      hi = id - 1n;
    }
  }

  if (best === null) {
    // No round of this phase is at or before t. Confirm with the phase's first existing round.
    const first = firstSeen !== null && aggregatorRoundOf(firstSeen.roundId) === 1n ? firstSeen : await firstRoundOfPhase(r, phase, hi0);
    if (phase > 1n) return { kind: 'phase-boundary', firstRoundOfPhase: first, reads: r.reads };
    return { kind: 'before-first-round', reads: r.reads };
  }

  // Round x + 1 in the same phase: the next EXISTING round is what bounds x from above
  // (the binary search guarantees every existing round after x is after t).
  const nextId = aggregatorRoundOf(best.roundId) + 1n;
  const next = nextId <= hi0 ? (nextId === hi0 ? latest : await r.get(proxyRoundId(phase, nextId))) : null;
  const sane = isSaneRound(best);
  return {
    kind: 'found',
    round: best,
    next,
    isLatest: false,
    sane,
    provable: sane && next !== null && next.updatedAt > T,
    age: T - best.updatedAt,
    reads: r.reads,
  };
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

async function firstRoundOfPhase(r: CountingReader, phase: bigint, hi: bigint): Promise<RoundData | null> {
  for (let id = 1n; id <= hi && id <= 64n; id++) {
    const round = await r.get(proxyRoundId(phase, id));
    if (round !== null) return round;
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
