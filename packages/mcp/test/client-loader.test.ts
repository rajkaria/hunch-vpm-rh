import { describe, expect, it } from "vitest";

import { clientFactoryConfig, loadVpmClient } from "../src/client-loader.js";
import { CLIENT_PAYLOADS, realShapedClientModule, SETTLER, stubClient, testConfig } from "./fixtures.js";

const config = testConfig();

describe("loadVpmClient", () => {
  it("binds the factory the real package exports, not its config-first module functions", async () => {
    let received: unknown;
    const client = await loadVpmClient(config, { importer: async () => realShapedClientModule((input) => (received = input)) });

    // The module namespace also carries marketBook(config, marketId). Binding that one
    // would put the market id in the configuration slot and fail on the first call.
    await expect(client.marketBook("7")).resolves.toEqual(CLIENT_PAYLOADS.marketBook);
    await expect(client.claimable("0x0")).resolves.toEqual(CLIENT_PAYLOADS.claimable);
    expect(received).toEqual(clientFactoryConfig(config));
  });

  it("hands the factory the field names the client actually reads", async () => {
    const passed = clientFactoryConfig(config);
    expect(passed.subgraphUrl).toBe("https://example.test/subgraphs/hunch-vpm");
    expect(passed.erc8004SubgraphUrl).toBe("https://example.test/subgraphs/erc8004-arc");
    // `chain` and `addresses`, not `chainId` and `settler`: a differently spelled config
    // is accepted silently and every value in it is dropped.
    expect(passed.chain.id).toBe(5042002);
    expect(passed.chain.rpcUrls.default.http).toEqual(["https://rpc.testnet.arc.network"]);
    expect(passed.addresses["vestedParimutuel"]).toBe(SETTLER);
    expect(passed.addresses["usdc"]).toBe("0x3600000000000000000000000000000000000000");
  });

  it("leaves an undeployed settler out rather than writing the placeholder over a default", async () => {
    const placeholder = clientFactoryConfig(testConfig({ HUNCH_VPM_SETTLER_ADDRESS: undefined }));
    expect(placeholder.addresses["vestedParimutuel"]).toBeUndefined();
  });

  it("refuses a module whose reads take a configuration first, naming them", async () => {
    const { createHunchClient: _factory, ...configFirstOnly } = realShapedClientModule();
    await expect(loadVpmClient(config, { importer: async () => configFirstOnly })).rejects.toMatchObject({
      code: "not_configured",
      hint: expect.stringContaining("impliedOdds, vestingEarned, claimable"),
    });
  });

  it("accepts six reads exported straight from a module when they are genuinely bound", async () => {
    const client = await loadVpmClient(config, { importer: async () => ({ ...stubClient() }) });
    await expect(client.marketBook("7")).resolves.toEqual(CLIENT_PAYLOADS.marketBook);
  });

  it("awaits a factory that resolves asynchronously", async () => {
    const client = await loadVpmClient(config, {
      importer: async () => ({ createHunchVpmClient: async () => stubClient() }),
    });
    await expect(client.impliedOdds("7")).resolves.toEqual(CLIENT_PAYLOADS.impliedOdds);
  });

  it("keeps `this` intact for a class-based client", async () => {
    class Client {
      readonly marker = "bound";
      async marketBook() {
        return { marker: this.marker };
      }
      async bestHeadroom() {
        return null;
      }
      async impliedOdds() {
        return [];
      }
      async counterpartyTrust() {
        return null;
      }
      async vestingEarned() {
        return null;
      }
      async claimable() {
        return null;
      }
    }
    const client = await loadVpmClient(config, { importer: async () => ({ default: () => new Client() }) });
    await expect(client.marketBook("7")).resolves.toEqual({ marker: "bound" });
  });

  it("reports a factory that rejects the configuration as configuration, not as a crash", async () => {
    // What the real client does with no subgraph endpoint: it throws in its constructor.
    await expect(
      loadVpmClient(config, {
        importer: async () => ({
          createHunchClient: () => {
            throw new Error("no subgraph endpoint: pass `subgraphUrl`");
          },
        }),
      }),
    ).rejects.toMatchObject({
      code: "not_configured",
      message: expect.stringContaining("no subgraph endpoint"),
      hint: expect.stringContaining("HUNCH_VPM_SUBGRAPH_URL"),
    });
  });

  it("explains a failed import instead of crashing the server", async () => {
    await expect(
      loadVpmClient(config, {
        importer: async () => {
          throw new Error("Cannot find package '@hunch-vpm/client'");
        },
      }),
    ).rejects.toMatchObject({ code: "not_configured", hint: expect.stringContaining("pnpm install") });
  });

  it("lists exactly which reads a mismatched module is missing", async () => {
    await expect(
      loadVpmClient(config, { importer: async () => ({ marketBook: async () => ({}), claimable: async () => ({}) }) }),
    ).rejects.toMatchObject({
      code: "not_configured",
      hint: expect.stringContaining("bestHeadroom, impliedOdds, counterpartyTrust, vestingEarned"),
    });
  });
});
