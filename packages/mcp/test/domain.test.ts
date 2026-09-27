import { describe, expect, it } from "vitest";

import { acceptanceOf, bestOutcomeToStake, capacityToAccept, oddsFromBooks, type BookState } from "../src/domain.js";
import { UNBOUNDED } from "../src/format.js";
import { MARKET, USDC } from "./fixtures.js";

const books = MARKET.books;

describe("capacityToAccept", () => {
  it("is the smallest OPPOSING headroom, not the outcome's own", () => {
    // YES has 29,900 of headroom of its own, but stake on YES vests into NO, which has 2,000.
    expect(capacityToAccept(books, 0)).toEqual({ amount: 2_000n * USDC, limitedBy: 1 });
    expect(capacityToAccept(books, 1)).toEqual({ amount: 29_900n * USDC, limitedBy: 0 });
  });

  it("takes the minimum across every opposing book in an n-way market", () => {
    const threeWay: BookState[] = [
      book(0, 500n, 0n),
      book(1, 500n, 900n),
      book(2, 500n, 40n),
    ];
    expect(capacityToAccept(threeWay, 0)).toEqual({ amount: 40n * USDC, limitedBy: 2 });
  });

  it("is unbounded when every opposing book is", () => {
    const unbounded: BookState[] = [
      { index: 0, label: "A", principal: USDC, vested: 0n, capacity: UNBOUNDED, headroom: UNBOUNDED },
      { index: 1, label: "B", principal: USDC, vested: 0n, capacity: UNBOUNDED, headroom: UNBOUNDED },
    ];
    expect(capacityToAccept(unbounded, 0)).toEqual({ amount: UNBOUNDED, limitedBy: undefined });
  });
});

describe("acceptanceOf", () => {
  it("accepts a stake that fits, in full", () => {
    const result = acceptanceOf(books, 0, 500n * USDC);
    expect(result.accepted).toBe(500n * USDC);
    expect(result.refused).toBe(0n);
    expect(result.limitedBy).toBeUndefined();
  });

  it("splits a stake that does not fit into accepted and refused", () => {
    const result = acceptanceOf(books, 0, 2_500n * USDC);
    expect(result.accepted).toBe(2_000n * USDC);
    expect(result.refused).toBe(500n * USDC);
    expect(result.limitedBy).toBe(1);
  });

  it("refuses the whole stake when the opposing book is saturated", () => {
    const saturated: BookState[] = [books[0] as BookState, { ...(books[1] as BookState), headroom: 0n }];
    const result = acceptanceOf(saturated, 0, 100n * USDC);
    expect(result.accepted).toBe(0n);
    expect(result.refused).toBe(100n * USDC);
  });

  it("never reports more accepted than offered when headroom is plentiful", () => {
    const result = acceptanceOf(books, 1, 10n * USDC);
    expect(result.accepted).toBe(10n * USDC);
  });
});

describe("odds and best headroom", () => {
  it("derives implied probability from accepted principal", () => {
    const rows = oddsFromBooks(books);
    expect(rows[0]?.impliedProbability).toBeCloseTo(1_000 / 1_100, 6);
    expect(rows[1]?.impliedProbability).toBeCloseTo(100 / 1_100, 6);
  });

  it("reports zero probabilities rather than dividing by an empty pool", () => {
    const empty: BookState[] = [book(0, 0n, 0n), book(1, 0n, 0n)];
    expect(oddsFromBooks(empty).every((row) => row.impliedProbability === 0)).toBe(true);
  });

  it("picks the outcome a stake can put the most money on, not the biggest book", () => {
    // YES holds the larger headroom, but a stake on YES is rationed by NO's 2,000. The
    // outcome you can actually put money on is NO.
    const best = bestOutcomeToStake(books);
    expect(best).toEqual({ index: 1, label: "NO", acceptsUpTo: 29_900n * USDC });
    expect(bestOutcomeToStake([])).toBeUndefined();
  });
});

function book(index: number, principal: bigint, headroom: bigint): BookState {
  return {
    index,
    label: `outcome ${index}`,
    principal: principal * USDC,
    vested: 0n,
    capacity: headroom * USDC,
    headroom: headroom * USDC,
  };
}
