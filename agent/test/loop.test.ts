/**
 * The whole loop, dry-run, against the shipped fixtures.
 *
 * `fetch` throws in every test in this file, so a network call anywhere in the dry-run
 * path is a failure rather than a slow test.
 */

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { formatUsdc } from "../src/domain/units.js";
import { MemoryLogger } from "../src/log.js";
import { decideAll, research, runLoop } from "../src/loop.js";
import type { LoopDeps, RunOptions } from "../src/loop.js";
import { wire } from "../src/wire.js";
import { NOW } from "./helpers.js";

const NO_NETWORK = ((): Promise<Response> => {
  throw new Error("the dry-run agent must not touch the network");
}) as unknown as typeof fetch;

async function agent(env: Record<string, string> = {}): Promise<{ deps: LoopDeps; options: RunOptions }> {
  const config = loadConfig(env);
  const logger = new MemoryLogger();
  const wiring = await wire(config, {
    logger,
    fixturePath: undefined,
    fetchImpl: NO_NETWORK,
    sleep: () => Promise.resolve(),
    startAt: NOW,
  });
  return {
    deps: wiring.deps,
    options: {
      rounds: config.rounds,
      advanceSeconds: wiring.advanceSeconds,
      onAdvance: wiring.onAdvance,
      sleep: () => Promise.resolve(),
      intervalMs: 0,
      readOnly: false,
    },
  };
}

describe("research", () => {
  it("needs no key and no network", async () => {
    const { deps } = await agent();
    const report = await research(deps);
    expect(report.markets).toHaveLength(6);
    expect(report.quotesBought).toBe(5); // six markets, five distinct feeds
    expect(report.authorizedMicroUsdc).toBe(5n * 250n);
  });

  it("buys one quote per feed, not one per market", async () => {
    const { deps } = await agent();
    const report = await research(deps);
    const btc = report.markets.filter((m) => m.market.spec.feedKey === "BTCUSD");
    expect(btc).toHaveLength(2);
    expect(btc[0]?.quote).toEqual(btc[1]?.quote);
  });

  it("does not price a market that has already settled, even when it holds the feed", async () => {
    // btc-72k and btc-68k-short share BTCUSD. Once the short one resolves, a quote for
    // that feed is still in hand for the other market, and must not become an estimate
    // for a question that is already answered.
    const { deps, options } = await agent();
    const result = await runLoop(deps, { ...options, readOnly: true });
    const last = result.rounds[result.rounds.length - 1];
    const resolved = last?.report.markets.find((m) => m.market.status !== "open");
    expect(resolved).toBeDefined();
    expect(resolved?.estimate).toBeUndefined();
    expect(resolved?.note).toMatch(/^market is /);
  });

  it("says why a market has no estimate", async () => {
    const { deps } = await agent();
    const report = await research(deps);
    const threeWay = report.markets.find((m) => m.market.marketId === "eur-ranked-3way");
    expect(threeWay?.estimate).toBeUndefined();
    expect(threeWay?.note).toContain("3-way");
  });
});

describe("decide, across the fixture set", () => {
  it("reaches the expected verdict on every market", async () => {
    const { deps } = await agent();
    const report = await research(deps);
    const decisions = decideAll(report, await deps.wallet.balance(), deps.policy);
    const byId = new Map(decisions.map((d) => [d.marketId, d]));

    expect(byId.get("btc-72k")?.action).toBe("enter");
    expect(byId.get("btc-68k-short")?.action).toBe("enter");
    expect(byId.get("eth-3200-late")?.reason).toBe("inside-freeze-window");
    expect(byId.get("sol-180-full")?.reason).toBe("no-headroom");
    expect(byId.get("xau-2400-anon")?.reason).toBe("edge-below-threshold");
    expect(byId.get("eur-ranked-3way")?.reason).toBe("no-estimate");
  });

  it("never proposes a stake larger than the bankroll", async () => {
    const { deps } = await agent({ HUNCH_DRY_RUN_BANKROLL: "5" });
    const report = await research(deps);
    const bankroll = await deps.wallet.balance();
    for (const decision of decideAll(report, bankroll, deps.policy)) {
      expect((decision.stake ?? 0n) <= bankroll).toBe(true);
    }
  });
});

describe("run: research -> decide -> enter -> monitor -> claim", () => {
  it("enters, watches the position vest, and claims when the market resolves", async () => {
    const { deps, options } = await agent();
    const result = await runLoop(deps, options);

    expect(result.rounds).toHaveLength(3);

    const entered = result.rounds.flatMap((r) => r.entries.map((e) => e.marketId));
    expect(entered).toContain("btc-72k");
    expect(entered).toContain("btc-68k-short");
    // The books it refused to touch stay untouched, round after round.
    expect(entered).not.toContain("eth-3200-late");
    expect(entered).not.toContain("sol-180-full");
    expect(entered).not.toContain("eur-ranked-3way");

    // Everything it offered was accepted, because it sized to the headroom that existed.
    for (const round of result.rounds) {
      for (const entry of round.entries) expect(entry.accepted).toBe(entry.offered);
    }

    // Monitor: by the last round, stake that landed later has vested into the positions.
    const last = result.rounds[result.rounds.length - 1];
    expect(last?.positions.length).toBeGreaterThan(0);
    expect(last?.positions.every((p) => p.vestingEarned > 0n)).toBe(true);

    // Claim: the short market froze, resolved, and paid more than its principal back.
    expect(result.claims).toHaveLength(1);
    const claim = result.claims[0];
    expect(claim?.txs.every((t) => t.status === "confirmed")).toBe(true);
    const claimed = result.rounds
      .flatMap((r) => r.entries)
      .find((e) => e.marketId === "btc-68k-short");
    expect((claim?.payout ?? 0n) > (claimed?.accepted ?? 0n)).toBe(true);
  });

  it("does not average into a market it already holds", async () => {
    const { deps, options } = await agent();
    const result = await runLoop(deps, options);
    const entered = result.rounds.flatMap((r) => r.entries.map((e) => e.marketId));
    expect(new Set(entered).size).toBe(entered.length);
  });

  it("settles every paid quote in a single on-chain payment", async () => {
    const { deps, options } = await agent();
    const result = await runLoop(deps, options);
    expect(result.quotesBought).toBeGreaterThan(5);
    expect(result.settlement.authorizations).toBe(result.quotesBought);
    expect(result.settlement.totalMicroUsdc).toBe(BigInt(result.quotesBought) * 250n);
    // The point of the exercise: a whole research loop for a fraction of a cent.
    expect(result.settlement.totalMicroUsdc).toBeLessThan(10_000n);
  });

  it("keeps the balance honest end to end", async () => {
    const { deps, options } = await agent();
    const result = await runLoop(deps, options);

    const staked = result.rounds
      .flatMap((r) => r.entries)
      .reduce((sum, e) => sum + (e.accepted ?? 0n), 0n);
    const returned = result.claims.reduce((sum, c) => sum + c.payout + c.refund, 0n);
    expect(result.closingBalance).toBe(result.openingBalance - staked + returned);
  });

  it("stakes nothing in read-only mode", async () => {
    const { deps, options } = await agent();
    const result = await runLoop(deps, { ...options, readOnly: true });
    expect(result.rounds.flatMap((r) => r.entries)).toHaveLength(0);
    expect(result.claims).toHaveLength(0);
    expect(formatUsdc(result.closingBalance)).toBe(formatUsdc(result.openingBalance));
  });

  it("stops entering when the bankroll runs out, without failing", async () => {
    const { deps, options } = await agent({ HUNCH_DRY_RUN_BANKROLL: "12" });
    const result = await runLoop(deps, options);
    expect(result.closingBalance >= 0n).toBe(true);
    for (const round of result.rounds) {
      for (const entry of round.entries) expect(entry.txs.every((t) => t.status === "confirmed")).toBe(true);
    }
  });
});
