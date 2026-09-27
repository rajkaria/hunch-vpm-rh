import {
  Address,
  BigDecimal,
  BigInt,
  Bytes,
  dataSource,
  ethereum,
} from "@graphprotocol/graph-ts";

import { Agent, Client, Registry, RegistryDayData, Validator } from "../generated/schema";
import {
  BIGDECIMAL_ZERO,
  BIGINT_ONE,
  BIGINT_ZERO,
  MAX_VALUE_DECIMALS,
  SECONDS_PER_DAY,
  SOURCE_IDENTITY,
  SOURCE_REPUTATION,
  SOURCE_VALIDATION,
  ZERO_ADDRESS,
} from "./constants";

/**
 * graph-ts does not expose the chain id, only the network slug the manifest was built for.
 * Every chain the standardized ERC-8004 schema is deployed on is listed here so that the same
 * mapping source compiles and produces identical CAIP-2 ids wherever it is pointed.
 */
export function chainIdForNetwork(network: string): BigInt {
  if (network == "arc") return BigInt.fromI32(5042);
  if (network == "arc-testnet") return BigInt.fromI32(5042002);
  if (network == "mainnet") return BigInt.fromI32(1);
  if (network == "sepolia") return BigInt.fromI32(11155111);
  if (network == "base") return BigInt.fromI32(8453);
  if (network == "base-sepolia") return BigInt.fromI32(84532);
  if (network == "bsc") return BigInt.fromI32(56);
  if (network == "chapel") return BigInt.fromI32(97);
  if (network == "matic") return BigInt.fromI32(137);
  if (network == "monad-testnet") return BigInt.fromI32(10143);
  return BIGINT_ZERO;
}

/**
 * CAIP-2 id used to namespace every entity id. Unknown networks fall back to the slug rather
 * than to eip155:0, so two unrecognised chains indexed into one store still cannot collide.
 */
export function caip2ForNetwork(network: string): string {
  const chainId = chainIdForNetwork(network);
  if (chainId.equals(BIGINT_ZERO)) return "network:" + network;
  return "eip155:" + chainId.toString();
}

export function getOrCreateRegistry(source: string, event: ethereum.Event): Registry {
  const network = dataSource.network();
  const id = caip2ForNetwork(network);
  let registry = Registry.load(id);

  if (registry == null) {
    registry = new Registry(id);
    registry.chainId = chainIdForNetwork(network);
    registry.network = network;
    // Each address is filled in by the first event from that data source. Until then it reads
    // as the zero address, which is honest: this deployment has not seen that contract yet.
    registry.identityRegistry = Bytes.fromHexString(ZERO_ADDRESS.toHexString()) as Bytes;
    registry.reputationRegistry = Bytes.fromHexString(ZERO_ADDRESS.toHexString()) as Bytes;
    registry.validationRegistry = Bytes.fromHexString(ZERO_ADDRESS.toHexString()) as Bytes;
    registry.agentCount = BIGINT_ZERO;
    registry.liveAgentCount = BIGINT_ZERO;
    registry.feedbackCount = BIGINT_ZERO;
    registry.activeFeedbackCount = BIGINT_ZERO;
    registry.revokedFeedbackCount = BIGINT_ZERO;
    registry.feedbackResponseCount = BIGINT_ZERO;
    registry.validationRequestCount = BIGINT_ZERO;
    registry.validationResponseCount = BIGINT_ZERO;
    registry.clientCount = BIGINT_ZERO;
    registry.validatorCount = BIGINT_ZERO;
    registry.averageScore = BIGDECIMAL_ZERO;
    registry.scoreSum = BIGDECIMAL_ZERO;
    registry.averageValidationResponse = BIGDECIMAL_ZERO;
    registry.validationResponseSum = BIGINT_ZERO;
  }

  const self = event.address as Bytes;
  if (source == SOURCE_IDENTITY) registry.identityRegistry = self;
  if (source == SOURCE_REPUTATION) registry.reputationRegistry = self;
  if (source == SOURCE_VALIDATION) registry.validationRegistry = self;

  registry.lastUpdatedAt = event.block.timestamp;
  registry.lastUpdatedBlock = event.block.number;
  registry.save();
  return registry;
}

export function agentEntityId(registryId: string, agentId: BigInt): string {
  return registryId + "/agent/" + agentId.toString();
}

/** One id shape for every log-derived entity: tx hash plus log index is unique within a chain. */
export function eventEntityId(prefix: string, kind: string, event: ethereum.Event): string {
  return (
    prefix + "/" + kind + "/" + event.transaction.hash.toHexString() + "-" + event.logIndex.toString()
  );
}

/**
 * Loads the agent, creating a placeholder if it is somehow missing.
 *
 * The registries make this unreachable in practice: giveFeedback and validationRequest both
 * call into the IdentityRegistry and revert for a nonexistent token. The placeholder exists so
 * that a manifest misconfiguration (an identity startBlock set past a registration, say) shows
 * up as an agent with no registeredTx rather than as silently dropped feedback.
 */
export function getOrCreateAgent(registry: Registry, agentId: BigInt, event: ethereum.Event): Agent {
  const id = agentEntityId(registry.id, agentId);
  let agent = Agent.load(id);
  if (agent != null) return agent;

  agent = new Agent(id);
  agent.registry = registry.id;
  agent.chainId = registry.chainId;
  agent.agentId = agentId;
  agent.tokenId = agentId;
  agent.owner = Bytes.fromHexString(ZERO_ADDRESS.toHexString()) as Bytes;
  agent.metadataURI = "";
  agent.registeredAt = event.block.timestamp;
  agent.registeredAtBlock = event.block.number;
  agent.registeredTx = event.transaction.hash;
  agent.updatedAt = event.block.timestamp;
  agent.burned = false;
  agent.feedbackCount = BIGINT_ZERO;
  agent.activeFeedbackCount = BIGINT_ZERO;
  agent.revokedFeedbackCount = BIGINT_ZERO;
  agent.scoreSum = BIGDECIMAL_ZERO;
  agent.averageScore = BIGDECIMAL_ZERO;
  agent.validationCount = BIGINT_ZERO;
  agent.validationResponseCount = BIGINT_ZERO;
  agent.validationResponseSum = BIGINT_ZERO;
  agent.averageValidationResponse = BIGDECIMAL_ZERO;
  agent.save();

  registry.agentCount = registry.agentCount.plus(BIGINT_ONE);
  registry.liveAgentCount = registry.liveAgentCount.plus(BIGINT_ONE);
  registry.save();

  return agent;
}

export function getOrCreateClient(registry: Registry, address: Address, event: ethereum.Event): Client {
  const id = registry.id + "/client/" + address.toHexString();
  let client = Client.load(id);
  if (client != null) {
    client.lastSeenAt = event.block.timestamp;
    return client;
  }

  client = new Client(id);
  client.registry = registry.id;
  client.address = address as Bytes;
  client.feedbackCount = BIGINT_ZERO;
  client.activeFeedbackCount = BIGINT_ZERO;
  client.revokedFeedbackCount = BIGINT_ZERO;
  client.agentsRated = BIGINT_ZERO;
  client.firstSeenAt = event.block.timestamp;
  client.lastSeenAt = event.block.timestamp;

  registry.clientCount = registry.clientCount.plus(BIGINT_ONE);
  registry.save();
  return client;
}

export function getOrCreateValidator(
  registry: Registry,
  address: Address,
  event: ethereum.Event,
): Validator {
  const id = registry.id + "/validator/" + address.toHexString();
  let validator = Validator.load(id);
  if (validator != null) {
    validator.lastSeenAt = event.block.timestamp;
    return validator;
  }

  validator = new Validator(id);
  validator.registry = registry.id;
  validator.address = address as Bytes;
  validator.requestCount = BIGINT_ZERO;
  validator.responseCount = BIGINT_ZERO;
  validator.responseSum = BIGINT_ZERO;
  validator.averageResponse = BIGDECIMAL_ZERO;
  validator.firstSeenAt = event.block.timestamp;
  validator.lastSeenAt = event.block.timestamp;

  registry.validatorCount = registry.validatorCount.plus(BIGINT_ONE);
  registry.save();
  return validator;
}

export function getOrCreateDayData(registry: Registry, event: ethereum.Event): RegistryDayData {
  const dayStart = (event.block.timestamp.toI32() / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  const id = registry.id + "/day/" + dayStart.toString();
  let day = RegistryDayData.load(id);
  if (day == null) {
    day = new RegistryDayData(id);
    day.registry = registry.id;
    day.date = dayStart;
    day.agentsRegistered = BIGINT_ZERO;
    day.feedbackGiven = BIGINT_ZERO;
    day.feedbackRevoked = BIGINT_ZERO;
    day.validationsRequested = BIGINT_ZERO;
    day.validationsResponded = BIGINT_ZERO;
  }
  day.totalAgents = registry.agentCount;
  return day;
}

export function exponentToBigDecimal(decimals: i32): BigDecimal {
  let result = BigDecimal.fromString("1");
  const ten = BigDecimal.fromString("10");
  for (let i = 0; i < decimals; i++) {
    result = result.times(ten);
  }
  return result;
}

/**
 * NewFeedback carries an int128 value and a separate uint8 scale. Rescaling here means a
 * consumer comparing agents never has to know that one client posted 87 with 0 decimals and
 * another posted 8700 with 2.
 */
export function scaleValue(value: BigInt, valueDecimals: i32): BigDecimal {
  let decimals = valueDecimals;
  if (decimals < 0) decimals = 0;
  if (decimals > MAX_VALUE_DECIMALS) decimals = MAX_VALUE_DECIMALS;
  return value.toBigDecimal().div(exponentToBigDecimal(decimals));
}

export function safeAverage(sum: BigDecimal, count: BigInt): BigDecimal {
  if (count.equals(BIGINT_ZERO)) return BIGDECIMAL_ZERO;
  return sum.div(count.toBigDecimal());
}

/** Drops empty entries, so an agent rated with only tag1 does not get a phantom "" tag. */
export function packTags(tag1: string, tag2: string): string[] {
  const tags: string[] = [];
  if (tag1.length > 0) tags.push(tag1);
  if (tag2.length > 0) tags.push(tag2);
  return tags;
}
