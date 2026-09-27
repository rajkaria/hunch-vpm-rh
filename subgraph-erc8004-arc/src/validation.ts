import { BigInt, Bytes } from "@graphprotocol/graph-ts";

import {
  ValidationRequest,
  ValidationResponse,
} from "../generated/ValidationRegistry/ValidationRegistry";
import { Validation } from "../generated/schema";
import { BIGINT_ONE, SOURCE_VALIDATION } from "./constants";
import {
  getOrCreateAgent,
  getOrCreateDayData,
  getOrCreateRegistry,
  getOrCreateValidator,
  safeAverage,
} from "./helpers";

/**
 * The registry keys a validation on requestHash and rejects a duplicate, so requestHash alone
 * identifies the row for both halves of the two-step flow. The response updates the same entity
 * rather than creating a second one, which is what lets a consumer ask "which requests are
 * still outstanding" with a single status filter.
 */
function validationEntityId(registryId: string, requestHash: Bytes): string {
  return registryId + "/validation/" + requestHash.toHexString();
}

export function handleValidationRequest(event: ValidationRequest): void {
  const registry = getOrCreateRegistry(SOURCE_VALIDATION, event);
  const agent = getOrCreateAgent(registry, event.params.agentId, event);
  const validator = getOrCreateValidator(registry, event.params.validatorAddress, event);

  const id = validationEntityId(registry.id, event.params.requestHash);
  const validation = new Validation(id);
  validation.agent = agent.id;
  validation.registry = registry.id;
  validation.chainId = registry.chainId;
  validation.validator = validator.id;
  validation.validatorAddress = event.params.validatorAddress as Bytes;
  validation.requestHash = event.params.requestHash;
  validation.request = event.params.requestURI;
  validation.requestedAt = event.block.timestamp;
  validation.requestedAtBlock = event.block.number;
  validation.requestedTx = event.transaction.hash;
  validation.status = "REQUESTED";
  validation.save();

  validator.requestCount = validator.requestCount.plus(BIGINT_ONE);
  validator.save();

  agent.validationCount = agent.validationCount.plus(BIGINT_ONE);
  agent.updatedAt = event.block.timestamp;
  agent.save();

  registry.validationRequestCount = registry.validationRequestCount.plus(BIGINT_ONE);
  registry.save();

  const day = getOrCreateDayData(registry, event);
  day.validationsRequested = day.validationsRequested.plus(BIGINT_ONE);
  day.save();
}

export function handleValidationResponse(event: ValidationResponse): void {
  const registry = getOrCreateRegistry(SOURCE_VALIDATION, event);
  const id = validationEntityId(registry.id, event.params.requestHash);

  const validation = Validation.load(id);
  // validationResponse reverts for an unknown requestHash, so a miss here means the request
  // predates this deployment's startBlock. Fabricating the request half would put a validation
  // in the store with no requestURI and a wrong requestedAt, so drop it instead.
  if (validation == null) return;

  const alreadyResponded = validation.status == "RESPONDED";
  // Read before the overwrite below. The generated getter for a nullable Int returns 0 when
  // unset, which is only safe to use because alreadyResponded gates every read of it.
  const previousValue = alreadyResponded ? BigInt.fromI32(validation.response) : BigInt.zero();

  const response = event.params.response;
  validation.response = response;
  validation.responseURI = event.params.responseURI;
  validation.responseHash = event.params.responseHash;
  validation.tag = event.params.tag;
  validation.respondedAt = event.block.timestamp;
  validation.respondedAtBlock = event.block.number;
  validation.respondedTx = event.transaction.hash;
  validation.status = "RESPONDED";
  validation.save();

  const responseValue = BigInt.fromI32(response);
  const validator = getOrCreateValidator(registry, event.params.validatorAddress, event);
  const agent = getOrCreateAgent(registry, event.params.agentId, event);

  // The contract permits a validator to overwrite its own response. Counting it twice would
  // make the mean drift, so a repeat swaps the old score out instead of adding to the count.
  if (alreadyResponded) {
    validator.responseSum = validator.responseSum.minus(previousValue).plus(responseValue);
    agent.validationResponseSum = agent.validationResponseSum.minus(previousValue).plus(responseValue);
    registry.validationResponseSum = registry.validationResponseSum
      .minus(previousValue)
      .plus(responseValue);
  } else {
    validator.responseCount = validator.responseCount.plus(BIGINT_ONE);
    validator.responseSum = validator.responseSum.plus(responseValue);
    agent.validationResponseCount = agent.validationResponseCount.plus(BIGINT_ONE);
    agent.validationResponseSum = agent.validationResponseSum.plus(responseValue);
    registry.validationResponseCount = registry.validationResponseCount.plus(BIGINT_ONE);
    registry.validationResponseSum = registry.validationResponseSum.plus(responseValue);

    const day = getOrCreateDayData(registry, event);
    day.validationsResponded = day.validationsResponded.plus(BIGINT_ONE);
    day.save();
  }

  validator.averageResponse = safeAverage(
    validator.responseSum.toBigDecimal(),
    validator.responseCount,
  );
  validator.save();

  agent.averageValidationResponse = safeAverage(
    agent.validationResponseSum.toBigDecimal(),
    agent.validationResponseCount,
  );
  agent.updatedAt = event.block.timestamp;
  agent.save();

  registry.averageValidationResponse = safeAverage(
    registry.validationResponseSum.toBigDecimal(),
    registry.validationResponseCount,
  );
  registry.save();
}
