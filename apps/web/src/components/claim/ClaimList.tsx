'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect } from 'react';
import { useWaitForTransactionReceipt, useWriteContract } from 'wagmi';

import { AddressLink } from '@/components/market/AddressLink';
import { friendlyError } from '@/components/market/EntryFlow';
import { Amount, Badge, Button, EmptyState, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { NETWORKS, isDeployed } from '@/lib/chain';
import type { ClaimReason, ClaimableItem, ClaimableView } from '@/lib/data/types';
import { settlerAbi } from '@/lib/wallet/abi';
import { useNetwork } from '@/lib/wallet/network';
import { truncateAddress, useWallet } from '@/lib/wallet/useWallet';

const REASONS: { key: ClaimReason; label: string; hint: string }[] = [
  {
    key: 'settlement',
    label: 'Settlement',
    hint: 'What the settler pays a winning position on a market that resolved your way, under that market’s own rule.',
  },
  {
    key: 'voidRefund',
    label: 'Void refund',
    hint: 'A market that ended without an answer refunds every position at its accepted principal.',
  },
  {
    key: 'refusedRemainder',
    label: 'Refused remainder',
    hint: 'Stake the opposing books had no room to cover. It was never at risk and it is yours to pull back.',
  },
  {
    key: 'residue',
    label: 'Residue',
    hint: 'The sub-unit remainder flooring leaves behind, sweepable by the owner named at the market’s creation.',
  },
];

/**
 * The claim page's body, for whichever address is connected.
 *
 * The lookup goes through `/api/claimable` rather than straight from the
 * browser: the live source reads The Graph, and a gateway URL carries its key
 * in the path. The address is the only thing the browser contributes.
 */
export function ClaimList() {
  const wallet = useWallet();
  const { network, hydrated } = useNetwork();

  const claims = useQuery({
    // Keyed by network: the same address holds different things on each Arc.
    queryKey: ['claimable', network, wallet.address],
    enabled: wallet.address !== null && hydrated,
    queryFn: async (): Promise<ClaimableView> => {
      const response = await fetch(`/api/claimable?network=${network}&address=${wallet.address ?? ''}`);
      if (!response.ok) throw new Error('The index could not be reached.');
      return decode(await response.json());
    },
  });

  if (wallet.address === null) {
    return (
      <EmptyState title="No wallet connected.">
        Claims are per position and per address: the settler pays the owner of the position, and
        nothing here can tell what you hold until it knows who you are.
      </EmptyState>
    );
  }

  if (claims.isPending) {
    return (
      <EmptyState title="Looking up what you are owed…">
        Reading positions for {truncateAddress(wallet.address)}.
      </EmptyState>
    );
  }

  if (claims.isError || claims.data === undefined) {
    return (
      <EmptyState title="The index could not be reached.">
        Nothing is wrong with your positions — this page could not read them. Reloading usually
        fixes it.
      </EmptyState>
    );
  }

  const view = claims.data;

  if (view.items.length === 0) {
    return (
      <EmptyState title="Nothing to pull.">
        {truncateAddress(wallet.address)} has no settled position, no refused remainder and no void
        refund waiting. Stake in an open market and anything the books refuse shows up here as soon
        as the vintage closes.
      </EmptyState>
    );
  }

  return (
    <>
      <Panel className="mb-6">
        <PanelHeader title="Ready to pull" hint="Split by why it is owed." />
        <dl className="grid grid-cols-2 gap-x-6 gap-y-6 px-4 py-5 sm:grid-cols-4 sm:px-5">
          {REASONS.map((reason) => (
            <Stat key={reason.key} label={reason.label} hint={reason.hint}>
              <Amount
                value={view.totals[reason.key]}
                className={view.totals[reason.key] > 0n ? '' : 'text-muted'}
              />
            </Stat>
          ))}
        </dl>
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-t border-edge px-4 py-4 sm:px-5">
          <span className="text-sm text-muted">Total</span>
          <span className="text-2xl leading-none">
            <Amount value={view.totals.total} />
            <span className="ml-2 text-sm text-muted">USDC</span>
          </span>
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          title="Transactions"
          hint="One row is one transaction. `claim` pays a settlement and any outstanding refused remainder together, so sending it twice reverts."
        />
        <ul className="divide-y divide-edge">
          {view.items.map((item) => (
            <ClaimRow key={item.id} item={item} onDone={() => void claims.refetch()} />
          ))}
        </ul>
      </Panel>

      {view.blockedResidue.length > 0 ? (
        <Panel className="mt-6">
          <PanelHeader
            title="Residue you own but cannot sweep yet"
            hint="The sum of the floors is not known until the last winner has claimed, so the gate is every winning position, not a timer."
          />
          <ul className="divide-y divide-edge">
            {view.blockedResidue.map((entry) => (
              <li
                key={entry.marketId}
                className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-4 sm:px-5"
              >
                <div className="min-w-0">
                  <Link href={`/m/${entry.marketId}`} className="text-sm hover:underline">
                    {entry.question}
                  </Link>
                  <p className="mt-1 text-xs text-muted">{entry.reason}</p>
                </div>
                <Amount value={entry.amount} fractionDigits={6} className="text-muted" />
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <p className="mt-6 text-xs text-faint">
        {view.index.source === 'fixture'
          ? 'Sample data. Amounts are computed from the same books the market pages show.'
          : `Indexed to block ${view.index.block.toString()}.`}
        {view.index.hasIndexingErrors
          ? ' The indexer reported errors, so this may be incomplete — check the market page before sending anything.'
          : ''}
      </p>
    </>
  );
}

function ClaimRow({ item, onDone }: { item: ClaimableItem; onDone: () => void }) {
  const wallet = useWallet();
  const { network } = useNetwork();
  const pull = useWriteContract();
  const receipt = useWaitForTransactionReceipt({
    hash: pull.data,
    query: { enabled: pull.data !== undefined },
  });

  const deployed = isDeployed(item.settler);
  const parts = REASONS.filter((reason) => item.breakdown[reason.key] > 0n);
  const done = receipt.data !== undefined;

  // Once the pull confirms, re-read: the row has been paid and should leave the
  // list on its own rather than sit there inviting a second transaction that
  // would revert.
  useEffect(() => {
    if (done) onDone();
    // `onDone` is a fresh closure each render; the confirmation is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  return (
    <li className="flex flex-wrap items-start justify-between gap-4 px-4 py-4 sm:px-5">
      <div className="min-w-0 flex-1">
        <Link href={`/m/${item.marketId}`} className="text-sm hover:underline">
          {item.question}
        </Link>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="num rounded-tag border border-edge px-1.5 py-0.5 text-[10px] tracking-[0.1em] uppercase">
            {item.call}({item.argument.toString()})
          </span>
          {parts.map((part) => (
            <span key={part.key}>
              {part.label} <Amount value={item.breakdown[part.key]} className="text-paper" />
            </span>
          ))}
          <AddressLink address={item.settler} className="text-xs" chain={NETWORKS[network].facts} />
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-2">
        <Amount value={item.amount} className="text-lg" />

        {done ? (
          <Badge tone="up">Pulled</Badge>
        ) : !deployed ? (
          <>
            <Button size="sm" variant="ghost" disabled aria-describedby={`undeployed-${item.id}`}>
              Pull
            </Button>
            <p
              id={`undeployed-${item.id}`}
              className="max-w-[13rem] text-right text-xs leading-snug text-muted"
            >
              The settler is not deployed yet, so there is no transaction to send.
            </p>
          </>
        ) : wallet.wrongChain ? (
          <Button size="sm" variant="ghost" onClick={wallet.switchToActive}>
            Switch network
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              disabled={pull.isPending || receipt.isLoading}
              onClick={async () => {
                if (!(await wallet.ensureActiveChain())) return;
                pull.writeContract({
                  address: item.settler as `0x${string}`,
                  abi: settlerAbi,
                  functionName: item.call,
                  args: [item.argument],
                  chainId: wallet.chainId,
                });
              }}
            >
              {pull.isPending ? 'Check your wallet…' : receipt.isLoading ? 'Pulling…' : 'Pull'}
            </Button>
            {pull.error === null ? null : (
              <p className="max-w-[15rem] text-right text-xs leading-snug text-coral">
                {friendlyError(pull.error)}
              </p>
            )}
          </>
        )}
      </div>
    </li>
  );
}

/** Decimal strings back to bigint. The route encodes them; nothing is rounded either way. */
function decode(raw: {
  wallet: string;
  totals: Record<string, string>;
  blockedResidue: { marketId: string; question: string; amount: string; reason: string }[];
  index: { block: string; hasIndexingErrors: boolean; source: 'fixture' | 'live' };
  items: (Omit<ClaimableItem, 'amount' | 'argument' | 'breakdown'> & {
    amount: string;
    argument: string;
    breakdown: Record<string, string>;
  })[];
}): ClaimableView {
  const money = (record: Record<string, string>) =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, BigInt(value)]));

  return {
    wallet: raw.wallet,
    totals: money(raw.totals) as ClaimableView['totals'],
    blockedResidue: raw.blockedResidue.map((entry) => ({ ...entry, amount: BigInt(entry.amount) })),
    index: { ...raw.index, block: BigInt(raw.index.block) },
    items: raw.items.map((item) => ({
      ...item,
      amount: BigInt(item.amount),
      argument: BigInt(item.argument),
      breakdown: money(item.breakdown) as ClaimableItem['breakdown'],
    })),
  };
}
