import type { Abi, Address, Hex, PublicClient } from 'viem';
import { multicall3Abi } from '../abi/index.js';
import { MULTICALL3_ADDRESS } from '../constants.js';
import type { Book, Position } from '../mechanics.js';
import type { RoundData } from '../rounds.js';

/**
 * Multicall plumbing and tuple decoding shared by every read. Reads never scan logs: the
 * venue is enumerated with view calls (factory listings → settler/resolver views), so it
 * works on the public RPC, which keeps ~10 min of state and caps `eth_getLogs`.
 */

export type ReadClient = PublicClient;

export interface Call {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

export type CallResult = { ok: true; value: unknown } | { ok: false; error: Error };

/** Run `calls` through Multicall3 with `allowFailure`, chunked. Order is preserved. */
export async function callMany(client: ReadClient, calls: readonly Call[], chunk = 400): Promise<CallResult[]> {
  const out: CallResult[] = [];
  for (let i = 0; i < calls.length; i += chunk) {
    const slice = calls.slice(i, i + chunk);
    const results = (await client.multicall({
      contracts: slice as never,
      allowFailure: true,
      multicallAddress: MULTICALL3_ADDRESS,
    } as never)) as readonly ({ status: 'success'; result: unknown } | { status: 'failure'; error: Error })[];
    for (const r of results) out.push(r.status === 'success' ? { ok: true, value: r.result } : { ok: false, error: r.error });
  }
  return out;
}

/** The value of a call that must succeed. */
export function must<T>(r: CallResult | undefined, what: string): T {
  if (r === undefined) throw new Error(`${what}: no result`);
  if (!r.ok) throw new Error(`${what}: ${r.error.message.split('\n')[0]}`);
  return r.value as T;
}

export function maybe<T>(r: CallResult | undefined): T | null {
  return r !== undefined && r.ok ? (r.value as T) : null;
}

export interface ChainHead {
  /** L2 block number. */
  blockNumber: bigint;
  /** L1 block estimate (= `block.number` inside contracts, the vintage clock). */
  l1BlockNumber: bigint;
  /** Block timestamp, unix seconds. */
  timestamp: number;
}

export function headCalls(): Call[] {
  return [
    { address: MULTICALL3_ADDRESS, abi: multicall3Abi, functionName: 'getBlockNumber' },
    { address: MULTICALL3_ADDRESS, abi: multicall3Abi, functionName: 'getCurrentBlockTimestamp' },
  ];
}

/** Current L2 head, the L1 block estimate and the block time. */
export async function readChainHead(client: ReadClient): Promise<ChainHead> {
  const [block, results] = await Promise.all([client.getBlock({ blockTag: 'latest' }), callMany(client, headCalls())]);
  return {
    blockNumber: block.number ?? 0n,
    l1BlockNumber: must<bigint>(results[0], 'getBlockNumber'),
    timestamp: Number(block.timestamp),
  };
}

// ------------------------------------------------------------------ decoding (arrays or named objects)

function field(v: unknown, index: number, name: string): unknown {
  if (Array.isArray(v)) return v[index];
  if (typeof v === 'object' && v !== null) return (v as Record<string, unknown>)[name];
  throw new TypeError(`cannot decode ${name}`);
}

export interface Listing {
  index: number;
  marketId: bigint;
  specId: Hex;
  feed: Address;
  strikeTime: number;
  finalTime: number;
  maxStrikeAge: number;
  maxFinalAge: number;
  seedPerLeg: bigint;
  minEntry: bigint;
  maxEntry: bigint;
  opener: Address;
  openedAt: number;
}

export function decodeListing(v: unknown, index: number): Listing {
  return {
    index,
    marketId: field(v, 0, 'marketId') as bigint,
    specId: field(v, 1, 'specId') as Hex,
    feed: field(v, 2, 'feed') as Address,
    strikeTime: Number(field(v, 3, 'strikeTime')),
    finalTime: Number(field(v, 4, 'finalTime')),
    maxStrikeAge: Number(field(v, 5, 'maxStrikeAge')),
    maxFinalAge: Number(field(v, 6, 'maxFinalAge')),
    seedPerLeg: field(v, 7, 'seedPerLeg') as bigint,
    minEntry: field(v, 8, 'minEntry') as bigint,
    maxEntry: field(v, 9, 'maxEntry') as bigint,
    opener: field(v, 10, 'opener') as Address,
    openedAt: Number(field(v, 11, 'openedAt')),
  };
}

export interface MarketTuple {
  token: Address;
  creator: Address;
  resolver: Address;
  residueOwner: Address;
  resolutionTime: number;
  voidTimeout: number;
  n: number;
  status: number;
  winner: number;
  kappa: bigint;
  acceptedPool: bigint;
  paidOut: bigint;
}

export function decodeMarket(v: unknown): MarketTuple {
  return {
    token: field(v, 0, 'token') as Address,
    creator: field(v, 1, 'creator') as Address,
    resolver: field(v, 2, 'resolver') as Address,
    residueOwner: field(v, 3, 'residueOwner') as Address,
    resolutionTime: Number(field(v, 4, 'resolutionTime')),
    voidTimeout: Number(field(v, 5, 'voidTimeout')),
    n: Number(field(v, 6, 'n')),
    status: Number(field(v, 7, 'status')),
    winner: Number(field(v, 8, 'winner')),
    kappa: field(v, 9, 'kappa') as bigint,
    acceptedPool: field(v, 10, 'acceptedPool') as bigint,
    paidOut: field(v, 11, 'paidOut') as bigint,
  };
}

export function decodeBook(v: unknown): Book {
  return {
    principal: field(v, 0, 'principal') as bigint,
    acc: field(v, 1, 'acc') as bigint,
    capacity: field(v, 2, 'capacity') as bigint,
    vested: field(v, 3, 'vested') as bigint,
    demand: field(v, 4, 'demand') as bigint,
    live: field(v, 5, 'live') as bigint,
  };
}

export function decodePosition(v: unknown): Position {
  return {
    marketId: BigInt(field(v, 0, 'marketId') as bigint),
    owner: field(v, 1, 'owner') as Address,
    outcome: Number(field(v, 2, 'outcome')),
    finalized: field(v, 3, 'finalized') as boolean,
    refunded: field(v, 4, 'refunded') as boolean,
    claimed: field(v, 5, 'claimed') as boolean,
    vintage: BigInt(field(v, 6, 'vintage') as bigint),
    offered: field(v, 7, 'offered') as bigint,
    accepted: field(v, 8, 'accepted') as bigint,
    entryAcc: field(v, 9, 'entryAcc') as bigint,
  };
}

export interface MarketTerms {
  feeBps: number;
  minEntry: bigint;
  maxEntry: bigint;
}

export function decodeTerms(v: unknown): MarketTerms {
  return {
    feeBps: Number(field(v, 0, 'feeBps')),
    minEntry: field(v, 1, 'minEntry') as bigint,
    maxEntry: field(v, 2, 'maxEntry') as bigint,
  };
}

export interface FeedInfo {
  stockToken: Address;
  maxStrikeAge: number;
  maxFinalAge: number;
  allowed: boolean;
  ticker: string;
}

export function decodeFeedInfo(v: unknown): FeedInfo {
  return {
    stockToken: field(v, 0, 'stockToken') as Address,
    maxStrikeAge: Number(field(v, 1, 'maxStrikeAge')),
    maxFinalAge: Number(field(v, 2, 'maxFinalAge')),
    allowed: field(v, 3, 'allowed') as boolean,
    ticker: field(v, 4, 'ticker') as string,
  };
}

export interface Spec {
  settler: Address;
  marketId: bigint;
  feed: Address;
  stockToken: Address;
  strikeTime: number;
  finalTime: number;
  maxStrikeAge: number;
  maxFinalAge: number;
}

export function decodeSpec(v: unknown): Spec {
  return {
    settler: field(v, 0, 'settler') as Address,
    marketId: field(v, 1, 'marketId') as bigint,
    feed: field(v, 2, 'feed') as Address,
    stockToken: field(v, 3, 'stockToken') as Address,
    strikeTime: Number(field(v, 4, 'strikeTime')),
    finalTime: Number(field(v, 5, 'finalTime')),
    maxStrikeAge: Number(field(v, 6, 'maxStrikeAge')),
    maxFinalAge: Number(field(v, 7, 'maxFinalAge')),
  };
}

export function decodeRound(v: unknown): RoundData {
  return {
    roundId: field(v, 0, 'roundId') as bigint,
    answer: field(v, 1, 'answer') as bigint,
    startedAt: field(v, 2, 'startedAt') as bigint,
    updatedAt: field(v, 3, 'updatedAt') as bigint,
    answeredInRound: field(v, 4, 'answeredInRound') as bigint,
  };
}

export interface PreviewResult {
  status: number;
  strikeAnswer: bigint;
  strikeAt: number;
  finalAnswer: bigint;
  finalAt: number;
}

export function decodePreview(v: unknown): PreviewResult {
  return {
    status: Number(field(v, 0, 'status')),
    strikeAnswer: field(v, 1, 'strikeAnswer') as bigint,
    strikeAt: Number(field(v, 2, 'strikeAt')),
    finalAnswer: field(v, 3, 'finalAnswer') as bigint,
    finalAt: Number(field(v, 4, 'finalAt')),
  };
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
