import Link from 'next/link';

import { Countdown } from '@/components/market/Countdown';
import { CapacityTrack } from '@/components/market/HeadroomBar';
import { SettlerBadge, StatusBadge } from '@/components/market/StatusBadge';
import { Amount, Badge, Percent } from '@/components/ui/primitives';
import type { MarketSummary, OutcomeTone } from '@/lib/data/types';
import { formatUtcDate } from '@/lib/time';
import { formatAmount, formatPpmPercent } from '@/lib/units';
import { capacityBar } from '@/lib/vpm';

const TONE_TEXT: Record<OutcomeTone, string> = {
  up: 'text-lime',
  down: 'text-coral',
  neutral: 'text-paper',
};

const TONE_DOT: Record<OutcomeTone, string> = {
  up: 'bg-lime',
  down: 'bg-coral',
  neutral: 'bg-paper',
};

export function MarketCard({ market }: { market: MarketSummary }) {
  const settled = market.status !== 'Open';

  return (
    <article className="lift group relative flex flex-col rounded-card border border-edge bg-raised transition-colors focus-within:border-lime/40 hover:border-lime/40 hover:bg-paper/5">
      <div className="flex items-center gap-2 border-b border-edge px-4 py-2.5">
        <Badge tone="quiet">{market.subject}</Badge>
        <SettlerBadge kind={market.settlerKind} />
        <span className="ml-auto">
          <StatusBadge status={market.status} frozen={market.frozen} />
        </span>
      </div>

      <div className="px-4 pt-4">
        <h3 className="text-base leading-snug">
          <Link href={`/m/${market.id}`} className="outline-none after:absolute after:inset-0">
            {market.question}
          </Link>
        </h3>
      </div>

      <div className="mt-4 space-y-3 px-4">
        {market.outcomes.map((outcome) => {
          const bar = capacityBar(outcome.capacity, outcome.vested);
          const won = market.winner === outcome.outcome;
          return (
            <div key={outcome.outcome}>
              <div className="flex items-baseline gap-2">
                <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[outcome.tone]}`} />
                <span className={`min-w-0 truncate text-sm ${won ? 'font-semibold' : ''}`}>
                  {outcome.label}
                  {won ? <span className="ml-2 text-xs uppercase tracking-wider text-muted">won</span> : null}
                </span>
                <span className="ml-auto shrink-0 text-sm">
                  <Amount value={outcome.principal} className="text-muted" />
                </span>
                <Percent ppm={outcome.probabilityPpm} className={`w-16 shrink-0 text-right text-sm ${TONE_TEXT[outcome.tone]}`} />
              </div>
              <div className="mt-1.5 flex items-center gap-3">
                <CapacityTrack
                  consumedPpm={bar.consumedPpm}
                  tone={outcome.tone}
                  unbounded={bar.unbounded}
                  label={`${outcome.label}: ${formatPpmPercent(bar.consumedPpm, 1)} percent of capacity used`}
                />
                <span className="num w-28 shrink-0 text-right text-[11px] text-faint">
                  {bar.unbounded ? 'no ceiling' : `${formatAmount(bar.headroom ?? 0n, { fractionDigits: 0 })} room`}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex items-baseline justify-between gap-3 border-t border-edge px-4 py-3">
        <span className="text-xs text-muted">
          Book <Amount value={market.acceptedPool} className="text-paper" />
        </span>
        <span className="text-xs text-muted">
          {settled ? (
            <>Settled {formatUtcDate(market.resolutionTime)}</>
          ) : market.frozen ? (
            <>Frozen {formatUtcDate(market.resolutionTime)}</>
          ) : (
            <>
              Freezes in{' '}
              <Countdown
                deadline={Number(market.resolutionTime)}
                initialSeconds={Number(market.secondsToFreeze)}
                className="text-paper"
              />
            </>
          )}
        </span>
      </div>
    </article>
  );
}
