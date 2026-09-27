import { Bytes } from "@graphprotocol/graph-ts";
import {
  afterEach,
  assert,
  beforeEach,
  clearStore,
  dataSourceMock,
  describe,
  test,
} from "matchstick-as/assembly/index";

import { Agent } from "../../generated/schema";
import {
  handleApproval,
  handleMetadataSet,
  handleRegistered,
  handleTransfer,
  handleURIUpdated,
} from "../../src/identity";
import {
  CAIP2,
  CLIENT,
  IDENTITY_REGISTRY,
  NETWORK,
  OTHER_CLIENT,
  OWNER,
  ZERO,
  agentId,
  createApproval,
  createMetadataSet,
  createRegistered,
  createTransfer,
  createURIUpdated,
} from "./factories";

describe("IdentityRegistry", () => {
  beforeEach(() => {
    dataSourceMock.setNetwork(NETWORK);
  });

  afterEach(() => {
    clearStore();
    dataSourceMock.resetValues();
  });

  test("register creates a chain-scoped agent and a Registry row", () => {
    handleRegistered(createRegistered(0, "ipfs://card-0", OWNER, 1, 1000));

    // The chain prefix is the whole point: agent 0 exists on every ERC-8004 chain.
    assert.entityCount("Agent", 1);
    assert.fieldEquals("Agent", agentId(0), "agentId", "0");
    assert.fieldEquals("Agent", agentId(0), "tokenId", "0");
    assert.fieldEquals("Agent", agentId(0), "owner", OWNER);
    assert.fieldEquals("Agent", agentId(0), "metadataURI", "ipfs://card-0");
    assert.fieldEquals("Agent", agentId(0), "chainId", "5042002");
    assert.fieldEquals("Agent", agentId(0), "burned", "false");
    assert.fieldEquals("Agent", agentId(0), "registry", CAIP2);

    assert.fieldEquals("Registry", CAIP2, "network", NETWORK);
    assert.fieldEquals("Registry", CAIP2, "chainId", "5042002");
    assert.fieldEquals("Registry", CAIP2, "agentCount", "1");
    assert.fieldEquals("Registry", CAIP2, "liveAgentCount", "1");
    assert.fieldEquals(
      "Registry",
      CAIP2,
      "identityRegistry",
      IDENTITY_REGISTRY.toLowerCase(),
    );
  });

  test("agent id 0 is indexed, not skipped", () => {
    // _lastId starts at 0 and post-increments, so the very first agent has id 0. A mapping
    // that treats 0 as absent would silently drop it.
    handleRegistered(createRegistered(0, "", OWNER, 1, 1000));
    assert.entityCount("Agent", 1);
    assert.fieldEquals("Agent", agentId(0), "agentId", "0");
  });

  test("setAgentURI replaces the card without disturbing registration data", () => {
    handleRegistered(createRegistered(1, "ipfs://old", OWNER, 1, 1000));
    handleURIUpdated(createURIUpdated(1, "ipfs://new", OWNER, 2, 2000));

    assert.fieldEquals("Agent", agentId(1), "metadataURI", "ipfs://new");
    assert.fieldEquals("Agent", agentId(1), "registeredAt", "1000");
    assert.fieldEquals("Agent", agentId(1), "updatedAt", "2000");
  });

  test("agentWallet metadata is decoded to an address", () => {
    handleRegistered(createRegistered(2, "", OWNER, 1, 1000));
    handleMetadataSet(
      createMetadataSet(2, "agentWallet", Bytes.fromHexString(OTHER_CLIENT), 2, 1000),
    );

    assert.fieldEquals("Agent", agentId(2), "agentWallet", OTHER_CLIENT);
    assert.fieldEquals(
      "AgentMetadata",
      agentId(2) + "/metadata/agentWallet",
      "key",
      "agentWallet",
    );
  });

  test("a malformed agentWallet is preserved raw but never promoted", () => {
    handleRegistered(createRegistered(2, "", OWNER, 1, 1000));
    handleMetadataSet(createMetadataSet(2, "agentWallet", Bytes.fromHexString(OWNER), 2, 1000));
    handleMetadataSet(createMetadataSet(2, "agentWallet", Bytes.fromUTF8("nope"), 3, 2000));

    // The raw entry always survives for inspection, but the typed field keeps the last valid
    // 20-byte value rather than an address assembled from the wrong number of bytes.
    assert.fieldEquals(
      "AgentMetadata",
      agentId(2) + "/metadata/agentWallet",
      "valueString",
      "nope",
    );
    assert.stringEquals(agentWalletHex(agentId(2)), OWNER.toLowerCase());
  });

  test("a zero-length agentWallet clears the field instead of keeping the old owner", () => {
    // The registry clears the reserved agentWallet entry on every ownership move, and
    // unsetAgentWallet does the same on demand: both emit MetadataSet with a zero-length
    // value. Treating that like a malformed write would keep serving the previous owner's
    // address as the wallet the agent signs as, which is the one answer that must not
    // outlive the ownership that produced it.
    handleRegistered(createRegistered(7, "", OWNER, 1, 1000));
    handleMetadataSet(createMetadataSet(7, "agentWallet", Bytes.fromHexString(OWNER), 2, 1000));
    assert.stringEquals(agentWalletHex(agentId(7)), OWNER.toLowerCase());

    handleMetadataSet(createMetadataSet(7, "agentWallet", Bytes.fromHexString("0x"), 3, 2000));
    handleTransfer(createTransfer(OWNER, CLIENT, 7, 4, 2000));

    assert.stringEquals(agentWalletHex(agentId(7)), UNSET);
    assert.fieldEquals("Agent", agentId(7), "owner", CLIENT);

    // The clear is still visible verbatim, so a consumer can tell "cleared" from "never set".
    assert.fieldEquals(
      "AgentMetadata",
      agentId(7) + "/metadata/agentWallet",
      "value",
      "0x",
    );
  });

  test("an agent with no agentWallet entry leaves the field unset", () => {
    handleRegistered(createRegistered(2, "", OWNER, 1, 1000));
    assert.stringEquals(agentWalletHex(agentId(2)), UNSET);
  });

  test("name and description metadata land on the standardized fields", () => {
    handleRegistered(createRegistered(3, "", OWNER, 1, 1000));
    handleMetadataSet(createMetadataSet(3, "name", Bytes.fromUTF8("settlement-watcher"), 2, 1000));
    handleMetadataSet(
      createMetadataSet(3, "description", Bytes.fromUTF8("Watches feed staleness"), 3, 1000),
    );

    assert.fieldEquals("Agent", agentId(3), "name", "settlement-watcher");
    assert.fieldEquals("Agent", agentId(3), "description", "Watches feed staleness");
  });

  test("endpoint keys become Endpoint rows keyed by lower-cased protocol", () => {
    handleRegistered(createRegistered(4, "", OWNER, 1, 1000));
    handleMetadataSet(
      createMetadataSet(4, "endpoints.MCP", Bytes.fromUTF8("https://a.example/mcp"), 2, 1000),
    );
    handleMetadataSet(
      createMetadataSet(4, "endpoint.a2a", Bytes.fromUTF8("https://a.example/a2a"), 3, 1000),
    );

    assert.entityCount("Endpoint", 2);
    assert.fieldEquals("Endpoint", agentId(4) + "/endpoint/mcp", "uri", "https://a.example/mcp");
    assert.fieldEquals("Endpoint", agentId(4) + "/endpoint/mcp", "protocol", "mcp");
    assert.fieldEquals("Endpoint", agentId(4) + "/endpoint/a2a", "uri", "https://a.example/a2a");
  });

  test("re-setting an endpoint updates in place rather than adding a row", () => {
    handleRegistered(createRegistered(4, "", OWNER, 1, 1000));
    handleMetadataSet(
      createMetadataSet(4, "endpoint.mcp", Bytes.fromUTF8("https://old.example"), 2, 1000),
    );
    handleMetadataSet(
      createMetadataSet(4, "endpoint.mcp", Bytes.fromUTF8("https://new.example"), 3, 2000),
    );

    assert.entityCount("Endpoint", 1);
    assert.fieldEquals("Endpoint", agentId(4) + "/endpoint/mcp", "uri", "https://new.example");
    assert.fieldEquals("Endpoint", agentId(4) + "/endpoint/mcp", "updatedAt", "2000");
  });

  test("a comma-separated capabilities list fans out and counts each agent once", () => {
    handleRegistered(createRegistered(5, "", OWNER, 1, 1000));
    handleRegistered(createRegistered(6, "", OWNER, 2, 1000));
    handleMetadataSet(
      createMetadataSet(5, "capabilities", Bytes.fromUTF8("pricing, settlement ,"), 3, 1000),
    );
    handleMetadataSet(createMetadataSet(6, "capabilities", Bytes.fromUTF8("pricing"), 4, 1000));

    // The trailing empty entry is dropped and whitespace is trimmed.
    assert.entityCount("Capability", 3);
    assert.fieldEquals("Capability", agentId(5) + "/capability/pricing", "name", "pricing");
    assert.fieldEquals("Capability", agentId(5) + "/capability/settlement", "name", "settlement");
    assert.fieldEquals("CapabilityStat", CAIP2 + "/capability/pricing", "agentCount", "2");
    assert.fieldEquals("CapabilityStat", CAIP2 + "/capability/settlement", "agentCount", "1");
  });

  test("re-advertising the same capability does not inflate the chain count", () => {
    handleRegistered(createRegistered(5, "", OWNER, 1, 1000));
    handleMetadataSet(createMetadataSet(5, "capability.pricing", Bytes.fromUTF8("v1"), 2, 1000));
    handleMetadataSet(createMetadataSet(5, "capability.pricing", Bytes.fromUTF8("v2"), 3, 2000));

    assert.entityCount("Capability", 1);
    assert.fieldEquals("Capability", agentId(5) + "/capability/pricing", "value", "v2");
    assert.fieldEquals("CapabilityStat", CAIP2 + "/capability/pricing", "agentCount", "1");
  });

  test("an unrecognised metadata key is still preserved verbatim", () => {
    handleRegistered(createRegistered(7, "", OWNER, 1, 1000));
    handleMetadataSet(
      createMetadataSet(7, "x-vendor-thing", Bytes.fromUTF8("{\"k\":1}"), 2, 1000),
    );

    assert.entityCount("AgentMetadata", 1);
    assert.fieldEquals(
      "AgentMetadata",
      agentId(7) + "/metadata/x-vendor-thing",
      "valueString",
      "{\"k\":1}",
    );
    assert.entityCount("Endpoint", 0);
    assert.entityCount("Capability", 0);
  });

  test("transfer moves ownership and records the move", () => {
    handleRegistered(createRegistered(8, "", OWNER, 1, 1000));
    handleTransfer(createTransfer(OWNER, OTHER_CLIENT, 8, 2, 2000));

    assert.fieldEquals("Agent", agentId(8), "owner", OTHER_CLIENT);
    assert.entityCount("AgentTransfer", 1);
  });

  test("burning marks the agent and decrements only the live count", () => {
    handleRegistered(createRegistered(9, "", OWNER, 1, 1000));
    handleTransfer(createTransfer(OWNER, ZERO, 9, 2, 2000));

    assert.fieldEquals("Agent", agentId(9), "burned", "true");
    assert.fieldEquals("Registry", CAIP2, "agentCount", "1");
    assert.fieldEquals("Registry", CAIP2, "liveAgentCount", "0");
  });

  test("a repeated burn log cannot drive liveAgentCount negative", () => {
    handleRegistered(createRegistered(9, "", OWNER, 1, 1000));
    handleTransfer(createTransfer(OWNER, ZERO, 9, 2, 2000));
    handleTransfer(createTransfer(ZERO, ZERO, 9, 3, 3000));

    assert.fieldEquals("Registry", CAIP2, "liveAgentCount", "0");
  });

  test("approval is recorded and cleared by a subsequent transfer", () => {
    handleRegistered(createRegistered(10, "", OWNER, 1, 1000));
    handleApproval(createApproval(OWNER, OTHER_CLIENT, 10, 2, 2000));
    assert.fieldEquals("Agent", agentId(10), "approved", OTHER_CLIENT);

    handleTransfer(createTransfer(OWNER, OTHER_CLIENT, 10, 3, 3000));
    assert.stringEquals(approvedHex(agentId(10)), UNSET);
  });

  test("a day roll-up counts registrations in its bucket", () => {
    handleRegistered(createRegistered(11, "", OWNER, 1, 86400));
    handleRegistered(createRegistered(12, "", OWNER, 2, 90000));

    assert.fieldEquals("RegistryDayData", CAIP2 + "/day/86400", "agentsRegistered", "2");
    assert.fieldEquals("RegistryDayData", CAIP2 + "/day/86400", "totalAgents", "2");
  });
});

const UNSET = "<unset>";

/**
 * graph-ts overloads == on ByteArray, and asking the AssemblyScript compiler to apply that
 * overload with a null operand crashes it. Reduce an optional Bytes to a string first, then
 * assert on the string.
 */
function optionalBytesHex(value: Bytes | null): string {
  if (value) return value.toHexString();
  return UNSET;
}

function agentWalletHex(id: string): string {
  const agent = Agent.load(id);
  if (agent == null) return "<no agent>";
  return optionalBytesHex(agent.agentWallet);
}

function approvedHex(id: string): string {
  const agent = Agent.load(id);
  if (agent == null) return "<no agent>";
  return optionalBytesHex(agent.approved);
}
