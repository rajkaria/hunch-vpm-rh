'use client';

import { CHAIN_ID, claimCall, formatUsdg, withdrawRefundCall, type Deployment } from '@hunch-rh/client';
import { useState } from 'react';

import { buttonClass } from '@/components/ui/primitives';
import { accrualSeries, matchStateOf, type LiveMarket, type LivePosition } from '@/lib/market/model';
import { describeWalletError } from '@/lib/wallet/errors';
import type { WalletPort } from '@/lib/wallet/port';

function tx(explorer: string, hash: string): string {
  return `${explorer.replace(/\/$/, '')}/tx/${hash}`;
}

/** A tiny step line of what the position is paid if its side wins: it can only go up. */
export function AccruedLine({ points }: { points: bigint[] }) {
  if (points.length < 2) return null;
  const width = 120;
  const height = 28;
  const lo = points[0]!;
  const hi = points[points.length - 1]!;
  const span = hi - lo === 0n ? 1n : hi - lo;
  const x = (i: number): number => (i / (points.length - 1)) * (width - 2) + 1;
  const y = (v: bigint): number => height - 2 - Number(((v - lo) * 1000n) / span) / 1000 * (height - 4);
  let d = `M ${x(0).toFixed(1)} ${y(points[0]!).toFixed(1)}`;
  for (let i = 1; i < points.length; i += 1) d += ` L ${x(i).toFixed(1)} ${y(points[i - 1]!).toFixed(1)} L ${x(i).toFixed(1)} ${y(points[i]!).toFixed(1)}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-7 w-[120px]" role="img" aria-label="What this bet is paid if it wins, over time: it only goes up">
      <path d={d} fill="none" stroke="var(--color-lime)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

type Busy = { id: bigint; action: 'claim' | 'refund' } | null;

function PositionRow({
  market,
  position,
  deployment,
  wallet,
  onChanged,
}: {
  market: LiveMarket;
  position: LivePosition;
  deployment: Deployment;
  wallet: WalletPort;
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<string | null>(null);
  const json = market.json;
  const phase = json.market.phase;
  const settled = phase === 'resolved' || phase === 'void';
  const match = matchStateOf(market, position);
  const series = accrualSeries(market, position).map((point) => point.accrued);
  const firstAccrued = series[0] ?? position.accepted ?? position.offered;
  const sideClass = position.side === 'UP' ? 'text-lime' : 'text-coral';

  const act = async (action: 'claim' | 'refund'): Promise<void> => {
    setMessage(null);
    setBusy({ id: position.id, action });
    try {
      if (wallet.chainId !== CHAIN_ID) await wallet.switchToRobinhood();
      const hash = await wallet.write(action === 'claim' ? claimCall(deployment, position.id) : withdrawRefundCall(deployment, position.id));
      const status = await wallet.waitForReceipt(hash);
      setMessage(status === 'success' ? 'Sent to your wallet.' : 'The transaction failed on chain. Nothing moved; try again.');
      await onChanged();
    } catch (error) {
      setMessage(describeWalletError(error).message);
    } finally {
      setBusy(null);
    }
  };

  const refundOwed = !settled && position.finalized && !position.refunded && position.settlement.refund > 0n;

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-paper">
          <span className={`font-semibold ${sideClass}`}>{position.side}</span> · staked <span className="num">{formatUsdg(position.offered)}</span> USDG
        </p>
        {match.kind === 'matched' ? null : (
          <span className="text-[11px] text-faint">{match.kind === 'open' ? 'Being matched now' : 'Matched; written on chain with the next bet'}</span>
        )}
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="text-faint">Accepted</dt>
        <dd className="num text-right text-muted">{match.accepted === null ? 'matching' : formatUsdg(match.accepted)}</dd>
        <dt className="text-faint">Returned</dt>
        <dd className="num text-right text-muted">{match.refused === null ? 'matching' : formatUsdg(match.refused)}</dd>
      </dl>

      {settled ? (
        <div className="mt-2 text-sm">
          {position.claimed ? (
            <p className="text-muted">
              Paid <span className="num text-paper">{formatUsdg(position.payout ?? 0n)}</span> USDG
              {position.payoutTx !== null ? (
                <>
                  {' '}
                  ·{' '}
                  <a href={tx(deployment.explorer, position.payoutTx)} target="_blank" rel="noreferrer noopener" className="underline decoration-edge-strong underline-offset-2 hover:text-paper">
                    payout transaction
                  </a>
                </>
              ) : null}
            </p>
          ) : position.settlement.deliverable ? (
            <>
              <p className="text-muted">
                <span className="num text-paper">{formatUsdg(position.settlement.total)}</span> USDG is yours. Hunch sends it to your wallet within about 10 minutes; you can also claim it now (needs a little ETH for gas).
              </p>
              <button type="button" onClick={() => void act('claim')} disabled={busy !== null} className={buttonClass('secondary', 'sm', 'mt-2 disabled:opacity-60')}>
                {busy?.action === 'claim' ? 'Check your wallet' : `Claim ${formatUsdg(position.settlement.total)} USDG now`}
              </button>
            </>
          ) : (
            <p className="text-muted">This bet lost. Nothing is owed.</p>
          )}
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <p className="text-sm text-muted">
            If <span className={`font-semibold ${sideClass}`}>{position.side}</span> wins now:{' '}
            <span className="num text-paper">{formatUsdg(position.finalized ? position.accrued : (match.accepted ?? position.offered))}</span> USDG
            {position.finalized ? (
              <>
                {' '}
                · was <span className="num">{formatUsdg(firstAccrued)}</span> when you bet
              </>
            ) : null}
          </p>
          <AccruedLine points={series} />
        </div>
      )}

      {refundOwed ? (
        <div className="mt-2">
          <p className="text-xs text-muted">
            <span className="num text-paper">{formatUsdg(position.settlement.refund)}</span> USDG did not fit and comes back to you; Hunch returns it within a few minutes.
          </p>
          <button type="button" onClick={() => void act('refund')} disabled={busy !== null} className={buttonClass('ghost', 'sm', 'mt-1 px-0 disabled:opacity-60')}>
            {busy?.action === 'refund' ? 'Check your wallet' : 'Take it back now'}
          </button>
        </div>
      ) : null}
      {message === null ? null : (
        <p className="mt-1 text-xs text-muted" role="status">
          {message}
        </p>
      )}
    </li>
  );
}

/** The connected wallet's positions in this market. */
export function PositionsPanel({
  market,
  deployment,
  wallet,
  onChanged,
}: {
  market: LiveMarket;
  deployment: Deployment;
  wallet: WalletPort;
  onChanged: () => Promise<void> | void;
}) {
  if (wallet.status !== 'connected' || wallet.address === null) return null;
  const owner = wallet.address.toLowerCase();
  const mine = market.positions.filter((p) => p.owner.toLowerCase() === owner).sort((a, b) => (a.id < b.id ? -1 : 1));
  return (
    <section aria-labelledby="your-positions" className="rounded-card border border-edge bg-raised p-4 sm:p-5" data-testid="your-positions">
      <h2 id="your-positions" className="font-body text-[15px] font-semibold tracking-normal text-paper">
        Your positions
      </h2>
      {mine.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No bets from this wallet in this market yet.</p>
      ) : (
        <ul className="mt-1 divide-y divide-edge-soft">
          {mine.map((position) => (
            <PositionRow key={position.id.toString()} market={market} position={position} deployment={deployment} wallet={wallet} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}
