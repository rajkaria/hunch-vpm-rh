import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";

import {
  FeedbackRevoked,
  NewFeedback,
  ResponseAppended,
} from "../generated/ReputationRegistry/ReputationRegistry";
import { Feedback, FeedbackResponse } from "../generated/schema";
import { BIGINT_ONE, BIGINT_ZERO, SOURCE_REPUTATION } from "./constants";
import {
  eventEntityId,
  getOrCreateAgent,
  getOrCreateClient,
  getOrCreateDayData,
  getOrCreateRegistry,
  packTags,
  safeAverage,
  scaleValue,
} from "./helpers";

/**
 * Feedback is keyed on (agentId, clientAddress, feedbackIndex): the registry lets one client
 * rate the same agent repeatedly, and indexes are 1-based per pair. Using the log position as
 * the id instead would break revocation, which only ever names that triple.
 */
function feedbackEntityId(agentEntity: string, client: Address, index: BigInt): string {
  return agentEntity + "/feedback/" + client.toHexString() + "/" + index.toString();
}

export function handleNewFeedback(event: NewFeedback): void {
  const registry = getOrCreateRegistry(SOURCE_REPUTATION, event);
  const agent = getOrCreateAgent(registry, event.params.agentId, event);
  const client = getOrCreateClient(registry, event.params.clientAddress, event);

  const score = scaleValue(event.params.value, event.params.valueDecimals);
  const id = feedbackEntityId(agent.id, event.params.clientAddress, event.params.feedbackIndex);

  const feedback = new Feedback(id);
  feedback.agent = agent.id;
  feedback.registry = registry.id;
  feedback.chainId = registry.chainId;
  feedback.author = event.params.clientAddress as Bytes;
  feedback.client = client.id;
  feedback.index = event.params.feedbackIndex;
  feedback.score = score;
  feedback.value = event.params.value;
  feedback.valueDecimals = event.params.valueDecimals;
  feedback.tags = packTags(event.params.tag1, event.params.tag2);
  feedback.tag1 = event.params.tag1;
  feedback.tag2 = event.params.tag2;
  feedback.endpoint = event.params.endpoint;
  feedback.uri = event.params.feedbackURI;
  feedback.feedbackHash = event.params.feedbackHash;
  feedback.revoked = false;
  feedback.createdAt = event.block.timestamp;
  feedback.createdAtBlock = event.block.number;
  feedback.createdTx = event.transaction.hash;
  feedback.responseCount = BIGINT_ZERO;
  feedback.save();

  // feedbackIndex 1 is this client's first entry for this agent, so it is also the moment the
  // client starts counting as having rated one more agent.
  if (event.params.feedbackIndex.equals(BIGINT_ONE)) {
    client.agentsRated = client.agentsRated.plus(BIGINT_ONE);
  }
  client.feedbackCount = client.feedbackCount.plus(BIGINT_ONE);
  client.activeFeedbackCount = client.activeFeedbackCount.plus(BIGINT_ONE);
  client.save();

  agent.feedbackCount = agent.feedbackCount.plus(BIGINT_ONE);
  agent.activeFeedbackCount = agent.activeFeedbackCount.plus(BIGINT_ONE);
  agent.scoreSum = agent.scoreSum.plus(score);
  agent.averageScore = safeAverage(agent.scoreSum, agent.activeFeedbackCount);
  agent.lastFeedbackAt = event.block.timestamp;
  agent.updatedAt = event.block.timestamp;
  agent.save();

  registry.feedbackCount = registry.feedbackCount.plus(BIGINT_ONE);
  registry.activeFeedbackCount = registry.activeFeedbackCount.plus(BIGINT_ONE);
  registry.scoreSum = registry.scoreSum.plus(score);
  registry.averageScore = safeAverage(registry.scoreSum, registry.activeFeedbackCount);
  registry.save();

  const day = getOrCreateDayData(registry, event);
  day.feedbackGiven = day.feedbackGiven.plus(BIGINT_ONE);
  day.save();
}

/**
 * Revocation is a flag flip on chain, not a delete, so the entity is kept and only the
 * aggregates are corrected. Subtracting the stored score is what makes this O(1) instead of a
 * re-scan of every entry the agent ever received.
 */
export function handleFeedbackRevoked(event: FeedbackRevoked): void {
  const registry = getOrCreateRegistry(SOURCE_REPUTATION, event);
  const agent = getOrCreateAgent(registry, event.params.agentId, event);
  const id = feedbackEntityId(agent.id, event.params.clientAddress, event.params.feedbackIndex);

  const feedback = Feedback.load(id);
  // The registry rejects a second revocation, so a missing or already-revoked entry can only
  // mean the subgraph started after the feedback was written. Leaving the aggregates alone is
  // the only safe response: subtracting a score we never added would corrupt the average.
  if (feedback == null || feedback.revoked) return;

  feedback.revoked = true;
  feedback.revokedAt = event.block.timestamp;
  feedback.revokedAtBlock = event.block.number;
  feedback.save();

  agent.activeFeedbackCount = agent.activeFeedbackCount.minus(BIGINT_ONE);
  agent.revokedFeedbackCount = agent.revokedFeedbackCount.plus(BIGINT_ONE);
  agent.scoreSum = agent.scoreSum.minus(feedback.score);
  agent.averageScore = safeAverage(agent.scoreSum, agent.activeFeedbackCount);
  agent.updatedAt = event.block.timestamp;
  agent.save();

  const client = getOrCreateClient(registry, event.params.clientAddress, event);
  client.activeFeedbackCount = client.activeFeedbackCount.minus(BIGINT_ONE);
  client.revokedFeedbackCount = client.revokedFeedbackCount.plus(BIGINT_ONE);
  client.save();

  registry.activeFeedbackCount = registry.activeFeedbackCount.minus(BIGINT_ONE);
  registry.revokedFeedbackCount = registry.revokedFeedbackCount.plus(BIGINT_ONE);
  registry.scoreSum = registry.scoreSum.minus(feedback.score);
  registry.averageScore = safeAverage(registry.scoreSum, registry.activeFeedbackCount);
  registry.save();

  const day = getOrCreateDayData(registry, event);
  day.feedbackRevoked = day.feedbackRevoked.plus(BIGINT_ONE);
  day.save();
}

export function handleResponseAppended(event: ResponseAppended): void {
  const registry = getOrCreateRegistry(SOURCE_REPUTATION, event);
  const agent = getOrCreateAgent(registry, event.params.agentId, event);
  const feedbackId = feedbackEntityId(
    agent.id,
    event.params.clientAddress,
    event.params.feedbackIndex,
  );

  const feedback = Feedback.load(feedbackId);
  if (feedback == null) return;

  const response = new FeedbackResponse(eventEntityId(registry.id, "response", event));
  response.feedback = feedback.id;
  response.agent = agent.id;
  response.responder = event.params.responder as Bytes;
  response.uri = event.params.responseURI;
  response.responseHash = event.params.responseHash;
  response.createdAt = event.block.timestamp;
  response.createdAtBlock = event.block.number;
  response.createdTx = event.transaction.hash;
  response.save();

  feedback.responseCount = feedback.responseCount.plus(BIGINT_ONE);
  feedback.save();

  registry.feedbackResponseCount = registry.feedbackResponseCount.plus(BIGINT_ONE);
  registry.save();
}
