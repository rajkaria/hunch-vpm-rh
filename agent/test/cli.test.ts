import { describe, expect, it } from "vitest";
import { MemoryLogger } from "../src/log.js";
import { ArgError, parseArgs } from "../src/cli/args.js";
import { runCli } from "../src/cli/commands.js";
import { NOW } from "./helpers.js";

const NO_NETWORK = ((): Promise<Response> => {
  throw new Error("the dry-run CLI must not touch the network");
}) as unknown as typeof fetch;

async function cli(argv: readonly string[], env: Record<string, string> = {}) {
  const logger = new MemoryLogger();
  const code = await runCli(argv, {
    logger,
    env,
    fetchImpl: NO_NETWORK,
    sleep: () => Promise.resolve(),
    now: () => NOW,
  });
  return { code, out: logger.lines.join("\n") };
}

describe("argument parsing", () => {
  it("defaults to help", () => {
    expect(parseArgs([]).command).toBe("help");
    expect(parseArgs(["--help"]).command).toBe("help");
  });

  it("reads the flags", () => {
    const args = parseArgs(["run", "--rounds", "5", "--bankroll", "250", "--market", "a", "--market", "b"]);
    expect(args).toMatchObject({ command: "run", rounds: 5, bankroll: "250", markets: ["a", "b"] });
  });

  it("rejects what it does not know", () => {
    expect(() => parseArgs(["fly"])).toThrow(ArgError);
    expect(() => parseArgs(["run", "--turbo"])).toThrow(ArgError);
    expect(() => parseArgs(["run", "--rounds"])).toThrow(ArgError);
    expect(() => parseArgs(["run", "--rounds", "0"])).toThrow(ArgError);
  });

  it("lets --dry-run override an earlier --live", () => {
    expect(parseArgs(["run", "--live", "--dry-run"]).live).toBe(false);
  });
});

describe("commands", () => {
  it("prints usage and exits clean", async () => {
    const { code, out } = await cli(["help"]);
    expect(code).toBe(0);
    expect(out).toContain("research -> decide -> enter -> monitor -> claim");
  });

  it("reports a bad command without a stack trace", async () => {
    const { code, out } = await cli(["fly"]);
    expect(code).toBe(2);
    expect(out).toContain("unknown command");
  });

  it("rejects a bankroll that is not an amount", async () => {
    const { code, out } = await cli(["run", "--bankroll", "lots"]);
    expect(code).toBe(2);
    expect(out).toContain("not a USDC amount");
  });

  it("research prints the book and what the quotes cost", async () => {
    const { code, out } = await cli(["research"]);
    expect(code).toBe(0);
    expect(out).toContain("mode            dry-run");
    expect(out).toContain("btc-72k");
    expect(out).toContain("paid quote(s)");
    expect(out).toContain("settled in 1 on-chain payment");
  });

  it("decide prints an auditable table for every market", async () => {
    const { code, out } = await cli(["decide"]);
    expect(code).toBe(0);
    expect(out).toContain("ENTER outcome");
    expect(out).toContain("abstain (inside-freeze-window)");
    expect(out).toContain("abstain (no-headroom)");
    expect(out).toContain("abstain (no-estimate)");
    expect(out).toContain("eff.edge");
  });

  it("decide --json emits machine-readable decisions with amounts as base units", async () => {
    const { code, out } = await cli(["decide", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { decisions: { marketId: string; stake: string | null }[] };
    expect(parsed.decisions).toHaveLength(6);
    const entered = parsed.decisions.find((d) => d.marketId === "btc-72k");
    expect(typeof entered?.stake).toBe("string");
  });

  it("run completes the loop and ends with a claim", async () => {
    const { code, out } = await cli(["run", "--rounds", "3"]);
    expect(code).toBe(0);
    expect(out).toContain("--- round 3");
    expect(out).toContain("monitor");
    expect(out).toContain("if it wins");
    expect(out).toContain("payout");
    expect(out).toContain("balance   1000.00 ->");
  });

  it("claim on a fresh agent says there is nothing outstanding", async () => {
    const { code, out } = await cli(["claim"]);
    expect(code).toBe(0);
    expect(out).toContain("nothing outstanding");
  });

  it("refuses live mode while nothing is deployed, and touches no network doing it", async () => {
    const { code, out } = await cli(["run", "--live"]);
    expect(code).toBe(1);
    expect(out).toContain("HUNCH_SETTLER");
    expect(out).toContain("placeholder");
  });

  it("refuses live mode with no markets to watch", async () => {
    const { code, out } = await cli(["run", "--live"], {
      HUNCH_SETTLER: "0x1111111111111111111111111111111111111111",
    });
    expect(code).toBe(1);
    expect(out).toContain("HUNCH_MARKET_IDS");
  });

  it("prints every policy knob, so a run's effective configuration is not a guess", async () => {
    const { out } = await cli(["research"], { HUNCH_MIN_EDGE: "0.4", HUNCH_MAX_TICKET_USDC: "42" });
    expect(out).toContain("minEdge         0.4");
    expect(out).toContain("maxTicket       42.00 USDC");
    expect(out).toContain("freezeBuffer    900s");
    expect(out).toContain("trustFloor      0.25");
    expect(out).toContain("headroomUtil    0.9");
    expect(out).toContain("minTicket       1.00 USDC");
    expect(out).toContain("dryRunBankroll  1000.00 USDC");
  });

  it("names an override it could not read instead of silently keeping the default", async () => {
    const { out } = await cli(["research"], {
      HUNCH_MAX_TICKET_USDC: "nonsense",
      HUNCH_DRY_RUN_BANKROLL: "notanumber",
      HUNCH_MIN_EDGE: "quite-a-lot",
    });
    expect(out).toContain("warn: HUNCH_MAX_TICKET_USDC");
    expect(out).toContain("warn: HUNCH_DRY_RUN_BANKROLL");
    expect(out).toContain("warn: HUNCH_MIN_EDGE");
    expect(out).toContain("IGNORED");
    // The defaults are what actually took effect, and the banner says so.
    expect(out).toContain("maxTicket       250.00 USDC");
    expect(out).toContain("dryRunBankroll  1000.00 USDC");
    expect(out).toContain("minEdge         0.03");
  });

  it("warns about an ignored override even under --json, where there is no banner", async () => {
    const { out } = await cli(["decide", "--json"], { HUNCH_MAX_TICKET_USDC: "nonsense" });
    expect(out).toContain("warn: HUNCH_MAX_TICKET_USDC");
    expect(out).not.toContain("maxTicket       ");
  });

  it("never prints a configured secret", async () => {
    const { out } = await cli(["research"], {
      CIRCLE_API_KEY: "sk-live-do-not-print-me",
      GATEWAY_API_KEY: "gw-do-not-print-me",
      CIRCLE_ENTITY_SECRET_CIPHERTEXT: "ciphertext-do-not-print-me",
    });
    expect(out).not.toContain("sk-live-do-not-print-me");
    expect(out).not.toContain("gw-do-not-print-me");
    expect(out).not.toContain("ciphertext-do-not-print-me");
    expect(out).toContain("circle api key  set");
  });

  // The Graph's gateway takes its API key as a path segment, so an endpoint variable is a
  // secret that does not read like one. The banner goes to stdout on every command.
  it("never prints the API key inside a keyed endpoint URL", async () => {
    const key = "0123456789abcdef0123456789abcdef";
    const { out } = await cli(["research"], {
      HUNCH_SUBGRAPH_URL: `https://gateway.thegraph.com/api/${key}/subgraphs/id/QmVpmSubgraphId`,
      HUNCH_INTEL_URL: `https://gateway.thegraph.com/api/${key}/intel`,
    });
    expect(out).not.toContain(key);
    // Still useful: the operator can see which host and which shape of path is configured.
    expect(out).toContain("subgraph        https://gateway.thegraph.com/api/***/subgraphs/id/***");
    expect(out).toContain("intel           https://gateway.thegraph.com/api/***/intel");
  });

  it("keeps a key out of the banner however the URL is shaped", async () => {
    const key = "0123456789abcdef0123456789abcdef";
    for (const url of [
      `https://gateway.thegraph.com/api/${key}/subgraphs/id/Qm1`,
      `https://example.test/graphql?api_key=${key}`,
      `https://alice:${key}@example.test/graphql`,
      `https://example.test/${key}`,
      `not-a-url-${key}`,
    ]) {
      const { out } = await cli(["research"], { HUNCH_SUBGRAPH_URL: url });
      expect(out, url).not.toContain(key);
    }
  });

  it("still says when no endpoint is configured, rather than printing a redacted nothing", async () => {
    const { out } = await cli(["research"]);
    expect(out).toContain("subgraph        none — dry-run fixtures");
    expect(out).toContain("intel           none — dry-run quotes");
  });
});
