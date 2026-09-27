import { describe, expect, it } from "vitest";

import { marketBookTool } from "../src/tools/market-book.js";
import { CLASSIC_SETTLER, fakeVenue, makeDeps, MARKET, NOW, RESOLUTION_TIME, USDC } from "./fixtures.js";

const deps = makeDeps();

interface Outcome {
  index: number;
  label: string;
  acceptsStakeUpTo: { usdc: string };
  headroom: { usdc: string };
  impliedProbabilityDisplay: string;
}

describe("vpm_market_book", () => {
  it("describes the book, the freeze and the acceptance ceiling", async () => {
    const payload = await marketBookTool.run({ marketId: "7" }, deps);

    expect(payload.summary).toContain("Will ETH close above $4,000");
    expect(payload.summary).toContain("Open, freezes in 1h 46m");
    expect(payload.summary).toContain("Accepted pool 1100 USDC");

    const market = payload.data["market"] as { status: string; kappa: string; frozen: boolean; settlerKind: string };
    expect(market).toMatchObject({ status: "open", kappa: "30", frozen: false, settlerKind: "vested" });

    const outcomes = payload.data["outcomes"] as Outcome[];
    // Stake on YES vests into NO, so YES is capped by NO's 2,000 of headroom.
    expect(outcomes[0]).toMatchObject({ label: "YES", headroom: { usdc: "29900" }, acceptsStakeUpTo: { usdc: "2000" } });
    expect(outcomes[1]).toMatchObject({ label: "NO", acceptsStakeUpTo: { usdc: "29900" } });
    expect(outcomes[0]?.impliedProbabilityDisplay).toBe("90.9%");
  });

  it("accepts a numeric market id as readily as a string one", async () => {
    const payload = await marketBookTool.run({ marketId: 7 }, deps);
    expect((payload.data["market"] as { id: string }).id).toBe("7");
  });

  it("splits a stake that overruns the opposing headroom", async () => {
    const payload = await marketBookTool.run({ marketId: "7", stake: "2500" }, deps);
    const check = payload.data["stakeCheck"] as { perOutcome: Array<{ label: string; accepted: { usdc: string }; refused: { usdc: string }; fullyAccepted: boolean; limitedByOutcome?: number }> };

    expect(check.perOutcome[0]).toMatchObject({
      label: "YES",
      accepted: { usdc: "2000" },
      refused: { usdc: "500" },
      fullyAccepted: false,
      limitedByOutcome: 1,
    });
    expect(check.perOutcome[1]).toMatchObject({ label: "NO", fullyAccepted: true });
    expect(payload.summary).toContain("2000 USDC accepted, 500 USDC refused");
    expect(payload.summary).toContain("Upper bound");
  });

  it("says so plainly when a stake would be refused outright", async () => {
    const saturated = fakeVenue({
      marketState: async () => ({
        ...MARKET,
        books: [MARKET.books[0]!, { ...MARKET.books[1]!, headroom: 0n }],
      }),
    });
    const payload = await marketBookTool.run({ marketId: "7", stake: "100" }, makeDeps({ venue: saturated }));
    expect(payload.summary).toContain("refused in full");
  });

  it("rejects a stake written with more precision than USDC has", async () => {
    await expect(marketBookTool.run({ marketId: "7", stake: "1.0000001" }, deps)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("rejects a zero stake", async () => {
    await expect(marketBookTool.run({ marketId: "7", stake: "0" }, deps)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("reports a frozen market as closed to entry", async () => {
    const payload = await marketBookTool.run({ marketId: "7" }, makeDeps({ now: () => RESOLUTION_TIME + 60 }));
    expect(payload.summary).toContain("Frozen");
    expect((payload.data["market"] as { frozen: boolean }).frozen).toBe(true);
  });

  it("points a resolved market at the claim tool", async () => {
    const venue = fakeVenue({ marketState: async () => ({ ...MARKET, status: "resolved" as const, winner: 0 }) });
    const payload = await marketBookTool.run({ marketId: "7" }, makeDeps({ venue }));
    expect(payload.summary).toContain("Resolved");
    expect(payload.summary).toContain("vpm_claimable");
  });

  it("does not answer the acceptance question on a market that takes no entry", async () => {
    // `enter` reverts with NotOpen here, so "2000 accepted, 500 refused" would describe a
    // transaction that cannot be sent.
    const venue = fakeVenue({ marketState: async () => ({ ...MARKET, status: "resolved" as const, winner: 0 }) });
    const payload = await marketBookTool.run({ marketId: "7", stake: "2500" }, makeDeps({ venue }));

    const check = payload.data["stakeCheck"] as { enterable: boolean; notEnterableBecause: string; perOutcome: unknown[] };
    expect(check.enterable).toBe(false);
    expect(check.notEnterableBecause).toContain("resolved");
    expect(check.perOutcome).toEqual([]);
    expect(payload.summary).toContain("cannot be entered at all");
    expect(payload.summary).not.toContain("accepted in full");
  });

  it("says the same about a market that has already frozen", async () => {
    const payload = await marketBookTool.run({ marketId: "7", stake: "2500" }, makeDeps({ now: () => RESOLUTION_TIME + 60 }));
    const check = payload.data["stakeCheck"] as { enterable: boolean; notEnterableBecause: string };
    expect(check.enterable).toBe(false);
    expect(check.notEnterableBecause).toContain("froze");
    // And it offers no outcome to put the money on either.
    expect(payload.data["bestHeadroom"]).toBeNull();
  });

  it("falls back to deriving odds from principal, and says that it did", async () => {
    const venue = fakeVenue({
      odds: async () => {
        throw new Error("subgraph is 400 blocks behind");
      },
    });
    const payload = await marketBookTool.run({ marketId: "7" }, makeDeps({ venue }));
    const outcomes = payload.data["outcomes"] as Outcome[];
    expect(outcomes[0]?.impliedProbabilityDisplay).toBe("90.9%");
    expect(payload.data["notes"]).toEqual([expect.stringContaining("derived from accepted principal")]);
  });

  it("prefers the client's pick of where the room is", async () => {
    const payload = await marketBookTool.run({ marketId: "7" }, deps);
    expect(payload.data["bestHeadroom"]).toMatchObject({
      index: 1,
      label: "NO",
      acceptsStakeUpTo: { usdc: "29900" },
      source: "client",
    });
    expect(payload.summary).toContain("Most room for new stake: NO");
  });

  it("still answers when the best-headroom read fails, deriving it from the book and saying so", async () => {
    const venue = fakeVenue({
      bestHeadroom: async () => {
        throw new Error("timeout");
      },
    });
    const payload = await marketBookTool.run({ marketId: "7" }, makeDeps({ venue }));
    // The derived answer agrees with the client's, which is the point of deriving it the
    // same way — and the substitution is declared rather than swallowed.
    expect(payload.data["bestHeadroom"]).toMatchObject({ index: 1, source: "derived" });
    expect(payload.data["notes"]).toEqual([expect.stringContaining("derived from the book")]);
  });

  it("flags a market that runs under the classic rule", async () => {
    const venue = fakeVenue({ marketState: async () => ({ ...MARKET, settler: CLASSIC_SETTLER }) });
    const payload = await marketBookTool.run({ marketId: "7" }, makeDeps({ venue }));
    expect(payload.data["notes"]).toEqual([expect.stringContaining("ClassicParimutuel")]);
  });

  it("includes counterparties only when asked", async () => {
    const without = await marketBookTool.run({ marketId: "7" }, deps);
    expect(without.data["counterparties"]).toBeNull();

    const withThem = await marketBookTool.run({ marketId: "7", includeCounterparties: true }, deps);
    const summary = withThem.data["counterparties"] as { wallets: unknown[]; humanBackedShare: number };
    expect(summary.wallets).toHaveLength(1);
    expect(summary.humanBackedShare).toBe(0.6);
    expect(withThem.summary).toContain("vpm_agent_reputation");
  });

  it("repeats what the trust read could not answer instead of implying nobody is there", async () => {
    const venue = fakeVenue({
      counterpartyTrust: async () => ({
        counterparties: [],
        registeredShare: undefined,
        humanBackedShare: undefined,
        notes: ["The client has no reputation source configured, so every counterparty reads as unrated."],
      }),
    });
    const payload = await marketBookTool.run({ marketId: "7", includeCounterparties: true }, makeDeps({ venue }));
    expect(payload.data["notes"]).toEqual([expect.stringContaining("no reputation source configured")]);
  });

  it("keeps the book when the counterparty read fails, and notes the failure", async () => {
    const venue = fakeVenue({
      counterpartyTrust: async () => {
        throw new Error("erc8004 subgraph unavailable");
      },
    });
    const payload = await marketBookTool.run({ marketId: "7", includeCounterparties: true }, makeDeps({ venue }));
    expect(payload.data["counterparties"]).toBeNull();
    expect(payload.data["notes"]).toEqual([expect.stringContaining("could not be read")]);
  });

  it("propagates a failed book read instead of inventing one", async () => {
    const venue = fakeVenue({
      marketState: async () => {
        throw new Error("boom");
      },
    });
    await expect(marketBookTool.run({ marketId: "7" }, makeDeps({ venue }))).rejects.toThrow(/boom/);
  });

  it("computes time to freeze from the injected clock", async () => {
    const payload = await marketBookTool.run({ marketId: "7" }, deps);
    const market = payload.data["market"] as { resolutionTime: { secondsAway: number; relative: string } };
    expect(market.resolutionTime.secondsAway).toBe(RESOLUTION_TIME - NOW);
    expect(market.resolutionTime.relative).toBe("in 1h 46m");
  });

  it("renders an unbounded book without printing a 78-digit number", async () => {
    const unbounded = fakeVenue({
      marketState: async () => ({
        ...MARKET,
        kappa: (1n << 256n) - 1n,
        books: MARKET.books.map((book) => ({ ...book, capacity: (1n << 256n) - 1n, headroom: (1n << 256n) - 1n })),
      }),
    });
    const payload = await marketBookTool.run({ marketId: "7", stake: "100" }, makeDeps({ venue: unbounded }));
    expect(payload.summary).toContain("unbounded");
    expect(payload.summary).not.toMatch(/\d{20}/);
    const check = payload.data["stakeCheck"] as { perOutcome: Array<{ accepted: { usdc: string } }> };
    expect(check.perOutcome[0]?.accepted.usdc).toBe("100");
  });

  it("refuses an empty market id", async () => {
    await expect(marketBookTool.run({ marketId: "  " }, deps)).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("vpm_market_book schema", () => {
  it("requires a market id and nothing else", () => {
    expect(marketBookTool.inputSchema.required).toEqual(["marketId"]);
    expect(marketBookTool.inputSchema.additionalProperties).toBe(false);
  });

  it("tells a model when to reach for it, not just what it does", () => {
    expect(marketBookTool.description).toMatch(/BEFORE staking/);
    expect(marketBookTool.description).toMatch(/refused/);
  });

  it("keeps every amount in the data as strings, so nothing overflows a double", () => {
    const stake = marketBookTool.inputSchema.properties?.["stake"] as { type: string };
    expect(stake.type).toBe("string");
  });

  it("prices the fixture's pool in whole USDC, as the fixture intends", () => {
    expect(MARKET.acceptedPool).toBe(1_100n * USDC);
  });
});
