import {
  afterEach,
  assert,
  beforeEach,
  clearStore,
  dataSourceMock,
  describe,
  test,
} from "matchstick-as/assembly/index";

import { handleRegistered } from "../../src/identity";
import {
  handleFeedbackRevoked,
  handleNewFeedback,
  handleResponseAppended,
} from "../../src/reputation";
import {
  CAIP2,
  CLIENT,
  NETWORK,
  OTHER_CLIENT,
  OWNER,
  REPUTATION_REGISTRY,
  agentId,
  createFeedbackRevoked,
  createNewFeedback,
  createRegistered,
  createResponseAppended,
} from "./factories";

function feedbackId(agent: i32, client: string, index: i32): string {
  return agentId(agent) + "/feedback/" + client.toLowerCase() + "/" + index.toString();
}

describe("ReputationRegistry", () => {
  beforeEach(() => {
    dataSourceMock.setNetwork(NETWORK);
    handleRegistered(createRegistered(0, "ipfs://card", OWNER, 1, 1000));
  });

  afterEach(() => {
    clearStore();
    dataSourceMock.resetValues();
  });

  test("feedback is keyed on agent, client and index", () => {
    handleNewFeedback(
      createNewFeedback(0, CLIENT, 1, 90, 0, "latency", "", "mcp", "ipfs://f1", 2, 2000),
    );

    const id = feedbackId(0, CLIENT, 1);
    assert.entityCount("Feedback", 1);
    assert.fieldEquals("Feedback", id, "author", CLIENT.toLowerCase());
    assert.fieldEquals("Feedback", id, "index", "1");
    assert.fieldEquals("Feedback", id, "value", "90");
    assert.fieldEquals("Feedback", id, "valueDecimals", "0");
    assert.fieldEquals("Feedback", id, "endpoint", "mcp");
    assert.fieldEquals("Feedback", id, "uri", "ipfs://f1");
    assert.fieldEquals("Feedback", id, "revoked", "false");
    assert.fieldEquals("Feedback", id, "registry", CAIP2);
    assert.fieldEquals("Registry", CAIP2, "reputationRegistry", REPUTATION_REGISTRY.toLowerCase());
  });

  test("valueDecimals rescales the score so scales are comparable", () => {
    // Two clients express the same 0.9 rating at different scales. Without rescaling, the
    // agent's mean would be 4350 instead of 0.9.
    handleNewFeedback(
      createNewFeedback(0, CLIENT, 1, 9, 1, "quality", "", "", "ipfs://a", 2, 2000),
    );
    handleNewFeedback(
      createNewFeedback(0, OTHER_CLIENT, 1, 8700, 4, "quality", "", "", "ipfs://b", 3, 2000),
    );

    assert.fieldEquals("Feedback", feedbackId(0, CLIENT, 1), "score", "0.9");
    assert.fieldEquals("Feedback", feedbackId(0, OTHER_CLIENT, 1), "score", "0.87");
    assert.fieldEquals("Agent", agentId(0), "averageScore", "0.885");
  });

  test("a negative score is preserved, since int128 permits one", () => {
    handleNewFeedback(
      createNewFeedback(0, CLIENT, 1, -50, 0, "dispute", "", "", "ipfs://neg", 2, 2000),
    );

    assert.fieldEquals("Feedback", feedbackId(0, CLIENT, 1), "value", "-50");
    assert.fieldEquals("Feedback", feedbackId(0, CLIENT, 1), "score", "-50");
    assert.fieldEquals("Agent", agentId(0), "averageScore", "-50");
  });

  test("tags drop empty entries", () => {
    handleNewFeedback(
      createNewFeedback(0, CLIENT, 1, 80, 0, "latency", "", "", "ipfs://a", 2, 2000),
    );
    handleNewFeedback(
      createNewFeedback(0, CLIENT, 2, 80, 0, "latency", "uptime", "", "ipfs://b", 3, 2000),
    );

    assert.fieldEquals("Feedback", feedbackId(0, CLIENT, 1), "tags", "[latency]");
    assert.fieldEquals("Feedback", feedbackId(0, CLIENT, 2), "tags", "[latency, uptime]");
  });

  test("a client rating the same agent twice counts as one agent rated", () => {
    handleNewFeedback(createNewFeedback(0, CLIENT, 1, 80, 0, "t", "", "", "ipfs://a", 2, 2000));
    handleNewFeedback(createNewFeedback(0, CLIENT, 2, 60, 0, "t", "", "", "ipfs://b", 3, 3000));

    const clientId = CAIP2 + "/client/" + CLIENT.toLowerCase();
    assert.fieldEquals("Client", clientId, "feedbackCount", "2");
    assert.fieldEquals("Client", clientId, "agentsRated", "1");
    assert.fieldEquals("Agent", agentId(0), "feedbackCount", "2");
    assert.fieldEquals("Agent", agentId(0), "averageScore", "70");
    assert.fieldEquals("Registry", CAIP2, "clientCount", "1");
  });

  test("revocation corrects the averages instead of deleting the entry", () => {
    handleNewFeedback(createNewFeedback(0, CLIENT, 1, 100, 0, "t", "", "", "ipfs://a", 2, 2000));
    handleNewFeedback(
      createNewFeedback(0, OTHER_CLIENT, 1, 20, 0, "t", "", "", "ipfs://b", 3, 2000),
    );
    assert.fieldEquals("Agent", agentId(0), "averageScore", "60");

    handleFeedbackRevoked(createFeedbackRevoked(0, OTHER_CLIENT, 1, 4, 3000));

    // The row survives with revoked=true; only the aggregates move.
    assert.entityCount("Feedback", 2);
    assert.fieldEquals("Feedback", feedbackId(0, OTHER_CLIENT, 1), "revoked", "true");
    assert.fieldEquals("Feedback", feedbackId(0, OTHER_CLIENT, 1), "revokedAt", "3000");
    assert.fieldEquals("Agent", agentId(0), "feedbackCount", "2");
    assert.fieldEquals("Agent", agentId(0), "activeFeedbackCount", "1");
    assert.fieldEquals("Agent", agentId(0), "revokedFeedbackCount", "1");
    assert.fieldEquals("Agent", agentId(0), "averageScore", "100");
    assert.fieldEquals("Registry", CAIP2, "activeFeedbackCount", "1");
    assert.fieldEquals("Registry", CAIP2, "averageScore", "100");
  });

  test("revoking the only feedback returns the average to zero, not a division by zero", () => {
    handleNewFeedback(createNewFeedback(0, CLIENT, 1, 77, 0, "t", "", "", "ipfs://a", 2, 2000));
    handleFeedbackRevoked(createFeedbackRevoked(0, CLIENT, 1, 3, 3000));

    assert.fieldEquals("Agent", agentId(0), "activeFeedbackCount", "0");
    assert.fieldEquals("Agent", agentId(0), "averageScore", "0");
    assert.fieldEquals("Agent", agentId(0), "scoreSum", "0");
  });

  test("a revocation for feedback this deployment never saw leaves aggregates alone", () => {
    handleNewFeedback(createNewFeedback(0, CLIENT, 1, 40, 0, "t", "", "", "ipfs://a", 2, 2000));
    // Index 9 was written before this subgraph's startBlock. Subtracting a score that was
    // never added would push the average below its true value forever.
    handleFeedbackRevoked(createFeedbackRevoked(0, CLIENT, 9, 3, 3000));

    assert.fieldEquals("Agent", agentId(0), "activeFeedbackCount", "1");
    assert.fieldEquals("Agent", agentId(0), "averageScore", "40");
    assert.fieldEquals("Agent", agentId(0), "revokedFeedbackCount", "0");
  });

  test("a duplicate revocation log is idempotent", () => {
    handleNewFeedback(createNewFeedback(0, CLIENT, 1, 40, 0, "t", "", "", "ipfs://a", 2, 2000));
    handleFeedbackRevoked(createFeedbackRevoked(0, CLIENT, 1, 3, 3000));
    handleFeedbackRevoked(createFeedbackRevoked(0, CLIENT, 1, 4, 4000));

    assert.fieldEquals("Agent", agentId(0), "revokedFeedbackCount", "1");
    assert.fieldEquals("Agent", agentId(0), "activeFeedbackCount", "0");
  });

  test("responses attach to the feedback they answer", () => {
    handleNewFeedback(createNewFeedback(0, CLIENT, 1, 40, 0, "t", "", "", "ipfs://a", 2, 2000));
    handleResponseAppended(
      createResponseAppended(0, CLIENT, 1, OWNER, "ipfs://reply", 3, 3000),
    );

    assert.entityCount("FeedbackResponse", 1);
    assert.fieldEquals("Feedback", feedbackId(0, CLIENT, 1), "responseCount", "1");
    assert.fieldEquals("Registry", CAIP2, "feedbackResponseCount", "1");
  });

  test("a response to unseen feedback is dropped rather than orphaned", () => {
    handleResponseAppended(
      createResponseAppended(0, CLIENT, 7, OWNER, "ipfs://reply", 2, 2000),
    );

    assert.entityCount("FeedbackResponse", 0);
    assert.fieldEquals("Registry", CAIP2, "feedbackResponseCount", "0");
  });

  test("feedback for an agent registered before startBlock still indexes", () => {
    // getOrCreateAgent stubs the agent so the feedback is not silently discarded.
    handleNewFeedback(createNewFeedback(99, CLIENT, 1, 55, 0, "t", "", "", "ipfs://a", 2, 2000));

    assert.fieldEquals("Agent", agentId(99), "averageScore", "55");
    assert.fieldEquals("Agent", agentId(99), "metadataURI", "");
  });

  test("the day roll-up separates feedback given from feedback revoked", () => {
    handleNewFeedback(createNewFeedback(0, CLIENT, 1, 10, 0, "t", "", "", "ipfs://a", 2, 86400));
    handleFeedbackRevoked(createFeedbackRevoked(0, CLIENT, 1, 3, 90000));

    assert.fieldEquals("RegistryDayData", CAIP2 + "/day/86400", "feedbackGiven", "1");
    assert.fieldEquals("RegistryDayData", CAIP2 + "/day/86400", "feedbackRevoked", "1");
  });
});
