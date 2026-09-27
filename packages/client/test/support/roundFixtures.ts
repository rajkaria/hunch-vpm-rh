import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Address } from 'viem';
import { proxyRoundId, type RoundData, type RoundReader } from '../../src/index.js';

/** A fixture written by scripts/capture-rounds.ts from chain 4663 (never hand-written). */
export interface RoundFixture {
  ticker: string;
  feed: Address;
  description: string;
  capturedAt: string;
  capturedAtTimestamp: number;
  rpc: string;
  phase: number;
  latestRoundId: string;
  missing: number[];
  rounds: [number, string, number, number, string][];
}

export const TICKERS = ['nvda', 'tsla', 'aapl', 'coin', 'spy'] as const;

export function loadRoundFixture(ticker: string): RoundFixture {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/rounds-${ticker}.json`, import.meta.url)), 'utf8')) as RoundFixture;
}

export function roundsOf(f: RoundFixture, phase = BigInt(f.phase)): RoundData[] {
  return f.rounds.map(([agg, answer, startedAt, updatedAt, answeredInRound]) => ({
    roundId: proxyRoundId(phase, BigInt(agg)),
    answer: BigInt(answer),
    startedAt: BigInt(startedAt),
    updatedAt: BigInt(updatedAt),
    answeredInRound: BigInt(answeredInRound),
  }));
}

/** A RoundReader that answers exactly like the proxy would, from a series (with read counting). */
export class SeriesReader implements RoundReader {
  readonly byId = new Map<bigint, RoundData>();
  reads = 0;
  constructor(readonly rounds: RoundData[], readonly latestId: bigint) {
    for (const r of rounds) this.byId.set(r.roundId, r);
  }
  async latestRoundData(): Promise<RoundData> {
    this.reads++;
    const r = this.byId.get(this.latestId);
    if (r === undefined) throw new Error('latest round missing from series');
    return r;
  }
  async getRoundData(_feed: Address, roundId: bigint): Promise<RoundData | null> {
    this.reads++;
    return this.byId.get(roundId) ?? null;
  }
}

/** Brute force: the last round (by id, present) with updatedAt ≤ t. */
export function bruteForce(rounds: RoundData[], t: bigint): RoundData | null {
  let best: RoundData | null = null;
  for (const r of rounds) if (r.updatedAt <= t && (best === null || r.roundId > best.roundId)) best = r;
  return best;
}

// ------------------------------------------------------------------ overlapping phases (M-1)

/**
 * TRANSFORMED data: `rounds` re-labelled as aggregator rounds 1..k of `phase`, every
 * `updatedAt` / `startedAt` moved by `shift` seconds. Used to build multi-phase tapes (an
 * aggregator migration) out of captured series; never presented as captured.
 */
export function relabel(rounds: RoundData[], phase: bigint, shift = 0n): RoundData[] {
  return rounds.map((r, i) => {
    const roundId = proxyRoundId(phase, BigInt(i + 1));
    return { ...r, roundId, answeredInRound: roundId, startedAt: r.startedAt + shift, updatedAt: r.updatedAt + shift };
  });
}

/** The resolver's rule by brute force: among rounds with updatedAt ≤ t, the highest phase; in it, the last round. */
export function bruteForceInEffect(rounds: RoundData[], t: bigint): RoundData | null {
  let best: RoundData | null = null;
  for (const r of rounds) {
    if (r.updatedAt > t) continue;
    if (best === null || r.roundId >> 64n > best.roundId >> 64n || (r.roundId >> 64n === best.roundId >> 64n && r.roundId > best.roundId)) best = r;
  }
  return best;
}

/**
 * A literal port of `StockRoundResolver._prove` over a series (what the contract would say
 * about round `x` for time `t`): 'ok', 'badProof', 'badAnswer' or 'phaseBoundary'.
 */
export function proveLikeTheResolver(byId: ReadonlyMap<bigint, RoundData>, latestId: bigint, x: bigint, t: bigint, maxSpan = 8n): string {
  const get = (id: bigint) => {
    const r = byId.get(id);
    return r === undefined || r.updatedAt === 0n ? null : r;
  };
  const round = get(x);
  if (round === null || round.updatedAt > t) return 'badProof';
  if (round.answer <= 0n || round.answer >= 10n ** 14n) return 'badAnswer';
  const phase = x >> 64n;
  const current = latestId >> 64n;
  if (phase > current) return 'badProof';
  if (current - phase > maxSpan) return 'phaseBoundary';
  let laterPrinted = false;
  for (let q = phase + 1n; q <= current; q++) {
    const first = get(proxyRoundId(q, 1n));
    if (first !== null) {
      if (first.updatedAt <= t) return 'phaseBoundary';
      laterPrinted = true;
    }
  }
  if ((x & ((1n << 64n) - 1n)) !== (1n << 64n) - 1n) {
    const next = get(x + 1n);
    if (next !== null) return next.updatedAt > t ? 'ok' : 'badProof';
  }
  return x === latestId || laterPrinted ? 'ok' : 'badProof';
}
