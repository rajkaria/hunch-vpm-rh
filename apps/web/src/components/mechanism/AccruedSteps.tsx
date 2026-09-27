import { EXAMPLE, WORKED } from '@/content/worked-example';
import { formatAmount } from '@/lib/units';

function Num({ value }: { value: bigint }) {
  return <span className="num text-paper">{formatAmount(value)}</span>;
}

const W = 640;
const H = 250;
const PAD = { top: 20, right: 64, bottom: 44, left: 44 };

/**
 * "Your payout can only go up": what Mei and Ben would be paid if UP won, after each bet in the
 * worked example. Steps, not curves: nothing changes between bets. Evenly spaced by bet, not by
 * time, so the Friday bets are readable. Server-rendered SVG; no client code.
 */
export function AccruedSteps() {
  // Columns: each bet, then the bell.
  const labels = [...EXAMPLE.bets.map((bet) => bet.name), 'Bell'];
  const steps = WORKED.steps.slice(1); // skip the opening seed
  const mei = steps.map((step) => step.accruedMei);
  const ben = steps.map((step) => step.accruedBen);
  mei.push(mei[mei.length - 1] ?? 0n);
  ben.push(ben[ben.length - 1] ?? 0n);

  const maxValue = 75_000_000n;
  const x = (index: number): number => PAD.left + (index / (labels.length - 1)) * (W - PAD.left - PAD.right);
  const y = (value: bigint): number => H - PAD.bottom - (Number((value * 1000n) / maxValue) / 1000) * (H - PAD.top - PAD.bottom);

  const path = (values: bigint[], from: number): string => {
    let d = '';
    for (let index = from; index < values.length; index += 1) {
      const value = values[index] ?? 0n;
      if (d === '') d = `M ${x(index)} ${y(value)}`;
      else d += ` H ${x(index)} V ${y(value)}`;
    }
    return d;
  };

  const benFrom = EXAMPLE.bets.findIndex((bet) => bet.name === 'Ben');
  const ticks = [0n, 25_000_000n, 50_000_000n, 75_000_000n];
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
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-4 h-auto w-full" role="img" aria-describedby="accrued-desc">
        {ticks.map((tick) => (
          <g key={tick.toString()}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} stroke="var(--color-edge)" />
            <text x={PAD.left - 8} y={y(tick) + 4} textAnchor="end" fontSize="11" fill="var(--color-faint)" className="num">
              {formatAmount(tick, { fractionDigits: 0 })}
            </text>
          </g>
        ))}
        {labels.map((label, index) => (
          <text key={label} x={x(index)} y={H - PAD.bottom + 20} textAnchor="middle" fontSize="11" fill="var(--color-faint)">
            {label}
          </text>
        ))}
        {labels.map((label, index) => (
          <line
            key={`${label}-tick`}
            x1={x(index)}
            x2={x(index)}
            y1={H - PAD.bottom}
            y2={H - PAD.bottom + 5}
            stroke="var(--color-edge-strong)"
          />
        ))}
        <path d={path(ben, benFrom)} fill="none" stroke="var(--color-paper)" strokeOpacity="0.7" strokeWidth="2" />
        <path d={path(mei, 0)} fill="none" stroke="var(--color-lime)" strokeWidth="2.5" />
        {mei.map((value, index) => (
          <circle key={`m${index}`} cx={x(index)} cy={y(value)} r="3" fill="var(--color-lime)" />
        ))}
        {ben.slice(benFrom).map((value, offset) => (
          <circle key={`b${offset}`} cx={x(benFrom + offset)} cy={y(value)} r="3" fill="var(--color-paper)" />
        ))}
        <text x={x(last) + 8} y={y(mei[last] ?? 0n) + 4} fontSize="12" fill="var(--color-lime)" className="num">
          Mei {formatAmount(mei[last] ?? 0n)}
        </text>
        <text x={x(last) + 8} y={y(ben[last] ?? 0n) + 16} fontSize="12" fill="var(--color-paper)" className="num">
          Ben {formatAmount(ben[last] ?? 0n)}
        </text>
      </svg>
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
