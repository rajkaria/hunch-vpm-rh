/**
 * Decoders for data arriving from outside this package — `@hunch-vpm/client` and the
 * subgraphs. Two packages built in parallel meet here, so the boundary is checked
 * rather than trusted: a mismatch produces a `bad_upstream_data` tool result naming
 * the exact field, which is a bug report an agent can relay, instead of `undefined`
 * quietly propagating into a number a stake is sized on.
 *
 * Amounts are liberal in their input form (bigint, decimal string, or safe integer)
 * because JSON transports cannot carry a bigint and different sources spell them
 * differently. They are strict about everything else.
 */

import { badUpstreamData } from "./errors.js";

export function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badUpstreamData(path, "an object", value);
  }
  return value as Record<string, unknown>;
}

export function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw badUpstreamData(path, "an array", value);
  return value;
}

export function asString(value: unknown, path: string): string {
  if (typeof value !== "string") throw badUpstreamData(path, "a string", value);
  return value;
}

export function asNumber(value: unknown, path: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  throw badUpstreamData(path, "a number", value);
}

/** Flags survive GraphQL and JSON as booleans, as "true"/"false", and as 0/1. */
export function asFlag(value: unknown, path: string): boolean {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes") return true;
    if (lower === "false" || lower === "0" || lower === "no") return false;
  }
  throw badUpstreamData(path, "a boolean", value);
}

/** Ids are strings here even when the source numbers them. */
export function asIdString(value: unknown, path: string): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  throw badUpstreamData(path, "an id", value);
}

/** Integer amounts in base units. Accepts bigint, decimal/hex string, or a safe integer. */
export function asBigInt(value: unknown, path: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw badUpstreamData(path, "an integer amount", value);
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed) || /^0x[0-9a-fA-F]+$/.test(trimmed)) {
      try {
        return BigInt(trimmed);
      } catch {
        throw badUpstreamData(path, "an integer amount", value);
      }
    }
  }
  throw badUpstreamData(path, "an integer amount", value);
}

/** Unix seconds. Tolerates milliseconds and ISO-8601, both of which show up in indexers. */
export function asUnixSeconds(value: unknown, path: string): number {
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) throw badUpstreamData(path, "a timestamp", value);
    return Math.floor(parsed / 1000);
  }
  const raw = Number(asBigInt(value, path));
  // A market resolving after the year 33658 is a millisecond value, not a second one.
  return raw > 1e12 ? Math.floor(raw / 1000) : raw;
}

export function optional<T>(value: unknown, decode: (value: unknown, path: string) => T, path: string): T | undefined {
  return value === undefined || value === null ? undefined : decode(value, path);
}

/** First present key wins. The venue's own vocabulary comes first in every call site. */
export function pick(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function require_(source: Record<string, unknown>, keys: readonly string[], path: string): unknown {
  const value = pick(source, keys);
  if (value === undefined) {
    throw badUpstreamData(`${path}.${keys[0] ?? "?"}`, `one of [${keys.join(", ")}]`, source);
  }
  return value;
}

/**
 * Like `require_`, but `null` is a value rather than an absence.
 *
 * `@hunch-vpm/client` spells "unbounded" as `null` on capacity, headroom and kappa, so a
 * decoder that treats null as missing rejects every n-way market. A key that is not
 * there at all is still a broken payload and still throws.
 */
export function requirePresent(source: Record<string, unknown>, keys: readonly string[], path: string): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  throw badUpstreamData(`${path}.${keys[0] ?? "?"}`, `one of [${keys.join(", ")}]`, source);
}

/** True when any of `keys` is present, whatever its value. */
export function hasKey(source: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(source, key));
}
