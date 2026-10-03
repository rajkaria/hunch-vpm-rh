import { getAbiItem, type AbiEvent, type Log } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogScanBudgetError, blockBefore, getLogsChunked, hunchVpmAbi, makePublicClient, statedRangeCap, type ReadClient } from '../src/index.js';

const ENTERED = getAbiItem({ abi: hunchVpmAbi, name: 'Entered' }) as AbiEvent;
const VPM = '0x1c23356536eA8E30F53481b971098aC30DA43576';

/** The exact body QuickNode's Discover plan answers with (HTTP 413) for any range above 5 blocks. */
const QUICKNODE_413 = 'HTTP request failed. Status: 413 Details: {"code":-32615,"message":"eth_getLogs is limited to a 5 range, upgrade from discover plan at https://example to increase the limit"}';

/** A log RPC: `logsAt` blocks hold one log each; `cap` (blocks) and `maxLogs` behave like real providers. */
function logRpc(opts: { head: bigint; logsAt: bigint[]; cap?: bigint; maxLogs?: number; message?: string }) {
  const ranges: [bigint, bigint][] = [];
  const client = {
    getBlockNumber: vi.fn(async () => opts.head),
    getLogs: vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push([fromBlock, toBlock]);
      if (opts.cap !== undefined && toBlock - fromBlock + 1n > opts.cap) throw new Error(opts.message ?? QUICKNODE_413);
      const hits = opts.logsAt.filter((b) => b >= fromBlock && b <= toBlock);
      if (opts.maxLogs !== undefined && hits.length > opts.maxLogs) throw new Error(`query returned more than ${opts.maxLogs} results`);
      return hits.map((b, i) => ({ blockNumber: b, logIndex: i }) as unknown as Log);
    }),
  };
  return { client: client as unknown as ReadClient, ranges, calls: () => client.getLogs.mock.calls.length };
}

const scan = (client: ReadClient, extra: Partial<Parameters<typeof getLogsChunked>[1]> = {}) =>
  getLogsChunked(client, { address: VPM, event: ENTERED, fromBlock: 0n, toBlock: 'latest', ...extra });

describe('getLogsChunked', () => {
  it('reads a long range in one request when the RPC serves it (the public RPC: 775k blocks in one query)', async () => {
    const rpc = logRpc({ head: 775_000n, logsAt: [10n, 500_000n] });
    expect((await scan(rpc.client)).map((l) => l.blockNumber)).toEqual([10n, 500_000n]);
    expect(rpc.calls()).toBe(1);
  });

  it('halves a range that returns too many logs, and keeps every log in order', async () => {
    const logsAt = Array.from({ length: 30 }, (_, i) => BigInt(i * 1000));
    const rpc = logRpc({ head: 30_000n, logsAt, maxLogs: 10 });
    const logs = await scan(rpc.client);
    expect(logs.map((l) => l.blockNumber)).toEqual(logsAt);
  });

  it('goes straight to the range cap an RPC states, when the budget allows', async () => {
    const rpc = logRpc({ head: 99n, logsAt: [3n, 42n, 99n], cap: 25n, message: 'max block range 25 exceeded' });
    expect((await scan(rpc.client)).map((l) => l.blockNumber)).toEqual([3n, 42n, 99n]);
    // One refused full-range request, then four cap-sized ranges: no halving cascade.
    expect(rpc.ranges.slice(1)).toEqual([
      [0n, 24n],
      [25n, 49n],
      [50n, 74n],
      [75n, 99n],
    ]);
  });

  it("fails fast on QuickNode Discover's 5-block cap instead of making 155,000 requests", async () => {
    const rpc = logRpc({ head: 775_000n, logsAt: [10n], cap: 5n });
    await expect(scan(rpc.client)).rejects.toBeInstanceOf(LogScanBudgetError);
    expect(rpc.calls()).toBe(1);
  });

  it('never exceeds its request budget, whatever the RPC answers', async () => {
    const rpc = logRpc({ head: 1_000_000n, logsAt: [], cap: 1n, message: 'request timed out' });
    await expect(scan(rpc.client, { maxRequests: 20 })).rejects.toBeInstanceOf(LogScanBudgetError);
    expect(rpc.calls()).toBeLessThanOrEqual(20);
  });

  it('rethrows an error that is not about size', async () => {
    const client = { getBlockNumber: async () => 10n, getLogs: async () => Promise.reject(new Error('execution reverted')) } as unknown as ReadClient;
    await expect(scan(client)).rejects.toThrow('execution reverted');
  });
});

describe('statedRangeCap', () => {
  it('reads the cap out of real provider errors', () => {
    expect(statedRangeCap(new Error(QUICKNODE_413))).toBe(5n);
    expect(statedRangeCap(new Error('max block range 10,000 exceeded'))).toBe(10_000n);
    expect(statedRangeCap(new Error('block range is limited to 2000'))).toBe(2_000n);
    expect(statedRangeCap(new Error('query returned more than 10000 results'))).toBeNull();
  });
});

/** Blocks every 100 ms from `genesisTime` (timestamps in whole seconds), with a call counter. */
function blockChain(head: bigint, genesisTime: number) {
  const timeOf = (n: bigint) => genesisTime + Math.floor(Number(n) / 10);
  const getBlock = vi.fn(async (args?: { blockNumber?: bigint }) => {
    const number = args?.blockNumber ?? head;
    return { number, timestamp: BigInt(timeOf(number)) };
  });
  return { client: { getBlock } as unknown as ReadClient, timeOf, calls: () => getBlock.mock.calls.length };
}

describe('blockBefore (where a market log scan starts)', () => {
  const START = 78_426_641n;
  const HEAD = START + 775_000n;
  const GENESIS = 1_790_000_000;

  it('finds a block just before the market opened, in a handful of calls', async () => {
    const chain = blockChain(HEAD, GENESIS);
    const openedAt = chain.timeOf(START + 98_765n);
    const block = await blockBefore(chain.client, openedAt, START);
    expect(chain.timeOf(block)).toBeLessThan(openedAt); // never after the opening: no entry is missed
    expect(START + 98_765n - block).toBeLessThanOrEqual(2_010n); // and close to it
    expect(chain.calls()).toBeLessThanOrEqual(12);
  });

  it('is exact with no slack', async () => {
    const chain = blockChain(HEAD, GENESIS);
    const openedAt = chain.timeOf(START + 500_000n);
    const block = await blockBefore(chain.client, openedAt, START, { slack: 1n });
    expect(chain.timeOf(block)).toBeLessThan(openedAt);
    expect(chain.timeOf(block + 1n)).toBe(openedAt);
  });

  it('returns the lower bound when the market is not after it, and the head when it is after the head', async () => {
    const chain = blockChain(HEAD, GENESIS);
    expect(await blockBefore(chain.client, chain.timeOf(START), START)).toBe(START);
    expect(await blockBefore(chain.client, chain.timeOf(HEAD) + 60, START)).toBe(HEAD);
  });
});

describe('makePublicClient: eth_getLogs stays off RPCs that cap its range', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the next RPC for logs, without a request to the capped one, and keeps it for everything else', async () => {
    const seen: { host: string; method: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { id: number; method: string };
        seen.push({ host: new URL(String(url)).host, method: body.method });
        const result = body.method === 'eth_getLogs' ? [] : '0x10';
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } });
      }),
    );
    const keyed = 'https://keyed.example/abc';
    const client = makePublicClient({ rpcUrl: keyed, noLogsRpcUrls: [keyed], multicallBatch: false });
    await client.getBlockNumber({ cacheTime: 0 });
    await client.getLogs({ address: VPM, event: ENTERED, fromBlock: 1n, toBlock: 1_000_000n });
    expect(seen).toEqual([
      { host: 'keyed.example', method: 'eth_blockNumber' },
      { host: 'rpc.mainnet.chain.robinhood.com', method: 'eth_getLogs' },
    ]);
  });
});
