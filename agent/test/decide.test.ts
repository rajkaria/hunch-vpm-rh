/**
 * The decision procedure, step by step.
 *
 * Each test names the step it is about, so a change that moves a number has to say which
 * rule it is changing.
 */

import { describe, expect, it } from "vitest";
import { KAPPA_UNBOUNDED } from "../src/domain/types.js";
import { formatUsdc, parseUsdc, scaleByFraction } from "../src/domain/units.js";
import { DEFAULT_POLICY, withOverrides } from "../src/policy/config.js";
import { acceptanceHeadroom, counterpartyTrust, decide, impliedOddsFromBooks } from "../src/policy/decide.js";
import { NOW, estimate, market } from "./helpers.js";

const BANKROLL = parseUsdc("1000");

/** A market the agent should want: a cheap book, plenty of room, trusted counterparties. */
function goodMarket(): ReturnType<typeof market> {
  return market({
    books: [
      { label: "yes", principal: "4200", vested: "6100", trust: 0.68 },
      { label: "no", principal: "5800", vested: "4900", trust: 0.71 },
    ],
    freezeInSeconds: 86_400,
    openedSecondsAgo: 7_200,
  });
}

function run(m: ReturnType<typeof market>, probs: readonly number[], overrides = {}) {
  return decide({
    market: m,
    estimate: estimate(...probs),
    bankroll: BANKROLL,
    now: NOW,
    policy: withOverrides(DEFAULT_POLICY, overrides),
  });
}

describe("step 1-2: the market has to be open and unfrozen", () => {
  it("abstains on a resolved market", () => {
    const decision = run(market({ books: goodMarket().books.map(toSpec), status: "resolved" }), [0.9, 0.1]);
    expect(decision.action).toBe("abstain");
    expect(decision.reason).toBe("market-not-open");
  });

  it("abstains once the freeze has passed, because `enter` reverts Frozen()", () => {
    const decision = run(market({ books: goodMarket().books.map(toSpec), freezeInSeconds: -1 }), [0.9, 0.1]);
    expect(decision.action).toBe("abstain");
    expect(decision.reason).toBe("frozen");
  });
});

describe("step 3: the freeze window", () => {
  it("refuses to enter inside the last N seconds however large the edge", () => {
    const m = market({ books: goodMarket().books.map(toSpec), freezeInSeconds: 300 });
    const decision = run(m, [0.99, 0.01]);
    expect(decision.action).toBe("abstain");
    expect(decision.reason).toBe("inside-freeze-window");
    expect(decision.secondsToFreeze).toBe(300);
  });

  it("enters the same market with the same edge once the window is clear", () => {
    const m = market({ books: goodMarket().books.map(toSpec), freezeInSeconds: 7_200 });
    const decision = run(m, [0.99, 0.01]);
    expect(decision.action).toBe("enter");
  });

  it("sits exactly on the boundary: freezeBufferSeconds is the first accepted value", () => {
    const books = goodMarket().books.map(toSpec);
    const inside = run(market({ books, freezeInSeconds: DEFAULT_POLICY.freezeBufferSeconds - 1 }), [0.9, 0.1]);
    const outside = run(market({ books, freezeInSeconds: DEFAULT_POLICY.freezeBufferSeconds }), [0.9, 0.1]);
    expect(inside.reason).toBe("inside-freeze-window");
    expect(outside.action).toBe("enter");
  });
});

describe("step 4: a real share of the arrival window must remain", () => {
  it("refuses when almost none of the arrival window is left, even outside the hard buffer", () => {
    // A market that ran for a year and freezes in twenty minutes: past the hard buffer,
    // but there is no future inflow left to vest into the position.
    const m = market({
      books: goodMarket().books.map(toSpec),
      openedSecondsAgo: 365 * 24 * 3600,
      freezeInSeconds: 1_200,
    });
    const decision = run(m, [0.99, 0.01]);
    expect(decision.reason).toBe("vesting-outlook-too-low");
  });
});

describe("step 5: no estimate means no trade", () => {
  it("abstains rather than guessing", () => {
    const decision = decide({
      market: goodMarket(),
      estimate: undefined,
      bankroll: BANKROLL,
      now: NOW,
      policy: DEFAULT_POLICY,
    });
    expect(decision.reason).toBe("no-estimate");
  });
});

describe("step 6: the bankroll must cover a minimum ticket", () => {
  it("abstains when the bankroll cannot cover the minimum ticket", () => {
    const decision = decide({
      market: goodMarket(),
      estimate: estimate(0.95, 0.05),
      bankroll: parseUsdc("0.5"),
      now: NOW,
      policy: DEFAULT_POLICY,
    });
    expect(decision.reason).toBe("bankroll-exhausted");
  });
});

describe("step 7: headroom, per outcome", () => {
  it("refuses to enter when the opposing book has no room", () => {
    const m = market({
      books: [
        { label: "yes", principal: "700", vested: "21000", capacity: "21000", trust: 0.6 },
        { label: "no", principal: "700", vested: "21000", capacity: "21000", trust: 0.6 },
      ],
    });
    const decision = run(m, [0.95, 0.05]);
    expect(decision.action).toBe("abstain");
    expect(decision.reason).toBe("no-headroom");
    expect(decision.candidates.every((c) => c.rejection === "no-headroom")).toBe(true);
  });

  it("takes the tightest opposing book, not the average", () => {
    const m = market({
      books: [
        { label: "a", principal: "1000", vested: "0", trust: 0.5 },
        { label: "b", principal: "1000", vested: "29900", trust: 0.5 },
        { label: "c", principal: "1000", vested: "0", trust: 0.5 },
      ],
    });
    const { headroom, unbounded } = acceptanceHeadroom(m.books, 0);
    expect(unbounded).toBe(false);
    // book b: capacity 30 * 1000 = 30000, vested 29900, so 100 left — and that is the cap.
    expect(formatUsdc(headroom)).toBe("100.00");
  });

  it("reports unbounded headroom when kappa is unbounded", () => {
    const m = market({
      kappa: KAPPA_UNBOUNDED,
      books: [
        { label: "a", principal: "1000", vested: "5000", trust: 0.5 },
        { label: "b", principal: "1000", vested: "5000", trust: 0.5 },
      ],
    });
    expect(acceptanceHeadroom(m.books, 0)).toEqual({ headroom: KAPPA_UNBOUNDED, unbounded: true });
  });

  it("still enters the outcome whose OWN book is full, as long as the others have room", () => {
    // Vesting flows into the opposing books, so a full book on the outcome being entered
    // is not an obstacle. Getting this backwards would make the agent refuse good trades.
    const m = market({
      books: [
        { label: "yes", principal: "1000", vested: "30000", capacity: "30000", trust: 0.7 },
        { label: "no", principal: "1000", vested: "0", trust: 0.7 },
      ],
    });
    const decision = run(m, [0.95, 0.05]);
    expect(decision.action).toBe("enter");
    expect(decision.outcome).toBe(0);
  });
});

describe("step 8: implied odds, edge and counterparty trust", () => {
  it("reads implied odds off accepted principal", () => {
    const odds = impliedOddsFromBooks(goodMarket().books);
    expect(odds[0]).toBeCloseTo(0.42, 6);
    expect(odds[1]).toBeCloseTo(0.58, 6);
  });

  it("weights by the trust of the books it is trading against, not its own", () => {
    const m = market({
      books: [
        { label: "yes", principal: "1000", vested: "0", trust: 0.1 },
        { label: "no", principal: "1000", vested: "0", trust: 0.9 },
      ],
    });
    expect(counterpartyTrust(m.books, 0, 0)).toBeCloseTo(0.9, 6);
    expect(counterpartyTrust(m.books, 1, 0)).toBeCloseTo(0.1, 6);
  });

  it("weights by principal, so a large anonymous book counts for more than a dust one", () => {
    const m = market({
      books: [
        { label: "target", principal: "1", vested: "0", trust: 1 },
        { label: "big-anon", principal: "9000", vested: "0", trust: 0 },
        { label: "small-trusted", principal: "1000", vested: "0", trust: 1 },
      ],
    });
    expect(counterpartyTrust(m.books, 0, 0)).toBeCloseTo(0.1, 6);
  });

  it("discounts the edge against an unproven book below the threshold", () => {
    // Same books, same estimate: only the counterparties' ERC-8004 history differs.
    const anonymous = market({
      books: [
        { label: "yes", principal: "2500", vested: "1900", trust: 0 },
        { label: "no", principal: "500", vested: "2400", trust: 0 },
      ],
      freezeInSeconds: 172_800,
    });
    const known = market({
      books: [
        { label: "yes", principal: "2500", vested: "1900", trust: 0.8 },
        { label: "no", principal: "500", vested: "2400", trust: 0.8 },
      ],
      freezeInSeconds: 172_800,
    });
    // 88.8% own view against an 83.3% book: a 5.5-point raw edge either way.
    const thin = run(anonymous, [0.888, 0.112]);
    const solid = run(known, [0.888, 0.112]);

    expect(thin.action).toBe("abstain");
    expect(thin.reason).toBe("edge-below-threshold");
    expect(solid.action).toBe("enter");
    expect(solid.outcome).toBe(0);
  });

  it("takes a source's opposing trust as given rather than flipping it a second time", () => {
    // The indexer answers "who is against me if I take o" directly. Deriving from per-book
    // holder trust on top of that would hand each outcome its OWN side's reputation, which
    // is the opposite of the rule. Book trust here is deliberately the wrong answer.
    const m = market({
      books: [
        { label: "yes", principal: "1000", vested: "0", trust: 0.1 },
        { label: "no", principal: "1000", vested: "0", trust: 0.9 },
      ],
      opposingTrust: [0.3, 0.8],
    });
    expect(counterpartyTrust(m.books, 0, 0, m.opposingTrust?.[0])).toBeCloseTo(0.3, 9);
    expect(counterpartyTrust(m.books, 1, 0, m.opposingTrust?.[1])).toBeCloseTo(0.8, 9);

    const decision = run(m, [0.95, 0.05]);
    expect(decision.candidates[0]?.counterpartyTrust).toBeCloseTo(0.3, 9);
    expect(decision.candidates[1]?.counterpartyTrust).toBeCloseTo(0.8, 9);
  });

  it("floors a supplied figure the same way it floors a derived one", () => {
    const m = market({
      books: [
        { label: "yes", principal: "4200", vested: "0", trust: 0.9 },
        { label: "no", principal: "5800", vested: "0", trust: 0.9 },
      ],
      opposingTrust: [0, 0],
    });
    const decision = run(m, [0.95, 0.05]);
    expect(decision.candidates[0]?.counterpartyTrust).toBeCloseTo(DEFAULT_POLICY.trustFloor, 9);
  });

  it("floors trust so an all-anonymous market is tradeable on a large enough edge", () => {
    const anonymous = market({
      books: [
        { label: "yes", principal: "4200", vested: "0", trust: 0 },
        { label: "no", principal: "5800", vested: "0", trust: 0 },
      ],
    });
    const decision = run(anonymous, [0.95, 0.05]);
    expect(decision.action).toBe("enter");
    expect(decision.candidates[0]?.counterpartyTrust).toBeCloseTo(DEFAULT_POLICY.trustFloor, 6);
  });

  it("never enters on a negative edge", () => {
    const decision = run(goodMarket(), [0.2, 0.8]);
    // 20% own view against a 42% book on yes; 80% against 58% on no. Only `no` has an edge.
    expect(decision.action).toBe("enter");
    expect(decision.outcome).toBe(1);
    expect(decision.candidates[0]?.rejection).toBe("edge-below-threshold");
  });
});

describe("step 9-10: sizing, then choosing between the survivors", () => {
  it("sizes to a fraction of the visible headroom, never all of it", () => {
    const m = market({
      books: [
        { label: "yes", principal: "4200", vested: "6100", trust: 0.7 },
        { label: "no", principal: "5800", vested: "173990", trust: 0.7 },
      ],
    });
    const decision = run(m, [0.95, 0.05]);
    const headroom = decision.candidates[0]?.acceptanceHeadroom ?? 0n;
    expect(formatUsdc(headroom)).toBe("10.00");
    expect(decision.stake).toBe(scaleByFraction(headroom, DEFAULT_POLICY.headroomUtilisation));
  });

  it("abstains when the room left is smaller than a worthwhile ticket", () => {
    const m = market({
      books: [
        { label: "yes", principal: "4200", vested: "6100", trust: 0.7 },
        { label: "no", principal: "5800", vested: "173999.9", trust: 0.7 },
      ],
    });
    const decision = run(m, [0.95, 0.05]);
    expect(decision.reason).toBe("below-min-ticket");
  });

  it("never stakes more than the single-ticket cap or the bankroll", () => {
    const decision = decide({
      market: goodMarket(),
      estimate: estimate(0.99, 0.01),
      bankroll: parseUsdc("1000000"),
      now: NOW,
      policy: DEFAULT_POLICY,
    });
    expect(decision.stake).toBe(DEFAULT_POLICY.maxTicket);
  });

  it("scales the stake down as the arrival window runs out", () => {
    const books = goodMarket().books.map(toSpec);
    const early = run(market({ books, openedSecondsAgo: 60, freezeInSeconds: 86_400 }), [0.9, 0.1]);
    const later = run(market({ books, openedSecondsAgo: 40_000, freezeInSeconds: 20_000 }), [0.9, 0.1]);
    expect(early.action).toBe("enter");
    expect(later.action).toBe("enter");
    expect((later.stake ?? 0n) < (early.stake ?? 0n)).toBe(true);
  });

  it("scales the stake with conviction", () => {
    const thin = run(goodMarket(), [0.52, 0.48]);
    const thick = run(goodMarket(), [0.95, 0.05]);
    expect(thin.action).toBe("enter");
    expect((thin.stake ?? 0n) < (thick.stake ?? 0n)).toBe(true);
  });

  it("breaks an exact tie on the roomier book, deterministically", () => {
    // Equal principal and equal trust make the two edges identical, so the tie-break is
    // the only thing choosing. Entering outcome 1 vests into book a, which has twice the
    // room, so outcome 1 is the one that can be filled whole.
    const m = market({
      books: [
        { label: "a", principal: "1000", vested: "20000", trust: 0.5 },
        { label: "b", principal: "1000", vested: "25000", trust: 0.5 },
      ],
    });
    const first = run(m, [0.6, 0.6]);
    const second = run(m, [0.6, 0.6]);
    expect(first.candidates[0]?.effectiveEdge).toBe(first.candidates[1]?.effectiveEdge);
    expect(first.outcome).toBe(1);
    expect(second.outcome).toBe(1);
  });

  it("reports every outcome it considered, whatever it decided", () => {
    const decision = run(goodMarket(), [0.9, 0.1]);
    expect(decision.candidates).toHaveLength(2);
    for (const c of decision.candidates) {
      expect(c.rawEdge).toBeCloseTo(c.ownProbability - c.impliedProbability, 9);
      expect(c.effectiveEdge).toBeCloseTo(c.rawEdge * c.counterpartyTrust, 9);
    }
  });

  it("is a pure function of its inputs", () => {
    const m = goodMarket();
    const a = run(m, [0.9, 0.1]);
    const b = run(m, [0.9, 0.1]);
    expect(b).toEqual(a);
  });
});

function toSpec(book: ReturnType<typeof market>["books"][number]) {
  return {
    label: book.label,
    principal: formatUsdc(book.principal),
    vested: formatUsdc(book.vested),
    capacity: formatUsdc(book.capacity),
    trust: book.trust,
  };
}
