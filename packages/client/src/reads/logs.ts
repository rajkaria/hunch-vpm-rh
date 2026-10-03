import type { AbiEvent, Address, Hex, Log } from 'viem';
import { getAbiItem } from 'viem';
import { hunchVpmAbi, stockRoundResolverAbi } from '../abi/index.js';
import { isDeployed, type Deployment } from '../deployment/index.js';
import type { ReadClient } from './shared.js';

/**
 * Log helpers: ENHANCEMENTS ONLY (entry times, tx links). The venue never depends on them:
 * the public RPC caps `eth_getLogs` at 10k logs per query, and providers cap block ranges
 * (QuickNode Discover: 5 blocks), so `getLogsChunked` splits a range adaptively within a
 * request budget, and a failure here must degrade to "no links", never to an empty market.
 * A market's scan starts at the block before it opened (`blockBefore`), not at the venue's
 * start block, so its cost does not grow with the venue's age.
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
  /**
   * Most `eth_getLogs` requests one scan may make (default 64). Past it the scan throws, so an
   * RPC that caps ranges far below the span degrades the enhancement in a second instead of
   * spending minutes (and its quota) on thousands of tiny ranges.
   */
  maxRequests?: number;
}

const TOO_MANY = /exceed|limit|too many|range|10000|10,000|query returned more than|response size|timeout|timed out/i;
/** A block-range cap the RPC states in its error ("eth_getLogs is limited to a 5 range", "max block range 10000"). */
const STATED_CAP = /(?:limited to(?: a)?|max(?:imum)?(?: block)? range(?: is| of)?|block range (?:limit|is limited to)(?: is| of)?)\s*(\d[\d,]*)/i;

/** The block-range cap an RPC error states, if any. */
export function statedRangeCap(error: unknown): bigint | null {
  const match = STATED_CAP.exec(String((error as Error)?.message ?? error));
  if (match === null) return null;
  const cap = BigInt(match[1]!.replace(/,/g, ''));
  return cap > 0n ? cap : null;
}

export class LogScanBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogScanBudgetError';
  }
}

export async function getLogsChunked(client: ReadClient, a: GetLogsChunkedArgs): Promise<Log[]> {
  const to = a.toBlock === 'latest' ? await client.getBlockNumber() : a.toBlock;
  const maxRange = a.maxRange ?? 5_000_000n;
  const minRange = a.minRange ?? 1n;
  const budget = a.maxRequests ?? 64;
  let requests = 0;
  const out: Log[] = [];
  const fetchRange = async (from: bigint, until: bigint): Promise<void> => {
    if (++requests > budget) throw new LogScanBudgetError(`eth_getLogs: more than ${budget} requests for blocks ${a.fromBlock}–${to}`);
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
      const cap = statedRangeCap(error);
      if (cap !== null && cap < span) {
        // The RPC said its cap: go straight to cap-sized ranges, if the budget allows them.
        const needed = (span + cap - 1n) / cap;
        if (needed > BigInt(budget - requests)) {
          throw new LogScanBudgetError(`eth_getLogs: the RPC caps ranges at ${cap} blocks; ${span} blocks would take ${needed} requests (budget ${budget})`);
        }
        for (let start = from; start <= until; start += cap) await fetchRange(start, start + cap - 1n < until ? start + cap - 1n : until);
        return;
      }
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

/**
 * A block before `timestamp` (unix seconds) and at or after `lo`: where a scan for the logs of
 * something that happened at `timestamp` can start. Interpolates on block times (~100 ms, near
 * uniform) with bisection every other step as the guard, and stops once the bracket is within
 * `slack` blocks, so it costs a handful of `eth_getBlockByNumber` calls. Returns `lo` when `lo`
 * is not before `timestamp`, and the head when the head is.
 */
export async function blockBefore(client: ReadClient, timestamp: number, lo: bigint, options: { slack?: bigint; maxSteps?: number } = {}): Promise<bigint> {
  const slack = options.slack ?? 2_000n;
  const maxSteps = options.maxSteps ?? 40;
  const timeOf = async (block: bigint): Promise<number> => Number((await client.getBlock({ blockNumber: block })).timestamp);
  let loBlock = lo;
  let loTime = await timeOf(loBlock);
  if (loTime >= timestamp) return lo;
  const head = await client.getBlock();
  let hiBlock = head.number!;
  let hiTime = Number(head.timestamp);
  if (hiTime < timestamp) return hiBlock;
  // Invariant: time(loBlock) < timestamp <= time(hiBlock).
  for (let step = 0; step < maxSteps && hiBlock - loBlock > slack; step++) {
    let guess =
      step % 2 === 0
        ? loBlock + ((hiBlock - loBlock) * BigInt(timestamp - loTime)) / BigInt(Math.max(1, hiTime - loTime))
        : loBlock + (hiBlock - loBlock) / 2n;
    if (guess <= loBlock) guess = loBlock + 1n;
    if (guess >= hiBlock) guess = hiBlock - 1n;
    const time = await timeOf(guess);
    if (time < timestamp) {
      loBlock = guess;
      loTime = time;
    } else {
      hiBlock = guess;
      hiTime = time;
    }
  }
  return loBlock;
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
 * Entry times and tx links for one market from settler/resolver logs, from `fromBlock`
 * (the block before the market opened, see `blockBefore`; default the deployment's start
 * block). Throws if the RPC cannot serve the range; callers treat that as "no enhancement".
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
