import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  createSubgraphAgentDirectory,
  ERC8004_AGENT_FIELDS,
  ERC8004_AGENT_FILTERS,
  ERC8004_AGENT_QUERY,
  VENUE_AGENT_FIELDS,
  VENUE_AGENT_QUERY,
} from "../src/agent-directory.js";
import type { FetchLike } from "../src/graphql.js";
import { testConfig, USDC, WALLET } from "./fixtures.js";

const IDENTITY_URL = "https://example.test/subgraphs/erc8004-arc";
const VENUE_URL = "https://example.test/subgraphs/hunch-vpm";

const identityAgent = {
  id: "eip155:5042002/agent/42",
  agentId: "42",
  owner: WALLET,
  agentWallet: WALLET,
  name: "forecaster",
  metadataURI: "ipfs://agent-card",
  registeredAt: "1790700000",
  updatedAt: "1790780000",
  burned: false,
  feedbackCount: 17,
  activeFeedbackCount: 15,
  revokedFeedbackCount: 2,
  averageScore: "4.6",
  validationCount: 3,
};

const identityPayload = { byOwner: [identityAgent], byWallet: [] };

const venuePayload = {
  agent: {
    id: WALLET,
    erc8004Id: "42",
    agentBookVerified: true,
    marketsEntered: "4",
    totalOffered: "2600000000",
    totalAccepted: "2400000000",
    totalClaimed: "900000000",
    firstSeenAt: "1790700000",
  },
};

function routed(routes: Record<string, unknown>, onCall?: (url: string) => void): FetchLike {
  return async (url) => {
    onCall?.(url);
    const payload = routes[url];
    if (payload === undefined) throw new Error(`unexpected endpoint ${url}`);
    if (payload instanceof Error) throw payload;
    return new Response(JSON.stringify({ data: payload }), { status: 200 });
  };
}

describe("createSubgraphAgentDirectory", () => {
  it("joins ERC-8004 identity with the venue's AgentBook flag", async () => {
    const directory = createSubgraphAgentDirectory(testConfig(), {
      fetchImpl: routed({ [IDENTITY_URL]: identityPayload, [VENUE_URL]: venuePayload }),
    });

    const record = await directory.lookup(WALLET.toUpperCase().replace("0X", "0x"));

    expect(record.wallet).toBe(WALLET);
    expect(record.identity).toMatchObject({
      registered: true,
      agentId: "42",
      name: "forecaster",
      metadataUri: "ipfs://agent-card",
    });
    expect(record.identity.registry).toBe("0x8004a818bfb912233c491871b3d84c89a494bd9e");
    expect(record.reputation).toMatchObject({
      feedbackCount: 17,
      activeFeedbackCount: 15,
      revokedFeedbackCount: 2,
      averageScore: 4.6,
      validationCount: 3,
    });
    expect(record.humanBacked).toBe(true);
    expect(record.venue).toEqual({
      marketsEntered: 4,
      offered: 2_600n * USDC,
      acceptedStake: 2_400n * USDC,
      claimed: 900n * USDC,
      firstSeen: 1_790_700_000,
    });
    expect(record.notes).toEqual([]);
  });

  it("finds an identity held in one wallet and signed for by another", async () => {
    const directory = createSubgraphAgentDirectory(testConfig(), {
      fetchImpl: routed({
        [IDENTITY_URL]: { byOwner: [], byWallet: [identityAgent] },
        [VENUE_URL]: venuePayload,
      }),
    });
    const record = await directory.lookup(WALLET);
    expect(record.identity.agentId).toBe("42");
  });

  it("does not call a burned identity registered, and says why", async () => {
    const directory = createSubgraphAgentDirectory(testConfig(), {
      fetchImpl: routed({
        [IDENTITY_URL]: { byOwner: [{ ...identityAgent, burned: true }], byWallet: [] },
        [VENUE_URL]: venuePayload,
      }),
    });
    const record = await directory.lookup(WALLET);
    expect(record.identity).toMatchObject({ registered: false, burned: true, agentId: "42" });
  });

  it("queries both endpoints exactly once", async () => {
    const seen: string[] = [];
    const directory = createSubgraphAgentDirectory(testConfig(), {
      fetchImpl: routed({ [IDENTITY_URL]: identityPayload, [VENUE_URL]: venuePayload }, (url) => seen.push(url)),
    });
    await directory.lookup(WALLET);
    expect(seen.sort()).toEqual([IDENTITY_URL, VENUE_URL].sort());
  });

  it("returns an unregistered record when the registry has no such agent", async () => {
    const directory = createSubgraphAgentDirectory(testConfig(), {
      fetchImpl: routed({ [IDENTITY_URL]: { byOwner: [], byWallet: [] }, [VENUE_URL]: { agent: null } }),
    });

    const record = await directory.lookup(WALLET);
    expect(record.identity.registered).toBe(false);
    expect(record.humanBacked).toBeUndefined();
    expect(record.venue).toEqual({
      marketsEntered: 0,
      offered: 0n,
      acceptedStake: 0n,
      claimed: 0n,
      firstSeen: undefined,
    });
  });

  it("answers with the half it could read, and names the half it could not", async () => {
    const directory = createSubgraphAgentDirectory(testConfig(), {
      fetchImpl: routed({ [IDENTITY_URL]: identityPayload, [VENUE_URL]: new Error("indexer down") }),
    });

    const record = await directory.lookup(WALLET);
    expect(record.identity.registered).toBe(true);
    expect(record.humanBacked).toBeUndefined();
    expect(record.notes).toEqual([expect.stringContaining("AgentBook status unavailable")]);
  });

  it("notes an ERC-8004 endpoint that was never configured", async () => {
    const config = testConfig({ HUNCH_VPM_ERC8004_SUBGRAPH_URL: undefined });
    const directory = createSubgraphAgentDirectory(config, { fetchImpl: routed({ [VENUE_URL]: venuePayload }) });

    const record = await directory.lookup(WALLET);
    expect(record.identity.registered).toBe(false);
    expect(record.humanBacked).toBe(true);
    expect(record.notes).toEqual([expect.stringContaining("HUNCH_VPM_ERC8004_SUBGRAPH_URL is not set")]);
  });

  it("prefers the registry's agent id over the venue's copy of it", async () => {
    const directory = createSubgraphAgentDirectory(testConfig(), {
      fetchImpl: routed({
        [IDENTITY_URL]: { byOwner: [{ id: "a", agentId: "42", owner: WALLET, burned: false }], byWallet: [] },
        [VENUE_URL]: { agent: { id: WALLET, erc8004Id: "999", agentBookVerified: false } },
      }),
    });
    const record = await directory.lookup(WALLET);
    expect(record.identity.agentId).toBe("42");
    expect(record.humanBacked).toBe(false);
  });
});

/**
 * A GraphQL server rejects the whole document for one unknown field, so a query that
 * drifts from its schema does not degrade an answer — it deletes it. These bind the two
 * query constants to the schema files they were written against.
 */
describe("the queries against the schemas in this repository", () => {
  const venueAgentFields = fieldsOfType("subgraph/schema.graphql", "Agent");
  const erc8004AgentFields = fieldsOfType("subgraph-erc8004-arc/schema.graphql", "Agent");

  it("selects only fields the venue subgraph publishes on Agent", () => {
    expect(venueAgentFields.size).toBeGreaterThan(5);
    for (const field of VENUE_AGENT_FIELDS) {
      expect(venueAgentFields, field).toContain(field);
      expect(VENUE_AGENT_QUERY).toContain(field);
    }
  });

  it("selects only fields the ERC-8004 subgraph publishes on Agent, and filters on real ones", () => {
    expect(erc8004AgentFields.size).toBeGreaterThan(5);
    for (const field of ERC8004_AGENT_FIELDS) {
      expect(erc8004AgentFields, field).toContain(field);
      expect(ERC8004_AGENT_QUERY).toContain(field);
    }
    for (const filter of ERC8004_AGENT_FILTERS) {
      expect(erc8004AgentFields, filter).toContain(filter);
    }
  });

  it("declares `owner` as Bytes, which is why the variable is Bytes and not String", () => {
    const schema = readSchema("subgraph-erc8004-arc/schema.graphql");
    expect(schema).toMatch(/^\s*owner: Bytes!/m);
    expect(ERC8004_AGENT_QUERY).toContain("$wallet: Bytes!");
    // The venue keys Agent by the wallet address itself, so that one is an ID.
    expect(VENUE_AGENT_QUERY).toContain("$wallet: ID!");
  });
});

function readSchema(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), "utf8");
}

/** Field names declared on one type, doc comments and directives ignored. */
function fieldsOfType(relative: string, typeName: string): Set<string> {
  const schema = readSchema(relative);
  const start = schema.search(new RegExp(`^type ${typeName}\\b[^{]*\\{`, "m"));
  if (start < 0) throw new Error(`${relative} has no type ${typeName}`);
  const open = schema.indexOf("{", start);
  const end = schema.indexOf("\n}", open);
  const body = schema.slice(open + 1, end);
  return new Set([...body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((match) => match[1] as string));
}
