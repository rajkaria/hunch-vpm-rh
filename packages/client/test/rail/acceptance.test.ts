import { describe, expect, it } from 'vitest';
import { acceptanceOf } from '../../src/rail/acceptance.js';
import type { OpposingBookRoom } from '../../src/types.js';

/** An opposing book, with the allowance the client derives from it. */
function room(outcome: number, headroom: bigint | null, competingDemand = 0n): OpposingBookRoom {
  return {
    outcome,
    headroom,
    competingDemand,
    allowance: headroom === null ? null : (headroom - competingDemand > 0n ? headroom - competingDemand : 0n),
  };
}

describe('acceptanceOf', () => {
  it('takes the whole offer when the binding book has room for it', () => {
    const answer = acceptanceOf([room(1, 14_000000n)], 10_000000n);
    expect(answer.accepted).toBe(10_000000n);
    expect(answer.refused).toBe(0n);
    expect(answer.binding).toBeNull();
    expect(answer.maxFullyAccepted).toBe(14_000000n);
  });

  it('rations an offer larger than the headroom, and reports the remainder', () => {
    // 20 offered against 14 of room and nothing queued: the settler's rule is
    // floor(c*H/(D+c)) = floor(20*14/20) = 14.
    const answer = acceptanceOf([room(0, 14_000000n)], 20_000000n);
    expect(answer.accepted).toBe(14_000000n);
    expect(answer.refused).toBe(6_000000n);
    expect(answer.binding?.outcome).toBe(0);
    expect(answer.binding?.wouldAccept).toBe(14_000000n);
  });

  it('shares the headroom with stake already queued in the same block', () => {
    // 1 of room, 2 already offered against it, 1 more offered now: three units
    // of demand chase one unit of room, so this offer gets a third of it.
    const answer = acceptanceOf([room(1, 1_000000n, 2_000000n)], 1_000000n);
    expect(answer.accepted).toBe(333333n);
    expect(answer.refused).toBe(666667n);
    expect(answer.binding?.competingDemand).toBe(2_000000n);
    // Nothing at all is taken whole while that queue stands.
    expect(answer.maxFullyAccepted).toBe(0n);
  });

  it('accepts nothing against a book with no headroom left', () => {
    const answer = acceptanceOf([room(1, 0n)], 5_000000n);
    expect(answer.accepted).toBe(0n);
    expect(answer.refused).toBe(5_000000n);
    expect(answer.binding?.outcome).toBe(1);
  });

  it('takes everything when every opposing book is unbounded', () => {
    const answer = acceptanceOf([room(1, null), room(2, null)], 10_000000n);
    expect(answer.accepted).toBe(10_000000n);
    expect(answer.maxFullyAccepted).toBeNull();
    expect(answer.binding).toBeNull();
  });

  it('is limited by the tightest opposing book, not the first', () => {
    const answer = acceptanceOf([room(1, null), room(2, 4_000000n), room(3, 9_000000n)], 10_000000n);
    // floor(10*4/10) = 4 on book 2, floor(10*9/10) = 9 on book 3.
    expect(answer.accepted).toBe(4_000000n);
    expect(answer.binding?.outcome).toBe(2);
    expect(answer.books.map((book) => book.wouldAccept)).toEqual([10_000000n, 4_000000n, 9_000000n]);
  });

  it('binds on the book that cuts THIS offer, not the one with the least room', () => {
    // Book 1 has 4 of allowance left and book 2 has 6, so book 1 is the tighter
    // book in the abstract. Against an offer of 10 it still lets 9 through,
    // because the 96 already queued against it dilutes everyone equally, while
    // book 2 cuts the offer to 6. The book that decides depends on the amount.
    const answer = acceptanceOf([room(1, 100n, 96n), room(2, 6n)], 10n);
    expect(answer.books.map((book) => book.wouldAccept)).toEqual([9n, 6n]);
    expect(answer.accepted).toBe(6n);
    expect(answer.binding?.outcome).toBe(2);
    // The largest offer taken WHOLE is still decided by the tightest allowance.
    expect(answer.maxFullyAccepted).toBe(4n);
  });

  it('does not redistribute headroom an offer leaves unused on another book', () => {
    // The settler makes a single pass: being cut to 6 on book 2 does not send
    // the unused room on book 1 back to this offer.
    const answer = acceptanceOf([room(1, 100n, 96n), room(2, 6n)], 10n);
    expect(answer.accepted).toBe(6n);
    expect(answer.books[0]?.wouldAccept).toBe(9n);
  });

  it('accepts nothing on an outcome with no opposing book', () => {
    const answer = acceptanceOf([], 5_000000n);
    expect(answer.accepted).toBe(0n);
    expect(answer.refused).toBe(5_000000n);
    expect(answer.maxFullyAccepted).toBe(0n);
    expect(answer.books).toEqual([]);
  });

  it('conserves the offer: accepted plus refused is what was asked for', () => {
    for (const amount of [1n, 7n, 999_999n, 1_000000n, 13_333_333n, 10n ** 18n]) {
      const answer = acceptanceOf([room(1, 3_000000n, 500000n), room(2, 7_000000n)], amount);
      expect(answer.accepted + answer.refused).toBe(amount);
      expect(answer.accepted).toBeLessThanOrEqual(amount);
    }
  });

  it('refuses to quote a non-positive offer rather than reporting zero', () => {
    expect(() => acceptanceOf([room(1, 10n)], 0n)).toThrow(RangeError);
    expect(() => acceptanceOf([room(1, 10n)], -1n)).toThrow(RangeError);
  });
});
