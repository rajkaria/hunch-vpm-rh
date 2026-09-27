import Link from 'next/link';

import { Amount, Badge, EmptyState, Stat } from '@/components/ui/primitives';
import { awaitingVintage } from '@/lib/data/position-wire';
import type { MarketDetail, OutcomeTone, PositionView } from '@/lib/data/types';
import { formatUtc } from '@/lib/time';
import { formatMultiple } from '@/lib/units';
import { classicMultiplePpm, classicPayout, earnedVesting, vestingMultiplePpm, vpmPayout } from '@/lib/vpm';

const TONE_TEXT: Record<OutcomeTone, string> = {
  up: 'text-lime',
  down: 'text-coral',
  neutral: 'text-paper',
};

/**
 * What the wallet holds here, and what it is worth if the market settled the
 * way it currently stands.
 *
 * "If it resolved right now" is stated as a conditional every time it appears.
 * A payout column with no condition attached reads as a balance, and this one
 * is not: it is what `claim` would pay if this outcome turned out to be the
 * one that happened.
 */
export function PositionPanel({ market }: { market: MarketDetail }) {
  if (market.positions.length === 0) {
    return (
      <EmptyState title="You hold nothing in this market.">
        A position is opened by calling <span className="num">enter</span> on the settler with an outcome and an
        amount. What the books accept is fixed when the block&rsquo;s vintage is finalized, and anything they
        could not cover comes straight back.
      </EmptyState>
    );
  }

  return (
    <div className="divide-y divide-edge">
      {market.positions.map((position) => (
        <PositionRow key={position.id} market={market} position={position} />
      ))}
    </div>
  );
}

function PositionRow({ market, position }: { market: MarketDetail; position: PositionView }) {
  const book = market.outcomes[position.outcome];
  const acc = book?.acc ?? 0n;
  const principal = book?.principal ?? 0n;
  // Two settlers, two payout rules, and the panel has to quote the one this
  // market actually runs. A classic book carries A_w = 0 and every position
  // entryAcc = 0, so `vpmPayout` there degenerates to the accepted principal —
  // it would render a number that looks like a payout and is not one.
  const classic = market.settlerKind === 'classic';
  const earned = classic ? 0n : earnedVesting(position.accepted, position.entryAcc, acc);
  const payoutIfWins = classic
    ? classicPayout(position.accepted, principal, market.acceptedPool)
    : vpmPayout(position.accepted, position.entryAcc, acc);
  const multiple = classic
    ? classicMultiplePpm(principal, market.acceptedPool)
    : vestingMultiplePpm(position.entryAcc, acc);

  const won = market.status === 'Resolved' && market.winner === position.outcome;
  const lost = market.status === 'Resolved' && market.winner !== position.outcome;
  const voided = market.status === 'Voided';
  // Buffered: its accepted and refused read as zero because nothing is decided
  // yet, not because the books took nothing. Say that instead of the zeros.
  const awaiting = awaitingVintage(position);

  const claimable = position.claimed
    ? 0n
    : won
      ? payoutIfWins
      : voided
        ? position.accepted
        : 0n;
  const refundable = position.refundWithdrawn ? 0n : position.refused;

  return (
    <div className="px-4 py-5 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={`font-display text-base ${TONE_TEXT[book?.tone ?? 'neutral']}`}>
          {book?.label ?? `Outcome ${position.outcome}`}
        </span>
        <span className="num text-xs text-faint">#{position.positionId.toString()}</span>
        {position.vintage === 0n ? <Badge tone="quiet">Seed leg</Badge> : null}
        {awaiting ? <Badge tone="note">Vintage open</Badge> : null}
        {won ? <Badge tone="up">Won</Badge> : null}
        {lost ? <Badge tone="down">Lost</Badge> : null}
        {voided ? <Badge tone="quiet">Voided</Badge> : null}
        <span className="num ml-auto text-xs text-muted">entered {formatUtc(position.enteredAt)}</span>
      </div>

      {/* Two columns, not four. This panel lives in a narrow rail on wide
          screens, and four columns of tabular numbers there either clip or
          collide. */}
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5">
        <Stat label="Offered">
          <Amount value={position.offered} />
        </Stat>
        <Stat label="Accepted" hint={awaiting ? 'decided when the vintage closes' : undefined}>
          {awaiting ? <span className="num text-muted">pending</span> : <Amount value={position.accepted} />}
        </Stat>
        <Stat
          label="Refused"
          hint={
            awaiting
              ? 'refundable at once, if any'
              : position.refused === 0n
                ? undefined
                : position.refundWithdrawn
                  ? 'already pulled back'
                  : 'refundable now'
          }
        >
          {awaiting ? (
            <span className="num text-muted">pending</span>
          ) : (
            <Amount value={position.refused} className={position.refused > 0n ? '' : 'text-muted'} />
          )}
        </Stat>
        {awaiting ? (
          <Stat label="Vested to it" hint="starts once the books accept it">
            <span className="num text-muted">—</span>
          </Stat>
        ) : classic ? (
          <Stat label="Pool multiple" hint="The whole pool over this outcome’s principal. Every later stake cuts it.">
            <span className="num text-muted">{formatMultiple(multiple)}</span>
          </Stat>
        ) : (
          <Stat label="Vested to it" hint={`${formatMultiple(multiple)} on the accepted principal`}>
            <Amount value={earned} className={earned > 0n ? 'text-lime' : 'text-muted'} />
          </Stat>
        )}
      </dl>

      <div className="mt-5 flex flex-wrap items-end justify-between gap-4 border-t border-edge pt-4">
        {awaiting ? (
          <div>
            <p className="text-xs uppercase tracking-[0.12em] text-faint">In, awaiting the books</p>
            <p className="mt-1.5 text-2xl leading-none">
              <Amount value={position.offered} />
              <span className="ml-2 text-sm text-muted">USDC</span>
            </p>
            <p className="mt-2 max-w-md text-xs leading-relaxed text-muted">
              The full amount has left the wallet and sits with the settler. Entries landing in the
              same block are rationed together when that block&rsquo;s vintage closes; until then
              none of it is accepted, refused or earning.
            </p>
          </div>
        ) : (
        <div>
          <p className="text-xs uppercase tracking-[0.12em] text-faint">
            {market.status === 'Open' ? 'If this outcome wins' : won ? 'Settlement' : voided ? 'Refund' : 'Settled at'}
          </p>
          <p className="mt-1.5 text-2xl leading-none">
            <Amount value={lost ? 0n : payoutIfWins} />
            <span className="ml-2 text-sm text-muted">USDC</span>
          </p>
          {market.status === 'Open' ? (
            <p className="mt-2 max-w-md text-xs leading-relaxed text-muted">
              {classic
                ? 'A share of the whole pool in proportion to stake, whenever that stake arrived. Nothing vests here: every stake that enters after you on this outcome takes a share of the same pool, and this number falls.'
                : 'Accepted principal plus what has vested to it so far. Anything that enters after you adds to this; nothing that entered before you can take from it.'}
            </p>
          ) : null}
        </div>
        )}

        {claimable + refundable > 0n ? (
          <Link
            href="/claim"
            className="border border-lime px-4 py-2.5 text-sm font-semibold text-lime transition-colors hover:bg-lime hover:text-ink"
          >
            <Amount value={claimable + refundable} /> ready to pull
          </Link>
        ) : null}
      </div>
    </div>
  );
}
