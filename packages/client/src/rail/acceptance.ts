import type { OpposingBookRoom } from '../types.js';

/**
 * The acceptance rule: how much of an offer the books would actually take.
 *
 * This is `VestedParimutuel._finalizeVintage` step (iii), restated on the
 * entities the index publishes:
 *
 *   for each opposing book w, with headroom H_w snapshotted at the vintage's
 *   start and total demand d_w against it (everything already offered in this
 *   block, PLUS this offer, because `enter` adds the offer to every opposing
 *   book's demand before the vintage is finalized):
 *
 *       cap_w = c                       when H_w is unbounded, or d_w <= H_w
 *       cap_w = floor(c * H_w / d_w)    otherwise
 *
 *   accepted = min over w of cap_w
 *
 * Two things about this are easy to get wrong and both are load-bearing.
 *
 * First, the minimum is taken over the RATIONED amounts, not over the
 * headrooms. The book with the least room left is not always the book that cuts
 * a given offer: against an offer of 10, a book with H=100 and 96 already
 * queued lets 9 through, while a book with H=6 and nothing queued lets only 6.
 * The first book has less room; the second is the one that binds.
 *
 * Second, headroom an offer leaves unused on one book because it was cut on
 * another is not redistributed. The settler makes a single pass, and so does
 * this.
 */

export interface BookAcceptance {
  readonly outcome: number;
  readonly headroom: bigint | null;
  /** Stake already offered against this book in the current block, excluding this offer. */
  readonly competingDemand: bigint;
  /** `headroom - competingDemand`, floored at 0: the largest offer this book takes whole. */
  readonly allowance: bigint | null;
  /** How much of this offer this book alone would let through. */
  readonly wouldAccept: bigint;
  /** True on the book that decided the answer. */
  readonly binding: boolean;
}

export interface Acceptance {
  readonly requested: bigint;
  readonly accepted: bigint;
  readonly refused: bigint;
  /** The opposing book that cut the offer, or `null` when nothing did. */
  readonly binding: BookAcceptance | null;
  /** Every opposing book, in outcome order. */
  readonly books: readonly BookAcceptance[];
  /** The largest offer that would be accepted whole. `null` when every book is unbounded. */
  readonly maxFullyAccepted: bigint | null;
}

/** What one book lets through of an offer of `amount`. */
function acceptedByBook(room: OpposingBookRoom, amount: bigint): bigint {
  if (room.headroom === null) return amount;
  // `demand` in the settler's formula is the total against this book once this
  // offer has been added to it, which is what `enter` does before the vintage
  // is finalized.
  const demand = room.competingDemand + amount;
  if (demand <= room.headroom) return amount;
  if (demand === 0n) return 0n;
  return (amount * room.headroom) / demand;
}

/**
 * Apply the rule to one outcome's opposing books.
 *
 * `rooms` is `OutcomeHeadroom.opposing` from the client's own headroom read, so
 * the headroom and the queued demand come from the same arithmetic the rest of
 * the package uses rather than from a second implementation of it.
 */
export function acceptanceOf(rooms: readonly OpposingBookRoom[], amount: bigint): Acceptance {
  if (amount <= 0n) throw new RangeError(`stake must be positive, got ${amount}`);

  // An outcome with no opposing book has no counterparty: there is nothing for
  // the stake to vest into, so nothing can be accepted.
  if (rooms.length === 0) {
    return { requested: amount, accepted: 0n, refused: amount, binding: null, books: [], maxFullyAccepted: 0n };
  }

  const ordered = [...rooms].sort((a, b) => a.outcome - b.outcome);
  const wouldAccept = ordered.map((room) => acceptedByBook(room, amount));

  let bindingIndex: number | null = null;
  let accepted = amount;
  for (const [index, taken] of wouldAccept.entries()) {
    if (taken < accepted) {
      accepted = taken;
      bindingIndex = index;
    }
  }

  const books: BookAcceptance[] = ordered.map((room, index) => ({
    outcome: room.outcome,
    headroom: room.headroom,
    competingDemand: room.competingDemand,
    allowance: room.allowance,
    wouldAccept: wouldAccept[index] ?? 0n,
    binding: index === bindingIndex,
  }));

  // The largest offer taken whole is the tightest allowance across the opposing
  // books, and is unbounded only when every one of them is.
  let maxFullyAccepted: bigint | null = null;
  for (const room of ordered) {
    if (room.allowance === null) continue;
    if (maxFullyAccepted === null || room.allowance < maxFullyAccepted) maxFullyAccepted = room.allowance;
  }

  return {
    requested: amount,
    accepted,
    refused: amount - accepted,
    binding: bindingIndex === null ? null : (books[bindingIndex] ?? null),
    books,
    maxFullyAccepted,
  };
}
