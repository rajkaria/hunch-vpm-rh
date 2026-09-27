import Link from 'next/link';

import { SideWord } from '@/components/ui/primitives';
import { formatEtTime } from '@/lib/et';
import type { MarketCardData, Side } from '@/lib/live/types';
import { formatAmount, formatPpmPercent, formatPrice } from '@/lib/units';

import { Countdown } from './Countdown';
import { StatusBadge } from './StatusBadge';
import { TickerMark } from './TickerMark';

/** Which way the live price sits against the strike, as a word. */
export function directionVsStrike(live: bigint, strike: bigint): Side | 'FLAT' {
  if (live > strike) return 'UP';
  if (live < strike) return 'DOWN';
  return 'FLAT';
}

/** (live - strike) / strike in parts per million, signed. */
export function changePpm(live: bigint, strike: bigint): bigint {
  if (strike === 0n) return 0n;
  return ((live - strike) * 1_000_000n) / strike;
}

function Split({ up, down }: { up: bigint; down: bigint }) {
  const total = up + down;
  const upShare = total === 0n ? 50 : Number((up * 1000n) / total) / 10;
  return (
    <div>
      <div className="flex h-1 overflow-hidden rounded-pill bg-paper/6" aria-hidden>
        <div className="h-full bg-lime/80" style={{ width: `${upShare}%` }} />
        <div className="h-full flex-1 bg-coral/70" />
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3 text-xs">
        <span className="flex items-baseline gap-1.5">
          <SideWord side="UP" />
          <span className="num text-muted">{formatAmount(up)}</span>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="num text-muted">{formatAmount(down)}</span>
          <SideWord side="DOWN" />
        </span>
      </div>
    </div>
  );
}

/**
 * One market on the landing grid. The whole card is the link to `/m/[id]`; a card never takes
 * money in place. Outcomes are the words UP and DOWN, coloured as reinforcement only.
 */
export function MarketCard({ market, now }: { market: MarketCardData; now: number }) {
  const total = market.pool.up + market.pool.down;
  const direction = market.strike !== null && market.live !== null ? directionVsStrike(market.live.answer, market.strike.answer) : null;
  const taking = market.phase === 'opens' || market.phase === 'live';

  return (
    <Link
      href={market.href}
      className={`lift group flex h-full flex-col rounded-card border bg-raised p-4 transition-colors duration-150 hover:border-paper/20 hover:bg-raised-2 sm:p-5 ${
        market.phase === 'resolved' || market.phase === 'void' ? 'border-edge opacity-70' : 'border-edge'
      }`}
    >
      <article className="flex h-full flex-col" aria-label={market.question}>
        <header className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2.5">
            <TickerMark ticker={market.ticker} />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-paper">{market.ticker}</span>
              <span className="block text-[11px] text-faint">{market.family === 'weekly' ? 'Weekly' : 'Daily'} · Stock Token</span>
            </span>
          </span>
          <StatusBadge phase={market.phase} winner={market.winner} />
        </header>

        <h3 className="mt-4 font-body text-base leading-snug font-semibold tracking-normal text-paper">{market.question}</h3>

        <dl className="mt-4 grid grid-cols-2 gap-3 rounded-control border border-edge bg-ghost p-3">
          <div className="min-w-0">
            <dt className="text-[11px] text-faint">Opening price</dt>
            {market.strike === null ? (
              <dd className="mt-1 text-sm text-muted">
                Sets at 9:30 ET
                <span className="mt-0.5 block text-xs">
                  <Countdown deadline={market.strikeTime} now={now} label="until the opening price is set" endedText="setting now" />
                </span>
              </dd>
            ) : (
              <dd className="num mt-1 text-[15px] text-paper">{formatPrice(market.strike.answer)}</dd>
            )}
          </div>
          <div className="min-w-0 text-right">
            <dt className="text-[11px] text-faint">Chainlink now</dt>
            {market.live === null ? (
              <dd className="mt-1 text-xs text-faint">Price unavailable, retrying</dd>
            ) : (
              <>
                <dd className="num mt-1 text-[15px] text-paper">{formatPrice(market.live.answer)}</dd>
                {direction === null || market.strike === null ? (
                  <dd className="num mt-0.5 text-[11px] text-faint">at {formatEtTime(market.live.updatedAt)}</dd>
                ) : (
                  <dd className="mt-0.5 flex items-baseline justify-end gap-1.5 text-xs">
                    <span className="num text-muted">
                      {changePpm(market.live.answer, market.strike.answer) > 0n ? '+' : ''}
                      {formatPpmPercent(changePpm(market.live.answer, market.strike.answer), 2)}%
                    </span>
                    {direction === 'FLAT' ? <span className="font-semibold text-muted">FLAT</span> : <SideWord side={direction} />}
                  </dd>
                )}
              </>
            )}
          </div>
        </dl>

        <div className="mt-4">
          <Split up={market.pool.up} down={market.pool.down} />
        </div>

        <div className="mt-4 flex items-baseline justify-between gap-3 border-t border-edge pt-3 text-xs">
          <span className="text-faint">
            Staked <span className="num text-muted">{formatAmount(total)}</span> USDG
          </span>
          {taking ? (
            <span className="text-faint">
              Bell in{' '}
              <Countdown deadline={market.finalTime} now={now} label="until the closing bell" endedText="closed" urgentBelow={3600} className="text-paper" />
            </span>
          ) : (
            <span className="text-faint">Closed at {formatEtTime(market.finalTime)}</span>
          )}
        </div>

        {taking ? (
          <p className="mt-3 text-xs leading-relaxed text-muted">
            Bet now and you&rsquo;d collect everything the other side adds from here.
          </p>
        ) : null}
      </article>
    </Link>
  );
}
