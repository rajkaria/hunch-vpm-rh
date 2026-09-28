/**
 * Log reads: enhancements only (entry times, transaction links, the rounds a settlement used,
 * fee sweeps). The venue never depends on them: the public RPC caps `eth_getLogs`, so every
 * caller treats a failure here as "no links" and falls back to view calls.
 */

import {
  getLogsChunked,
  hunchVpmAbi,
  isDeployed,
  readMarketActivity,
  stockRoundResolverAbi,
  type Deployment,
  type MarketActivity,
} from '@hunch-rh/client';
import { getAbiItem, type AbiEvent, type Address, type Hex, type Log, type PublicClient } from 'viem';

export interface TxRefData {
  txHash: Hex;
  blockNumber: bigint;
  timestamp: number;
}

/** `readMarketActivity`, with its Maps flattened so it can be cached as JSON. */
export interface ActivityData {
  entries: Record<string, TxRefData>;
  claims: Record<string, (TxRefData & { payout: bigint; refund: bigint })[]>;
  resolved: TxRefData | null;
  voided: TxRefData | null;
}

export function flattenActivity(activity: MarketActivity): ActivityData {
  return {
    entries: Object.fromEntries([...activity.entries].map(([id, ref]) => [id.toString(), ref])),
    claims: Object.fromEntries([...activity.claims].map(([id, list]) => [id.toString(), list])),
    resolved: activity.resolved,
    voided: activity.voided,
  };
}

export async function readActivity(client: PublicClient, d: Deployment, marketId: bigint): Promise<ActivityData> {
  return flattenActivity(await readMarketActivity(client, d, marketId));
}

export interface ResolutionLog {
  marketId: bigint;
  kind: 'resolved' | 'voided-stale' | 'voided-paused' | 'voided-bad-answer';
  /** For `resolved`: the resolver's outcome (FLAT voids inside `resolve`). */
  outcome: 'UP' | 'DOWN' | 'FLAT' | null;
  strikeRound: bigint | null;
  finalRound: bigint | null;
  strikeAnswer: bigint | null;
  finalAnswer: bigint | null;
  strikeAt: number | null;
  finalAt: number | null;
  txHash: Hex;
  blockNumber: bigint;
}

type Decoded = Log & { args: Record<string, unknown> };

const OUTCOME = ['UP', 'DOWN', 'FLAT'] as const;

/** Every settlement the resolver made (`Resolved`, `VoidedStale`, `VoidedBadAnswer`, `VoidedPaused`), oldest first. */
export async function readResolutionLogs(client: PublicClient, d: Deployment): Promise<ResolutionLog[]> {
  if (!isDeployed(d)) return [];
  const address = d.contracts.StockRoundResolver.address;
  const fromBlock = BigInt(d.startBlock ?? 0);
  const event = (name: 'Resolved' | 'VoidedStale' | 'VoidedBadAnswer' | 'VoidedPaused') => getAbiItem({ abi: stockRoundResolverAbi, name }) as AbiEvent;
  const [resolved, stale, badAnswer, paused] = await Promise.all([
    getLogsChunked(client, { address, event: event('Resolved'), fromBlock, toBlock: 'latest' }),
    getLogsChunked(client, { address, event: event('VoidedStale'), fromBlock, toBlock: 'latest' }),
    getLogsChunked(client, { address, event: event('VoidedBadAnswer'), fromBlock, toBlock: 'latest' }),
    getLogsChunked(client, { address, event: event('VoidedPaused'), fromBlock, toBlock: 'latest' }),
  ]);
  const out: ResolutionLog[] = [];
  for (const log of resolved as Decoded[]) {
    const a = log.args;
    out.push({
      marketId: a.marketId as bigint,
      kind: 'resolved',
      outcome: OUTCOME[Number(a.outcome)] ?? null,
      strikeRound: a.strikeRound as bigint,
      finalRound: a.finalRound as bigint,
      strikeAnswer: a.strikeAnswer as bigint,
      finalAnswer: a.finalAnswer as bigint,
      strikeAt: Number(a.strikeAt),
      finalAt: Number(a.finalAt),
      txHash: log.transactionHash!,
      blockNumber: log.blockNumber!,
    });
  }
  const voids = [
    ...(stale as Decoded[]).map((log) => ({ kind: 'voided-stale' as const, log })),
    ...(badAnswer as Decoded[]).map((log) => ({ kind: 'voided-bad-answer' as const, log })),
  ];
  for (const { kind, log } of voids) {
    out.push({
      marketId: log.args.marketId as bigint,
      kind,
      outcome: null,
      strikeRound: log.args.strikeRound as bigint,
      finalRound: log.args.finalRound as bigint,
      strikeAnswer: null,
      finalAnswer: null,
      strikeAt: null,
      finalAt: null,
      txHash: log.transactionHash!,
      blockNumber: log.blockNumber!,
    });
  }
  for (const log of paused as Decoded[]) {
    out.push({
      marketId: log.args.marketId as bigint,
      kind: 'voided-paused',
      outcome: null,
      strikeRound: null,
      finalRound: null,
      strikeAnswer: null,
      finalAnswer: null,
      strikeAt: null,
      finalAt: null,
      txHash: log.transactionHash!,
      blockNumber: log.blockNumber!,
    });
  }
  return out.sort((x, y) => (x.blockNumber < y.blockNumber ? -1 : x.blockNumber > y.blockNumber ? 1 : 0));
}

export interface FeeSweepLog {
  txHash: Hex;
  to: Address;
  amount: bigint;
  blockNumber: bigint;
  timestamp: number;
}

/** `FeesSwept` events of the settler for USDG, newest first, with block times. */
export async function readFeeSweeps(client: PublicClient, d: Deployment): Promise<FeeSweepLog[]> {
  if (!isDeployed(d)) return [];
  const event = getAbiItem({ abi: hunchVpmAbi, name: 'FeesSwept' }) as AbiEvent;
  const logs = (await getLogsChunked(client, {
    address: d.contracts.HunchVPM.address,
    event,
    args: { token: d.usdg },
    fromBlock: BigInt(d.startBlock ?? 0),
    toBlock: 'latest',
  })) as Decoded[];
  const times = new Map<bigint, Promise<number>>();
  const timeOf = (block: bigint): Promise<number> => {
    let t = times.get(block);
    if (t === undefined) {
      t = client.getBlock({ blockNumber: block }).then((b) => Number(b.timestamp));
      times.set(block, t);
    }
    return t;
  };
  const rows = await Promise.all(
    logs.map(async (log) => ({
      txHash: log.transactionHash!,
      to: log.args.to as Address,
      amount: log.args.amount as bigint,
      blockNumber: log.blockNumber!,
      timestamp: await timeOf(log.blockNumber!),
    })),
  );
  return rows.reverse();
}
