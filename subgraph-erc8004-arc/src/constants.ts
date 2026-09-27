import { Address, BigDecimal, BigInt } from "@graphprotocol/graph-ts";

export const BIGINT_ZERO = BigInt.fromI32(0);
export const BIGINT_ONE = BigInt.fromI32(1);
export const BIGDECIMAL_ZERO = BigDecimal.fromString("0");

export const ZERO_ADDRESS = Address.fromString("0x0000000000000000000000000000000000000000");

export const SECONDS_PER_DAY = 86400;

// Which of the three registries a handler belongs to. Passed into getOrCreateRegistry so the
// Registry row can record each contract address from dataSource.address() instead of hardcoding
// them, which would go stale the moment `graph build --network arc` rewrites the manifest.
export const SOURCE_IDENTITY = "identity";
export const SOURCE_REPUTATION = "reputation";
export const SOURCE_VALIDATION = "validation";

// Reserved metadata key. The registry sets it on every register() and forbids it in setMetadata.
export const KEY_AGENT_WALLET = "agentWallet";
export const KEY_NAME = "name";
export const KEY_DESCRIPTION = "description";
export const KEY_CAPABILITIES = "capabilities";

// Prefixes this mapping interprets. The registry itself imposes no key convention, so anything
// not matched here is still preserved verbatim as an AgentMetadata row.
export const PREFIX_ENDPOINTS = "endpoints.";
export const PREFIX_ENDPOINT = "endpoint.";
export const PREFIX_CAPABILITIES = "capabilities.";
export const PREFIX_CAPABILITY = "capability.";

// valueDecimals is a uint8 and the registry only requires it to be <= 18. Clamp anyway: a
// divisor of 10^255 would be built one multiplication at a time and is not worth attempting.
export const MAX_VALUE_DECIMALS = 18;
