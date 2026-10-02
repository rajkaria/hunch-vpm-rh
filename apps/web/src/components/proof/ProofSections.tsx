import Link from 'next/link';

import { AddressLink } from '@/components/market/AddressLink';
import { EmptyState, SideWord } from '@/components/ui/primitives';
import { formatEtDateTime } from '@/lib/et';
import type { FeeSweepRow, ProofCounter, RefundDrillData, RoundRef, SafeInfo, SettledMarketRow } from '@/lib/view/types';
import { LINKS } from '@/lib/site';
import { formatAmount, formatPrice, shortAddress } from '@/lib/units';

/**
 * The /proof page's sections. Each takes typed props (lib/view/types.ts), filled from chain reads
 * by lib/server/proof.ts, and each has a defined empty state that says what will appear and why
 * it is not there yet. None of them shows a zero it did not read.
 */

function formatCount(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function ProofCounters({ counters, deployed }: { counters: ProofCounter[]; deployed: boolean }) {
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-edge bg-edge lg:grid-cols-3">
      {counters.map((counter) => (
        <div key={counter.label} className="flex flex-col bg-ink p-4 sm:p-5">
          <dt className="eyebrow">{counter.label}</dt>
          <dd className="mt-3 text-2xl leading-none text-paper sm:text-[28px]">
            {counter.value === null ? (
              <span className="text-sm text-faint">{deployed ? 'Not read just now' : 'Not deployed yet'}</span>
            ) : counter.unit === 'USDG' ? (
              <span className="num">
                {formatAmount(counter.value)} <span className="text-sm text-faint">USDG</span>
              </span>
            ) : (
              <span className="num">{formatCount(counter.value)}</span>
            )}
          </dd>
          <dd className="mt-auto pt-3 text-[11px] leading-snug text-faint">
            {counter.sourceUrl === null ? (
              <span className="num">{counter.sourceLabel}</span>
            ) : (
              <a
                href={counter.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="num underline decoration-edge-strong underline-offset-2 hover:text-paper"
              >
                {counter.sourceLabel}
              </a>
            )}
            {counter.note === undefined ? null : <span className="mt-1 block font-body">{counter.note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function SafePanel({ safe }: { safe: SafeInfo }) {
  return (
    <div className="rounded-card border border-edge bg-raised p-4 sm:p-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="min-w-0">
          <p className="text-[11px] text-faint">Safe address</p>
          <div className="mt-1">
            <AddressLink address={safe.address} />
          </div>
        </div>
        <div>
          <p className="text-[11px] text-faint">Signatures required</p>
          <p className="num mt-1 text-sm text-paper">
            {safe.threshold === null || safe.owners === null ? (
              <span className="font-body text-faint">{safe.address === null ? 'Not yet deployed' : 'Not read just now'}</span>
            ) : (
              `${safe.threshold} of ${safe.owners}`
            )}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-faint">Open in the Safe app</p>
          <p className="mt-1 text-sm">
            {safe.address === null ? (
              <span className="text-faint">Not yet deployed</span>
            ) : (
              <a
                href={`${LINKS.safeApp}/home?safe=robinhood:${safe.address}`}
                target="_blank"
                rel="noreferrer noopener"
                className="text-muted underline decoration-edge-strong underline-offset-2 hover:text-paper"
              >
                app.safe.global
              </a>
            )}
          </p>
        </div>
      </div>
      <p className="mt-4 border-t border-edge pt-4 text-sm leading-relaxed text-muted">
        One Safe is the guardian and treasury of the betting contract and the owner of the market factory. It can pause and
        resume new bets and new markets (a pauser key it names can only pause) and choose which price feeds and which
        listing wallet are allowed. It cannot move a stake, set a price, or
        stop claims, refunds or settlement. The threshold is read on-chain, not typed here.
      </p>
    </div>
  );
}

function Round({ round }: { round: RoundRef | null }) {
  if (round === null) return <span className="text-xs text-faint">Not read</span>;
  const body = (
    <>
      <span className="num text-paper">{formatPrice(round.answer)}</span>{' '}
      <span className="num text-[11px] text-faint">round {round.roundId}</span>
    </>
  );
  return (
    <span className="block">
      {round.url === null ? (
        body
      ) : (
        <a href={round.url} target="_blank" rel="noreferrer noopener" className="hover:underline">
          {body}
        </a>
      )}
      <span className="num block text-[11px] text-faint">{formatEtDateTime(round.at)}</span>
    </span>
  );
}

export function SettledMarkets({ rows }: { rows: SettledMarketRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState title="No market has settled yet">
        Every settled market will be listed here with the two Chainlink rounds that decided it, both prices, the
        settlement transaction, how many bets it held and what it paid out.
      </EmptyState>
    );
  }
  return (
    <div className="scroll-x rounded-card border border-edge">
      <table className="data-table min-w-[760px]">
        <caption className="sr-only">Every settled market with its proof rounds</caption>
        <thead>
          <tr>
            <th scope="col">Market</th>
            <th scope="col">Result</th>
            <th scope="col">Opening price</th>
            <th scope="col">Closing price</th>
            <th scope="col" className="text-right">Bets</th>
            <th scope="col" className="text-right">Paid out</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="max-w-[220px]">
                <Link href={row.href} className="text-paper hover:underline">
                  {row.question}
                </Link>
                {row.resolveTxUrl === null ? (
                  <span className="mt-1 block text-[11px] text-faint">Settlement transaction not read</span>
                ) : (
                  <a
                    href={row.resolveTxUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-1 block text-[11px] text-faint underline decoration-edge-strong underline-offset-2 hover:text-paper"
                  >
                    Settlement transaction
                  </a>
                )}
              </td>
              <td>
                {row.outcome === 'FLAT' ? (
                  <span className="font-semibold text-muted">FLAT · refunded</span>
                ) : row.outcome === 'VOID' ? (
                  <span className="font-semibold text-muted">Refunded</span>
                ) : (
                  <SideWord side={row.outcome} />
                )}
              </td>
              <td>
                <Round round={row.strike} />
              </td>
              <td>
                <Round round={row.final} />
              </td>
              <td className="num text-right text-paper">{row.positions}</td>
              <td className="num text-right text-paper">{formatAmount(row.totalPaid)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const DRILL_REASON: Record<NonNullable<RefundDrillData['reason']>, string> = {
  stale: 'The closing price was provably older than the market allowed.',
  'bad-answer': 'The Chainlink price in effect at a bell was provably out of range.',
  flat: 'The price did not move between the bells.',
  paused: "Robinhood paused the token's price for a corporate action.",
  timeout: 'Nobody settled it within 72 hours of the bell.',
};

export function RefundDrill({ drill }: { drill: RefundDrillData | null }) {
  if (drill === null) {
    return (
      <EmptyState title="Planned: a market built to refund">
        <p>
          One labelled market uses Friday&rsquo;s opening price and a closing time of 2:00 am ET on Saturday, when
          Chainlink&rsquo;s stock prices do not update, with a one-hour age limit. The closing price is then provably too
          old, so anyone can refund it, and every bet, Hunch&rsquo;s opening seed included, comes back in full.
        </p>
        <p className="mt-2">Its refund transaction and every refund to every bettor will be listed here once it runs.</p>
      </EmptyState>
    );
  }
  const total = drill.refunds.reduce((sum, refund) => sum + refund.amount, 0n);
  if (drill.status === 'listed') {
    return (
      <div className="rounded-card border border-dashed border-edge-strong p-4 sm:p-5">
        <p className="text-[15px] font-semibold text-paper">
          <Link href={drill.href} className="hover:underline">
            {drill.question}
          </Link>
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Listed and taking small bets. Its closing price is read at{' '}
          <span className="num text-paper">{formatEtDateTime(drill.finalTime)}</span>, when Chainlink&rsquo;s stock prices
          do not update, so it cannot settle and anyone can refund it. The refund transaction and every refund will be
          listed here once it runs.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-card border border-edge bg-raised p-4 sm:p-5">
      <p className="text-[15px] font-semibold text-paper">
        <Link href={drill.href} className="hover:underline">
          {drill.question}
        </Link>
      </p>
      {drill.reason === null ? null : <p className="mt-2 text-sm text-muted">{DRILL_REASON[drill.reason]}</p>}
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {drill.strike === null ? null : (
          <div>
            <p className="text-[11px] text-faint">Opening price</p>
            <Round round={drill.strike} />
          </div>
        )}
        {drill.final === null ? null : (
          <div>
            <p className="text-[11px] text-faint">Closing price</p>
            <Round round={drill.final} />
          </div>
        )}
        <div>
          <p className="text-[11px] text-faint">Refund transaction</p>
          {drill.voidTxUrl === null ? (
            <span className="text-sm text-faint">Not read</span>
          ) : (
            <a href={drill.voidTxUrl} target="_blank" rel="noreferrer noopener" className="text-sm text-muted underline decoration-edge-strong underline-offset-2 hover:text-paper">
              View on Blockscout
            </a>
          )}
        </div>
      </div>
      <ul className="mt-5 divide-y divide-edge-soft border-t border-edge">
        {drill.refunds.map((refund) => (
          <li key={refund.txUrl} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
            <span className="num text-muted">
              {shortAddress(refund.owner)}
              {refund.label === undefined ? null : <span className="ml-2 font-body text-xs text-faint">{refund.label}</span>}
            </span>
            <a href={refund.txUrl} target="_blank" rel="noreferrer noopener" className="num text-paper hover:underline">
              {formatAmount(refund.amount)} USDG
            </a>
          </li>
        ))}
      </ul>
      <p className="num mt-3 text-right text-sm text-paper">
        <span className="font-body text-faint">Refunded in total </span>
        {formatAmount(total)} USDG
      </p>
    </div>
  );
}

export function FeeSweeps({ rows }: { rows: FeeSweepRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState title="No fees swept yet">
        Fees are 2% of winners&rsquo; gains. Anyone can sweep them to the treasury Safe; each sweep will be listed here
        with its transaction.
      </EmptyState>
    );
  }
  return (
    <ul className="divide-y divide-edge-soft rounded-card border border-edge bg-raised">
      {rows.map((row) => (
        <li key={row.txUrl} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm sm:px-5">
          <span className="num text-faint">{formatEtDateTime(row.at)}</span>
          <a href={row.txUrl} target="_blank" rel="noreferrer noopener" className="num text-paper hover:underline">
            {formatAmount(row.amount)} USDG
          </a>
        </li>
      ))}
    </ul>
  );
}
