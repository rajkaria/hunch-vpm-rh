import { describe, expect, it } from 'vitest';

import { ACC_SCALE, PPM } from '@/lib/units';
import {
  bookHeadroom,
  capacityBar,
  classicMultiplePpm,
  classicPayout,
  earnedVesting,
  impliedProbabilityPpm,
  newEntryComparison,
  positionComparison,
  simulateEntry,
  totalPrincipal,
  vestingMultiplePpm,
  vpmPayout,
  type BookMath,
} from '@/lib/vpm';

/** USDC smallest units, written the way the fixtures write them. */
const usdc = (whole: number): bigint => BigInt(whole) * 1_000_000n;

function book(
  outcome: number,
  principal: bigint,
  vested: bigint,
  capacity: bigint | null,
  demand = 0n,
  acc = 0n,
): BookMath {
  return { outcome, principal, vested, capacity, demand, acc };
}

// ------------------------------------------------------------------ headroom

describe('bookHeadroom', () => {
  it('is capacity less what has vested in', () => {
    expect(bookHeadroom(usdc(87_000), usdc(81_000))).toBe(usdc(6_000));
  });

  it('floors at zero rather than going negative', () => {
    expect(bookHeadroom(usdc(100), usdc(140))).toBe(0n);
  });

  it('is unbounded when capacity is', () => {
    expect(bookHeadroom(null, usdc(1_000_000))).toBeNull();
  });
});

// ------------------------------------------------------------------ the bar maths

describe('capacityBar', () => {
  it('reports the consumed share, floored, as the fixtures show it', () => {
    const bar = capacityBar(usdc(87_000), usdc(81_000));
    expect(bar.unbounded).toBe(false);
    expect(bar.headroom).toBe(usdc(6_000));
    // 81000/87000 = 0.9310344..., floored to ppm.
    expect(bar.consumedPpm).toBe(931_034n);
    expect(bar.full).toBe(false);
  });

  it('always splits the track into two halves that sum to the whole', () => {
    for (const [capacity, vested] of [
      [usdc(87_000), usdc(81_000)],
      [usdc(100), 0n],
      [usdc(100), usdc(100)],
      [usdc(3), usdc(1)],
      [usdc(100), usdc(250)],
    ] as const) {
      const bar = capacityBar(capacity, vested);
      expect(bar.consumedPpm + bar.freePpm).toBe(PPM);
    }
  });

  it('clamps an over-vested book to a full bar instead of overflowing the track', () => {
    const bar = capacityBar(usdc(100), usdc(250));
    expect(bar.consumedPpm).toBe(PPM);
    expect(bar.freePpm).toBe(0n);
    expect(bar.headroom).toBe(0n);
    expect(bar.full).toBe(true);
  });

  it('treats a book with no capacity at all as full, not as empty', () => {
    const bar = capacityBar(0n, 0n);
    expect(bar.consumedPpm).toBe(PPM);
    expect(bar.full).toBe(true);
  });

  it('draws no bar for an unbounded book', () => {
    const bar = capacityBar(null, usdc(5_000));
    expect(bar.unbounded).toBe(true);
    expect(bar.headroom).toBeNull();
    expect(bar.consumedPpm).toBe(0n);
    expect(bar.freePpm).toBe(PPM);
    expect(bar.full).toBe(false);
  });
});

// ------------------------------------------------------------------ acceptance

describe('simulateEntry', () => {
  const tight: BookMath[] = [
    book(0, usdc(66_000), usdc(2_200), usdc(1_980_000)),
    book(1, usdc(2_200), usdc(51_000), usdc(66_000)),
  ];

  it('accepts in full when the opposing book has the room', () => {
    const result = simulateEntry(tight, 0, usdc(10_000));
    expect(result.accepted).toBe(usdc(10_000));
    expect(result.refused).toBe(0n);
    expect(result.bindingOutcome).toBeNull();
    expect(result.maxFullyAccepted).toBe(usdc(15_000));
  });

  it('rations against the room the opposing book has, including the offer itself', () => {
    // H = 66,000 - 51,000 = 15,000 and the offer is 20,000. The settler adds
    // the offer to the book's demand before finalizing, so the denominator is
    // 20,000 and the cap is floor(20,000 * 15,000 / 20,000) = 15,000.
    const result = simulateEntry(tight, 0, usdc(20_000));
    expect(result.accepted).toBe(usdc(15_000));
    expect(result.refused).toBe(usdc(5_000));
    expect(result.bindingOutcome).toBe(1);
  });

  it('rations alongside stake already queued in the same vintage', () => {
    const queued: BookMath[] = [tight[0]!, { ...tight[1]!, demand: usdc(5_000) }];
    // D + c = 25,000 > H = 15,000, so the cap is floor(20,000 * 15,000 / 25,000).
    const result = simulateEntry(queued, 0, usdc(20_000));
    expect(result.accepted).toBe(usdc(12_000));
    expect(result.refused).toBe(usdc(8_000));
    // Only 10,000 would have gone through in full: H - D.
    expect(result.maxFullyAccepted).toBe(usdc(10_000));
  });

  it('accepts an offer exactly equal to the headroom in full', () => {
    // The settler rations only when demand strictly exceeds the headroom.
    const result = simulateEntry(tight, 0, usdc(15_000));
    expect(result.accepted).toBe(usdc(15_000));
    expect(result.refused).toBe(0n);
  });

  it('lets the tightest opposing book bind, in one pass with no redistribution', () => {
    const threeWay: BookMath[] = [
      book(0, usdc(1_000), usdc(1_000), usdc(30_000)),
      book(1, usdc(1_000), usdc(29_500), usdc(30_000)), // H = 500
      book(2, usdc(1_000), usdc(28_000), usdc(30_000)), // H = 2,000
    ];
    const result = simulateEntry(threeWay, 0, usdc(1_000));
    // floor(1,000 * 500 / 1,000) = 500 on book 1; floor(1,000 * 2,000 / 1,000)
    // is not a cut at all on book 2. The minimum stands, and the 1,500 of room
    // book 2 keeps is not handed back round inside the vintage.
    expect(result.accepted).toBe(usdc(500));
    expect(result.bindingOutcome).toBe(1);
    expect(result.maxFullyAccepted).toBe(usdc(500));
  });

  it('ignores an unbounded opposing book and lets a bounded one decide', () => {
    const mixed: BookMath[] = [
      book(0, usdc(1_000), usdc(1_000), null),
      book(1, usdc(1_000), usdc(29_800), usdc(30_000)), // H = 200
      book(2, usdc(1_000), usdc(1_000), null),
    ];
    const result = simulateEntry(mixed, 0, usdc(1_000));
    expect(result.accepted).toBe(usdc(200));
    expect(result.bindingOutcome).toBe(1);
    expect(result.maxFullyAccepted).toBe(usdc(200));
  });

  it('refuses nothing when every opposing book is unbounded', () => {
    const unbounded: BookMath[] = [
      book(0, usdc(1_000), usdc(9_000), null),
      book(1, usdc(1_000), usdc(9_000), null),
    ];
    const result = simulateEntry(unbounded, 0, usdc(500_000));
    expect(result.accepted).toBe(usdc(500_000));
    expect(result.refused).toBe(0n);
    expect(result.maxFullyAccepted).toBeNull();
  });

  it('accepts nothing on an outcome with no counterparty', () => {
    const lonely: BookMath[] = [book(0, usdc(1_000), 0n, usdc(30_000))];
    const result = simulateEntry(lonely, 0, usdc(100));
    expect(result.accepted).toBe(0n);
    expect(result.refused).toBe(usdc(100));
    expect(result.maxFullyAccepted).toBe(0n);
  });

  it('accepts nothing into a book that is already full', () => {
    const full: BookMath[] = [
      book(0, usdc(1_000), usdc(1_000), usdc(30_000)),
      book(1, usdc(1_000), usdc(30_000), usdc(30_000)), // H = 0
    ];
    const result = simulateEntry(full, 0, usdc(1_000));
    expect(result.accepted).toBe(0n);
    expect(result.refused).toBe(usdc(1_000));
    expect(result.maxFullyAccepted).toBe(0n);
  });

  it('floors the ration rather than rounding it', () => {
    const odd: BookMath[] = [
      book(0, 1n, 0n, null),
      book(1, 1n, 7n, 10n), // H = 3
    ];
    // floor(10 * 3 / 10) = 3
    expect(simulateEntry(odd, 0, 10n).accepted).toBe(3n);
    // floor(7 * 3 / 7) = 3
    expect(simulateEntry(odd, 0, 7n).accepted).toBe(3n);
    // floor(4 * 3 / 4) = 3
    expect(simulateEntry(odd, 0, 4n).accepted).toBe(3n);
  });

  it('reports every opposing book, not only the binding one', () => {
    const result = simulateEntry(tight, 0, usdc(20_000));
    expect(result.opposing).toHaveLength(1);
    expect(result.opposing[0]).toMatchObject({ outcome: 1, headroom: usdc(15_000), demand: 0n });
  });
});

// ------------------------------------------------------------------ payouts

describe('vpmPayout', () => {
  it('is principal plus what vested to it', () => {
    expect(earnedVesting(usdc(1_000), 0n, 2n * ACC_SCALE)).toBe(usdc(2_000));
    expect(vpmPayout(usdc(1_000), 0n, 2n * ACC_SCALE)).toBe(usdc(3_000));
  });

  it('matches the settler to the unit: floor(s(S + dA)/S) == s + floor(s dA/S)', () => {
    const cases: [bigint, bigint, bigint][] = [
      [usdc(800), ACC_SCALE, 41n * ACC_SCALE],
      [1n, 0n, 3n],
      [999_999n, 7n * ACC_SCALE, 7n * ACC_SCALE + 123_456_789_012_345_678n],
      [usdc(15_000), 1_811_111_111_111_111_111n, 1_821_160_000_000_000_000n],
    ];
    for (const [accepted, entryAcc, currentAcc] of cases) {
      const direct = (accepted * (ACC_SCALE + currentAcc - entryAcc)) / ACC_SCALE;
      expect(vpmPayout(accepted, entryAcc, currentAcc)).toBe(direct);
    }
  });

  it('never reports a negative earning when the two reads disagree', () => {
    expect(earnedVesting(usdc(100), 5n * ACC_SCALE, 2n * ACC_SCALE)).toBe(0n);
    expect(vpmPayout(usdc(100), 5n * ACC_SCALE, 2n * ACC_SCALE)).toBe(usdc(100));
  });

  it('pays nothing on nothing', () => {
    expect(vpmPayout(0n, 0n, 9n * ACC_SCALE)).toBe(0n);
  });
});

describe('classicPayout', () => {
  it('is the pool in proportion to stake, floored', () => {
    expect(classicPayout(usdc(800), usdc(2_900), usdc(83_900))).toBe(23_144_827_586n);
  });

  it('pays nothing when nobody backed the winning outcome', () => {
    expect(classicPayout(usdc(100), 0n, usdc(500))).toBe(0n);
  });

  it('gives a single holder of the winning book the whole pool', () => {
    expect(classicPayout(usdc(1_000), usdc(1_000), usdc(3_000))).toBe(usdc(3_000));
  });
});

describe('multiples', () => {
  it('reads the accumulator as a multiple of the accepted principal', () => {
    expect(vestingMultiplePpm(ACC_SCALE, 41n * ACC_SCALE)).toBe(41_000_000n);
    expect(vestingMultiplePpm(0n, 0n)).toBe(1_000_000n);
  });

  it('reads the classic multiple off the book', () => {
    expect(classicMultiplePpm(usdc(2_900), usdc(83_900))).toBe(28_931_034n);
    expect(classicMultiplePpm(0n, usdc(100))).toBeNull();
  });
});

// ------------------------------------------------------------------ the comparison

describe('positionComparison', () => {
  it('states the difference between the rules as a number', () => {
    const result = positionComparison({
      accepted: usdc(800),
      entryAcc: ACC_SCALE,
      currentAcc: 41n * ACC_SCALE,
      outcomePrincipal: usdc(2_900),
      acceptedPool: usdc(83_900),
    });
    expect(result.stake).toBe(usdc(800));
    expect(result.vpm).toBe(32_800_000_000n);
    expect(result.classic).toBe(23_144_827_586n);
    expect(result.delta).toBe(9_655_172_414n);
    expect(result.vpmMultiplePpm).toBe(41_000_000n);
    expect(result.classicMultiplePpm).toBe(28_931_034n);
    expect(result.deltaOfStakePpm).toBe(12_068_965n);
  });

  it('turns the sign over for a position that arrived late', () => {
    // Almost nothing vested to it after it entered, but the classic rule still
    // hands it a share of the whole pool.
    const result = positionComparison({
      accepted: usdc(15_000),
      entryAcc: 1_811_111_111_111_111_111n,
      currentAcc: 1_821_160_000_000_000_000n,
      outcomePrincipal: usdc(81_000),
      acceptedPool: usdc(83_900),
    });
    // 15,000 of principal and floor(15,000 * 0.010048888… ) = 150.733333 vested.
    expect(result.vpm).toBe(15_150_733_333n);
    expect(result.classic).toBe(15_537_037_037n);
    expect(result.delta).toBeLessThan(0n);
    expect(result.deltaOfStakePpm).toBeLessThan(0n);
  });

  it('agrees with the classic rule when one position is the whole winning book', () => {
    const result = positionComparison({
      accepted: usdc(1_000),
      entryAcc: 0n,
      currentAcc: 2n * ACC_SCALE,
      outcomePrincipal: usdc(1_000),
      acceptedPool: usdc(3_000),
    });
    expect(result.vpm).toBe(usdc(3_000));
    expect(result.classic).toBe(usdc(3_000));
    expect(result.delta).toBe(0n);
  });

  it('has no multiple to report for an empty stake', () => {
    const result = positionComparison({
      accepted: 0n,
      entryAcc: 0n,
      currentAcc: ACC_SCALE,
      outcomePrincipal: usdc(10),
      acceptedPool: usdc(20),
    });
    expect(result.vpmMultiplePpm).toBeNull();
    expect(result.classicMultiplePpm).toBeNull();
    expect(result.deltaOfStakePpm).toBeNull();
  });
});

describe('newEntryComparison', () => {
  const books: BookMath[] = [
    book(0, usdc(81_000), usdc(2_900), usdc(2_430_000)),
    book(1, usdc(2_900), usdc(81_000), usdc(87_000)),
  ];

  it('gives a late stake its money back under the vested rule and a multiple under the classic one', () => {
    const result = newEntryComparison(books, 0, usdc(10_000));

    expect(result.acceptance.accepted).toBe(usdc(6_000));
    expect(result.acceptance.refused).toBe(usdc(4_000));

    // Accepted principal back plus the refund: exactly the offer. Nothing
    // vests to a stake that has nothing arriving behind it.
    expect(result.vpmReturnedIfWins).toBe(usdc(10_000));
    expect(result.classicReturnedIfWins).toBe(10_318_681_318n);

    expect(result.comparison.stake).toBe(usdc(10_000));
    expect(result.comparison.delta).toBe(-318_681_318n);
    expect(result.comparison.deltaOfStakePpm).toBe(-31_868n);
  });

  it('prices what the classic rule takes from the incumbents to pay for it', () => {
    const result = newEntryComparison(books, 0, usdc(10_000));
    expect(result.incumbentMultipleBeforePpm).toBe(1_035_802n);
    expect(result.incumbentClassicMultipleAfterPpm).toBe(1_031_868n);
    // The incumbents' multiple can only fall under the classic rule.
    expect(result.incumbentClassicMultipleAfterPpm!).toBeLessThan(result.incumbentMultipleBeforePpm!);
  });

  it('handles a zero offer without dividing by it', () => {
    const result = newEntryComparison(books, 0, 0n);
    expect(result.acceptance.accepted).toBe(0n);
    expect(result.comparison.vpmMultiplePpm).toBeNull();
    expect(result.comparison.delta).toBe(0n);
  });
});

describe('implied probability', () => {
  it('is that outcome\'s share of accepted principal, floored', () => {
    const books: BookMath[] = [
      book(0, usdc(81_000), usdc(2_900), usdc(2_430_000)),
      book(1, usdc(2_900), usdc(81_000), usdc(87_000)),
    ];
    const pool = totalPrincipal(books);
    expect(pool).toBe(usdc(83_900));
    expect(impliedProbabilityPpm(usdc(81_000), pool)).toBe(965_435n);
    expect(impliedProbabilityPpm(usdc(2_900), pool)).toBe(34_564n);
    // Flooring leaves the outcomes summing to just under 1e6. That gap is the
    // rounding, not a margin anybody takes.
    expect(965_435n + 34_564n).toBeLessThan(PPM);
    expect(PPM - (965_435n + 34_564n)).toBeLessThanOrEqual(2n);
  });
});
