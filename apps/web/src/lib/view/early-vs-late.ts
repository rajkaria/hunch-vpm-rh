/**
 * The landing page's proof card from a real settled market: its earliest and its latest winning
 * bets (never the opening seed), what each staked and was paid, and what an ordinary pool would
 * have paid the same winners. Pure, so it is tested on a real-shaped market.
 */

import { MARKET_STATUS, UP, formatEtDate, type MarketDetail, type PositionView } from '@hunch-rh/client';

import { formatEtDayTime } from '@/lib/et';
import { shortAddress } from '@/lib/units';
import type { ActivityData } from '@/lib/server/logs';

import type { EarlyVsLateProof, ProofBettor, RoundRef } from './types';

const PPM = 1_000_000n;

export function feedRoundUrl(explorer: string, feed: string): string {
  return `${explorer.replace(/\/$/, '')}/address/${feed}?tab=read_contract`;
}

export function txLink(explorer: string, hash: string | null | undefined): string | null {
  return hash === null || hash === undefined ? null : `${explorer.replace(/\/$/, '')}/tx/${hash}`;
}

/** The settlement amount a winner was (or will be) sent, net of the fee. */
function paidOf(p: PositionView): bigint {
  return p.claimed ? (p.paidOut ?? 0n) : p.settlement.net;
}

function bettor(p: PositionView, order: number, activity: ActivityData | null, explorer: string): ProofBettor {
  const id = p.id.toString();
  const entry = activity?.entries[id];
  const claims = activity?.claims[id] ?? [];
  const payoutTx = [...claims].reverse().find((c) => c.payout > 0n)?.txHash ?? null;
  const stake = p.accepted ?? 0n;
  const payout = paidOf(p);
  return {
    label: p.isOpener ? 'Hunch operator' : shortAddress(p.owner),
    side: p.side,
    entryLabel: entry === undefined ? `Bet ${order} in entry order` : formatEtDayTime(entry.timestamp),
    stake,
    payout,
    multiplePpm: stake === 0n ? 0n : (payout * PPM) / stake,
    txUrl: txLink(explorer, payoutTx),
    entryTxUrl: txLink(explorer, entry?.txHash),
  };
}

/**
 * The ordinary pool's multiple for every winner, `pool / winning principal`, after the same fee
 * on winnings this market charges, in ppm (floored).
 */
export function classicMultipleAfterFee(pool: bigint, winningPrincipal: bigint, feeBps: number): bigint {
  if (winningPrincipal === 0n) return PPM;
  const gross = (pool * PPM) / winningPrincipal;
  if (gross <= PPM) return gross;
  return gross - ((gross - PPM) * BigInt(feeBps)) / 10_000n;
}

export function earlyVsLateFrom(
  m: MarketDetail,
  activity: ActivityData | null,
  kind: 'weekly' | 'daily',
  explorer: string,
): EarlyVsLateProof | null {
  if (m.statusCode !== MARKET_STATUS.Resolved || m.winner === null) return null;
  const winnerSide = m.winner === UP ? 'UP' : 'DOWN';
  const bets = m.positions.filter((p) => !p.isSeed).sort((a, b) => (a.id < b.id ? -1 : 1));
  const winners = bets.filter((p) => p.side === winnerSide && (p.accepted ?? 0n) > 0n);
  const first = winners[0];
  const last = winners[winners.length - 1];
  if (first === undefined || last === undefined) return null;

  const rounds = m.resolution?.rounds.ok === true ? m.resolution.rounds : null;
  const ref = (round: { roundId: bigint; answer: bigint; updatedAt: bigint } | undefined): RoundRef | null =>
    round === undefined ? null : { answer: round.answer, roundId: round.roundId.toString(), at: Number(round.updatedAt), url: feedRoundUrl(explorer, m.feed) };
  const winningBook = m.books[m.winner === UP ? 0 : 1];

  return {
    kind,
    question: m.question,
    ticker: m.ticker,
    winner: winnerSide,
    windowLabel: kind === 'weekly' ? `${formatEtDate(m.strikeTime)} to ${formatEtDate(m.finalTime)}` : formatEtDate(m.strikeTime),
    strike: ref(rounds?.strike.round),
    final: ref(rounds?.final.round),
    early: bettor(first, bets.indexOf(first) + 1, activity, explorer),
    late: bettor(last, bets.indexOf(last) + 1, activity, explorer),
    classicMultiplePpm: classicMultipleAfterFee(m.totals.pool, winningBook.principal, m.feeBps),
    marketHref: `/m/${m.id.toString()}`,
  };
}
