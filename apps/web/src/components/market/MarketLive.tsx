'use client';

import type { Deployment } from '@hunch-rh/client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { refreshMarket } from '@/app/actions';
import type { MarketDetailJson } from '@/lib/api/shapes';
import { publicDeployment } from '@/lib/deployment';
import { useNow } from '@/lib/hooks/useNow';
import { reviveMarket } from '@/lib/market/model';
import { useWalletPort } from '@/lib/wallet/port';

import { BookTable } from './BookTable';
import { PositionsPanel } from './PositionsPanel';
import { PricePanel } from './PricePanel';
import { ResolutionPanel } from './ResolutionPanel';
import { StakePanel } from './StakePanel';

const POLL_MS = 15_000;

/**
 * The market page's live part. It starts from the server's read (so the first paint is complete
 * and correct), polls `/api/markets/[id]` every 15 s while the tab is visible, and after a
 * confirmed bet, claim or settlement expires the server's cache and reads again, so the numbers
 * here and on a hard refresh agree.
 *
 * Layout, in the spec's order on a phone (rules, prices, bet, your positions, every bet,
 * settlement); on a wide screen the bet panel and your positions sit in a column on the right.
 */
export function MarketLive({
  initial,
  rules,
  region,
  serverNow,
  deploymentOverride,
}: {
  initial: MarketDetailJson;
  rules: ReactNode;
  region: 'restricted' | 'open';
  serverNow: number;
  /** The deployment the server read the market with, so the island and the server always agree. */
  deploymentOverride?: Deployment;
}) {
  const [detail, setDetail] = useState(initial);
  const market = useMemo(() => reviveMarket(detail), [detail]);
  const nowSec = useNow(serverNow);
  const wallet = useWalletPort({ autoload: true });
  const deployment = useMemo(() => deploymentOverride ?? publicDeployment(), [deploymentOverride]);
  const id = detail.market.id;
  const inflight = useRef(false);

  const load = useCallback(
    async (fresh: boolean): Promise<void> => {
      if (inflight.current && !fresh) return;
      inflight.current = true;
      try {
        const response = await fetch(`/api/markets/${id}${fresh ? `?fresh=${Date.now()}` : ''}`, { cache: 'no-store' });
        if (!response.ok) return;
        const next = (await response.json()) as MarketDetailJson;
        if (next.market?.id === id) setDetail(next);
      } catch {
        // Keep what is on screen; the next poll tries again.
      } finally {
        inflight.current = false;
      }
    },
    [id],
  );

  const refresh = useCallback(async (): Promise<void> => {
    try {
      await refreshMarket(id, wallet.address);
    } catch {
      // The cache expires on its own within seconds.
    }
    await load(true);
    // A bet's batch is written on chain with the next bet or the keeper's pass: read again shortly.
    window.setTimeout(() => void load(true), 16_000);
  }, [id, wallet.address, load]);

  useEffect(() => {
    const settled = detail.market.phase === 'resolved' || detail.market.phase === 'void';
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(false);
    }, settled ? POLL_MS * 4 : POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, detail.market.phase]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-6">
      <div className="min-w-0 lg:col-start-1">{rules}</div>
      <div className="min-w-0 lg:col-start-1">
        <PricePanel market={detail.market} explorer={deployment.explorer} nowSec={nowSec} serverNow={serverNow} stale={detail.stale} readAt={detail.readAt} />
      </div>
      <div className="grid min-w-0 gap-4 lg:sticky lg:top-20 lg:col-start-2 lg:row-span-4 lg:row-start-1">
        <StakePanel market={market} deployment={deployment} region={region} nowSec={nowSec} onConfirmed={refresh} />
        <PositionsPanel market={market} deployment={deployment} wallet={wallet} onChanged={refresh} />
      </div>
      <div className="min-w-0 lg:col-start-1">
        <BookTable market={market} explorer={deployment.explorer} viewer={wallet.address} />
      </div>
      <div className="min-w-0 lg:col-start-1">
        <ResolutionPanel detail={detail} deployment={deployment} wallet={wallet} nowSec={nowSec} onSettled={refresh} />
      </div>
    </div>
  );
}
