'use client';

import { formatAge, formatPrice } from '@hunch-rh/client';

import { formatEtDateTime, formatEtTime } from '@/lib/et';
import type { MarketJson } from '@/lib/api/shapes';
import { feedRoundUrl } from '@/lib/view/early-vs-late';

import { Countdown } from './Countdown';

function RoundLink({ explorer, feed, roundId }: { explorer: string; feed: string; roundId: string }) {
  return (
    <a
      href={feedRoundUrl(explorer, feed)}
      target="_blank"
      rel="noreferrer noopener"
      title="Read getRoundData(round) on the feed's contract page"
      className="num break-hash text-[11px] text-faint underline decoration-edge-strong underline-offset-2 hover:text-paper"
    >
      round {roundId}
    </a>
  );
}

/**
 * The prices that decide the market: the opening price (the Chainlink round in effect at the
 * opening bell, with its round id linked to the feed), the latest price with its age, the change
 * against the opening price in words, and the time left to the bell.
 */
export function PricePanel({
  market,
  explorer,
  nowSec,
  serverNow,
  stale,
  readAt,
}: {
  market: MarketJson;
  explorer: string;
  nowSec: number;
  serverNow: number;
  /** The market read is an older value served during an outage. */
  stale: boolean;
  readAt: number;
}) {
  const strike = market.strike;
  const live = market.live;
  const change = market.change;
  const open = market.phase === 'opens' || market.phase === 'live';

  return (
    <section aria-label="Prices" className="rounded-card border border-edge bg-raised p-4 sm:p-5">
      <dl className="grid gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="eyebrow">Opening price</dt>
          {strike !== null ? (
            <dd className="mt-2">
              <span className="num block text-2xl leading-none text-paper">{formatPrice(BigInt(strike.answer))}</span>
              <span className="mt-2 block text-xs text-muted">
                In effect at <span className="num">{formatEtDateTime(market.strikeTime)}</span>
              </span>
              <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-[11px] text-faint">
                <RoundLink explorer={explorer} feed={market.feed} roundId={strike.roundId} />
                <span className="num">printed {formatEtTime(strike.at)}</span>
              </span>
            </dd>
          ) : nowSec < market.strikeTime ? (
            <dd className="mt-2">
              <span className="block text-lg text-paper">Sets at 9:30 ET</span>
              <span className="mt-1 block text-xs text-muted">
                <Countdown deadline={market.strikeTime} now={serverNow} label="until the opening price is set" endedText="setting now" />{' '}
                <span className="text-faint">until {formatEtDateTime(market.strikeTime)}</span>
              </span>
            </dd>
          ) : (
            <dd className="mt-2 text-sm text-muted">Reading the opening price from Chainlink, retrying.</dd>
          )}
        </div>

        <div className="min-w-0 sm:text-right">
          <dt className="eyebrow">Chainlink now</dt>
          {live === null ? (
            <dd className="mt-2 text-sm text-muted">Price unavailable, retrying</dd>
          ) : (
            <dd className="mt-2">
              <span className="num block text-2xl leading-none text-paper">{formatPrice(BigInt(live.answer))}</span>
              <span className="num mt-2 block text-xs text-muted">updated {formatAge(live.at, Math.max(nowSec, live.at))}</span>
              {change === null || strike === null ? null : (
                <span className="mt-0.5 block text-xs text-muted" data-testid="change-vs-strike">
                  {change.direction === 'FLAT' ? (
                    <>
                      <span className="font-semibold text-paper">FLAT</span> since the open
                    </>
                  ) : (
                    <>
                      <span className={`font-semibold ${change.direction === 'UP' ? 'text-lime' : 'text-coral'}`}>{change.direction}</span>{' '}
                      <span className="num">{change.text.replace(/^[+-]/, '')}</span> since the open
                    </>
                  )}
                </span>
              )}
            </dd>
          )}
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-edge pt-3 text-sm">
        {open ? (
          <span className="text-muted">
            Closing bell in{' '}
            <Countdown deadline={market.finalTime} now={serverNow} label="until the closing bell" endedText="now" urgentBelow={3600} className="text-paper" />
          </span>
        ) : (
          <span className="text-muted">
            Closing bell rang at <span className="num text-paper">{formatEtDateTime(market.finalTime)}</span>
          </span>
        )}
        {stale ? (
          <span className="text-xs text-coral">Price unavailable, retrying. Last read {formatAge(readAt, Math.max(nowSec, readAt))}.</span>
        ) : null}
      </div>
    </section>
  );
}
