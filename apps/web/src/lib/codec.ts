/**
 * bigint across JSON.
 *
 * - `toJsonSafe` turns every bigint into its decimal string (Maps into arrays of entries, Sets
 *   into arrays), which is the public API's convention: amounts and ids are strings.
 * - `encode` / `decode` round-trip exactly (a bigint becomes `{ "$n": "123" }`), for the server's
 *   data cache, which stores JSON and must hand back the same bigints it was given.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function toJsonSafe(value: unknown): JsonValue {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value instanceof Map) return [...value.entries()].map(([k, v]) => [toJsonSafe(k), toJsonSafe(v)]);
  if (value instanceof Set) return [...value].map(toJsonSafe);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined || typeof entry === 'function') continue;
      out[key] = toJsonSafe(entry);
    }
    return out;
  }
  return null;
}

const BIG = '$n';

/** Exact, reversible encoding (bigint → `{ $n }`). Maps and Sets are not supported: convert first. */
export function encode(value: unknown): unknown {
  if (typeof value === 'bigint') return { [BIG]: value.toString() };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      out[key] = encode(entry);
    }
    return out;
  }
  return value;
}

export function decode<T>(value: unknown): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const record = v as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.length === 1 && keys[0] === BIG && typeof record[BIG] === 'string') return BigInt(record[BIG]);
      const out: Record<string, unknown> = {};
      for (const key of keys) out[key] = walk(record[key]);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
