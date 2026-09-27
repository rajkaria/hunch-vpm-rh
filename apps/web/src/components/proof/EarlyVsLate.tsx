import Link from 'next/link';

import { SideWord } from '@/components/ui/primitives';
import { TickerMark } from '@/components/market/TickerMark';
import { EXAMPLE, WORKED, exampleBet, exampleRow, multiplePpm } from '@/content/worked-example';
import { formatEtDateTime } from '@/lib/et';
import type { EarlyVsLateProof, ProofBettor, RoundRef } from '@/lib/live/types';
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
        <span className="num text-[15px] text-paper">{formatPrice(round.answer)}</span>
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

function Column({
  role,
  bettor,
  classicPpm,
  scalePpm,
  accent,
  illustration,
}: {
  role: 'Earliest winner' | 'Latest winner';
  bettor: ProofBettor;
  classicPpm: bigint;
  scalePpm: bigint;
  accent: boolean;
  illustration: boolean;
}) {
  const width = (ppm: bigint): string => `${Math.max(4, Number((ppm * 1000n) / (scalePpm === 0n ? 1n : scalePpm)) / 10)}%`;
  return (
    <div className="min-w-0 rounded-control border border-edge bg-ghost p-3 sm:p-4">
      <p className="eyebrow">{role}</p>
      <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-[15px] font-semibold text-paper">
        <span className="min-w-0 break-hash">{bettor.label}</span>
        <SideWord side={bettor.side} className="text-xs" />
      </p>
      <p className="num mt-1 text-[11px] leading-snug text-faint">{bettor.entryLabel}</p>

      <dl className="mt-4 grid gap-3">
        <div>
          <dt className="text-[11px] text-faint">Staked</dt>
          <dd className="num mt-0.5 text-sm text-muted">
            {formatAmount(bettor.stake)} <span className="text-faint">USDG</span>
          </dd>
        </div>
        <div>
          <dt className="text-[11px] text-faint">Paid</dt>
          <dd className={`num mt-0.5 text-[26px] leading-none font-medium sm:text-[30px] ${accent ? 'text-lime' : 'text-paper'}`}>
            {formatAmount(bettor.payout)}
          </dd>
          <dd className="num mt-1.5 text-xs text-muted">
            {formatMultiple(bettor.multiplePpm)} <span className="text-faint">of stake</span>
          </dd>
        </div>
      </dl>

      <div className="mt-4 grid gap-1.5" aria-hidden>
        <div className="h-1 overflow-hidden rounded-pill bg-paper/6">
          <div
            className={`h-full origin-left rounded-pill motion-safe:animate-grow ${accent ? 'bg-lime' : 'bg-paper/70'}`}
            style={{ width: width(bettor.multiplePpm) }}
          />
        </div>
        <div className="h-1 overflow-hidden rounded-pill bg-paper/6">
          <div
            className="h-full origin-left rounded-pill bg-paper/25 motion-safe:animate-grow [animation-delay:120ms]"
            style={{ width: width(classicPpm) }}
          />
        </div>
      </div>

      <div className="mt-3 min-h-5 text-[11px]">
        {illustration ? (
          <span className="text-faint">No transaction: made-up bettor</span>
        ) : bettor.txUrl === null ? (
          <span className="text-faint">Payout transaction pending</span>
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

/**
 * The proof card, the most important component on the site: one settled market, its earliest
 * and latest winning bettors side by side, what each was paid, and what an ordinary pool would
 * have paid both of them. Every number links to its transaction; the worked example, used before
 * any market has settled, is always labelled "Illustration".
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
  const scale = [proof.early.multiplePpm, proof.late.multiplePpm, proof.classicMultiplePpm].reduce(
    (max, value) => (value > max ? value : max),
    1n,
  );

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
          <span className="inline-flex items-center rounded-tag border border-edge bg-paper/4 px-2 py-1 text-[11px] leading-none font-semibold tracking-[0.05em] text-muted uppercase">
            Settled {proof.kind === 'weekly' ? 'weekly' : 'daily'} market
          </span>
        )}
        <span className="text-[11px] text-faint">Early vs late, same market</span>
      </div>

      <div className="mt-4 flex items-start gap-3">
        <TickerMark ticker={proof.ticker} />
        <div className="min-w-0">
          <Heading id={titleId} className="font-body text-base leading-snug font-semibold tracking-normal text-paper">
            {proof.question}
          </Heading>
          <p className="mt-1 text-sm text-muted">
            {proof.ticker} finished <SideWord side={proof.winner} /> · {proof.windowLabel}
          </p>
        </div>
      </div>

      {proof.strike !== null && proof.final !== null ? (
        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-edge pt-4">
          <Price label="Opening price" round={proof.strike} />
          <Price label="Closing price" round={proof.final} />
        </dl>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:gap-3">
        <Column
          role="Earliest winner"
          bettor={proof.early}
          classicPpm={proof.classicMultiplePpm}
          scalePpm={scale}
          accent
          illustration={illustration}
        />
        <Column
          role="Latest winner"
          bettor={proof.late}
          classicPpm={proof.classicMultiplePpm}
          scalePpm={scale}
          accent={false}
          illustration={illustration}
        />
      </div>

      <figcaption className="mt-4 border-t border-edge pt-4">
        <p className="text-sm leading-relaxed text-paper">
          In an ordinary pool both would have been paid{' '}
          <span className="num font-medium">{formatMultiple(proof.classicMultiplePpm)}</span>.
        </p>
        <p className="mt-1 text-xs leading-relaxed text-faint">
          Bars: this market (top) against an ordinary pool (bottom), as a multiple of stake.
          {illustration
            ? ' Made-up bettors and the arithmetic the contract runs; a real settled market replaces this once one settles.'
            : null}
        </p>
        <p className="mt-1 text-sm">
          {proof.marketHref === null ? (
            <Link href="/how-it-works#worked-example" className="inline-flex min-h-11 items-center font-semibold text-paper underline decoration-paper/25 underline-offset-4 hover:decoration-lime">
              How these numbers are worked out
            </Link>
          ) : (
            <Link href={proof.marketHref} className="inline-flex min-h-11 items-center font-semibold text-paper underline decoration-paper/25 underline-offset-4 hover:decoration-lime">
              See every bet in this market
            </Link>
          )}
        </p>
      </figcaption>
    </figure>
  );
}
