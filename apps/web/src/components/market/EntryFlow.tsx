'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { decodeEventLog } from 'viem';
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';

import { CloseVintageButton, useCloseVintage } from '@/components/market/CloseVintage';
import { Amount, Badge, Button } from '@/components/ui/primitives';
import { isDeployed, txExplorerUrl } from '@/lib/chain';
import type { MarketDetail } from '@/lib/data/types';
import { erc20Abi, settlerAbi } from '@/lib/wallet/abi';
import { FAUCET_URL } from '@/lib/wallet/chains';
import { friendlyError } from '@/lib/wallet/errors';
import { useNetwork } from '@/lib/wallet/network';
import { expectPosition } from '@/lib/wallet/positions';
import { useWallet } from '@/lib/wallet/useWallet';
import type { Acceptance } from '@/lib/vpm';

/**
 * The signing half of an entry.
 *
 * Three contract states, not two, and the difference is the whole reason this
 * component is shaped the way it is — see `.ocean/DECISIONS.md` D7:
 *
 *   1. **Nothing sent.** Maybe an allowance is needed first.
 *   2. **Entered, and buffered.** `enter` pushes the position with
 *      `accepted: 0` and pulls the full amount. It emits `Entered` carrying
 *      `offered` — there is no accepted figure anywhere in that receipt.
 *   3. **Finalized.** `_finalizeVintage` runs on the first call to touch this
 *      market in a LATER block — the next entry, or anyone poking
 *      `finalizeVintage`. Only then is the stake rationed and the remainder
 *      made withdrawable.
 *
 * So this never claims an acceptance it cannot know. Between 2 and 3 it says
 * what is actually true: the stake is in, the books have not ruled on it yet,
 * and here is the button that makes them.
 */
export function EntryFlow({
  market,
  outcome,
  offered,
  acceptance,
}: {
  market: MarketDetail;
  outcome: number;
  offered: bigint;
  acceptance: Acceptance;
}) {
  const wallet = useWallet();
  const { address } = useAccount();

  // Addresses follow the network the viewer selected, not a build-time constant.
  // On Arc that matters less for USDC — it is the native gas token at the same
  // predeploy address on both chains — but reading it from the selection keeps
  // one source of truth and makes a future divergence a config change.
  const { addresses, facts, network } = useNetwork();
  const queryClient = useQueryClient();

  const settler = market.settler as `0x${string}`;
  const usdc = addresses.usdc as `0x${string}`;
  const live = isDeployed(market.settler);

  const allowance = useReadContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address === undefined ? undefined : [address, settler],
    query: { enabled: live && address !== undefined },
  });

  const balance = useReadContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address === undefined ? undefined : [address],
    query: { enabled: live && address !== undefined },
  });

  const approve = useWriteContract();
  const enter = useWriteContract();

  const approveReceipt = useWaitForTransactionReceipt({ hash: approve.data });
  const enterReceipt = useWaitForTransactionReceipt({ hash: enter.data });

  // The allowance read is refetched after an approval confirms, so `needsApproval`
  // flips on its own rather than needing the component to track a fourth state.
  const current = allowance.data ?? 0n;
  const needsApproval = current < offered;
  const short = balance.data !== undefined && balance.data < offered;

  const entered = useMemo(() => {
    if (enterReceipt.data === undefined) return null;
    for (const log of enterReceipt.data.logs) {
      try {
        const decoded = decodeEventLog({ abi: settlerAbi, data: log.data, topics: log.topics });
        if (decoded.eventName === 'Entered') {
          const args = decoded.args as unknown as { positionId: bigint; offered: bigint; vintage: bigint };
          return { positionId: args.positionId, offered: args.offered, vintage: args.vintage };
        }
      } catch {
        // Not one of ours. Receipts carry every log in the transaction.
      }
    }
    return null;
  }, [enterReceipt.data]);

  // This receipt lives in component state and is gone on reload; the index is
  // not. Point the positions read at the entry so "Your position" holds it as
  // soon as the index does, and keeps holding it after a refresh.
  const walletAddress = wallet.address;
  useEffect(() => {
    if (entered === null || walletAddress === null) return;
    expectPosition(queryClient, network, walletAddress, market.id, entered.positionId);
  }, [entered, walletAddress, network, market.id, queryClient]);

  if (!live) {
    return (
      <Note>
        The settler for this market is not deployed yet, so there is no transaction to send. The
        estimate above is the rule applied to the replayed book.
      </Note>
    );
  }

  if (wallet.address === null) {
    return <Note>Connect a wallet to take this side.</Note>;
  }

  if (wallet.wrongChain) {
    return (
      <div className="space-y-3">
        <Note tone="warn">
          Your wallet is on another network. Entries settle on {wallet.chainName}.
        </Note>
        <Button onClick={wallet.switchToActive} size="sm" className="w-full">
          {wallet.switching ? 'Check your wallet…' : `Switch to ${wallet.chainName}`}
        </Button>
      </div>
    );
  }

  // Entered and confirmed: say what is true, which is that nothing is decided yet.
  if (entered !== null) {
    return (
      <BufferedResult
        market={market}
        entered={entered}
        acceptance={acceptance}
        explorer={enter.data === undefined ? null : txExplorerUrl(enter.data, facts)}
      />
    );
  }

  const sending = approve.isPending || enter.isPending;
  const waiting = approveReceipt.isLoading || enterReceipt.isLoading;
  const problem = approve.error ?? enter.error;

  return (
    <div className="space-y-3">
      {short ? <ShortBalance balance={balance.data ?? 0n} /> : null}

      {needsApproval ? (
        <Button
          size="sm"
          className="w-full"
          disabled={sending || waiting}
          onClick={async () => {
            // Switch first, then send — and pin the chain on the write itself so
            // wagmi refuses outright if the wallet moved in between. An approval
            // to 0x3600…0000 on any other chain is the failure this prevents.
            if (!(await wallet.ensureActiveChain())) return;
            approve.writeContract({
              address: usdc,
              abi: erc20Abi,
              functionName: 'approve',
              args: [settler, offered],
              chainId: wallet.chainId,
            });
          }}
        >
          {approve.isPending
            ? 'Check your wallet…'
            : approveReceipt.isLoading
              ? 'Approving…'
              : 'Approve USDC'}
        </Button>
      ) : (
        <Button
          size="sm"
          className="w-full"
          disabled={sending || waiting || short || offered <= 0n}
          onClick={async () => {
            if (!(await wallet.ensureActiveChain())) return;
            enter.writeContract({
              address: settler,
              abi: settlerAbi,
              functionName: 'enter',
              args: [market.onChainMarketId, outcome, offered],
              chainId: wallet.chainId,
            });
          }}
        >
          {enter.isPending
            ? 'Check your wallet…'
            : enterReceipt.isLoading
              ? 'Entering…'
              : 'Offer stake'}
        </Button>
      )}

      <p className="text-xs leading-snug text-faint">
        {needsApproval
          ? 'Two transactions: one to let the settler move your USDC, one to enter. The settler can only ever move what you approve.'
          : 'The full amount is pulled when you enter. Whatever the books refuse becomes withdrawable once the vintage closes.'}
      </p>

      {problem === null || problem === undefined ? null : (
        <Note tone="warn">{friendlyError(problem)}</Note>
      )}
    </div>
  );
}

/**
 * What the user sees between entering and the vintage closing.
 *
 * The estimate is repeated here as an estimate, explicitly labelled, because it
 * is still the best available answer — but it is conditional on nobody else
 * having entered in the same block, and that caveat is stated rather than
 * buried.
 */
function BufferedResult({
  market,
  entered,
  acceptance,
  explorer,
}: {
  market: MarketDetail;
  entered: { positionId: bigint; offered: bigint; vintage: bigint };
  acceptance: Acceptance;
  explorer: string | null;
}) {
  const closer = useCloseVintage(market);
  const done = closer.done;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs tracking-[0.12em] text-faint uppercase">Your entry</span>
        <Badge tone={done ? 'up' : 'note'}>{done ? 'Vintage closed' : 'In this block’s vintage'}</Badge>
      </div>

      <p className="text-sm leading-relaxed text-muted">
        <Amount value={entered.offered} className="text-paper" /> USDC is in, as position{' '}
        <span className="num text-paper">#{entered.positionId.toString()}</span>. The books have not
        ruled on it yet — stake entering in the same block is rationed together when that block’s
        vintage closes, so the split below is still an estimate until it does. It stays listed
        under Your position, reload or not.
      </p>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-control border border-edge bg-raised-2 px-4 py-3.5">
        <div>
          <dt className="text-xs tracking-[0.12em] text-faint uppercase">Est. accepted</dt>
          <dd className="mt-1 text-base leading-none">
            <Amount value={acceptance.accepted} />
          </dd>
        </div>
        <div>
          <dt className="text-xs tracking-[0.12em] text-faint uppercase">Est. refused</dt>
          <dd className="mt-1 text-base leading-none">
            <Amount value={acceptance.refused} />
          </dd>
        </div>
      </dl>

      {done ? (
        <Note>
          The vintage is closed and your position is final. Anything the books refused is
          withdrawable from <a className="text-lime hover:underline" href="/claim">Claim</a>.
        </Note>
      ) : (
        <CloseVintageButton state={closer} />
      )}

      {explorer === null ? null : (
        <a
          href={explorer}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-block text-xs text-muted hover:text-paper hover:underline"
        >
          View the entry transaction →
        </a>
      )}
    </div>
  );
}

/**
 * The empty-wallet state.
 *
 * On Arc this is a hard stop, not an inconvenience: USDC is the gas token, so a
 * wallet with none cannot send any transaction at all — including one that
 * would fund it. Saying "insufficient balance" and stopping there leaves
 * somebody with nowhere to go, so this points at a faucet when the deployment
 * has been told about one, and says plainly that it has not when it hasn't.
 */
function ShortBalance({ balance }: { balance: bigint }) {
  return (
    <div className="rounded-control border border-coral/35 bg-coral/10 px-3 py-2.5">
      <p className="text-sm leading-snug text-paper">
        {balance === 0n ? (
          <>This wallet holds no USDC.</>
        ) : (
          <>
            This wallet holds <Amount value={balance} className="text-paper" /> USDC, less than you
            are offering.
          </>
        )}{' '}
        <span className="text-muted">
          USDC is also the gas token on Arc, so you need some before anything can be sent.
        </span>
      </p>
      {FAUCET_URL === '' ? (
        <p className="mt-2 text-xs leading-snug text-muted">
          This deployment has no faucet link configured — ask whoever runs it where testnet USDC
          comes from.
        </p>
      ) : (
        <a
          href={FAUCET_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-2 inline-block text-xs font-semibold text-lime hover:underline"
        >
          Get testnet USDC →
        </a>
      )}
    </div>
  );
}

function Note({ children, tone = 'quiet' }: { children: React.ReactNode; tone?: 'quiet' | 'warn' }) {
  return (
    <p
      className={`rounded-control border px-3 py-2.5 text-sm leading-snug ${
        tone === 'warn' ? 'border-coral/35 bg-coral/10 text-paper' : 'border-edge bg-ghost text-muted'
      }`}
    >
      {children}
    </p>
  );
}

// Shared with the close-vintage and claim flows; re-exported where it was first defined.
export { friendlyError } from '@/lib/wallet/errors';
