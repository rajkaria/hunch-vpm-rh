import Link from 'next/link';

import { splitQuestion } from '@/components/market/MarketCard';
import { TickerMark } from '@/components/market/TickerMark';
import { Badge, SideWord } from '@/components/ui/primitives';
import { EXAMPLE, WORKED, exampleBet, exampleRow, multiplePpm } from '@/content/worked-example';
import { formatEtDateTime } from '@/lib/et';
import type { EarlyVsLateProof, ProofBettor, RoundRef } from '@/lib/view/types';
import { formatAmount, formatMultiple, formatPrice } from '@/lib/units';

/**
 * The worked example from docs/spec/02-mechanism.md as a proof card. Only ever shown with the
 * "Illustration" label: `EarlyVsLate` prints it for `kind: 'illustration'` unconditionally.
 */
export const ILLUSTRATION_PROOF: EarlyVsLateProof = (() => {
  const mei = exampleRow('Mei');
  const ben = exampleRow('Ben');
  const meiBet = exampleBet('Mei');
  const benBet = exampleBet('Ben');
  return {
    kind: 'illustration',
    question: EXAMPLE.question,
    ticker: EXAMPLE.ticker,
    winner: EXAMPLE.winner,
    windowLabel: 'Tuesday open to Friday close',
    strike: null,
    final: null,
    early: {
      label: mei.name,
      side: mei.side,
      entryLabel: `${meiBet.when} ET`,
      stake: mei.stake,
      payout: mei.payout,
      multiplePpm: multiplePpm(mei.payout, mei.stake),
      txUrl: null,
    },
    late: {
      label: ben.name,
      side: ben.side,
      entryLabel: `${benBet.when} ET`,
      stake: ben.stake,
      payout: ben.payout,
      multiplePpm: multiplePpm(ben.payout, ben.stake),
      txUrl: null,
    },
    classicMultiplePpm: WORKED.classicMultiplePpm,
    marketHref: null,
  };
})();

/**
 * Which market the proof card shows (docs/spec/05-web-app.md): the latest settled weekly market,
 * else the latest settled daily market, else the worked example. Never nothing, and never an
 * unlabelled example.
 */
export function selectProof(settled: { weekly: EarlyVsLateProof | null; daily: EarlyVsLateProof | null }): EarlyVsLateProof {
  return settled.weekly ?? settled.daily ?? ILLUSTRATION_PROOF;
}

function Price({ label, round }: { label: string; round: RoundRef }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="num text-lg leading-none text-paper">{formatPrice(round.answer)}</span>
        {round.url === null ? (
          <span className="num text-[11px] text-faint">round {round.roundId}</span>
        ) : (
          <a
            href={round.url}
            target="_blank"
            rel="noreferrer noopener"
            className="num text-[11px] text-faint underline decoration-edge-strong underline-offset-2 hover:text-paper"
          >
            round {round.roundId}
          </a>
        )}
      </dd>
      <p className="num mt-1 text-[11px] text-faint">{formatEtDateTime(round.at)}</p>
    </div>
  );
}

/** One winner as a tile: who, when, what they were paid, and the transaction that paid them. */
function Winner({
  role,
  bettor,
  accent,
  illustration,
}: {
  role: 'Earliest winner' | 'Latest winner';
  bettor: ProofBettor;
  accent: boolean;
  illustration: boolean;
}) {
  return (
    <div className={`flex min-w-0 flex-col rounded-control border p-3 sm:p-4 ${accent ? 'border-lime/30 bg-lime/[0.05]' : 'border-edge bg-ghost'}`}>
      <p className={`eyebrow ${accent ? '!text-lime/80' : ''}`}>{role}</p>
      <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-[15px] leading-tight font-semibold text-paper">
        <span className="min-w-0 break-hash">{bettor.label}</span>
        <SideWord side={bettor.side} className="text-xs" />
      </p>
      <p className="num mt-1 text-[11px] leading-snug text-faint">{bettor.entryLabel}</p>

      <p className="mt-4 text-[11px] text-faint">Paid</p>
      <p className={`num mt-1 text-[26px] leading-none font-medium sm:text-[30px] ${accent ? 'text-lime' : 'text-paper'}`}>{formatAmount(bettor.payout)}</p>
      <p className="num mt-2 text-xs text-muted">
        {formatMultiple(bettor.multiplePpm)} <span className="text-faint">on</span> {formatAmount(bettor.stake)}{' '}
        <span className="text-faint">USDG</span>
      </p>

      <div className="mt-auto pt-2 text-[11px]">
        {illustration ? (
          <span className="inline-flex min-h-7 items-center text-faint">Made-up bettor, no transaction</span>
        ) : bettor.txUrl === null ? (
          <span className="inline-flex min-h-7 items-center text-faint">Payout transaction pending</span>
        ) : (
          <a
            href={bettor.txUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex min-h-11 items-center text-muted underline decoration-edge-strong underline-offset-2 hover:text-paper"
          >
            Payout transaction
          </a>
        )}
      </div>
    </div>
  );
}

/** The whole argument as three bars: the early call, the late call, and what an ordinary pool pays both. */
function Multiples({ proof }: { proof: EarlyVsLateProof }) {
  const scale = [proof.early.multiplePpm, proof.late.multiplePpm, proof.classicMultiplePpm].reduce((max, value) => (value > max ? value : max), 1n);
  const width = (ppm: bigint): string => `${Math.max(4, Number((ppm * 1000n) / scale) / 10)}%`;
  const rows = [
    { label: 'Early', ppm: proof.early.multiplePpm, bar: 'bg-lime', text: 'text-lime' },
    { label: 'Late', ppm: proof.late.multiplePpm, bar: 'bg-paper/70', text: 'text-paper' },
    { label: 'Ordinary pool', ppm: proof.classicMultiplePpm, bar: 'bg-paper/25', text: 'text-muted' },
  ];
  return (
    <div className="mt-3 rounded-control border border-edge bg-ghost p-3 sm:px-4">
      <p className="eyebrow">Paid, as a multiple of stake</p>
      <dl className="mt-3 grid gap-2">
        {rows.map((row, index) => (
          <div key={row.label} className="grid grid-cols-[92px_minmax(0,1fr)_48px] items-center gap-3 text-xs">
            <dt className="text-muted">{row.label}</dt>
            <dd className="h-1.5 overflow-hidden rounded-pill bg-paper/6" aria-hidden>
              <div
                className={`h-full origin-left rounded-pill motion-safe:animate-grow ${row.bar}`}
                style={{ width: width(row.ppm), animationDelay: `${index * 90}ms` }}
              />
            </dd>
            <dd className={`num text-right ${row.text}`}>{formatMultiple(row.ppm)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The proof card, the most important component on the site: one settled market, its earliest
 * and latest winning bettors side by side, what each was paid, and what an ordinary pool would
 * have paid both of them. Drawn in the same card language as a market card: a tag row, the
 * question, an inset panel, two tiles. Every number links to its transaction; the worked
 * example, used before any market has settled, is always labelled "Illustration".
 */
export function EarlyVsLate({
  proof,
  headingLevel = 'h2',
  titleId = 'early-vs-late-title',
}: {
  proof: EarlyVsLateProof;
  headingLevel?: 'h2' | 'h3';
  /** Unique per page if the card is rendered more than once. */
  titleId?: string;
}) {
  const illustration = proof.kind === 'illustration';
  const Heading = headingLevel;
  const { title } = splitQuestion(proof.question);

  return (
    <figure
      aria-labelledby={titleId}
      className="lift relative rounded-card border border-edge bg-raised p-4 sm:p-5"
      data-kind={proof.kind}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {illustration ? (
          <span
            data-testid="illustration-label"
            className="inline-flex items-center rounded-tag border border-paper/25 bg-paper/8 px-2 py-1 text-[11px] leading-none font-semibold tracking-[0.05em] text-paper uppercase"
          >
            Illustration
          </span>
        ) : (
          <Badge tone="info">Settled {proof.kind === 'weekly' ? 'weekly' : 'daily'} market</Badge>
        )}
        <span className="text-[11px] text-faint">Early vs late, same market</span>
      </div>

      <div className="mt-3.5 flex items-start gap-3">
        <TickerMark ticker={proof.ticker} />
        <div className="min-w-0">
          <Heading id={titleId} className="font-body text-lg leading-tight font-semibold tracking-normal text-paper sm:text-xl">
            {title}
          </Heading>
          <p className="mt-1 text-sm text-muted">
            {proof.ticker} finished <SideWord side={proof.winner} /> · {proof.windowLabel}
          </p>
        </div>
      </div>

      {proof.strike !== null && proof.final !== null ? (
        <dl className="mt-4 grid grid-cols-2 gap-3 rounded-control border border-edge bg-ghost p-3">
          <Price label="Opening price" round={proof.strike} />
          <Price label="Closing price" round={proof.final} />
        </dl>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <Winner role="Earliest winner" bettor={proof.early} accent illustration={illustration} />
        <Winner role="Latest winner" bettor={proof.late} accent={false} illustration={illustration} />
      </div>

      <Multiples proof={proof} />

      <figcaption className="mt-4">
        <p className="text-sm leading-relaxed text-paper">
          In an ordinary pool both would have been paid{' '}
          <span className="num font-medium">{formatMultiple(proof.classicMultiplePpm)}</span>.
        </p>
        <p className="mt-1 text-xs leading-relaxed text-faint">
          {illustration
            ? 'Made-up bettors and the arithmetic the contract runs; a real settled market replaces this once one settles.'
            : "Both after the market's fee on winnings."}
        </p>
        <p className="text-sm">
          <Link
            href={proof.marketHref ?? '/how-it-works#worked-example'}
            className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-paper underline decoration-paper/25 underline-offset-4 hover:decoration-lime"
          >
            {proof.marketHref === null ? 'How these numbers are worked out' : 'See every bet in this market'}
          </Link>
        </p>
      </figcaption>
    </figure>
  );
}
