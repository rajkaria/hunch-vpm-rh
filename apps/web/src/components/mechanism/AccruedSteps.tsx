import { EXAMPLE, WORKED } from '@/content/worked-example';
import { formatAmount } from '@/lib/units';

function Num({ value }: { value: bigint }) {
  return <span className="num text-paper">{formatAmount(value)}</span>;
}

interface Frame {
  W: number;
  H: number;
  pad: { top: number; right: number; bottom: number; left: number };
  font: number;
}

/** A phone gets its own, narrower drawing so its labels stay legible instead of scaling down to 5 px. */
const WIDE: Frame = { W: 640, H: 250, pad: { top: 20, right: 84, bottom: 44, left: 44 }, font: 11 };
const NARROW: Frame = { W: 360, H: 250, pad: { top: 18, right: 80, bottom: 40, left: 30 }, font: 12 };

function Chart({
  frame,
  labels,
  mei,
  ben,
  benFrom,
  last,
}: {
  frame: Frame;
  labels: string[];
  mei: bigint[];
  ben: bigint[];
  benFrom: number;
  last: number;
}) {
  const { W, H, pad, font } = frame;
  const maxValue = 75_000_000n;
  const x = (index: number): number => pad.left + (index / (labels.length - 1)) * (W - pad.left - pad.right);
  const y = (value: bigint): number => H - pad.bottom - (Number((value * 1000n) / maxValue) / 1000) * (H - pad.top - pad.bottom);
  const path = (values: bigint[], from: number): string => {
    let d = '';
    for (let index = from; index < values.length; index += 1) {
      const value = values[index] ?? 0n;
      if (d === '') d = `M ${x(index)} ${y(value)}`;
      else d += ` H ${x(index)} V ${y(value)}`;
    }
    return d;
  };
  const ticks = [0n, 25_000_000n, 50_000_000n, 75_000_000n];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-describedby="accrued-desc">
      {ticks.map((tick) => (
        <g key={tick.toString()}>
          <line x1={pad.left} x2={W - pad.right} y1={y(tick)} y2={y(tick)} stroke="var(--color-edge)" />
          <text x={pad.left - 8} y={y(tick) + 4} textAnchor="end" fontSize={font} fill="var(--color-faint)" className="num">
            {formatAmount(tick, { fractionDigits: 0 })}
          </text>
        </g>
      ))}
      {labels.map((label, index) => (
        <text key={label} x={x(index)} y={H - pad.bottom + 20} textAnchor="middle" fontSize={font} fill="var(--color-faint)">
          {label}
        </text>
      ))}
      {labels.map((label, index) => (
        <line key={`${label}-tick`} x1={x(index)} x2={x(index)} y1={H - pad.bottom} y2={H - pad.bottom + 5} stroke="var(--color-edge-strong)" />
      ))}
      <path d={path(ben, benFrom)} fill="none" stroke="var(--color-paper)" strokeOpacity="0.7" strokeWidth="2" />
      <path d={path(mei, 0)} fill="none" stroke="var(--color-lime)" strokeWidth="2.5" />
      {mei.map((value, index) => (
        <circle key={`m${index}`} cx={x(index)} cy={y(value)} r="3" fill="var(--color-lime)" />
      ))}
      {ben.slice(benFrom).map((value, offset) => (
        <circle key={`b${offset}`} cx={x(benFrom + offset)} cy={y(value)} r="3" fill="var(--color-paper)" />
      ))}
      <text x={x(last) + 8} y={y(mei[last] ?? 0n) + 4} fontSize={font + 1} fill="var(--color-lime)" className="num">
        Mei {formatAmount(mei[last] ?? 0n)}
      </text>
      <text x={x(last) + 8} y={y(ben[last] ?? 0n) + 16} fontSize={font + 1} fill="var(--color-paper)" className="num">
        Ben {formatAmount(ben[last] ?? 0n)}
      </text>
    </svg>
  );
}

export function AccruedSteps() {
  // Columns: each bet, then the bell.
  const labels = [...EXAMPLE.bets.map((bet) => bet.name), 'Bell'];
  const steps = WORKED.steps.slice(1); // skip the opening seed
  const mei = steps.map((step) => step.accruedMei);
  const ben = steps.map((step) => step.accruedBen);
  mei.push(mei[mei.length - 1] ?? 0n);
  ben.push(ben[ben.length - 1] ?? 0n);

  const benFrom = EXAMPLE.bets.findIndex((bet) => bet.name === 'Ben');
  const last = labels.length - 1;

  return (
    <figure className="lift rounded-card border border-edge bg-raised p-4 sm:p-5" aria-labelledby="accrued-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id="accrued-title" className="text-[15px] font-semibold text-paper">
          If UP wins, what Mei and Ben are paid, after each bet
        </p>
        <span className="inline-flex items-center rounded-tag border border-paper/25 bg-paper/8 px-2 py-1 text-[11px] leading-none font-semibold tracking-[0.05em] text-paper uppercase">
          Illustration
        </span>
      </div>
      <div className="mt-4 sm:hidden">
        <Chart frame={NARROW} labels={labels} mei={mei} ben={ben} benFrom={benFrom} last={last} />
      </div>
      <div className="mt-4 hidden sm:block">
        <Chart frame={WIDE} labels={labels} mei={mei} ben={ben} benFrom={benFrom} last={last} />
      </div>
      <figcaption id="accrued-desc" className="mt-3 text-sm leading-relaxed text-muted">
        Mei staked <Num value={mei[0] ?? 0n} /> on Tuesday. Every DOWN bet after hers raised what she would be paid:{' '}
        <Num value={mei[1] ?? 0n} /> after Dan, <Num value={mei[2] ?? 0n} /> after Kim, <Num value={mei[4] ?? 0n} /> after
        Lee. Ben&rsquo;s UP bet on Friday did not change her number, and nothing could lower it. Ben staked{' '}
        <Num value={ben[benFrom] ?? 0n} /> five minutes before the bell; only Lee&rsquo;s bet came after him, so he ends at{' '}
        <Num value={ben[last] ?? 0n} />.
      </figcaption>
    </figure>
  );
}
