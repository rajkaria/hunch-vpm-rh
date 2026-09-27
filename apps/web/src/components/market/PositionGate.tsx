'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { CloseVintageButton, useCloseVintage } from '@/components/market/CloseVintage';
import { PositionPanel } from '@/components/market/PositionPanel';
import { EmptyState } from '@/components/ui/primitives';
import { dataSourceKinds } from '@/lib/data/kind';
import { awaitingVintage } from '@/lib/data/position-wire';
import type { MarketDetail } from '@/lib/data/types';
import { useNetwork } from '@/lib/wallet/network';
import { useMarketPositions } from '@/lib/wallet/positions';
import { truncateAddress, useWallet } from '@/lib/wallet/useWallet';

/**
 * Who "your position" belongs to.
 *
 * `MarketDetail.positions` is filled server-side for whatever address the data
 * source is reading for. On fixtures that is a sample wallet, which means the
 * panel underneath was showing a stranger's position to every visitor and
 * calling it theirs. That is the one thing a position panel must never do, so
 * this gate stands in front of it.
 *
 * With a wallet connected and the surface on fixtures, the positions shown are
 * still the sample wallet's, and it says so rather than implying they are the
 * visitor's. On a live network the server renders for nobody in particular, so
 * the connected wallet's positions are read here, in the browser, from the
 * index — which is what keeps a stake on screen across a reload.
 */
export function PositionGate({ market }: { market: MarketDetail }) {
  const wallet = useWallet();
  const { network } = useNetwork();

  if (wallet.address === null) {
    return (
      <EmptyState title="Connect a wallet to see your position.">
        Positions belong to an address: the settler pays whoever owns the position, so there is
        nothing to show here until this page knows who you are.
      </EmptyState>
    );
  }

  if (dataSourceKinds[network] === 'fixture') {
    return (
      <div>
        <p className="border-b border-edge px-4 py-3 text-xs leading-snug text-faint sm:px-5">
          Connected as <span className="num text-muted">{truncateAddress(wallet.address)}</span>.
          The position below belongs to the sample wallet, not to you — this network&rsquo;s index
          is not connected, so there is nothing on-chain to read for your address here.
        </p>
        <PositionPanel market={market} />
      </div>
    );
  }

  return <LivePosition market={market} />;
}

function LivePosition({ market }: { market: MarketDetail }) {
  const router = useRouter();
  const { query, positions } = useMarketPositions(market.id);
  const closer = useCloseVintage(market);
  const pending = positions.filter(awaitingVintage).length;

  // The capacity bars and the book table were rendered on the server before the
  // books ruled on a buffered entry. When one is ruled on, re-render them once.
  const previous = useRef(pending);
  useEffect(() => {
    if (pending < previous.current) router.refresh();
    previous.current = pending;
  }, [pending, router]);

  if (query.isPending) {
    return <p className="px-4 py-6 text-sm leading-relaxed text-muted sm:px-5">Reading your position from the index…</p>;
  }

  if (query.isError) {
    return (
      <EmptyState title="Your position could not be read.">
        Nothing has happened to it — it is on chain either way. The index did not answer this
        time; the portfolio page reads the same thing.
      </EmptyState>
    );
  }

  return (
    <div>
      <PositionPanel market={{ ...market, positions }} />
      {pending === 0 || closer.done ? null : (
        <div className="space-y-3 border-t border-edge px-4 py-5 sm:px-5">
          <CloseVintageButton state={closer} />
        </div>
      )}
    </div>
  );
}
