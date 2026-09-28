import { Countdown } from '@/components/market/Countdown';
import { TickerMark } from '@/components/market/TickerMark';
import { Badge, ButtonLink } from '@/components/ui/primitives';
import type { Deployment } from '@/lib/deployment';
import type { MarketCardData } from '@/lib/view/types';
import { formatDuration } from '@hunch-rh/client';

import { currentOrNextSession, formatEtDateTime, marketClock } from '@/lib/et';

import { MarketCard } from './MarketCard';

/**
 * The board: a row you swipe on a phone (each card 85% wide, so the next one peeks in and says
 * there is more), a grid from 640 px up. The list bleeds to the screen edge on a phone so a card
 * can scroll under the gutter rather than being cut off inside it.
 */
const BOARD =
  '-mx-4 -my-1 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 py-1 [scrollbar-width:none] sm:mx-0 sm:my-0 sm:grid sm:grid-cols-2 sm:gap-4 sm:overflow-visible sm:px-0 sm:py-0 [&::-webkit-scrollbar]:hidden';
const BOARD_ITEM = 'w-[85%] max-w-sm shrink-0 snap-start sm:w-auto sm:max-w-none';

/** A market shape with nothing in it: dashed, tagged "Template", no numbers, never a link. */
function TemplateCard({ ticker, family }: { ticker: string; family: 'daily' | 'weekly' }) {
  const daily = family === 'daily';
  return (
    <div className="flex h-full flex-col rounded-card border border-dashed border-edge-strong p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <TickerMark ticker={ticker} size="sm" />
          <Badge tone="quiet">
            {ticker} · {daily ? 'Daily' : 'Weekly'}
          </Badge>
        </span>
        <Badge tone="quiet">Template</Badge>
      </div>
      <p className="mt-3.5 text-lg leading-tight font-semibold text-paper/80">
        {daily ? `Will ${ticker} close UP today?` : `Will ${ticker} finish the week UP?`}
      </p>
      <p className="mt-1 text-xs text-faint">
        {daily ? 'Opening bell to closing bell, every trading day.' : "The week's first opening bell to Friday's closing bell."}
      </p>
      <div className="mt-auto grid grid-cols-2 gap-2.5 pt-5" aria-hidden>
        {(['UP', 'DOWN'] as const).map((side) => (
          <span key={side} className="rounded-control border border-dashed border-edge-strong px-3 py-2.5 text-center text-sm font-semibold tracking-[0.02em] text-faint">
            {side}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Before any market exists: say so, say when the first ones can open, and show the market
 * shapes as templates (dashed, no numbers) so nobody mistakes them for live markets.
 */
export function LaunchingState({ deployment, now }: { deployment: Deployment; now: number }) {
  const clock = marketClock(now);
  const next = clock.sessionOpen ? currentOrNextSession(clock.session.close + 60) : clock.session;
  const tickers = deployment.feeds.filter((feed) => feed.families.length > 0).map((feed) => feed.ticker);
  const deployed = deployment.status === 'deployed';
  // One template per ticker; the first shows the weekly shape so both kinds are on the board.
  const templates = tickers.slice(0, 4).map((ticker, index) => ({ ticker, family: index === 0 ? ('weekly' as const) : ('daily' as const) }));

  return (
    <div className="grid gap-4">
      <div className="lift flex flex-col gap-5 rounded-card border border-edge bg-raised p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between lg:gap-10">
        <div className="min-w-0 max-w-2xl">
          <Badge tone="note">{deployed ? 'Between markets' : 'Launching'}</Badge>
          <h3 className="mt-3 font-body text-lg leading-snug font-semibold tracking-normal text-paper sm:text-xl">
            {deployed ? 'New markets open before the next opening bell.' : 'Markets open at the next opening bell once the venue is live.'}
          </h3>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            {deployed
              ? 'No market is taking bets right now. New daily markets are listed before each opening bell.'
              : 'The contracts are not deployed yet, so there is nothing to bet on and nothing here pretends otherwise. Get set up now and you can place your first bet the morning it opens.'}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4 lg:shrink-0 lg:flex-nowrap">
          <dl className="flex gap-6">
            <div>
              <dt className="eyebrow">Next opening bell</dt>
              <dd className="num mt-1.5 text-sm whitespace-nowrap text-paper">{formatEtDateTime(next.open)}</dd>
            </div>
            <div>
              <dt className="eyebrow">In</dt>
              <dd className="mt-1.5 text-sm text-paper">
                <Countdown deadline={next.open} now={now} label="until the next opening bell" endedText="ringing now" />
              </dd>
            </div>
          </dl>
          <ButtonLink href="/start" variant="secondary" size="sm">
            Get set up before it opens
          </ButtonLink>
        </div>
      </div>

      <ul className={`${BOARD} xl:grid-cols-4`} aria-label={deployed ? 'The kinds of market' : 'The markets planned for launch'}>
        {templates.map((template) => (
          <li key={template.ticker} className={BOARD_ITEM}>
            <TemplateCard ticker={template.ticker} family={template.family} />
          </li>
        ))}
      </ul>
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
      <ul className={`${BOARD} xl:grid-cols-3`}>
        {markets.map((market) => (
          <li key={market.id} className={BOARD_ITEM}>
            <MarketCard market={market} now={now} />
          </li>
        ))}
      </ul>
    </>
  );
}
