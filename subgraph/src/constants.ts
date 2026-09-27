import { BigDecimal, BigInt } from "@graphprotocol/graph-ts";

export const ZERO = BigInt.zero();
export const ONE = BigInt.fromI32(1);
export const ZERO_BD = BigDecimal.zero();

/// VestedParimutuel.SCALE — the fixed point of the reward-per-share accumulator.
export const SCALE = BigInt.fromString("1000000000000000000");

/// VestedParimutuel.KAPPA_UNBOUNDED — type(uint256).max, the sentinel for kappa -> infinity.
/// ClassicParimutuel.headroom() returns the same value for the same reason.
export const UINT256_MAX = BigInt.fromString(
  "115792089237316195423570985008687907853269984665640564039457584007913129639935"
);

/// What this subgraph reports instead of 2^256-1. A consumer that renders BigInt fields as
/// numbers would turn the on-chain sentinel into 1.16e77 and put it on a chart; -1 is
/// obviously not an amount, so it fails loudly instead. Always read the paired boolean
/// (Market.kappaIsUnbounded, Book.capacityIsUnbounded) rather than testing for -1.
export const UNBOUNDED_SENTINEL = BigInt.fromI32(-1);

export const SETTLER_VESTED = "VESTED";
export const SETTLER_CLASSIC = "CLASSIC";

export const STATUS_OPEN = "OPEN";
export const STATUS_RESOLVED = "RESOLVED";
export const STATUS_VOIDED = "VOIDED";

export const DIRECTION_ABOVE = "ABOVE";
export const DIRECTION_BELOW = "BELOW";

export const SECONDS_PER_DAY = 86400;

export const PROTOCOL_ID = "1";

/// Contract Status enum: 0 Open, 1 Resolved, 2 Voided.
export function statusFromUint8(raw: i32): string {
  if (raw == 1) return STATUS_RESOLVED;
  if (raw == 2) return STATUS_VOIDED;
  return STATUS_OPEN;
}
