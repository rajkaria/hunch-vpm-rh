import type { Deployment } from '@hunch-rh/client';
import type { PublicClient, WalletClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { finalizeDue, finalizeWhenDue } from '../src/index.js';
import { deployedDeployment } from '../../client/test/support/fakeChain.js';

const d: Deployment = deployedDeployment();

/** A public client that answers pendingCount and the L1 block number from scripted sequences. */
function fakeClient(pending: bigint[], l1: bigint[]) {
  let reads = 0;
  const simulated: unknown[] = [];
  const client = {
    async readContract() {
      return pending[Math.min(reads, pending.length - 1)];
    },
    async getBlock() {
      return { number: 1n, timestamp: 1n };
    },
    async multicall() {
      const v = l1[Math.min(reads, l1.length - 1)];
      reads++;
      return [{ status: 'success', result: v }, { status: 'success', result: 1n }];
    },
    async simulateContract(req: unknown) {
      simulated.push(req);
      return { request: req };
    },
  } as unknown as PublicClient;
  return { client, simulated, reads: () => reads };
}

function wallet(): WalletClient & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    account: { address: '0x00000000000000000000000000000000000000A1', type: 'local' },
    sent,
    async writeContract(req: unknown) {
      sent.push(req);
      return `0x${'ab'.repeat(32)}`;
    },
  } as unknown as WalletClient & { sent: unknown[] };
}

const noSleep = async () => {};

describe('finalize soon after a relayed bet', () => {
  it('finalizeDue: waits for the next Ethereum block, skips an empty batch', () => {
    expect(finalizeDue({ pendingCount: 0n, l1BlockAtEntry: 10n, l1BlockNow: 11n })).toBe('nothing-pending');
    expect(finalizeDue({ pendingCount: 2n, l1BlockAtEntry: 10n, l1BlockNow: 10n })).toBe('wait');
    expect(finalizeDue({ pendingCount: 2n, l1BlockAtEntry: 10n, l1BlockNow: 11n })).toBe('due');
  });

  it('polls until the block passes, then sends finalizeVintage once', async () => {
    const { client, simulated } = fakeClient([1n], [10n, 10n, 11n]);
    const w = wallet();
    const out = await finalizeWhenDue(client, w, d, 3n, 10n, { sleep: noSleep, pollMs: 1 });
    expect(out.status).toBe('finalized');
    expect(simulated).toHaveLength(1);
    expect(simulated[0]).toMatchObject({ functionName: 'finalizeVintage', args: [3n] });
    expect(w.sent).toHaveLength(1);
  });

  it('does nothing when the next bet or the deliver job already wrote the batch', async () => {
    const { client, simulated } = fakeClient([0n], [11n]);
    expect((await finalizeWhenDue(client, wallet(), d, 3n, 10n, { sleep: noSleep })).status).toBe('nothing-pending');
    expect(simulated).toEqual([]);
  });

  it('gives up at the deadline and never sends without a wallet', async () => {
    const { client } = fakeClient([1n], [10n]);
    let t = 0;
    const out = await finalizeWhenDue(client, wallet(), d, 3n, 10n, { sleep: async (ms) => void (t += ms), now: () => t, maxWaitMs: 9, pollMs: 3 });
    expect(out.status).toBe('timeout');
    expect((await finalizeWhenDue(client, null, d, 3n, 10n)).status).toBe('no-wallet');
  });
});
