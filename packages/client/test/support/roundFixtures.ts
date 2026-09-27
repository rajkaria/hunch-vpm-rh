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
