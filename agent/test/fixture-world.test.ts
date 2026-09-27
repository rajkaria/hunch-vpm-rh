/**
 * The in-memory settler model, checked against the rules it claims to implement.
 *
 * These are not a substitute for the Foundry tests on `VestedParimutuel`. They are the
 * guard that the fixture the agent is developed against behaves like the contract in the
 * ways the policy depends on.
 */

import { describe, expect, it } from "vitest";
import { KAPPA_UNBOUNDED } from "../src/domain/types.js";
import { formatUsdc, parseUsdc } from "../src/domain/units.js";
import { CROWD, FixtureWorld } from "../src/research/fixture-world.js";
import { DEFAULT_FIXTURE_PATH, loadFixtureWorld, parseFixtureWorld } from "../src/research/fixtures.js";
import { NOW, USDC, ZERO } from "./helpers.js";

const AGENT = "0xa9e47a9e47a9e47a9e47a9e47a9e47a9e47a9e47" as const;

function world(options: { capacity?: string; flow?: string } = {}): FixtureWorld {
  const principal = parseUsdc("1000");
  const capacity = options.capacity === undefined ? 30n * principal : parseUsdc(options.capacity);
  return new FixtureWorld([
    {
      marketId: "m",
      onChainMarketId: 0n,
      question: "q",
      settler: ZERO,
      token: USDC,
      kappa: 30n,
      openedAt: NOW - 3600,
      resolutionTime: NOW + 86_400,
      spec: { feedKey: "TESTUSD", strike8: 100_00000000n, direction: 0, maxStaleness: 3600 },
      status: "open",
      winner: undefined,
      intel: { price8: 110_00000000n, volAnnualised: 0.4, driftPerTick: 0, source: "test" },
      flowPerTick: parseUsdc(options.flow ?? "0"),
      books: [
        { outcome: 0, label: "yes", principal, acc: 0n, capacity, vested: 0n, holders: 1, trust: 0.5 },
        { outcome: 1, label: "no", principal, acc: 0n, capacity, vested: 0n, holders: 1, trust: 0.5 },
      ],
    },
  ]);
}

describe("rule 1: a stake vests into the opposing books on arrival", () => {
  it("moves the opposing book's accumulator, not its own", () => {
    const w = world();
    w.enter("m", 0, parseUsdc("100"), AGENT);
    const m = w.snapshot(w.list()[0]!);
    expect(formatUsdc(m.books[1]!.vested)).toBe("100.00");
    expect(formatUsdc(m.books[0]!.vested)).toBe("0.00");
    // and the entering book gained the principal
    expect(formatUsdc(m.books[0]!.principal)).toBe("1100.00");
  });

  it("pays an earlier position out of a later one", () => {
    const w = world();
    const early = w.enter("m", 0, parseUsdc("100"), AGENT).position;
    expect(w.vestingEarned(early.positionId)).toBe(0n);

    w.enter("m", 1, parseUsdc("500"), CROWD);
    // 500 vested into book 0, whose principal was 1100 at the time: 500/1100 per unit.
    const earned = w.vestingEarned(early.positionId);
    expect(Number(earned) / Number(parseUsdc("100"))).toBeCloseTo(500 / 1100, 4);
  });

  it("pays nothing to a position from stake in its own book", () => {
    const w = world();
    const first = w.enter("m", 0, parseUsdc("100"), AGENT).position;
    w.enter("m", 0, parseUsdc("900"), CROWD);
    expect(w.vestingEarned(first.positionId)).toBe(0n);
  });

  it("pays early money more than late money — the whole point of the mechanism", () => {
    const w = world();
    const early = w.enter("m", 0, parseUsdc("100"), AGENT).position;
    w.enter("m", 1, parseUsdc("400"), CROWD);
    const late = w.enter("m", 0, parseUsdc("100"), AGENT).position;
    w.enter("m", 1, parseUsdc("400"), CROWD);

    const earlyEarned = w.vestingEarned(early.positionId);
    const lateEarned = w.vestingEarned(late.positionId);
    expect(earlyEarned > lateEarned).toBe(true);
    // The late entry earned only from the flow that came after it.
    expect(lateEarned > 0n).toBe(true);
  });
});

describe("rule 2: acceptance is capped by the opposing books' headroom", () => {
  it("accepts in full when there is room", () => {
    const w = world();
    const { position, refused } = w.enter("m", 0, parseUsdc("100"), AGENT);
    expect(formatUsdc(position.accepted)).toBe("100.00");
    expect(refused).toBe(0n);
  });

  it("refuses the remainder rather than failing the call", () => {
    // capacity 1200 on each book, so book 1 can absorb 1200 of vesting and no more.
    const w = world({ capacity: "1200" });
    const { position, refused } = w.enter("m", 0, parseUsdc("5000"), AGENT);
    expect(formatUsdc(position.accepted)).toBe("1200.00");
    expect(formatUsdc(refused)).toBe("3800.00");
    expect(formatUsdc(position.offered)).toBe("5000.00");
  });

  it("accepts nothing once the opposing book is full, and keeps the offer whole", () => {
    const w = world({ capacity: "1000" });
    w.enter("m", 0, parseUsdc("1000"), CROWD);
    expect(FixtureWorld.headroom(w.list()[0]!.books[1]!)).toBe(0n);
    const { position, refused } = w.enter("m", 0, parseUsdc("50"), AGENT);
    expect(position.accepted).toBe(0n);
    expect(formatUsdc(refused)).toBe("50.00");
  });

  it("never runs out of room when kappa is unbounded", () => {
    const w = world();
    const market = w.list()[0]!;
    for (const b of market.books) b.capacity = KAPPA_UNBOUNDED;
    market.kappa = KAPPA_UNBOUNDED;
    const { position } = w.enter("m", 0, parseUsdc("1000000"), AGENT);
    expect(formatUsdc(position.accepted)).toBe("1000000.00");
  });
});

describe("settlement", () => {
  it("resolves the way FeedResolver would and pays principal plus what vested in", () => {
    const w = world();
    const mine = w.enter("m", 0, parseUsdc("100"), AGENT).position;
    w.enter("m", 1, parseUsdc("1100"), CROWD);

    expect(w.settleDue(NOW)).toEqual([]);
    expect(w.settleDue(NOW + 86_400)).toEqual(["m"]);
    // price8 110 >= strike 100, direction 0, so outcome 0 wins.
    expect(w.list()[0]!.winner).toBe(0);

    const payout = w.payout(mine.positionId);
    expect(payout).toBe(mine.accepted + w.vestingEarned(mine.positionId));
    expect(payout > mine.accepted).toBe(true);
  });

  it("pays a losing position nothing", () => {
    const w = world();
    const losing = w.enter("m", 1, parseUsdc("100"), AGENT).position;
    w.settleDue(NOW + 86_400);
    expect(w.list()[0]!.winner).toBe(0);
    expect(w.payout(losing.positionId)).toBe(0n);
  });

  it("lists a claim once, and not after it is claimed", () => {
    const w = world();
    w.enter("m", 0, parseUsdc("100"), AGENT);
    w.enter("m", 1, parseUsdc("100"), CROWD);
    w.settleDue(NOW + 86_400);
    const first = w.claimable(AGENT);
    expect(first).toHaveLength(1);
    w.markClaimed(first[0]!.positionId);
    expect(w.claimable(AGENT)).toHaveLength(0);
  });
});

describe("background flow", () => {
  it("splits arrivals across the books in proportion to accepted principal", () => {
    const w = world({ flow: "1000" });
    w.tick();
    const m = w.snapshot(w.list()[0]!);
    // Symmetric books, so a symmetric split: each book received 500 of vesting.
    expect(formatUsdc(m.books[0]!.vested)).toBe("500.00");
    expect(formatUsdc(m.books[1]!.vested)).toBe("500.00");
  });

  it("does nothing to a settled market", () => {
    const w = world({ flow: "1000" });
    w.settleDue(NOW + 86_400);
    w.tick();
    expect(w.snapshot(w.list()[0]!).books[0]!.vested).toBe(0n);
  });
});

describe("the shipped fixtures", () => {
  it("load and describe six markets", () => {
    const w = loadFixtureWorld(NOW, DEFAULT_FIXTURE_PATH);
    expect(w.list()).toHaveLength(6);
    for (const m of w.list()) {
      expect(m.books.length).toBeGreaterThanOrEqual(2);
      expect(m.resolutionTime).toBeGreaterThan(m.openedAt);
      for (const b of m.books) expect(b.principal > 0n).toBe(true);
    }
  });

  it("keeps its times relative, so the fixtures never expire", () => {
    const early = loadFixtureWorld(1_000_000_000, DEFAULT_FIXTURE_PATH).list()[0]!;
    const late = loadFixtureWorld(2_000_000_000, DEFAULT_FIXTURE_PATH).list()[0]!;
    expect(late.resolutionTime - late.openedAt).toBe(early.resolutionTime - early.openedAt);
    expect(late.resolutionTime - early.resolutionTime).toBe(1_000_000_000);
  });

  it("names the field it cannot read", () => {
    expect(() => parseFixtureWorld({ markets: [{ id: "x" }] }, NOW)).toThrow(
      /fixtures\.markets\[0\]\.kappa: missing/,
    );
    expect(() => parseFixtureWorld({}, NOW)).toThrow(/markets: missing/);
  });
});
