// @vitest-environment node
/**
 * Entry times and transaction links come from `eth_getLogs`. The keyed RPC's plan caps its range
 * at 5 blocks (HTTP 413), so logs must never go there, and a market's scan starts at the block
 * before it opened rather than the venue's start block, so it does not grow with the venue's age.
 */
import type { PublicClient } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readDeployment } from '@/lib/deployment';
import { clearLastGood } from '@/lib/server/cache';
import { serverClientOptions, setServerClient } from '@/lib/server/client';
import { getActivity, getActivitySnapshot } from '@/lib/server/market';

afterEach(() => {
  setServerClient(null);
  clearLastGood();
});

const START = BigInt(readDeployment().startBlock ?? 0);
const HEAD = START + 775_000n;
const GENESIS = 1_790_960_000;
const timeOf = (n: bigint): number => GENESIS + Math.floor(Number(n - START) / 10);

function fakeChain() {
  const scans: bigint[] = [];
  const client = {
    getBlockNumber: vi.fn(async () => HEAD),
    getBlock: vi.fn(async (args?: { blockNumber?: bigint }) => {
      const number = args?.blockNumber ?? HEAD;
      return { number, timestamp: BigInt(timeOf(number)) };
    }),
    getLogs: vi.fn(async ({ fromBlock }: { fromBlock: bigint }) => {
      scans.push(fromBlock);
      return [];
    }),
  };
  setServerClient(client as unknown as PublicClient);
  return { client, scans };
}

describe('a market log scan', () => {
  it('starts just before the market opened, not at the venue start block', async () => {
    const { scans } = fakeChain();
    const opening = START + 700_000n;
    const snapshot = await getActivitySnapshot(7n, false, timeOf(opening));
    expect(snapshot.stale).toBe(false);
    expect(scans.length).toBeGreaterThan(0);
    for (const from of scans) {
      expect(from).toBeLessThan(opening); // nothing the market did is skipped
      expect(opening - from).toBeLessThanOrEqual(2_010n); // and the 700k blocks before it are not scanned
    }
  });

  it('falls back to the start block when the opening block cannot be found, and still reads', async () => {
    const { client, scans } = fakeChain();
    client.getBlock.mockRejectedValue(new Error('block headers unavailable'));
    expect(await getActivity(8n, false, timeOf(START + 700_000n))).not.toBeNull();
    expect(scans.every((from) => from === START)).toBe(true);
  });

  it('degrades to no links (null), never to an error, when logs cannot be read', async () => {
    const { client } = fakeChain();
    client.getLogs.mockRejectedValue(new Error('execution reverted'));
    expect(await getActivity(9n, false, timeOf(START + 10n))).toBeNull();
  });
});

describe('the server RPC client', () => {
  it('keeps eth_getLogs off the keyed RPC by default (its plan caps the range at 5 blocks)', () => {
    expect(serverClientOptions({ RH_RPC_URL: ' https://keyed.example/k ' })).toEqual({
      rpcUrl: 'https://keyed.example/k',
      fallbackRpcUrls: [undefined],
      noLogsRpcUrls: ['https://keyed.example/k'],
    });
  });

  it('sends logs to RH_LOGS_RPC_URL first when set, and to the keyed RPC only if it is that URL', () => {
    expect(serverClientOptions({ RH_RPC_URL: 'https://keyed.example/k', RH_LOGS_RPC_URL: 'https://logs.example/l' })).toEqual({
      rpcUrl: 'https://keyed.example/k',
      fallbackRpcUrls: ['https://logs.example/l'],
      noLogsRpcUrls: ['https://keyed.example/k'],
    });
    expect(serverClientOptions({ RH_RPC_URL: 'https://keyed.example/k', RH_LOGS_RPC_URL: 'https://keyed.example/k' }).noLogsRpcUrls).toEqual([]);
    expect(serverClientOptions({})).toEqual({ rpcUrl: undefined, fallbackRpcUrls: [undefined], noLogsRpcUrls: [] });
  });
});
