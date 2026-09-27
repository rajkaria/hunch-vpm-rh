import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { newMockEvent } from "matchstick-as/assembly/index";

import {
  Approval,
  MetadataSet,
  Registered,
  Transfer,
  URIUpdated,
} from "../../generated/IdentityRegistry/IdentityRegistry";
import {
  FeedbackRevoked,
  NewFeedback,
  ResponseAppended,
} from "../../generated/ReputationRegistry/ReputationRegistry";
import {
  ValidationRequest,
  ValidationResponse,
} from "../../generated/ValidationRegistry/ValidationRegistry";

// The live Arc testnet proxies. Mock events are stamped with these so the Registry row a test
// produces carries the same addresses an indexer would write.
export const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
export const VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272";

export const NETWORK = "arc-testnet";
export const CAIP2 = "eip155:5042002";

export const OWNER = "0x1111111111111111111111111111111111111111";
export const CLIENT = "0x2222222222222222222222222222222222222222";
export const OTHER_CLIENT = "0x3333333333333333333333333333333333333333";
export const VALIDATOR = "0x4444444444444444444444444444444444444444";
export const ZERO = "0x0000000000000000000000000000000000000000";

export function agentId(id: i32): string {
  return CAIP2 + "/agent/" + id.toString();
}

/**
 * newMockEvent() hands every event the same logIndex, so two events in one test would produce
 * the same id for log-keyed entities. Each factory takes an explicit logIndex instead.
 */
function base(source: string, logIndex: i32, timestamp: i32): ethereum.Event {
  const event = newMockEvent();
  event.address = Address.fromString(source);
  event.logIndex = BigInt.fromI32(logIndex);
  event.block.timestamp = BigInt.fromI32(timestamp);
  event.block.number = BigInt.fromI32(29241340 + logIndex);
  event.parameters = new Array<ethereum.EventParam>();
  return event;
}

function param(name: string, value: ethereum.Value): ethereum.EventParam {
  return new ethereum.EventParam(name, value);
}

export function createRegistered(
  id: i32,
  agentURI: string,
  owner: string,
  logIndex: i32,
  timestamp: i32,
): Registered {
  const event = changetype<Registered>(base(IDENTITY_REGISTRY, logIndex, timestamp));
  event.parameters.push(param("agentId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(id))));
  event.parameters.push(param("agentURI", ethereum.Value.fromString(agentURI)));
  event.parameters.push(param("owner", ethereum.Value.fromAddress(Address.fromString(owner))));
  return event;
}

export function createURIUpdated(
  id: i32,
  newURI: string,
  updatedBy: string,
  logIndex: i32,
  timestamp: i32,
): URIUpdated {
  const event = changetype<URIUpdated>(base(IDENTITY_REGISTRY, logIndex, timestamp));
  event.parameters.push(param("agentId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(id))));
  event.parameters.push(param("newURI", ethereum.Value.fromString(newURI)));
  event.parameters.push(
    param("updatedBy", ethereum.Value.fromAddress(Address.fromString(updatedBy))),
  );
  return event;
}

/**
 * The second parameter is the key again but indexed, so on chain it arrives as a topic hash.
 * The mapping reads the third (unindexed) parameter; the hash is filled in here for realism.
 */
export function createMetadataSet(
  id: i32,
  key: string,
  value: Bytes,
  logIndex: i32,
  timestamp: i32,
): MetadataSet {
  const event = changetype<MetadataSet>(base(IDENTITY_REGISTRY, logIndex, timestamp));
  event.parameters.push(param("agentId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(id))));
  event.parameters.push(
    param("indexedMetadataKey", ethereum.Value.fromBytes(Bytes.fromUTF8(key))),
  );
  event.parameters.push(param("metadataKey", ethereum.Value.fromString(key)));
  event.parameters.push(param("metadataValue", ethereum.Value.fromBytes(value)));
  return event;
}

export function createTransfer(
  from: string,
  to: string,
  tokenId: i32,
  logIndex: i32,
  timestamp: i32,
): Transfer {
  const event = changetype<Transfer>(base(IDENTITY_REGISTRY, logIndex, timestamp));
  event.parameters.push(param("from", ethereum.Value.fromAddress(Address.fromString(from))));
  event.parameters.push(param("to", ethereum.Value.fromAddress(Address.fromString(to))));
  event.parameters.push(
    param("tokenId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(tokenId))),
  );
  return event;
}

export function createApproval(
  owner: string,
  approved: string,
  tokenId: i32,
  logIndex: i32,
  timestamp: i32,
): Approval {
  const event = changetype<Approval>(base(IDENTITY_REGISTRY, logIndex, timestamp));
  event.parameters.push(param("owner", ethereum.Value.fromAddress(Address.fromString(owner))));
  event.parameters.push(
    param("approved", ethereum.Value.fromAddress(Address.fromString(approved))),
  );
  event.parameters.push(
    param("tokenId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(tokenId))),
  );
  return event;
}

export function createNewFeedback(
  agent: i32,
  client: string,
  index: i32,
  value: i32,
  valueDecimals: i32,
  tag1: string,
  tag2: string,
  endpoint: string,
  uri: string,
  logIndex: i32,
  timestamp: i32,
): NewFeedback {
  const event = changetype<NewFeedback>(base(REPUTATION_REGISTRY, logIndex, timestamp));
  event.parameters.push(param("agentId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(agent))));
  event.parameters.push(
    param("clientAddress", ethereum.Value.fromAddress(Address.fromString(client))),
  );
  event.parameters.push(
    param("feedbackIndex", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(index))),
  );
  // value is an int128, so it must go in signed: a negative score is legal on chain.
  event.parameters.push(param("value", ethereum.Value.fromSignedBigInt(BigInt.fromI32(value))));
  event.parameters.push(
    param("valueDecimals", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(valueDecimals))),
  );
  event.parameters.push(param("indexedTag1", ethereum.Value.fromBytes(Bytes.fromUTF8(tag1))));
  event.parameters.push(param("tag1", ethereum.Value.fromString(tag1)));
  event.parameters.push(param("tag2", ethereum.Value.fromString(tag2)));
  event.parameters.push(param("endpoint", ethereum.Value.fromString(endpoint)));
  event.parameters.push(param("feedbackURI", ethereum.Value.fromString(uri)));
  event.parameters.push(
    param("feedbackHash", ethereum.Value.fromBytes(Bytes.fromUTF8("hash:" + uri))),
  );
  return event;
}

export function createFeedbackRevoked(
  agent: i32,
  client: string,
  index: i32,
  logIndex: i32,
  timestamp: i32,
): FeedbackRevoked {
  const event = changetype<FeedbackRevoked>(base(REPUTATION_REGISTRY, logIndex, timestamp));
  event.parameters.push(param("agentId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(agent))));
  event.parameters.push(
    param("clientAddress", ethereum.Value.fromAddress(Address.fromString(client))),
  );
  event.parameters.push(
    param("feedbackIndex", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(index))),
  );
  return event;
}

export function createResponseAppended(
  agent: i32,
  client: string,
  index: i32,
  responder: string,
  uri: string,
  logIndex: i32,
  timestamp: i32,
): ResponseAppended {
  const event = changetype<ResponseAppended>(base(REPUTATION_REGISTRY, logIndex, timestamp));
  event.parameters.push(param("agentId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(agent))));
  event.parameters.push(
    param("clientAddress", ethereum.Value.fromAddress(Address.fromString(client))),
  );
  event.parameters.push(
    param("feedbackIndex", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(index))),
  );
  event.parameters.push(
    param("responder", ethereum.Value.fromAddress(Address.fromString(responder))),
  );
  event.parameters.push(param("responseURI", ethereum.Value.fromString(uri)));
  event.parameters.push(
    param("responseHash", ethereum.Value.fromBytes(Bytes.fromUTF8("hash:" + uri))),
  );
  return event;
}

export function createValidationRequest(
  validator: string,
  agent: i32,
  requestURI: string,
  requestHash: Bytes,
  logIndex: i32,
  timestamp: i32,
): ValidationRequest {
  const event = changetype<ValidationRequest>(base(VALIDATION_REGISTRY, logIndex, timestamp));
  event.parameters.push(
    param("validatorAddress", ethereum.Value.fromAddress(Address.fromString(validator))),
  );
  event.parameters.push(param("agentId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(agent))));
  event.parameters.push(param("requestURI", ethereum.Value.fromString(requestURI)));
  event.parameters.push(param("requestHash", ethereum.Value.fromBytes(requestHash)));
  return event;
}

export function createValidationResponse(
  validator: string,
  agent: i32,
  requestHash: Bytes,
  response: i32,
  responseURI: string,
  tag: string,
  logIndex: i32,
  timestamp: i32,
): ValidationResponse {
  const event = changetype<ValidationResponse>(base(VALIDATION_REGISTRY, logIndex, timestamp));
  event.parameters.push(
    param("validatorAddress", ethereum.Value.fromAddress(Address.fromString(validator))),
  );
  event.parameters.push(param("agentId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(agent))));
  event.parameters.push(param("requestHash", ethereum.Value.fromBytes(requestHash)));
  event.parameters.push(
    param("response", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(response))),
  );
  event.parameters.push(param("responseURI", ethereum.Value.fromString(responseURI)));
  event.parameters.push(
    param("responseHash", ethereum.Value.fromBytes(Bytes.fromUTF8("hash:" + responseURI))),
  );
  event.parameters.push(param("tag", ethereum.Value.fromString(tag)));
  return event;
}

export function hash32(seed: string): Bytes {
  const padded = (seed + "................................").slice(0, 32);
  return Bytes.fromUTF8(padded);
}
