import Link from 'next/link';

import { Badge, SideWord } from '@/components/ui/primitives';
import { formatEtTime } from '@/lib/et';
import type { MarketCardData, Side } from '@/lib/view/types';
import { formatAmount, formatPpmPercent, formatPrice, ppmToPercentNumber, shareToPpm } from '@/lib/units';

import { Countdown } from './Countdown';
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

/** "Will NVDA close UP today? · Tue Sep 29" -> the question, then the day it runs. */
export function splitQuestion(question: string): { title: string; when: string | null } {
  const at = question.indexOf(' · ');
  if (at < 0) return { title: question, when: null };
  return { title: question.slice(0, at), when: question.slice(at + 3) };
}

const FAMILY: Record<MarketCardData['family'], string> = { daily: 'Daily', weekly: 'Weekly', drill: 'Refund drill' };

/**
 * The top-right tag: where the market is in its day, and how long it has left. The same slot
 * the Hunch market card uses for its clock, so a card here reads like a card there.
 */
function PhaseTag({ market, now, taking }: { market: MarketCardData; now: number; taking: boolean }) {
  switch (market.phase) {
    case 'opens':
    case 'live': {
      if (!taking) return <Badge tone="quiet">Paused</Badge>;
      const urgent = market.finalTime - now < 3600;
      return (
        <Badge tone={urgent ? 'down' : market.phase === 'live' ? 'up' : 'note'}>
          <span aria-hidden className={`h-1.5 w-1.5 rounded-pill motion-safe:animate-pulse ${urgent ? 'bg-coral' : market.phase === 'live' ? 'bg-lime' : 'bg-sky'}`} />
          {market.phase === 'live' ? 'Live' : 'Pre-open'}
          <Countdown deadline={market.finalTime} now={now} label="until the closing bell" endedText="closing" className="font-medium tracking-normal" />
        </Badge>
      );
    }
    case 'frozen':
      return <Badge tone="neutral">Settling</Badge>;
    case 'resolved':
      return <Badge tone={market.winner === 'DOWN' ? 'down' : 'up'}>Resolved {market.winner ?? ''}</Badge>;
    case 'void':
      return <Badge tone="quiet">Void · refunded</Badge>;
  }
}

/** The price block: the opening price (or when it sets) against Chainlink's latest. */
function PricePanel({ market, now }: { market: MarketCardData; now: number }) {
  const direction = market.strike !== null && market.live !== null ? directionVsStrike(market.live.answer, market.strike.answer) : null;
  const change = market.strike !== null && market.live !== null ? changePpm(market.live.answer, market.strike.answer) : null;

  return (
    <dl className="mt-4 grid grid-cols-2 gap-3 rounded-card border border-edge bg-ghost p-3">
      <div className="min-w-0">
        <dt className="eyebrow">Opening price</dt>
        {market.strike === null ? (
          <dd className="mt-1.5 text-sm text-muted">
            Sets at 9:30 ET
            <span className="mt-0.5 block text-xs">
              <Countdown deadline={market.strikeTime} now={now} label="until the opening price is set" endedText="setting now" />
            </span>
          </dd>
        ) : (
          <dd className="num mt-1.5 text-lg leading-none text-paper">{formatPrice(market.strike.answer)}</dd>
        )}
      </div>
      <div className="min-w-0 text-right">
        <dt className="eyebrow">Chainlink now</dt>
        {market.live === null ? (
          <dd className="mt-1.5 text-xs text-faint">Price unavailable, retrying</dd>
        ) : (
          <>
            <dd className="num mt-1.5 text-lg leading-none text-paper">{formatPrice(market.live.answer)}</dd>
            {direction === null || change === null ? (
              <dd className="num mt-1.5 text-[11px] text-faint">at {formatEtTime(market.live.updatedAt)}</dd>
            ) : (
              <dd className="mt-1.5 flex items-baseline justify-end gap-1.5 text-xs">
                <span className={`num ${direction === 'UP' ? 'text-lime' : direction === 'DOWN' ? 'text-coral' : 'text-muted'}`}>
                  {change > 0n ? '+' : ''}
                  {formatPpmPercent(change, 2)}%
                </span>
                {direction === 'FLAT' ? <span className="font-semibold text-muted">FLAT</span> : <SideWord side={direction} />}
              </dd>
            )}
          </>
        )}
      </div>
    </dl>
  );
}

/**
 * The two sides as the tiles a Hunch card ends on: UP solid, DOWN outlined while bets are taken,
 * both quiet once they are not (the winner keeps its colour). Each shows what is staked on it.
 * Tiles, not buttons: the whole card is one link and never takes money in place.
 */
function SideTiles({ market, taking }: { market: MarketCardData; taking: boolean }) {
  const settled = market.phase === 'resolved';
  const tile = (side: Side): string => {
    const won = settled && market.winner === side;
    if (side === 'UP') {
      if (taking) return 'bg-lime text-ink group-hover:bg-lime/90';
      return won ? 'border border-lime/40 bg-lime/10 text-lime' : 'border border-edge text-muted';
    }
    if (taking) return 'border border-coral/40 text-coral group-hover:border-coral/60 group-hover:bg-coral/[0.06]';
    return won ? 'border border-coral/40 bg-coral/10 text-coral' : 'border border-edge text-muted';
  };
  return (
    <div className="mt-3 grid grid-cols-2 gap-2.5">
      {(['UP', 'DOWN'] as const).map((side) => (
        <span key={side} className={`rounded-control px-3 py-2.5 text-center transition-colors duration-150 ${tile(side)}`}>
          <span className="block text-sm leading-tight font-semibold tracking-[0.02em]">{side}</span>
          <span className={`num mt-1 block text-[11px] leading-none ${taking && side === 'UP' ? 'text-ink/70' : 'opacity-75'}`}>
            {formatAmount(side === 'UP' ? market.pool.up : market.pool.down)}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * Only when it matters: a side whose room is below the largest bet, so part of a big bet on it
 * would come straight back. Most of the time both sides take a full bet and this says nothing.
 */
function HeadroomLine({ headroom, maxEntry }: { headroom: { up: bigint; down: bigint }; maxEntry: bigint }) {
  const tight = (['UP', 'DOWN'] as const).filter((side) => (side === 'UP' ? headroom.up : headroom.down) < maxEntry);
  if (tight.length === 0) return null;
  return (
    <p className="mt-2 text-center text-[11px] leading-relaxed text-faint">
      {tight.map((side, index) => (
        <span key={side}>
          {index > 0 ? ' · ' : null}
          <SideWord side={side} /> takes up to <span className="num text-muted">{formatAmount(side === 'UP' ? headroom.up : headroom.down)}</span> USDG in full right now
        </span>
      ))}
    </p>
  );
}

/**
 * One market, drawn the way a Hunch market card is drawn: a tag and a clock, the question, one
 * inset panel with the number that decides it, a split bar, the two sides as tiles, and a line
 * underneath. The whole card is the link to `/m/[id]`; a card never takes money in place.
 * Outcomes are the words UP and DOWN, coloured as reinforcement only.
 */
export function MarketCard({ market, now }: { market: MarketCardData; now: number }) {
  const total = market.pool.up + market.pool.down;
  const upShare = shareToPpm(market.pool.up, total);
  const taking = (market.phase === 'opens' || market.phase === 'live') && market.acceptingBets !== false;
  const over = market.phase === 'resolved' || market.phase === 'void';
  const { title, when } = splitQuestion(market.question);

  return (
    <Link href={market.href} className="group block h-full rounded-card">
      <article
        aria-label={market.question}
        className={`lift flex h-full flex-col rounded-card border border-edge bg-raised p-4 transition-[background-color,border-color,transform] duration-150 ease-out group-hover:-translate-y-0.5 group-hover:border-paper/20 group-hover:bg-raised-2 motion-reduce:group-hover:translate-y-0 sm:p-5 ${
          over ? 'opacity-70' : ''
        }`}
      >
        <header className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <TickerMark ticker={market.ticker} size="sm" />
            <Badge tone="info">
              {market.ticker} · {FAMILY[market.family]}
            </Badge>
          </span>
          <PhaseTag market={market} now={now} taking={taking} />
        </header>

        <h3 className="mt-3.5 font-body text-lg leading-tight font-semibold tracking-normal text-paper sm:text-xl">{title}</h3>
        {when === null ? null : <p className="mt-1 text-xs text-faint">{when}</p>}

        <PricePanel market={market} now={now} />

        <div className="mt-4 flex items-baseline justify-between gap-3 text-[11px]">
          <span className="text-faint">
            <span className="num text-muted">{formatAmount(total)}</span> USDG staked
          </span>
          {total === 0n ? (
            <span className="text-faint">{taking ? 'No bets yet' : 'No bets'}</span>
          ) : (
            <span className="text-faint">
              <span className="num text-muted">{formatPpmPercent(upShare, 0)}%</span> on <SideWord side="UP" />
            </span>
          )}
        </div>
        <div className="mt-2 h-[3px] overflow-hidden rounded-pill bg-coral/35" aria-hidden>
          <div className="h-full rounded-pill bg-lime" style={{ width: `${total === 0n ? 50 : ppmToPercentNumber(upShare)}%` }} />
        </div>

        <div className="mt-auto">
          <SideTiles market={market} taking={taking} />
          <p className="mt-3 text-center text-xs leading-relaxed text-muted">
            {taking
              ? 'Bet now and you’d collect everything the other side adds from here.'
              : market.phase === 'frozen'
                ? `Closed at ${formatEtTime(market.finalTime)}. Chainlink settles it next.`
                : market.phase === 'void'
                  ? 'Every stake was refunded in full.'
                  : `Closed at ${formatEtTime(market.finalTime)}.`}
          </p>
          {taking && market.headroom != null && market.maxEntry !== undefined ? <HeadroomLine headroom={market.headroom} maxEntry={market.maxEntry} /> : null}
        </div>
      </article>
    </Link>
  );
}
