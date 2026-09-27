import { SideWord } from '@/components/ui/primitives';
import { EXAMPLE, WORKED, formatAcc, multiplePpm } from '@/content/worked-example';
import { formatAmount, formatMultiple } from '@/lib/units';

/** The bets, in order, as the spec's worked example lists them. */
export function WorkedExampleBets() {
  return (
    <div className="scroll-x rounded-card border border-edge">
      <table className="data-table min-w-[420px]">
        <caption className="sr-only">The bets in the worked example, in the order they landed</caption>
        <thead>
          <tr>
            <th scope="col">When (ET)</th>
            <th scope="col">Who</th>
            <th scope="col">Side</th>
            <th scope="col" className="text-right">Stake (USDG)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="text-muted">At listing</td>
            <td className="text-muted">Hunch opening seed</td>
            <td className="text-xs">
              <SideWord side="UP" /> <span className="text-faint">and</span> <SideWord side="DOWN" />
            </td>
            <td className="num text-right text-muted">
              {formatAmount(EXAMPLE.seedPerLeg)} + {formatAmount(EXAMPLE.seedPerLeg)}
            </td>
          </tr>
          {EXAMPLE.bets.map((bet) => (
            <tr key={bet.name}>
              <td className="num whitespace-nowrap text-muted">{bet.when}</td>
              <td className="text-paper">{bet.name}</td>
              <td>
                <SideWord side={bet.side} className="text-xs" />
              </td>
              <td className="num text-right text-paper">{formatAmount(bet.stake)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What every winning position is paid, against an ordinary pool. */
export function WorkedExamplePayouts() {
  const winners = [...WORKED.rows.filter((row) => row.side === 'UP'), WORKED.seedUp];
  const totalPaid = winners.reduce((sum, row) => sum + row.payout, 0n);
  const totalClassic = winners.reduce((sum, row) => sum + row.classic, 0n);
  return (
    <div className="scroll-x rounded-card border border-edge">
      <table className="data-table min-w-[520px]">
        <caption className="sr-only">What each winning position is paid when NVDA closes UP</caption>
        <thead>
          <tr>
            <th scope="col">Position</th>
            <th scope="col" className="text-right">Stake</th>
            <th scope="col" className="text-right">Hunch pays</th>
            <th scope="col" className="text-right">Multiple</th>
            <th scope="col" className="text-right">Ordinary pool</th>
          </tr>
        </thead>
        <tbody>
          {winners.map((row) => (
            <tr key={row.name}>
              <td className="text-paper">
                {row.name === 'Mei' ? 'Mei (Tuesday)' : row.name === 'Ben' ? 'Ben (Friday, 5 min before the bell)' : 'Hunch seed, UP side'}
              </td>
              <td className="num text-right text-muted">{formatAmount(row.stake)}</td>
              <td className={`num text-right ${row.name === 'Mei' ? 'text-lime' : 'text-paper'}`}>{formatAmount(row.payout)}</td>
              <td className="num text-right text-muted">{formatMultiple(multiplePpm(row.payout, row.stake))}</td>
              <td className="num text-right text-muted">{formatAmount(row.classic)}</td>
            </tr>
          ))}
          <tr>
            <td className="text-faint">Total paid to UP</td>
            <td />
            <td className="num text-right text-paper">{formatAmount(totalPaid)}</td>
            <td />
            <td className="num text-right text-muted">{formatAmount(totalClassic)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** The spec's full table, per-side running totals included. For the curious. */
export function WorkedExampleAccumulators() {
  return (
    <div className="scroll-x rounded-card border border-edge">
      <table className="data-table min-w-[560px]">
        <caption className="sr-only">Running per-side totals after each bet in the worked example</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Who</th>
            <th scope="col" className="text-right">Stake</th>
            <th scope="col" className="text-right">A_UP after</th>
            <th scope="col" className="text-right">A_DOWN after</th>
            <th scope="col" className="text-right">Entry accumulator</th>
          </tr>
        </thead>
        <tbody>
          {WORKED.steps.map((step) => {
            const bet = step.bet === -1 ? null : EXAMPLE.bets[step.bet];
            return (
              <tr key={step.bet}>
                <td className="num whitespace-nowrap text-muted">{bet === null ? 'open' : bet?.when}</td>
                <td className="text-paper">
                  {bet === null ? 'seed' : bet?.name} {bet === null || bet === undefined ? null : <SideWord side={bet.side} className="text-xs" />}
                </td>
                <td className="num text-right text-muted">
                  {bet === null ? '10 / 10' : bet === undefined ? '' : formatAmount(bet.stake, { fractionDigits: 0 })}
                </td>
                <td className="num text-right text-paper">{formatAcc(step.accUp)}</td>
                <td className="num text-right text-paper">{formatAcc(step.accDown)}</td>
                <td className="num text-right text-muted">
                  {bet === null ? '0 (both legs)' : bet === undefined ? '' : `A_${bet.side} = ${formatAcc(step.entryAcc)}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
