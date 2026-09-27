'use client';

import { useMemo } from 'react';

import { RuleComparator, type WireBook, type WirePosition } from '@/components/market/RuleComparator';
import { dataSourceKinds } from '@/lib/data/kind';
import { awaitingVintage } from '@/lib/data/position-wire';
import { useNetwork } from '@/lib/wallet/network';
import { useMarketPositions } from '@/lib/wallet/positions';

/**
 * The comparator, fed the viewer's own positions.
 *
 * On fixtures the server already rendered the sample wallet's positions and
 * those are passed through. On a live network the server renders for nobody, so
 * the connected wallet's positions come from the index read the position panel
 * uses. A buffered entry is left out: its accepted figure is a placeholder zero
 * until the vintage closes, and comparing two payout rules on it would compare
 * nothing.
 */
export function MarketRuleComparator({
  marketId,
  books,
  positions,
  settlerKind,
  frozen,
}: {
  marketId: string;
  books: WireBook[];
  positions: WirePosition[];
  settlerKind: 'vested' | 'classic';
  frozen: boolean;
}) {
  const { network } = useNetwork();
  const live = dataSourceKinds[network] === 'live';
  const read = useMarketPositions(marketId, { enabled: live });

  const mine = useMemo<WirePosition[]>(
    () =>
      live
        ? read.positions.filter((position) => !awaitingVintage(position)).map((position) => ({
            positionId: position.positionId.toString(),
            outcome: position.outcome,
            offered: position.offered.toString(),
            accepted: position.accepted.toString(),
            refused: position.refused.toString(),
            entryAcc: position.entryAcc.toString(),
          }))
        : positions,
    [live, read.positions, positions],
  );

  return (
    <RuleComparator
      // Remount once positions arrive, so it opens on "Your position" the way it
      // does when the server rendered them.
      key={mine.length > 0 ? 'held' : 'none'}
      books={books}
      positions={mine}
      settlerKind={settlerKind}
      frozen={frozen}
    />
  );
}
