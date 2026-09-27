/**
 * The whole path, end to end: load the client the way the server loads it, wrap it in the
 * venue reader, and run the tools through it.
 *
 * Every unit here is tested on its own elsewhere. This exists because the expensive
 * failures are at the seams — a factory bound by the wrong name, a payload field spelled
 * the way the reader expects rather than the way the client writes it — and those only
 * show up when the pieces are wired together against a package-shaped module.
 */

import { describe, expect, it } from "vitest";

import { loadVpmClient } from "../src/client-loader.js";
import { claimableTool } from "../src/tools/claimable.js";
import { marketBookTool } from "../src/tools/market-book.js";
import type { ToolDeps } from "../src/tool.js";
import { createClientVenueReader } from "../src/venue-reader.js";
import {
  fakeAgents,
  NOW,
  realShapedClientModule,
  SETTLER,
  stubClient,
  testConfig,
  UNBOUNDED_MARKET_PAYLOAD,
  WALLET,
} from "./fixtures.js";

const config = testConfig();

async function depsAgainst(module: Record<string, unknown>): Promise<ToolDeps> {
  const client = await loadVpmClient(config, { importer: async () => module });
  return { config, venue: createClientVenueReader(client), agents: fakeAgents(), now: () => NOW };
}

describe("against a package-shaped @hunch-vpm/client", () => {
  it("reads the book and sizes a stake", async () => {
    const deps = await depsAgainst(realShapedClientModule());
    const payload = await marketBookTool.run({ marketId: `${SETTLER}-7`, stake: "2500" }, deps);

    expect(payload.summary).toContain("Open, freezes in 1h 46m");
    expect(payload.summary).toContain("Most room for new stake: outcome 1");
    expect(payload.summary).toContain("2000 USDC accepted, 500 USDC refused");

    const outcomes = payload.data["outcomes"] as Array<{ headroom: { usdc: string }; acceptsStakeUpTo: { usdc: string } }>;
    expect(outcomes[0]).toMatchObject({ headroom: { usdc: "29900" }, acceptsStakeUpTo: { usdc: "2000" } });
    expect((payload.data["market"] as { kappa: string }).kappa).toBe("30");
  });

  it("lists what can be pulled, with the call and the argument that pays each item", async () => {
    const deps = await depsAgainst(realShapedClientModule());
    const payload = await claimableTool.run({ wallet: WALLET }, deps);

    expect(payload.summary).toContain("can pull 1512 USDC right now, across 3 item(s)");
    expect(payload.summary).toContain("claim(uint256) with 11");
    expect(payload.summary).toContain("withdrawRefund(uint256) with 24");
    expect(payload.summary).toContain("claimResidue(uint256) with 3");
    // The table must never print a `-` where the call belongs: that column is the point.
    for (const item of payload.data["items"] as Array<{ call: unknown }>) expect(item.call).not.toBeNull();
  });

  it("reads an n-way market whose capacity is unbounded", async () => {
    const module = {
      ...realShapedClientModule(),
      createHunchClient: () => stubClient({ marketBook: async () => UNBOUNDED_MARKET_PAYLOAD }),
    };
    const deps = await depsAgainst(module);
    const payload = await marketBookTool.run({ marketId: `${SETTLER}-9`, stake: "250" }, deps);

    expect((payload.data["market"] as { kappa: string }).kappa).toBe("unbounded");
    const check = payload.data["stakeCheck"] as { perOutcome: Array<{ accepted: { usdc: string }; refused: { usdc: string } }> };
    expect(check.perOutcome).toHaveLength(3);
    expect(check.perOutcome[0]).toMatchObject({ accepted: { usdc: "250" }, refused: { usdc: "0" } });
    // The failure this guards against reported "-0.000001 USDC accepted" and called the
    // book saturated when it had infinite room.
    expect(payload.summary).not.toContain("-0.");
    expect(payload.summary).toContain("unbounded");
  });
});
