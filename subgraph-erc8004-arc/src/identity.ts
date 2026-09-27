import { Bytes, ethereum } from "@graphprotocol/graph-ts";

import {
  Approval,
  MetadataSet,
  Registered,
  Transfer,
  URIUpdated,
} from "../generated/IdentityRegistry/IdentityRegistry";
import {
  Agent,
  AgentMetadata,
  AgentTransfer,
  Capability,
  CapabilityStat,
  Endpoint,
  Registry,
} from "../generated/schema";
import {
  BIGINT_ONE,
  BIGINT_ZERO,
  KEY_AGENT_WALLET,
  KEY_CAPABILITIES,
  KEY_DESCRIPTION,
  KEY_NAME,
  PREFIX_CAPABILITIES,
  PREFIX_CAPABILITY,
  PREFIX_ENDPOINT,
  PREFIX_ENDPOINTS,
  SOURCE_IDENTITY,
  ZERO_ADDRESS,
} from "./constants";
import {
  eventEntityId,
  getOrCreateAgent,
  getOrCreateDayData,
  getOrCreateRegistry,
} from "./helpers";

export function handleRegistered(event: Registered): void {
  const registry = getOrCreateRegistry(SOURCE_IDENTITY, event);
  const agent = getOrCreateAgent(registry, event.params.agentId, event);

  agent.owner = event.params.owner as Bytes;
  agent.metadataURI = event.params.agentURI;
  agent.registeredAt = event.block.timestamp;
  agent.registeredAtBlock = event.block.number;
  agent.registeredTx = event.transaction.hash;
  agent.updatedAt = event.block.timestamp;
  agent.save();

  const day = getOrCreateDayData(registry, event);
  day.agentsRegistered = day.agentsRegistered.plus(BIGINT_ONE);
  day.save();
}

export function handleURIUpdated(event: URIUpdated): void {
  const registry = getOrCreateRegistry(SOURCE_IDENTITY, event);
  const agent = getOrCreateAgent(registry, event.params.agentId, event);
  agent.metadataURI = event.params.newURI;
  agent.updatedAt = event.block.timestamp;
  agent.save();
}

/**
 * ERC-721 Transfer covers three cases: the mint that accompanies register(), a real ownership
 * move, and a burn. Registered fires in the same transaction as the mint, but the order of the
 * two logs is an implementation detail, so this handler creates the agent if it has not been
 * seen yet and never touches the URI.
 */
export function handleTransfer(event: Transfer): void {
  const registry = getOrCreateRegistry(SOURCE_IDENTITY, event);
  const agent = getOrCreateAgent(registry, event.params.tokenId, event);

  const to = event.params.to;
  agent.owner = to as Bytes;
  agent.updatedAt = event.block.timestamp;

  // A transfer clears any single-token approval, per ERC-721.
  agent.approved = null;

  if (to.equals(ZERO_ADDRESS) && !agent.burned) {
    agent.burned = true;
    registry.liveAgentCount = registry.liveAgentCount.minus(BIGINT_ONE);
    registry.save();
  }
  agent.save();

  const transfer = new AgentTransfer(eventEntityId(registry.id, "transfer", event));
  transfer.agent = agent.id;
  transfer.from = event.params.from as Bytes;
  transfer.to = to as Bytes;
  transfer.timestamp = event.block.timestamp;
  transfer.block = event.block.number;
  transfer.tx = event.transaction.hash;
  transfer.save();
}

export function handleApproval(event: Approval): void {
  const registry = getOrCreateRegistry(SOURCE_IDENTITY, event);
  const agent = getOrCreateAgent(registry, event.params.tokenId, event);
  const approved = event.params.approved;
  agent.approved = approved.equals(ZERO_ADDRESS) ? null : (approved as Bytes);
  agent.updatedAt = event.block.timestamp;
  agent.save();
}

/**
 * The registry imposes no key convention, so every entry is stored verbatim as AgentMetadata
 * and a documented subset is additionally projected onto the standardized Agent fields. Keys
 * this mapping does not recognise stay queryable through Agent.metadata, which is what keeps
 * the schema usable for registries that adopt a different convention later.
 */
export function handleMetadataSet(event: MetadataSet): void {
  const registry = getOrCreateRegistry(SOURCE_IDENTITY, event);
  const agent = getOrCreateAgent(registry, event.params.agentId, event);

  const key = event.params.metadataKey;
  const raw = event.params.metadataValue;
  const text = raw.toString();

  const entryId = agent.id + "/metadata/" + key;
  let entry = AgentMetadata.load(entryId);
  if (entry == null) {
    entry = new AgentMetadata(entryId);
    entry.agent = agent.id;
    entry.key = key;
  }
  entry.value = raw;
  entry.valueString = text;
  entry.updatedAt = event.block.timestamp;
  entry.updatedAtBlock = event.block.number;
  entry.save();

  if (key == KEY_AGENT_WALLET) {
    // Written by the registry as abi.encodePacked(address): exactly 20 bytes. The registry
    // also clears this entry on every ownership move and on unsetAgentWallet, which arrives
    // as a zero-length value and must clear the field: the wallet an agent signs as cannot be
    // allowed to outlive the ownership that set it. Any other length means a different
    // contract than the one this subgraph was built against, so the last good value stands
    // rather than an address assembled from the wrong number of bytes.
    if (raw.length == 20) {
      agent.agentWallet = raw;
    } else if (raw.length == 0) {
      agent.agentWallet = null;
    }
  } else if (key == KEY_NAME) {
    agent.name = text;
  } else if (key == KEY_DESCRIPTION) {
    agent.description = text;
  } else if (key == KEY_CAPABILITIES) {
    const names = text.split(",");
    for (let i = 0; i < names.length; i++) {
      upsertCapability(registry, agent, names[i], "", event);
    }
  } else if (key.startsWith(PREFIX_ENDPOINTS)) {
    upsertEndpoint(agent, key.slice(PREFIX_ENDPOINTS.length), text, event);
  } else if (key.startsWith(PREFIX_ENDPOINT)) {
    upsertEndpoint(agent, key.slice(PREFIX_ENDPOINT.length), text, event);
  } else if (key.startsWith(PREFIX_CAPABILITIES)) {
    upsertCapability(registry, agent, key.slice(PREFIX_CAPABILITIES.length), text, event);
  } else if (key.startsWith(PREFIX_CAPABILITY)) {
    upsertCapability(registry, agent, key.slice(PREFIX_CAPABILITY.length), text, event);
  }

  agent.updatedAt = event.block.timestamp;
  agent.save();
}

function upsertEndpoint(agent: Agent, protocol: string, uri: string, event: ethereum.Event): void {
  const name = protocol.trim().toLowerCase();
  if (name.length == 0) return;

  const id = agent.id + "/endpoint/" + name;
  let endpoint = Endpoint.load(id);
  if (endpoint == null) {
    endpoint = new Endpoint(id);
    endpoint.agent = agent.id;
    endpoint.protocol = name;
  }
  endpoint.uri = uri;
  endpoint.updatedAt = event.block.timestamp;
  endpoint.save();
}

function upsertCapability(
  registry: Registry,
  agent: Agent,
  rawName: string,
  value: string,
  event: ethereum.Event,
): void {
  const name = rawName.trim();
  if (name.length == 0) return;

  const id = agent.id + "/capability/" + name;
  let capability = Capability.load(id);
  if (capability == null) {
    capability = new Capability(id);
    capability.agent = agent.id;
    capability.name = name;
    capability.addedAt = event.block.timestamp;

    // CapabilityStat counts agents, not writes, so it only moves the first time this agent
    // advertises the capability. Re-setting the same key must not inflate it.
    const statId = registry.id + "/capability/" + name;
    let stat = CapabilityStat.load(statId);
    if (stat == null) {
      stat = new CapabilityStat(statId);
      stat.registry = registry.id;
      stat.name = name;
      stat.agentCount = BIGINT_ZERO;
    }
    stat.agentCount = stat.agentCount.plus(BIGINT_ONE);
    stat.save();
  }
  capability.value = value;
  capability.updatedAt = event.block.timestamp;
  capability.save();
}
