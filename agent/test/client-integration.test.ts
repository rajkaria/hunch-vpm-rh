/**
 * The seam between two packages, held against the real thing.
 *
 * `graph-source.test.ts` checks the agent's decoders against a `MarketBook` literal the
 * agent wrote down itself. That catches a decoder bug and nothing else: when the client
 * stops publishing — or never publishes — a field the agent requires, both suites stay
 * green and live mode fails on the first market. That is not hypothetical. The client's
 * `MarketBook` carried no opening time while `decodeOpenedAt` threw without one, so every
 * live market died on `marketBook(...).openedAt: missing` while 204 tests passed.
 *
 * So this file builds a `MarketBook` the one way that cannot drift: through the client's
 * own read, over the client's own recorded subgraph response, decoded by the agent's own
 * decoder. A field the agent needs and the client does not publish fails here.
 *
 * Two deliberate choices:
 *
 *   - The client is loaded from SOURCE, not from `@hunch-vpm/client`. CI runs `test`
 *     before `build`, so `packages/client/dist` may not exist, and when it does it may be
 *     stale — a stale build is exactly how these two would drift apart again unnoticed.
 *     The specifier is therefore a file URL, which is also why nothing here appears in the
 *     agent's own dependency graph.
 *   - The client goes through the agent's own `bindHunchClient`, so the config the live
 *     CLI builds (address overrides, chain lookup by id) is under test too, not bypassed.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MemoryLogger } from "../src/log.js";
import { bindHunchClient } from "../src/research/client-binding.js";
import type { HunchClientSurface } from "../src/research/client-binding.js";
import { GraphResearchSource, decodeMarket } from "../src/research/graph-source.js";

/** The client's entry, as source. A bare specifier would resolve to its build output. */
const CLIENT_SRC = new URL("../../packages/client/src/index.js", import.meta.url).href;

/** The client's own recorded subgraph response — the shape The Graph actually serves. */
const RECORDED = new URL("../../packages/client/test/fixtures/market-open.json", import.meta.url);

const SETTLER = "0x1111111111111111111111111111111111111111";
const MARKET_ID = `${SETTLER}-0`;

interface RawMarketResponse {
  readonly market: Record<string, string>;
}

const recorded = JSON.parse(readFileSync(RECORDED, "utf8")) as RawMarketResponse;

/**
 * Serves the recorded response and nothing else. A read that starts issuing some other
 * query fails loudly here rather than quietly returning an empty market.
 */
const transport = {
  async request<T>({ operation }: { operation: string }): Promise<T> {
    if (operation !== "market") throw new Error(`no recorded response for operation "${operation}"`);
    return recorded as unknown as T;
  },
};

/** The real client, bound the way `loadHunchClient` binds it, reading the recording. */
async function boundClient(): Promise<HunchClientSurface> {
  const namespace = (await import(CLIENT_SRC)) as Record<string, unknown>;
  const factory = namespace["createHunchClient"] as (config: Record<string, unknown>) => unknown;
  const chainId = (namespace["arcTestnet"] as { id: number }).id;
  // Only the transport is swapped. Everything else about the config — the settler
  // override, the chain object, the subgraph URL — is built by the agent's own binding.
  const wired = {
    ...namespace,
    createHunchClient: (config: Record<string, unknown>) => factory({ ...config, transport }),
  };
  return bindHunchClient(
    wired,
    { subgraphUrl: "https://subgraph.invalid/hunch-vpm", settler: SETTLER, chainId },
    CLIENT_SRC,
  );
}

describe("a market shaped the way @hunch-vpm/client actually returns one", () => {
  it("decodes, with every field the agent requires present", async () => {
    const client = await boundClient();
    const book = (await client.marketBook(MARKET_ID)) as Record<string, unknown>;

    const market = decodeMarket(book, MARKET_ID);

    expect(market.marketId).toBe(MARKET_ID);
    expect(market.onChainMarketId).toBe(0n);
    expect(market.status).toBe("open");
    expect(market.books).toHaveLength(2);
  });

  /**
   * The field the two packages disagreed about. The subgraph has always recorded it as
   * `Market.createdAt`; the agent has always required it, under that name or `openedAt`,
   * because the vesting-outlook rule divides by the arrival window. Only the client's
   * selection was missing.
   */
  it("carries the opening time the vesting-outlook rule divides by", async () => {
    const client = await boundClient();
    const book = (await client.marketBook(MARKET_ID)) as Record<string, unknown>;

    expect(book["createdAt"]).toBe(BigInt(recorded.market["createdAt"] ?? ""));
    expect(decodeMarket(book, MARKET_ID).openedAt).toBe(Number(recorded.market["createdAt"]));
    // And it really is the start of a window, not a restatement of the end of one.
    expect(decodeMarket(book, MARKET_ID).openedAt).toBeLessThan(
      decodeMarket(book, MARKET_ID).resolutionTime,
    );
  });

  it("fails by name, not by silent default, if the client ever drops it again", async () => {
    const client = await boundClient();
    const { createdAt, ...without } = (await client.marketBook(MARKET_ID)) as Record<string, unknown>;
    void createdAt;

    expect(() => decodeMarket(without, MARKET_ID)).toThrow(/openedAt: missing/);
  });

  /**
   * The whole research read, not just the decoder: `market()` also cross-checks the
   * client's own implied odds and headroom against the books it just decoded. A
   * disagreement there means the indexer is serving two views of one market, and this is
   * where that would show up against real client arithmetic rather than a hand-written
   * fixture.
   */
  it("passes the source's own cross-checks against the client's derived figures", async () => {
    const logger = new MemoryLogger();
    const source = new GraphResearchSource(await boundClient(), { marketIds: [MARKET_ID], logger });

    const market = await source.market(MARKET_ID);

    expect(market?.openedAt).toBe(Number(recorded.market["createdAt"]));
    expect(logger.lines.filter((line) => line.includes("impliedOdds says"))).toEqual([]);
    expect(logger.lines.filter((line) => line.includes("bestHeadroom says"))).toEqual([]);
  });
});
