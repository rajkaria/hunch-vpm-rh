import { formatBps, formatMultiple, formatUsdg } from '@hunch-rh/client';

import { SideWord } from '@/components/ui/primitives';
import { formatEtDayTime } from '@/lib/et';
import type { LiveMarket, LivePosition } from '@/lib/market/model';
import { shortAddress } from '@/lib/units';

/** The ordinary pool's payout after the same fee on winnings this market charges (floored). */
function classicAfterFee(classic: bigint, stake: bigint, feeBps: number): bigint {
  return classic > stake ? classic - ((classic - stake) * BigInt(feeBps)) / 10_000n : classic;
}

function tx(explorer: string, hash: string): string {
  return `${explorer.replace(/\/$/, '')}/tx/${hash}`;
}

/**
 * Every position in entry order: when (ET, from the entry's block when the logs are readable,
 * else its place in the order), side, stake, what it is worth if its side wins now (or what it
 * was paid), and the multiple. The opening seed is labelled. After resolution, a column shows
 * what an ordinary pool would have paid the same bets.
 */
export function BookTable({ market, explorer, viewer }: { market: LiveMarket; explorer: string; viewer: string | null }) {
  const json = market.json;
  const settled = json.market.phase === 'resolved' || json.market.phase === 'void';
  const resolved = json.market.phase === 'resolved';
  const rows = [...market.positions].sort((a, b) => (a.id < b.id ? -1 : 1));
  const bets = rows.filter((p) => !p.seed).length;
  let order = 0;

  const worth = (p: LivePosition): bigint | null => (settled ? p.payout : p.finalized ? p.accrued : null);

  return (
    <section aria-labelledby="book-title" className="rounded-card border border-edge bg-raised">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-edge px-4 py-3.5 sm:px-5">
        <h2 id="book-title" className="font-body text-[15px] font-semibold tracking-normal text-paper">
          Every bet
        </h2>
        <p className="text-xs text-faint">
          <span className="num">{bets}</span> {bets === 1 ? 'bet' : 'bets'} · pool <span className="num">{formatUsdg(market.pool.total)}</span> USDG
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted sm:px-5">No bets yet.</p>
      ) : (
        <div className="scroll-x">
          <table className="data-table min-w-[640px]">
            <caption className="sr-only">Every position in this market, in the order it was placed</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">Side</th>
                <th scope="col" className="text-right">
                  Stake
                </th>
                <th scope="col" className="text-right">
                  {settled ? 'Paid' : 'If it wins now'}
                </th>
                <th scope="col" className="text-right">
                  Multiple
                </th>
                {resolved ? (
                  <th scope="col" className="text-right">
                    Ordinary pool would have paid
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                if (!p.seed) order += 1;
                const value = worth(p);
                const stake = p.accepted ?? p.offered;
                const multiple = value === null || stake === 0n ? null : formatMultiple(value, stake);
                const mine = viewer !== null && viewer.toLowerCase() === p.owner.toLowerCase();
                return (
                  <tr key={p.id.toString()} className={mine ? 'bg-lime/5' : undefined}>
                    <td className="whitespace-nowrap">
                      {p.seed ? (
                        <span className="text-xs text-faint">Opening</span>
                      ) : p.enteredAt !== null ? (
                        p.entryTx === null ? (
                          <span className="num text-xs text-muted">{formatEtDayTime(p.enteredAt)}</span>
                        ) : (
                          <a href={tx(explorer, p.entryTx)} target="_blank" rel="noreferrer noopener" className="num text-xs text-muted underline decoration-edge-strong underline-offset-2 hover:text-paper">
                            {formatEtDayTime(p.enteredAt)}
                          </a>
                        )
                      ) : (
                        <span className="num text-xs text-muted">Bet {order}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      {p.seed ? (
                        <span className="text-faint">Hunch opening seed</span>
                      ) : (
                        <span className="num text-muted">
                          {shortAddress(p.owner)}
                          {mine ? <span className="ml-1.5 font-body text-lime">you</span> : p.opener ? <span className="ml-1.5 font-body text-faint">Hunch</span> : null}
                        </span>
                      )}
                    </td>
                    <td>
                      <SideWord side={p.side} className="text-xs" />
                    </td>
                    <td className="num whitespace-nowrap text-right text-paper">
                      {formatUsdg(stake)}
                      {p.accepted !== null && p.accepted < p.offered ? <span className="block text-[11px] text-faint">of {formatUsdg(p.offered)}</span> : null}
                      {p.accepted === null ? <span className="block font-body text-[11px] text-faint">matching</span> : null}
                    </td>
                    <td className="num whitespace-nowrap text-right text-paper">
                      {value === null ? (
                        <span className="text-faint">pending</span>
                      ) : p.payoutTx !== null ? (
                        <a href={tx(explorer, p.payoutTx)} target="_blank" rel="noreferrer noopener" className="underline decoration-edge-strong underline-offset-2 hover:text-lime">
                          {formatUsdg(value)}
                        </a>
                      ) : (
                        formatUsdg(value)
                      )}
                    </td>
                    <td className="num whitespace-nowrap text-right text-muted">{multiple ?? ''}</td>
                    {resolved ? (
                      <td className="num whitespace-nowrap text-right text-muted">
                        {p.classicPayout === null ? '' : formatUsdg(classicAfterFee(p.classicPayout, p.accepted ?? 0n, json.market.limits.feeBps))}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-edge px-4 py-3 text-xs leading-relaxed text-faint sm:px-5">
        {settled
          ? `Paid is what each position receives after the ${formatBps(json.market.limits.feeBps)} fee on winnings (a loss pays nothing; a refund returns the stake); the ordinary pool is shown after the same fee. Amounts link to their payout transactions once delivered.`
          : 'If it wins now is what each bet is paid if its side wins, as of now. It only goes up as the other side adds money.'}
        {json.activity ? '' : ' Entry times appear once the chain logs can be read.'}
      </p>
    </section>
  );
}
