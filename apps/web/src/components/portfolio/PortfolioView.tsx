'use client';

import { CHAIN_ID, claimCall, formatUsdg, withdrawRefundCall, type Deployment } from '@hunch-rh/client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { refreshPortfolio } from '@/app/actions';
import { StatusBadge } from '@/components/market/StatusBadge';
import { EmptyState, SideWord, buttonClass } from '@/components/ui/primitives';
import type { PortfolioJson, PortfolioPositionJson } from '@/lib/api/shapes';
import { publicDeployment } from '@/lib/deployment';
import { describeWalletError } from '@/lib/wallet/errors';
import { useWalletPort, type WalletPort } from '@/lib/wallet/port';

const POLL_MS = 30_000;

function tx(explorer: string, hash: string): string {
  return `${explorer.replace(/\/$/, '')}/tx/${hash}`;
}

function Row({ p, deployment, wallet, onChanged }: { p: PortfolioPositionJson; deployment: Deployment; wallet: WalletPort; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const deliverable = !p.open && p.settlement.deliverable;
  const refund = p.open && p.finalized && !p.refunded && BigInt(p.settlement.refund) > 0n;

  const act = async (kind: 'claim' | 'refund'): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      if (wallet.chainId !== CHAIN_ID) await wallet.switchToRobinhood();
      const hash = await wallet.write(kind === 'claim' ? claimCall(deployment, BigInt(p.id)) : withdrawRefundCall(deployment, BigInt(p.id)));
      const status = await wallet.waitForReceipt(hash);
      setMessage(status === 'success' ? 'Sent to your wallet.' : 'The transaction failed on chain. Nothing moved; try again.');
      await onChanged();
    } catch (error) {
      setMessage(describeWalletError(error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="grid gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-6">
      <div className="min-w-0">
        <Link href={p.href} className="text-[15px] font-semibold text-paper hover:underline">
          {p.question}
        </Link>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <StatusBadge phase={p.phase} winner={p.winner ?? undefined} />
          <span>
            <SideWord side={p.side} /> · staked <span className="num">{formatUsdg(BigInt(p.offered))}</span> USDG
            {p.accepted !== null && p.accepted !== p.offered ? (
              <>
                {' '}
                · accepted <span className="num">{formatUsdg(BigInt(p.accepted))}</span>
              </>
            ) : null}
          </span>
        </p>
      </div>
      <div className="text-sm sm:text-right">
        {p.open ? (
          <p className="text-muted">
            If <SideWord side={p.side} /> wins now: <span className="num text-paper">{formatUsdg(BigInt(p.accrued))}</span> USDG
          </p>
        ) : p.claimed ? (
          <p className="text-muted">
            Paid <span className="num text-paper">{formatUsdg(BigInt(p.payout ?? '0'))}</span> USDG
            {p.payoutTx !== null ? (
              <>
                {' '}
                ·{' '}
                <a href={tx(deployment.explorer, p.payoutTx)} target="_blank" rel="noreferrer noopener" className="underline decoration-edge-strong underline-offset-2 hover:text-paper">
                  transaction
                </a>
              </>
            ) : null}
          </p>
        ) : deliverable ? (
          <p className="text-muted">
            <span className="num text-paper">{formatUsdg(BigInt(p.settlement.total))}</span> USDG on its way
          </p>
        ) : (
          <p className="text-muted">Lost · nothing owed</p>
        )}
        {deliverable ? (
          <button type="button" onClick={() => void act('claim')} disabled={busy} className={buttonClass('secondary', 'sm', 'mt-2 disabled:opacity-60')}>
            {busy ? 'Check your wallet' : 'Claim it now'}
          </button>
        ) : null}
        {refund ? (
          <button type="button" onClick={() => void act('refund')} disabled={busy} className={buttonClass('ghost', 'sm', 'mt-1 disabled:opacity-60')}>
            {busy ? 'Check your wallet' : `Take back ${formatUsdg(BigInt(p.settlement.refund))} USDG that did not fit`}
          </button>
        ) : null}
        {message === null ? null : (
          <p className="mt-1 text-xs text-muted" role="status">
            {message}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * The connected wallet's positions across every market, read from `/api/positions?owner=`:
 * totals, then each position with its status and what it is worth or was paid. Hunch delivers
 * payouts automatically; the claim buttons are for anyone who would rather not wait.
 */
export function PortfolioView({ deploymentOverride }: { deploymentOverride?: Deployment }) {
  const wallet = useWalletPort({ autoload: true });
  const deployment = useMemo(() => deploymentOverride ?? publicDeployment(), [deploymentOverride]);
  const [data, setData] = useState<PortfolioJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const address = wallet.status === 'connected' ? wallet.address : null;

  const load = useCallback(async (): Promise<void> => {
    if (address === null) return;
    try {
      const response = await fetch(`/api/positions?owner=${address}`, { cache: 'no-store' });
      const body = (await response.json()) as PortfolioJson | { message?: string };
      if (!response.ok || !('positions' in body)) {
        setError('message' in body && typeof body.message === 'string' ? body.message : 'Your positions could not be read. Retrying.');
        return;
      }
      setError(null);
      setData(body);
    } catch {
      setError('Your positions could not be read. Retrying.');
    }
  }, [address]);

  useEffect(() => {
    setData(null);
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const onChanged = useCallback(async (): Promise<void> => {
    if (address !== null) await refreshPortfolio(address).catch(() => undefined);
    await load();
  }, [address, load]);

  if (address === null) {
    return (
      <EmptyState
        title="Connect a wallet to see your positions"
        action={
          <button type="button" onClick={() => wallet.openConnect()} className={buttonClass('primary', 'md')}>
            {wallet.status === 'connecting' || wallet.status === 'reconnecting' ? 'Connecting' : 'Connect'}
          </button>
        }
      >
        Every bet this wallet has placed, in every market, with what it is worth now or what it was paid.
      </EmptyState>
    );
  }

  if (data === null) {
    return <p className="rounded-card border border-edge p-5 text-sm text-muted">{error ?? 'Reading your positions from Robinhood Chain…'}</p>;
  }

  if (!data.deployed) {
    return (
      <EmptyState title="Nothing here yet" action={<Link href="/start" className={buttonClass('secondary', 'md')}>Get set up before it opens</Link>}>
        Hunch is not deployed on Robinhood Chain yet, so no wallet holds a position. Markets open at the next opening bell once the venue is live.
      </EmptyState>
    );
  }

  if (data.positions.length === 0) {
    return (
      <EmptyState title="No positions yet" action={<Link href="/#markets" className={buttonClass('primary', 'md')}>See the live markets</Link>}>
        This wallet has not bet on Hunch yet. Pick a market, choose UP or DOWN, and your position shows here.
      </EmptyState>
    );
  }

  const open = data.positions.filter((p) => p.open);
  const settled = data.positions.filter((p) => !p.open);
  const totals = data.totals;

  return (
    <div className="grid gap-8">
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-edge bg-edge lg:grid-cols-4">
        {[
          { label: 'Staked', value: totals.staked },
          { label: 'If each open bet wins now', value: totals.accrued },
          { label: 'Paid to you', value: totals.paid },
          { label: 'On its way to you', value: totals.deliverable },
        ].map((item) => (
          <div key={item.label} className="bg-ink p-4 sm:p-5">
            <dt className="eyebrow">{item.label}</dt>
            <dd className="num mt-3 text-xl text-paper">
              {formatUsdg(BigInt(item.value))} <span className="text-sm text-faint">USDG</span>
            </dd>
          </div>
        ))}
      </dl>
      {error === null ? null : <p className="text-sm text-coral">{error}</p>}
      {open.length > 0 ? (
        <section aria-labelledby="open-positions">
          <h2 id="open-positions" className="text-[22px] leading-tight">
            Open
          </h2>
          <ul className="mt-2 divide-y divide-edge-soft border-y border-edge">
            {open.map((p) => (
              <Row key={p.id} p={p} deployment={deployment} wallet={wallet} onChanged={onChanged} />
            ))}
          </ul>
        </section>
      ) : null}
      {settled.length > 0 ? (
        <section aria-labelledby="settled-positions">
          <h2 id="settled-positions" className="text-[22px] leading-tight">
            Settled
          </h2>
          <ul className="mt-2 divide-y divide-edge-soft border-y border-edge">
            {settled.map((p) => (
              <Row key={p.id} p={p} deployment={deployment} wallet={wallet} onChanged={onChanged} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
