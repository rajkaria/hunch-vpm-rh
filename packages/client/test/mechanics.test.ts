import { describe, expect, it } from 'vitest';
import { bookHeadroom, competingDemand, earnedVesting, outcomeHeadroom, payoutIfWins } from '../src/mechanics.js';
import type { Book, Market } from '../src/types.js';
import { ACC_SCALE } from '../src/units.js';

function book(partial: Partial<Book> & { outcome: number }): Book {
  return {
    principal: 0n,
    vested: 0n,
    capacity: null,
    acc: 0n,
    demand: null,
    ...partial,
  };
}

function market(books: Book[], partial: Partial<Market> = {}): Market {
  return {
    id: 'm',
    settler: '0x1111111111111111111111111111111111111111',
    settlerKind: 'vested',
    marketId: 0n,
    token: '0x3600000000000000000000000000000000000000',
    creator: '0x2222222222222222222222222222222222222222',
    opener: null,
    resolver: '0x3333333333333333333333333333333333333333',
    residueOwner: '0x2222222222222222222222222222222222222222',
    outcomeCount: books.length,
    kappa: 30n,
    createdAt: 1_999_395_200n,
    resolutionTime: 2_000_000_000n,
    voidTimeout: 86_400n,
    status: 'Open',
    winner: null,
    acceptedPool: 0n,
    paidOut: 0n,
    residue: 0n,
    residueClaimed: false,
    resolvedPrice: null,
    priceUpdatedAt: null,
    voidedStaleAge: null,
    vintageOpen: null,
    vintageBlock: null,
    books,
    spec: null,
    ...partial,
  };
}

describe('bookHeadroom', () => {
  it('is capacity minus vested', () => {
    expect(bookHeadroom(book({ outcome: 0, capacity: 180_000000n, vested: 101_000000n }))).toBe(79_000000n);
  });

  it('floors at zero when a book is already covered past its capacity', () => {
    expect(bookHeadroom(book({ outcome: 0, capacity: 2_000000n, vested: 3_000000n }))).toBe(0n);
  });

  it('is null when capacity is unbounded', () => {
    expect(bookHeadroom(book({ outcome: 0, capacity: null, vested: 5n }))).toBeNull();
  });
});

describe('competingDemand', () => {
  const b = book({ outcome: 1, demand: 50_000000n });

  it('counts demand only while the vintage belongs to the current block', () => {
    const open = market([b], { vintageOpen: true, vintageBlock: 1000n });
    expect(competingDemand(open, b, 1000n)).toBe(50_000000n);
  });

  it('ignores a vintage left open by an earlier block, which a new entry rolls first', () => {
    const stale = market([b], { vintageOpen: true, vintageBlock: 999n });
    expect(competingDemand(stale, b, 1000n)).toBe(0n);
  });

  it('ignores demand when no vintage is open', () => {
    const closed = market([b], { vintageOpen: false, vintageBlock: 0n });
    expect(competingDemand(closed, b, 1000n)).toBe(0n);
  });
});

describe('outcomeHeadroom', () => {
  it('is bound by the OPPOSING book, not the outcome you stake on', () => {
    const m = market([
      book({ outcome: 0, capacity: 180_000000n, vested: 101_000000n }),
      book({ outcome: 1, capacity: 3_030_000000n, vested: 6_000000n }),
    ]);
    const zero = outcomeHeadroom(m, 0, 1000n);
    expect(zero.bookHeadroom).toBe(79_000000n);
    expect(zero.bindingHeadroom).toBe(3_024_000000n);
    expect(zero.bindingOutcome).toBe(1);
  });

  it('takes the tightest of several opposing books', () => {
    const m = market([
      book({ outcome: 0, capacity: 100n, vested: 0n }),
      book({ outcome: 1, capacity: 60n, vested: 10n }),
      book({ outcome: 2, capacity: 80n, vested: 0n }),
    ]);
    const zero = outcomeHeadroom(m, 0, 1000n);
    expect(zero.bindingHeadroom).toBe(50n);
    expect(zero.bindingOutcome).toBe(1);
    expect(zero.maxFullyAccepted).toBe(50n);
  });

  it('subtracts demand already queued in this block', () => {
    const m = market(
      [
        book({ outcome: 0, capacity: 180_000000n, vested: 101_000000n, demand: 50_000000n }),
        book({ outcome: 1, capacity: 3_030_000000n, vested: 6_000000n, demand: 0n }),
      ],
      { vintageOpen: true, vintageBlock: 1000n },
    );
    const one = outcomeHeadroom(m, 1, 1000n);
    expect(one.bindingHeadroom).toBe(79_000000n);
    expect(one.competingDemand).toBe(50_000000n);
    expect(one.maxFullyAccepted).toBe(29_000000n);
  });

  it('names the book that actually binds, not the one with the smallest headroom', () => {
    // Book 1 has more room than book 2 but a queue against it that book 2 does
    // not have, so book 2 is what a stake on outcome 0 is rationed against. All
    // three fields describing the binding book have to name the same book, or
    // `bindingHeadroom - competingDemand` does not reconstruct
    // `maxFullyAccepted` and the answer cannot be audited.
    const m = market(
      [
        book({ outcome: 0, capacity: 1000n, vested: 0n, demand: 0n }),
        book({ outcome: 1, capacity: 100n, vested: 0n, demand: 90n }),
        book({ outcome: 2, capacity: 50n, vested: 0n, demand: 0n }),
      ],
      { vintageOpen: true, vintageBlock: 1000n },
    );
    const zero = outcomeHeadroom(m, 0, 1000n);

    expect(zero.maxFullyAccepted).toBe(10n);
    expect(zero.bindingOutcome).toBe(1);
    expect(zero.bindingHeadroom).toBe(100n);
    expect(zero.competingDemand).toBe(90n);
    expect((zero.bindingHeadroom ?? 0n) - zero.competingDemand).toBe(zero.maxFullyAccepted);
    // The book with the least raw room is still there to be found.
    expect(zero.opposing.map((room) => room.headroom)).toEqual([100n, 50n]);
  });

  it('reports nothing accepted when there is no opposing book to vest into', () => {
    const m = market([book({ outcome: 0, capacity: 100n })]);
    expect(outcomeHeadroom(m, 0, 1000n).maxFullyAccepted).toBe(0n);
  });
});

describe('earnedVesting and payoutIfWins', () => {
  const cases: { accepted: bigint; entryAcc: bigint; currentAcc: bigint }[] = [
    { accepted: 5_000000n, entryAcc: ACC_SCALE, currentAcc: 17_666666666666666666n },
    { accepted: 1_000000n, entryAcc: 0n, currentAcc: 17_666666666666666666n },
    { accepted: 1_000000n, entryAcc: 0n, currentAcc: 6n * ACC_SCALE },
    { accepted: 100_000000n, entryAcc: 6n * ACC_SCALE, currentAcc: 6n * ACC_SCALE },
    { accepted: 1n, entryAcc: 0n, currentAcc: 1n },
    { accepted: 123_456789n, entryAcc: 7n, currentAcc: 999_999_999_999_999_999n },
  ];

  it('matches the settler: floor(s*(S + dA)/S) == s + floor(s*dA/S)', () => {
    for (const { accepted, entryAcc, currentAcc } of cases) {
      const settlerFormula = (accepted * (ACC_SCALE + currentAcc - entryAcc)) / ACC_SCALE;
      expect(payoutIfWins(accepted, entryAcc, currentAcc)).toBe(settlerFormula);
    }
  });

  it('earns the accrual only', () => {
    expect(earnedVesting(5_000000n, ACC_SCALE, 17_666666666666666666n)).toBe(83_333333n);
    expect(payoutIfWins(5_000000n, ACC_SCALE, 17_666666666666666666n)).toBe(88_333333n);
  });

  it('is zero when nothing has vested since entry', () => {
    expect(earnedVesting(100_000000n, 6n * ACC_SCALE, 6n * ACC_SCALE)).toBe(0n);
  });

  it('clamps rather than reporting a negative earning on an inconsistent read', () => {
    expect(earnedVesting(100n, 5n * ACC_SCALE, ACC_SCALE)).toBe(0n);
  });

  it('is zero for a position the books accepted nothing of', () => {
    expect(earnedVesting(0n, 0n, 99n * ACC_SCALE)).toBe(0n);
  });
});
