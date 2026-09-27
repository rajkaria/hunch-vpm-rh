import type { AbiEvent, Address, Hex, Log } from 'viem';
import { getAbiItem } from 'viem';
import { hunchVpmAbi, stockRoundResolverAbi } from '../abi/index.js';
import { isDeployed, type Deployment } from '../deployment/index.js';
import type { ReadClient } from './shared.js';

/**
 * Log helpers: ENHANCEMENTS ONLY (entry times, tx links). The venue never depends on them:
 * the public RPC caps `eth_getLogs` at 10k logs per query, and providers cap block ranges,
 * so `getLogsChunked` splits a range adaptively and a failure here must degrade to "no
 * links", never to an empty market.
 */

export interface GetLogsChunkedArgs {
  address: Address | Address[];
  event: AbiEvent;
  args?: Record<string, unknown>;
  fromBlock: bigint;
  toBlock: bigint | 'latest';
  /** Largest range tried in one request (default 5,000,000 blocks ≈ 5.8 days at 100 ms). */
  maxRange?: bigint;
  /** Stop splitting below this range and rethrow (default 1). */
  minRange?: bigint;
}

const TOO_MANY = /exceed|limit|too many|range|10000|10,000|query returned more than|response size|timeout|timed out/i;

export async function getLogsChunked(client: ReadClient, a: GetLogsChunkedArgs): Promise<Log[]> {
  const to = a.toBlock === 'latest' ? await client.getBlockNumber() : a.toBlock;
  const maxRange = a.maxRange ?? 5_000_000n;
  const minRange = a.minRange ?? 1n;
  const out: Log[] = [];
  const fetchRange = async (from: bigint, until: bigint): Promise<void> => {
    try {
      const logs = await client.getLogs({
        address: a.address,
        event: a.event,
        args: a.args,
        fromBlock: from,
        toBlock: until,
      } as never);
      out.push(...(logs as Log[]));
    } catch (error) {
      const span = until - from + 1n;
      if (span <= minRange || !TOO_MANY.test(String((error as Error)?.message ?? error))) throw error;
      const mid = from + span / 2n - 1n;
      await fetchRange(from, mid);
      await fetchRange(mid + 1n, until);
    }
  };
  for (let from = a.fromBlock; from <= to; from += maxRange) {
    const until = from + maxRange - 1n < to ? from + maxRange - 1n : to;
    await fetchRange(from, until);
  }
  return out.sort((x, y) => (x.blockNumber === y.blockNumber ? (x.logIndex ?? 0) - (y.logIndex ?? 0) : x.blockNumber! < y.blockNumber! ? -1 : 1));
}

export interface TxRef {
  txHash: Hex;
  blockNumber: bigint;
  /** Unix seconds (from the block). */
  timestamp: number;
}

export interface MarketActivity {
  /** positionId → the entry transaction. */
  entries: Map<bigint, TxRef>;
  /** positionId → the claim transactions (claim/claimFor/withdrawRefund*). */
  claims: Map<bigint, (TxRef & { payout: bigint; refund: bigint })[]>;
  resolved: TxRef | null;
  voided: TxRef | null;
}

/**
 * Entry times and tx links for one market from settler/resolver logs, from the
 * deployment's start block. Throws if the RPC cannot serve the range; callers treat
 * that as "no enhancement".
 */
export async function readMarketActivity(
  client: ReadClient,
  d: Deployment,
  marketId: bigint,
  options: { fromBlock?: bigint; specId?: Hex } = {},
): Promise<MarketActivity> {
  const activity: MarketActivity = { entries: new Map(), claims: new Map(), resolved: null, voided: null };
  if (!isDeployed(d)) return activity;
  const fromBlock = options.fromBlock ?? BigInt(d.startBlock ?? 0);
  const vpm = d.contracts.HunchVPM.address;
  const entered = getAbiItem({ abi: hunchVpmAbi, name: 'Entered' }) as AbiEvent;
  const claimed = getAbiItem({ abi: hunchVpmAbi, name: 'Claimed' }) as AbiEvent;
  const voided = getAbiItem({ abi: hunchVpmAbi, name: 'Voided' }) as AbiEvent;
  const resolvedEv = getAbiItem({ abi: stockRoundResolverAbi, name: 'Resolved' }) as AbiEvent;

  const [entries, voids, resolves] = await Promise.all([
    getLogsChunked(client, { address: vpm, event: entered, args: { marketId }, fromBlock, toBlock: 'latest' }),
    getLogsChunked(client, { address: vpm, event: voided, args: { marketId }, fromBlock, toBlock: 'latest' }),
    getLogsChunked(client, { address: d.contracts.StockRoundResolver.address, event: resolvedEv, args: { marketId }, fromBlock, toBlock: 'latest' }),
  ]);
  const ids = entries.map((l) => (l as unknown as { args: { positionId: bigint } }).args.positionId);
  const claims = ids.length === 0 ? [] : await getLogsChunked(client, { address: vpm, event: claimed, args: { positionId: ids }, fromBlock, toBlock: 'latest' });

  const times = new Map<bigint, Promise<number>>();
  const timeOf = (block: bigint) => {
    let t = times.get(block);
    if (t === undefined) {
      t = client.getBlock({ blockNumber: block }).then((b) => Number(b.timestamp));
      times.set(block, t);
    }
    return t;
  };
  const ref = async (l: Log): Promise<TxRef> => ({ txHash: l.transactionHash!, blockNumber: l.blockNumber!, timestamp: await timeOf(l.blockNumber!) });

  for (const l of entries) {
    const { positionId } = (l as unknown as { args: { positionId: bigint } }).args;
    activity.entries.set(positionId, await ref(l));
  }
  for (const l of claims) {
    const { positionId, payout, refund } = (l as unknown as { args: { positionId: bigint; payout: bigint; refund: bigint } }).args;
    const list = activity.claims.get(positionId) ?? [];
    list.push({ ...(await ref(l)), payout, refund });
    activity.claims.set(positionId, list);
  }
  const lastVoid = voids[voids.length - 1];
  if (lastVoid !== undefined) activity.voided = await ref(lastVoid);
  const lastResolve = resolves[resolves.length - 1];
  if (lastResolve !== undefined) activity.resolved = await ref(lastResolve);
  return activity;
}
