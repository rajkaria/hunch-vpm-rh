import type { ResolvedConfig } from '../config.js';
import { earnedVesting } from '../mechanics.js';
import type { Position, PositionState, VestingEarned } from '../types.js';
import { fetchPosition } from './shared.js';

function stateOf(position: Position): PositionState {
  if (position.claimed) return 'claimed';
  if (!position.finalized) return 'pending-vintage';
  const market = position.market;
  if (market.status === 'Voided') return 'voided';
  if (market.status === 'Resolved') return market.winner === position.outcome ? 'won' : 'lost';
  return 'open';
}

/**
 * What has already vested to one position.
 *
 * A position is priced by two numbers: the principal the books accepted, and
 * the accumulator of its own outcome at the moment it entered. Everything that
 * vested into that book afterwards is credited to it in proportion, which is
 * `floor(accepted * (A_now - A_entry) / S)`. Add the principal back and you
 * have what the position pays if its outcome is the one that happens — the
 * same number the settler's `previewPayout` returns.
 *
 * Before the position's vintage is finalized there is no answer to give:
 * `accepted` is not fixed until the settler rations the vintage, so `earned`
 * is `null` rather than a guess.
 */
export async function vestingEarned(config: ResolvedConfig, positionId: string): Promise<VestingEarned> {
  const { position, index } = await fetchPosition(config, positionId);
  const market = position.market;
  const book = market.books.find((candidate) => candidate.outcome === position.outcome);
  const currentAcc = book?.acc ?? 0n;
  const state = stateOf(position);

  // Nothing vests in a classic pool, so there is no accrual to report there —
  // `null` rather than a zero that would read as "nothing has vested yet". The
  // payout is still defined; it is the index's pool-share figure.
  const vests = market.settlerKind === 'vested';
  const earned = position.finalized && vests ? earnedVesting(position.accepted, position.entryAcc, currentAcc) : null;
  const payoutIfOutcomeWins = !position.finalized
    ? null
    : vests
      ? position.accepted + (earned ?? 0n)
      : position.previewPayout;
  const refused = position.finalized ? position.refused : 0n;

  let claimableNow = 0n;
  if (!position.claimed) {
    if (state === 'won' && payoutIfOutcomeWins !== null) claimableNow += payoutIfOutcomeWins;
    // A voided market refunds accepted principal exactly — no vesting is paid.
    if (state === 'voided') claimableNow += position.accepted;
  }
  if (!position.refundWithdrawn && position.finalized) claimableNow += refused;

  return {
    positionId: position.id,
    marketId: market.id,
    owner: position.owner,
    outcome: position.outcome,
    state,
    offered: position.offered,
    accepted: position.accepted,
    refused,
    refundWithdrawn: position.refundWithdrawn,
    entryAcc: position.entryAcc,
    currentAcc,
    earned,
    payoutIfOutcomeWins,
    claimableNow,
    index,
  };
}
