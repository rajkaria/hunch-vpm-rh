import { Amount } from '@/components/ui/primitives';
import type { OutcomeTone } from '@/lib/data/types';
import { formatPpmPercent, ppmToPercentNumber } from '@/lib/units';
import { capacityBar } from '@/lib/vpm';

const FILL: Record<OutcomeTone, string> = {
  up: 'bg-lime',
  down: 'bg-coral',
  neutral: 'bg-paper',
};

/**
 * The bar itself: a fixed-height track and a fill whose width is the only
 * thing that ever changes, so a value that updates moves one rectangle and
 * leaves the rest of the row where it was.
 *
 * There is no colour change as it fills. Lime means YES and coral means NO on
 * this surface, and a book running out of room does not get to borrow either
 * of them for a third meaning — that is said in words and in the number
 * beside it.
 */
export function CapacityTrack({
  consumedPpm,
  tone,
  label,
  unbounded = false,
}: {
  consumedPpm: bigint;
  tone: OutcomeTone;
  label: string;
  unbounded?: boolean;
}) {
  if (unbounded) {
    // A book with no ceiling has no bar to fill. The empty track is still
    // drawn so a row of outcomes keeps one height.
    return <div className="h-1.5 w-full rounded-pill bg-paper/8" aria-hidden />;
  }
  const percent = ppmToPercentNumber(consumedPpm);
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-pill bg-paper/8"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Number(percent.toFixed(1))}
      aria-label={label}
    >
      <div
        className={`h-full rounded-pill ${FILL[tone]} transition-[width] duration-500 ease-out`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/**
 * One book's capacity, as a labelled bar: how much of C_w stake from the other
 * outcomes has already consumed, and what is left.
 */
export function HeadroomBar({
  label,
  tone,
  capacity,
  vested,
  /** What the reader is told this room constrains, in their words. */
  constrains,
  compact = false,
}: {
  label: string;
  tone: OutcomeTone;
  capacity: bigint | null;
  vested: bigint;
  constrains?: string;
  compact?: boolean;
}) {
  const bar = capacityBar(capacity, vested);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-sm">{label}</span>
        <span className="num shrink-0 text-sm">
          {bar.unbounded ? (
            <span className="text-muted">no ceiling</span>
          ) : (
            <>
              {formatPpmPercent(bar.consumedPpm, 1)}
              <span className="text-muted">% used</span>
            </>
          )}
        </span>
      </div>

      <div className="mt-2">
        <CapacityTrack
          consumedPpm={bar.consumedPpm}
          tone={tone}
          unbounded={bar.unbounded}
          label={`${label}: ${formatPpmPercent(bar.consumedPpm, 1)} percent of capacity used`}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-muted">
        {bar.unbounded ? (
          <span>Capacity is unbounded here, so nothing is refused for want of room.</span>
        ) : (
          <span>
            <Amount value={bar.headroom ?? 0n} className="text-paper" /> room left of{' '}
            <Amount value={bar.capacity ?? 0n} />
          </span>
        )}
        {constrains === undefined || compact ? null : <span className="text-faint">{constrains}</span>}
      </div>
    </div>
  );
}
