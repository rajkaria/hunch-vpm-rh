import { SideWord } from '@/components/ui/primitives';
import { EXAMPLE, WORKED, exampleBet, exampleRow, multiplePpm } from '@/content/worked-example';
import { formatAmount, formatMultiple } from '@/lib/units';

/**
 * "Why early pays more", drawn from the worked example: the week as a track with every bet on
 * it at its real time, then what the early and the late winner are paid here against an
 * ordinary pool. Always labelled "Illustration".
 */
export function EarlyPaysMore() {
  const mei = exampleRow('Mei');
  const ben = exampleRow('Ben');
  const rows = [
    { row: mei, when: exampleBet('Mei').when, note: 'Called it Tuesday morning and held through two days of bets against her.' },
    { row: ben, when: exampleBet('Ben').when, note: 'Bet the obvious side five minutes before the bell.' },
  ];
  const max = [mei.payout, ben.payout, mei.classic, ben.classic].reduce((a, b) => (b > a ? b : a), 1n);
  const pct = (value: bigint): string => `${Math.max(2, Number((value * 1000n) / max) / 10)}%`;

  // Above the track: the two UP bettors. Below: the three DOWN bettors.
  const placed = EXAMPLE.bets.map((bet) => ({ ...bet, at: (bet.hoursIn / EXAMPLE.weekHours) * 100 }));

  return (
    <figure className="lift rounded-card border border-edge bg-raised p-4 sm:p-6" aria-labelledby="early-pays-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center rounded-tag border border-paper/25 bg-paper/8 px-2 py-1 text-[11px] leading-none font-semibold tracking-[0.05em] text-paper uppercase">
          Illustration
        </span>
        <span className="text-[11px] text-faint">Made-up bettors, the contract&rsquo;s arithmetic</span>
      </div>
      <p id="early-pays-title" className="mt-4 text-[15px] font-semibold text-paper">
        {EXAMPLE.question} <span className="font-normal text-muted">NVDA closes</span> <SideWord side="UP" />
      </p>

      {/* The week, to scale. */}
      <div className="mt-6" aria-hidden>
        <div className="relative h-[100px]">
          {placed.map((bet, index) => {
            const above = bet.side === 'UP';
            const nearEnd = bet.at > 80;
            // The last DOWN bet lands a few minutes after Ben's, beside Kim's label: give it its own row.
            const lowerRow = !above && index === placed.length - 1;
            return (
              <div
                key={bet.name}
                className="absolute"
                style={{
                  left: `${bet.at}%`,
                  top: above ? 0 : lowerRow ? 76 : 48,
                  transform: `translateX(${nearEnd ? '-100%' : bet.at < 10 ? '0' : '-50%'})`,
                }}
              >
                <span
                  className={`num whitespace-nowrap rounded-tag border px-1.5 py-0.5 text-[10px] ${
                    bet.side === 'UP' ? 'border-lime/35 text-lime' : 'border-coral/35 text-coral'
                  }`}
                >
                  {bet.name} {bet.side} {formatAmount(bet.stake, { fractionDigits: 0 })}
                </span>
              </div>
            );
          })}
          <div className="absolute inset-x-0 top-[38px] h-px bg-edge-strong" />
          {placed.map((bet) => (
            <span
              key={`${bet.name}-dot`}
              className={`absolute top-[34px] h-[9px] w-[3px] rounded-pill ${bet.side === 'UP' ? 'bg-lime' : 'bg-coral'}`}
              style={{ left: `calc(${bet.at}% - 1.5px)` }}
            />
          ))}
        </div>
        <div className="num mt-1 flex justify-between text-[10px] text-faint">
          <span>Tue 9:30 am opening bell</span>
          <span>Fri 4:00 pm closing bell</span>
        </div>
      </div>

      <p className="sr-only">
        Bets in order: {EXAMPLE.bets.map((bet) => `${bet.name} bet ${bet.side} ${formatAmount(bet.stake)} USDG at ${bet.when} ET`).join('; ')}.
      </p>

      <div className="mt-6 grid gap-4">
        {rows.map(({ row, when, note }) => (
          <div key={row.name} className="rounded-control border border-edge bg-ghost p-3 sm:p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="text-sm font-semibold text-paper">
                {row.name} <SideWord side={row.side} className="text-xs" />{' '}
                <span className="num font-normal text-muted">{formatAmount(row.stake)} USDG</span>
              </p>
              <p className="num text-[11px] text-faint">{when} ET</p>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted">{note}</p>
            <dl className="mt-3 grid gap-2">
              <div className="grid grid-cols-[92px_1fr_auto] items-center gap-3 text-xs sm:grid-cols-[120px_1fr_auto]">
                <dt className="text-paper">Hunch pays</dt>
                <dd className="h-2 overflow-hidden rounded-pill bg-paper/6" aria-hidden>
                  <div className={`h-full origin-left rounded-pill motion-safe:animate-grow ${row.name === 'Mei' ? 'bg-lime' : 'bg-paper/70'}`} style={{ width: pct(row.payout) }} />
                </dd>
                <dd className="num text-right text-paper">
                  {formatAmount(row.payout)} <span className="text-faint">{formatMultiple(multiplePpm(row.payout, row.stake))}</span>
                </dd>
              </div>
              <div className="grid grid-cols-[92px_1fr_auto] items-center gap-3 text-xs sm:grid-cols-[120px_1fr_auto]">
                <dt className="text-muted">Ordinary pool</dt>
                <dd className="h-2 overflow-hidden rounded-pill bg-paper/6" aria-hidden>
                  <div className="h-full origin-left rounded-pill bg-paper/25 motion-safe:animate-grow [animation-delay:120ms]" style={{ width: pct(row.classic) }} />
                </dd>
                <dd className="num text-right text-muted">
                  {formatAmount(row.classic)} <span className="text-faint">{formatMultiple(multiplePpm(row.classic, row.stake))}</span>
                </dd>
              </div>
            </dl>
          </div>
        ))}
      </div>

      <figcaption className="mt-5 text-sm leading-relaxed text-muted">
        Same market, same result. The pool is <span className="num text-paper">{formatAmount(WORKED.pool)}</span> USDG either
        way; what changes is who it goes to. Here the early call is paid more than three times its stake, and the late
        bet gets its stake back plus a share of the one bet against it that came after. An ordinary pool would have
        handed Ben <span className="num text-paper">{formatAmount(ben.classic)}</span> of it for five minutes of risk.
      </figcaption>
    </figure>
  );
}
