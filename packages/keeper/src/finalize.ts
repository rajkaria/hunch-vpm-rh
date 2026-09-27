import { finalizeVintageCall, hunchVpmAbi, readChainHead, type Deployment } from '@hunch-rh/client';
import type { PublicClient, WalletClient } from 'viem';

/**
 * Write a market's open batch (vintage) on chain as soon as its Ethereum block has passed.
 *
 * On Robinhood Chain `block.number` is the Ethereum block estimate (~12 s), so a bet placed now
 * is matched with everything else in the same Ethereum block. The match is final the moment that
 * block passes, but it is only written on chain by the next transaction touching the market.
 * The relay route calls this after a relayed bet so the book, refunds and "if it wins now" show
 * the match within about one Ethereum block instead of waiting for the next bet or the deliver
 * cron. Anyone may call `finalizeVintage`; it changes no outcome, only when the numbers appear.
 */

export type FinalizeOutcome =
  | { status: 'finalized'; txHash: `0x${string}` }
  | { status: 'nothing-pending' }
  | { status: 'no-wallet' }
  | { status: 'timeout' }
  | { status: 'failed'; reason: string };

export interface FinalizeOptions {
  /** Give up after this long (the route's function budget bounds it too). */
  maxWaitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Pure: may the open batch be written now? */
export function finalizeDue(input: { pendingCount: bigint; l1BlockAtEntry: bigint; l1BlockNow: bigint }): 'due' | 'wait' | 'nothing-pending' {
  if (input.pendingCount === 0n) return 'nothing-pending';
  return input.l1BlockNow > input.l1BlockAtEntry ? 'due' : 'wait';
}

export async function finalizeWhenDue(
  publicClient: PublicClient,
  walletClient: WalletClient | null,
  deployment: Deployment,
  marketId: bigint,
  l1BlockAtEntry: bigint,
  options: FinalizeOptions = {},
): Promise<FinalizeOutcome> {
  if (walletClient === null || walletClient.account === undefined) return { status: 'no-wallet' };
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.maxWaitMs ?? 45_000);
  const pollMs = options.pollMs ?? 3_000;
  const vpm = deployment.contracts.HunchVPM.address;

  for (;;) {
    let decision: ReturnType<typeof finalizeDue>;
    try {
      const [pendingCount, head] = await Promise.all([
        publicClient.readContract({ address: vpm, abi: hunchVpmAbi, functionName: 'pendingCount', args: [marketId] }) as Promise<bigint>,
        readChainHead(publicClient),
      ]);
      decision = finalizeDue({ pendingCount, l1BlockAtEntry, l1BlockNow: head.l1BlockNumber });
    } catch (error) {
      return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
    if (decision === 'nothing-pending') return { status: 'nothing-pending' };
    if (decision === 'due') break;
    if (now() + pollMs > deadline) return { status: 'timeout' };
    await sleep(pollMs);
  }

  try {
    const call = finalizeVintageCall(deployment, marketId);
    const { request } = await publicClient.simulateContract({ ...call, account: walletClient.account });
    const txHash = await walletClient.writeContract(request);
    return { status: 'finalized', txHash };
  } catch (error) {
    // Someone else (the next bet, the deliver job) may have written it first: harmless.
    return { status: 'failed', reason: error instanceof Error ? error.message.split('\n')[0]! : String(error) };
  }
}
