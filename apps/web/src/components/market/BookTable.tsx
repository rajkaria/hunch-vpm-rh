import { Amount, Percent } from '@/components/ui/primitives';
import type { MarketDetail, OutcomeTone } from '@/lib/data/types';
import { bookHeadroom, simulateEntry, type BookMath } from '@/lib/vpm';

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

/**
 * The whole book, per outcome.
 *
 * `Room for a stake` is the number that decides whether an entry is refused,
 * and it is not this outcome's own headroom: stake on an outcome vests into
 * the OPPOSING books, so it is the tightest of those that binds. Showing both
 * columns side by side is the only way that stops being surprising.
 */
export function BookTable({ market }: { market: MarketDetail }) {
  const math: BookMath[] = market.outcomes.map((outcome) => ({
    outcome: outcome.outcome,
    principal: outcome.principal,
    vested: outcome.vested,
    capacity: outcome.capacity,
    demand: outcome.demand,
    acc: outcome.acc,
  }));

  return (
    <div className="scroll-x">
      <table className="w-full min-w-[46rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-edge text-left text-xs uppercase tracking-[0.1em] text-faint">
            <th scope="col" className="px-4 py-2.5 font-normal sm:px-5">
              Outcome
            </th>
            <th scope="col" className="px-3 py-2.5 text-right font-normal">
              Implied
            </th>
            <th scope="col" className="px-3 py-2.5 text-right font-normal">
              Book P
            </th>
            <th scope="col" className="px-3 py-2.5 text-right font-normal">
              Vested in V
            </th>
            <th scope="col" className="px-3 py-2.5 text-right font-normal">
              Capacity C
            </th>
            <th scope="col" className="px-3 py-2.5 text-right font-normal">
              Headroom H
            </th>
            <th scope="col" className="px-4 py-2.5 text-right font-normal sm:px-5">
              Room for a stake
            </th>
          </tr>
        </thead>
        <tbody>
          {market.outcomes.map((outcome) => {
            const headroom = bookHeadroom(outcome.capacity, outcome.vested);
            const room = simulateEntry(math, outcome.outcome, 0n).maxFullyAccepted;
            const won = market.winner === outcome.outcome;
            return (
              <tr key={outcome.outcome} className="border-b border-edge/60 last:border-0">
                <th scope="row" className="px-4 py-3 text-left font-normal sm:px-5">
                  <span className="flex items-center gap-2">
                    <span aria-hidden className={`h-2 w-2 shrink-0 ${TONE_DOT[outcome.tone]}`} />
                    <span className={won ? 'font-semibold' : ''}>{outcome.label}</span>
                    {won ? (
                      <span className="num text-[10px] uppercase tracking-[0.12em] text-muted">won</span>
                    ) : null}
                  </span>
                </th>
                <td className="px-3 py-3 text-right">
                  <Percent ppm={outcome.probabilityPpm} className={TONE_TEXT[outcome.tone]} />
                </td>
                <td className="px-3 py-3 text-right">
                  <Amount value={outcome.principal} />
                </td>
                <td className="px-3 py-3 text-right text-muted">
                  <Amount value={outcome.vested} />
                </td>
                <td className="px-3 py-3 text-right text-muted">
                  {outcome.capacity === null ? <span className="num">unbounded</span> : <Amount value={outcome.capacity} />}
                </td>
                <td className="px-3 py-3 text-right text-muted">
                  {headroom === null ? <span className="num">unbounded</span> : <Amount value={headroom} />}
                </td>
                <td className="px-4 py-3 text-right sm:px-5">
                  {room === null ? <span className="num text-muted">unbounded</span> : <Amount value={room} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
