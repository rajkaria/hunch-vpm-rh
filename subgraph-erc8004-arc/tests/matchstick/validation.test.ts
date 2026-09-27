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
import { handleValidationRequest, handleValidationResponse } from "../../src/validation";
import {
  CAIP2,
  NETWORK,
  OWNER,
  VALIDATION_REGISTRY,
  VALIDATOR,
  agentId,
  createRegistered,
  createValidationRequest,
  createValidationResponse,
  hash32,
} from "./factories";

const REQ = hash32("req-1");
const REQ_ID = CAIP2 + "/validation/" + REQ.toHexString();
const VALIDATOR_ID = CAIP2 + "/validator/" + VALIDATOR.toLowerCase();

describe("ValidationRegistry", () => {
  beforeEach(() => {
    dataSourceMock.setNetwork(NETWORK);
    handleRegistered(createRegistered(0, "ipfs://card", OWNER, 1, 1000));
  });

  afterEach(() => {
    clearStore();
    dataSourceMock.resetValues();
  });

  test("a request opens a validation in REQUESTED", () => {
    handleValidationRequest(
      createValidationRequest(VALIDATOR, 0, "ipfs://req", REQ, 2, 2000),
    );

    assert.entityCount("Validation", 1);
    assert.fieldEquals("Validation", REQ_ID, "status", "REQUESTED");
    assert.fieldEquals("Validation", REQ_ID, "request", "ipfs://req");
    assert.fieldEquals("Validation", REQ_ID, "validatorAddress", VALIDATOR.toLowerCase());
    assert.fieldEquals("Validation", REQ_ID, "agent", agentId(0));
    assert.fieldEquals("Validation", REQ_ID, "requestedAt", "2000");
    assert.fieldEquals("Agent", agentId(0), "validationCount", "1");
    assert.fieldEquals("Validator", VALIDATOR_ID, "requestCount", "1");
    assert.fieldEquals("Validator", VALIDATOR_ID, "responseCount", "0");
    assert.fieldEquals("Registry", CAIP2, "validationRegistry", VALIDATION_REGISTRY.toLowerCase());
  });

  test("the response completes the same row rather than opening a second one", () => {
    handleValidationRequest(createValidationRequest(VALIDATOR, 0, "ipfs://req", REQ, 2, 2000));
    handleValidationResponse(
      createValidationResponse(VALIDATOR, 0, REQ, 80, "ipfs://res", "soundness", 3, 3000),
    );

    // One entity for both halves: "which requests are still open" is a status filter.
    assert.entityCount("Validation", 1);
    assert.fieldEquals("Validation", REQ_ID, "status", "RESPONDED");
    assert.fieldEquals("Validation", REQ_ID, "response", "80");
    assert.fieldEquals("Validation", REQ_ID, "responseURI", "ipfs://res");
    assert.fieldEquals("Validation", REQ_ID, "tag", "soundness");
    assert.fieldEquals("Validation", REQ_ID, "respondedAt", "3000");
    // The request half is untouched.
    assert.fieldEquals("Validation", REQ_ID, "request", "ipfs://req");
    assert.fieldEquals("Validation", REQ_ID, "requestedAt", "2000");
  });

  test("responses roll up into agent, validator and chain averages", () => {
    const req2 = hash32("req-2");
    handleValidationRequest(createValidationRequest(VALIDATOR, 0, "ipfs://a", REQ, 2, 2000));
    handleValidationRequest(createValidationRequest(VALIDATOR, 0, "ipfs://b", req2, 3, 2000));
    handleValidationResponse(
      createValidationResponse(VALIDATOR, 0, REQ, 100, "ipfs://ra", "t", 4, 3000),
    );
    handleValidationResponse(
      createValidationResponse(VALIDATOR, 0, req2, 60, "ipfs://rb", "t", 5, 3000),
    );

    assert.fieldEquals("Agent", agentId(0), "validationCount", "2");
    assert.fieldEquals("Agent", agentId(0), "validationResponseCount", "2");
    assert.fieldEquals("Agent", agentId(0), "averageValidationResponse", "80");
    assert.fieldEquals("Validator", VALIDATOR_ID, "responseCount", "2");
    assert.fieldEquals("Validator", VALIDATOR_ID, "averageResponse", "80");
    assert.fieldEquals("Registry", CAIP2, "validationResponseCount", "2");
    assert.fieldEquals("Registry", CAIP2, "averageValidationResponse", "80");
  });

  test("a validator revising its response swaps the score instead of double counting", () => {
    handleValidationRequest(createValidationRequest(VALIDATOR, 0, "ipfs://a", REQ, 2, 2000));
    handleValidationResponse(
      createValidationResponse(VALIDATOR, 0, REQ, 100, "ipfs://ra", "t", 3, 3000),
    );
    // The contract lets the same validator overwrite its own response for a request.
    handleValidationResponse(
      createValidationResponse(VALIDATOR, 0, REQ, 40, "ipfs://rb", "t", 4, 4000),
    );

    assert.fieldEquals("Validation", REQ_ID, "response", "40");
    assert.fieldEquals("Agent", agentId(0), "validationResponseCount", "1");
    assert.fieldEquals("Agent", agentId(0), "averageValidationResponse", "40");
    assert.fieldEquals("Validator", VALIDATOR_ID, "responseCount", "1");
    assert.fieldEquals("Validator", VALIDATOR_ID, "averageResponse", "40");
    assert.fieldEquals("Registry", CAIP2, "validationResponseCount", "1");
    assert.fieldEquals("Registry", CAIP2, "averageValidationResponse", "40");
  });

  test("a response with no indexed request is dropped rather than half-built", () => {
    handleValidationResponse(
      createValidationResponse(VALIDATOR, 0, hash32("unseen"), 90, "ipfs://r", "t", 2, 2000),
    );

    // Fabricating the request half would put a row in the store with no requestURI and a
    // requestedAt that never happened.
    assert.entityCount("Validation", 0);
    assert.fieldEquals("Registry", CAIP2, "validationResponseCount", "0");
  });

  test("a rejection scores zero and still counts as a response", () => {
    handleValidationRequest(createValidationRequest(VALIDATOR, 0, "ipfs://a", REQ, 2, 2000));
    handleValidationResponse(
      createValidationResponse(VALIDATOR, 0, REQ, 0, "ipfs://ra", "rejected", 3, 3000),
    );

    // response 0 is a real verdict, not an absent one; status is what distinguishes them.
    assert.fieldEquals("Validation", REQ_ID, "status", "RESPONDED");
    assert.fieldEquals("Validation", REQ_ID, "response", "0");
    assert.fieldEquals("Agent", agentId(0), "validationResponseCount", "1");
  });

  test("the day roll-up separates requests from responses", () => {
    handleValidationRequest(createValidationRequest(VALIDATOR, 0, "ipfs://a", REQ, 2, 86400));
    handleValidationResponse(
      createValidationResponse(VALIDATOR, 0, REQ, 70, "ipfs://ra", "t", 3, 90000),
    );

    assert.fieldEquals("RegistryDayData", CAIP2 + "/day/86400", "validationsRequested", "1");
    assert.fieldEquals("RegistryDayData", CAIP2 + "/day/86400", "validationsResponded", "1");
  });
});
