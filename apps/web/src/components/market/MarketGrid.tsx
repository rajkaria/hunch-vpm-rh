import { Countdown } from '@/components/market/Countdown';
import { TickerMark } from '@/components/market/TickerMark';
import { ButtonLink } from '@/components/ui/primitives';
import type { Deployment } from '@/lib/deployment';
import type { MarketCardData } from '@/lib/view/types';
import { formatDuration } from '@hunch-rh/client';

import { currentOrNextSession, formatEtDateTime, marketClock } from '@/lib/et';

import { MarketCard } from './MarketCard';

/**
 * Before any market exists: say so, say when the first ones can open, and show the two market
 * shapes as templates (dashed, no numbers) so nobody mistakes them for live markets.
 */
export function LaunchingState({ deployment, now }: { deployment: Deployment; now: number }) {
  const clock = marketClock(now);
  const next = clock.sessionOpen ? currentOrNextSession(clock.session.close + 60) : clock.session;
  const tickers = deployment.feeds.filter((feed) => feed.families.length > 0).map((feed) => feed.ticker);
  const deployed = deployment.status === 'deployed';

  return (
    <div className="rounded-card border border-dashed border-edge-strong p-5 sm:p-8">
      <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr] lg:items-center">
        <div>
          <p className="eyebrow">{deployed ? 'Between markets' : 'Launching'}</p>
          <h3 className="mt-3 text-2xl leading-tight sm:text-[28px]">
            {deployed ? 'New markets open before the next opening bell.' : 'Markets open at the next opening bell once the venue is live.'}
          </h3>
          <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-muted">
            {deployed
              ? 'No market is taking bets right now. New daily markets are listed before each opening bell.'
              : 'The contracts are not deployed yet, so there is nothing to bet on and nothing here pretends otherwise. Get set up now and you can place your first bet the morning it opens.'}
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
            <div>
              <p className="text-[11px] text-faint">Next opening bell</p>
              <p className="num mt-1 text-sm text-paper">{formatEtDateTime(next.open)}</p>
            </div>
            <div>
              <p className="text-[11px] text-faint">In</p>
              <p className="mt-1 text-sm text-paper">
                <Countdown deadline={next.open} now={now} label="until the next opening bell" endedText="ringing now" />
              </p>
            </div>
          </div>
          <div className="mt-6">
            <ButtonLink href="/start" variant="secondary">
              Get set up before it opens
            </ButtonLink>
          </div>
        </div>

        <div className="grid gap-3" aria-label="The two kinds of market">
          {[
            { family: 'Daily', question: `Will ${tickers[1] ?? 'TSLA'} close UP today?`, detail: 'Opening bell to closing bell, every trading day.' },
            {
              family: 'Weekly',
              question: `Will ${tickers[0] ?? 'NVDA'} finish the week UP?`,
              detail: "The week's first opening bell to Friday's closing bell.",
            },
          ].map((template) => (
            <div key={template.family} className="rounded-control border border-dashed border-edge p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="eyebrow">{template.family} market · template</span>
              </div>
              <p className="mt-2 text-[15px] font-semibold text-paper/80">{template.question}</p>
              <p className="mt-1 text-xs text-faint">{template.detail}</p>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-[11px] text-faint">{deployed ? 'Tickers' : 'Planned tickers'}</span>
            {tickers.map((ticker) => (
              <span key={ticker} className="inline-flex items-center gap-1.5 text-xs text-muted">
                <TickerMark ticker={ticker} size="sm" />
                {ticker}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function nextOpen(now: number): number {
  const clock = marketClock(now);
  return (clock.sessionOpen ? currentOrNextSession(clock.session.close + 60) : clock.session).open;
}

/** When the chain could not be read: say so, with the age of what is shown. Never an empty grid without a reason. */
function Degraded({ kind, readAt, now }: { kind: 'stale' | 'unavailable'; readAt: number | null; now: number }) {
  return (
    <p className="mb-4 rounded-control border border-coral/35 bg-coral/10 px-4 py-3 text-sm text-paper" role="status">
      {kind === 'unavailable'
        ? 'Market data unavailable, retrying. Robinhood Chain could not be read just now; every stake is safe in the contract.'
        : `Price unavailable, retrying. Showing the last good read${readAt === null ? '' : ` from ${formatDuration(Math.max(0, now - readAt))} ago`}.`}
    </p>
  );
}

/** The live markets grid, or the launching state when there are none. Never fake markets. */
export function MarketGrid({
  markets,
  deployment,
  now,
  degraded = null,
  readAt = null,
}: {
  markets: MarketCardData[];
  deployment: Deployment;
  now: number;
  degraded?: 'stale' | 'unavailable' | null;
  readAt?: number | null;
}) {
  if (degraded === 'unavailable') return <Degraded kind="unavailable" readAt={readAt} now={now} />;
  if (markets.length === 0) return <LaunchingState deployment={deployment} now={now} />;
  return (
    <>
      {degraded === 'stale' ? <Degraded kind="stale" readAt={readAt} now={now} /> : null}
      {markets.some((market) => market.phase === 'opens' || market.phase === 'live') ? null : (
        <p className="mb-4 rounded-control border border-dashed border-edge-strong px-4 py-3 text-sm text-muted">
          No market is taking bets right now. New daily markets are listed before each opening bell; the next one rings{' '}
          <span className="num text-paper">{formatEtDateTime(nextOpen(now))}</span>. Recently settled markets are below.
        </p>
      )}
      <ul className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
        {markets.map((market) => (
          <li key={market.id}>
            <MarketCard market={market} now={now} />
          </li>
        ))}
      </ul>
    </>
  );
}
