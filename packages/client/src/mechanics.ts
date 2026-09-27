import type { Book, Market, OpposingBookRoom, OutcomeHeadroom } from './types.js';
import { ACC_SCALE, maxBigInt } from './units.js';

/**
 * The settler's arithmetic, restated exactly, on entities instead of storage.
 *
 * Each function here mirrors a specific piece of `VestedParimutuel`, and the
 * tests assert the mirror holds — in particular that
 * `accepted + earned == previewPayout`, which is true because
 * `floor(s*(S + dA)/S) == s + floor(s*dA/S)` for integer `s`.
 */

/** H_w = C_w - V_w, floored at 0. `null` when the book's capacity is unbounded. */
export function bookHeadroom(book: Book): bigint | null {
  if (book.capacity === null) return null;
  return maxBigInt(0n, book.capacity - book.vested);
}

/**
 * Stake already offered against `book` in the vintage that is open right now.
 *
 * A vintage is only competition if it belongs to the block a new entry would
 * land in. The settler finalizes vintages lazily: a vintage left open by an
 * earlier block is rolled by the very transaction that enters, so its demand
 * has already been rationed and does not ration against the newcomer. Reading
 * `demand` without that check would understate the room by a whole stale
 * vintage.
 */
export function competingDemand(market: Market, book: Book, headBlock: bigint): bigint {
  if (market.vintageOpen !== true) return 0n;
  if (market.vintageBlock === null || market.vintageBlock !== headBlock) return 0n;
  return book.demand ?? 0n;
}

/**
 * The room one opposing book has for a new stake.
 *
 * With demand `D` already queued in this block's vintage, an entry of `c` is
 * rationed to `floor(c*H/(D+c))` whenever `D + c > H`. That is `< c` exactly
 * when `c > H - D`, so `H - D` is the largest stake this book accepts in full.
 */
export function opposingRoom(market: Market, book: Book, headBlock: bigint): OpposingBookRoom {
  const headroom = bookHeadroom(book);
  const demand = competingDemand(market, book, headBlock);
  return {
    outcome: book.outcome,
    headroom,
    competingDemand: demand,
    allowance: headroom === null ? null : maxBigInt(0n, headroom - demand),
  };
}

/**
 * What outcome `outcome` would do with a stake right now.
 *
 * Stake on an outcome vests into every OTHER outcome's book, so every opposing
 * book has to have room for it; the tightest one decides. A market with no
 * opposing book has no counterparty and accepts nothing.
 */
export function outcomeHeadroom(market: Market, outcome: number, headBlock: bigint): OutcomeHeadroom {
  const own = market.books.find((book) => book.outcome === outcome);
  const opposing = market.books
    .filter((book) => book.outcome !== outcome)
    .map((book) => opposingRoom(market, book, headBlock));

  if (opposing.length === 0) {
    return {
      outcome,
      bookHeadroom: own === undefined ? 0n : bookHeadroom(own),
      bindingHeadroom: 0n,
      bindingOutcome: null,
      maxFullyAccepted: 0n,
      competingDemand: 0n,
      opposing,
    };
  }

  // One book binds, and every field describing it has to come from that one
  // book. The binding book is the one with the least room left after the stake
  // already queued against it, which is not always the one with the smallest
  // raw headroom: a roomier book with a long queue can be tighter than a
  // narrow empty one. Ties go to the lower outcome index so the answer is
  // stable between calls. The smallest-headroom book is still in `opposing`
  // for a caller that wants it.
  let binding: OpposingBookRoom | null = null;
  for (const room of opposing) {
    if (room.allowance === null) continue;
    if (binding === null || binding.allowance === null || room.allowance < binding.allowance) binding = room;
  }

  return {
    outcome,
    bookHeadroom: own === undefined ? 0n : bookHeadroom(own),
    bindingHeadroom: binding?.headroom ?? null,
    bindingOutcome: binding?.outcome ?? null,
    maxFullyAccepted: binding?.allowance ?? null,
    competingDemand: binding?.competingDemand ?? 0n,
    opposing,
  };
}

/**
 * Stake that has vested to a position since it entered:
 * `floor(s * (A_now - A_entry) / S)`.
 *
 * The accumulator only ever rises, so a negative delta means the index handed
 * us an entry accumulator from a later state than the book — we clamp to 0
 * rather than report a negative earning.
 */
export function earnedVesting(accepted: bigint, entryAcc: bigint, currentAcc: bigint): bigint {
  const delta = currentAcc - entryAcc;
  if (delta <= 0n || accepted <= 0n) return 0n;
  return (accepted * delta) / ACC_SCALE;
}

/**
 * What the settler pays a position whose outcome wins: principal plus what
 * vested to it. Identical to `VestedParimutuel.previewPayout`.
 */
export function payoutIfWins(accepted: bigint, entryAcc: bigint, currentAcc: bigint): bigint {
  return accepted + earnedVesting(accepted, entryAcc, currentAcc);
}

/** Sum of accepted principal across a market's books. */
export function totalPrincipal(market: Market): bigint {
  return market.books.reduce((total, book) => total + book.principal, 0n);
}
