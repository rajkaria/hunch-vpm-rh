import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createMcpServer, createToolRouter, SERVER_INSTRUCTIONS } from "../src/server.js";
import { TOOLS } from "../src/tools/index.js";
import { fakeVenue, makeDeps, WALLET } from "./fixtures.js";

const router = createToolRouter(makeDeps());

describe("tools/list", () => {
  it("publishes the three tools under their exact names", () => {
    expect(router.list().map((tool) => tool.name)).toEqual(["vpm_market_book", "vpm_agent_reputation", "vpm_claimable"]);
  });

  it("marks every tool read-only and open-world", () => {
    for (const tool of router.list()) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    }
  });

  it("publishes closed object schemas with descriptions on every property", () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      const properties = Object.entries(tool.inputSchema.properties ?? {});
      expect(properties.length).toBeGreaterThan(0);
      for (const [name, schema] of properties) {
        expect(schema, `${tool.name}.${name}`).toHaveProperty("description");
      }
    }
  });

  it("tells a model when to reach for each tool, not only what it returns", () => {
    for (const tool of TOOLS) {
      expect(tool.description, tool.name).toMatch(/Reach for this/);
      expect(tool.description.length, tool.name).toBeGreaterThan(200);
    }
  });
});

describe("tools/call", () => {
  it("answers a valid call with prose plus the same data as JSON", async () => {
    const result = await router.call("vpm_market_book", { marketId: "7" });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);
    const [prose, json] = result.content as Array<{ type: string; text: string }>;
    expect(prose?.type).toBe("text");
    expect(prose?.text).toContain("Will ETH close above");
    expect(JSON.parse(json?.text ?? "{}")).toEqual(result.structuredContent);
  });

  it("reports an unknown tool as a tool result, listing the ones that exist", async () => {
    const result = await router.call("vpm_place_bet", {});
    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: { code: string; hint: string } }).error;
    expect(error.code).toBe("invalid_input");
    expect(error.hint).toContain("vpm_market_book");
  });

  it("reports a missing required argument as a tool result, not a protocol error", async () => {
    const result = await router.call("vpm_claimable", {});
    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("wallet");
  });

  it("rejects an argument the schema does not declare", async () => {
    const result = await router.call("vpm_claimable", { wallet: WALLET, sendTo: "0xattacker" });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { message: string } }).error.message).toMatch(/additional propert/i);
  });

  it("enforces the address pattern from the published schema", async () => {
    const result = await router.call("vpm_agent_reputation", { wallet: "not-an-address" });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { message: string } }).error.message).toMatch(/pattern/);
  });

  it("turns an upstream failure into a readable tool result", async () => {
    const failing = createToolRouter(
      makeDeps({
        venue: fakeVenue({
          marketState: async () => {
            throw new Error("subgraph unreachable");
          },
        }),
      }),
    );
    const result = await failing.call("vpm_market_book", { marketId: "7" });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { message: string } }).error.message).toContain("subgraph unreachable");
  });

  it("never lets a handler throw past the router", async () => {
    const exploding = createToolRouter(
      makeDeps({
        venue: fakeVenue({
          claimable: () => {
            throw "not even an Error";
          },
        }),
      }),
    );
    const result = await exploding.call("vpm_claimable", { wallet: WALLET });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe("internal");
  });
});

describe("over a real MCP connection", () => {
  it("initializes, lists and calls across a transport", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(makeDeps());
    const client = new Client({ name: "test-agent", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["vpm_market_book", "vpm_agent_reputation", "vpm_claimable"]);

    const called = await client.callTool({ name: "vpm_claimable", arguments: { wallet: WALLET } });
    expect(called.isError).toBeFalsy();
    expect(JSON.stringify(called.content)).toContain("can pull 1512 USDC");

    await client.close();
    await server.close();
  });

  it("teaches the venue's one surprising rule in its instructions", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/REFUSED/);
    expect(SERVER_INSTRUCTIONS).toMatch(/headroom/);
    expect(SERVER_INSTRUCTIONS).toMatch(/holds no\s*\n?keys|holds no keys/);
  });
});
