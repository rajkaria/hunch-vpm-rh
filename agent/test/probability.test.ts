import { describe, expect, it } from "vitest";
import { SECONDS_PER_YEAR, digitalAbove, erf, normalCdf } from "../src/domain/probability.js";
import { estimateFromFeed } from "../src/intel/estimate.js";
import { market } from "./helpers.js";

describe("normalCdf", () => {
  it("matches the table to the accuracy the approximation claims", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1)).toBeCloseTo(0.8413447, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.1586553, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021, 6);
    expect(normalCdf(-2.5758)).toBeCloseTo(0.005, 5);
  });

  it("is symmetric and monotone", () => {
    for (const x of [0.1, 0.5, 1, 2, 3]) {
      expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 6);
    }
    let previous = 0;
    for (let x = -4; x <= 4; x += 0.25) {
      const value = normalCdf(x);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("erf is odd", () => {
    expect(erf(0)).toBeCloseTo(0, 7);
    expect(erf(0.7) + erf(-0.7)).toBeCloseTo(0, 7);
  });
});

describe("digitalAbove", () => {
  const base = { spot: 100, strike: 100, volAnnualised: 0.5, years: 1 / 365 };

  it("is near even money at the strike with little time left", () => {
    expect(digitalAbove(base)).toBeGreaterThan(0.45);
    expect(digitalAbove(base)).toBeLessThan(0.5);
  });

  it("rises with spot and falls with the strike", () => {
    expect(digitalAbove({ ...base, spot: 110 })).toBeGreaterThan(digitalAbove(base));
    expect(digitalAbove({ ...base, strike: 110 })).toBeLessThan(digitalAbove(base));
  });

  it("collapses to the already-decided answer with no time or no volatility", () => {
    expect(digitalAbove({ ...base, years: 0, spot: 101 })).toBe(1);
    expect(digitalAbove({ ...base, years: 0, spot: 99 })).toBe(0);
    expect(digitalAbove({ ...base, volAnnualised: 0, spot: 101 })).toBe(1);
    // The strike itself counts as above, matching FeedResolver.winnerFor.
    expect(digitalAbove({ ...base, years: 0, spot: 100 })).toBe(1);
  });

  it("stays a probability for absurd inputs", () => {
    for (const years of [0, 1e-9, 1, 100]) {
      for (const vol of [0, 0.01, 5]) {
        const p = digitalAbove({ spot: 100, strike: 50, volAnnualised: vol, years });
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
    expect(digitalAbove({ ...base, spot: 0 })).toBe(0.5);
  });

  it("uses a whole year the way the constant says", () => {
    expect(SECONDS_PER_YEAR).toBeCloseTo(31_557_600, 0);
  });
});

describe("estimateFromFeed", () => {
  const now = 1_800_000_000;

  function binary(direction: 0 | 1, freezeInSeconds = 86_400) {
    const m = market({
      books: [
        { label: "above", principal: "1000", vested: "0", trust: 0.5 },
        { label: "below", principal: "1000", vested: "0", trust: 0.5 },
      ],
      freezeInSeconds,
      now,
    });
    return { ...m, spec: { ...m.spec, direction } };
  }

  const quote = { price8: 110_00000000n, volAnnualised: 0.4, observedAt: now, source: "test" };

  it("maps direction 0 so outcome 0 wins above the strike", () => {
    const e = estimateFromFeed(binary(0), quote, now);
    expect(e).toBeDefined();
    expect(e?.probabilities[0]).toBeGreaterThan(0.5);
    expect((e?.probabilities[0] ?? 0) + (e?.probabilities[1] ?? 0)).toBeCloseTo(1, 9);
  });

  it("maps direction 1 the other way round, on the same reading", () => {
    const above = estimateFromFeed(binary(0), quote, now);
    const below = estimateFromFeed(binary(1), quote, now);
    expect(below?.probabilities[0]).toBeCloseTo(above?.probabilities[1] ?? 0, 9);
  });

  it("refuses a reading older than the market's own staleness bound", () => {
    const m = binary(0);
    const stale = { ...quote, observedAt: now - m.spec.maxStaleness - 1 };
    expect(estimateFromFeed(m, stale, now)).toBeUndefined();
    expect(estimateFromFeed(m, { ...quote, observedAt: now - m.spec.maxStaleness }, now)).toBeDefined();
  });

  it("refuses an n-way market rather than inventing a uniform prior", () => {
    const m = market({
      books: [
        { label: "low", principal: "1000", vested: "0", trust: 0.5 },
        { label: "mid", principal: "1000", vested: "0", trust: 0.5 },
        { label: "high", principal: "1000", vested: "0", trust: 0.5 },
      ],
      now,
    });
    expect(estimateFromFeed(m, quote, now)).toBeUndefined();
  });

  it("records what the estimate was based on", () => {
    const e = estimateFromFeed(binary(0), quote, now);
    expect(e?.basis).toContain("test");
    expect(e?.observedAt).toBe(now);
  });
});
