/**
 * Narrowing helpers for data that arrives as `unknown`.
 *
 * Fixtures and indexer responses both come in untyped. Every accessor here names the
 * field it failed on, so a shape change points at its own fix instead of surfacing three
 * frames later as "cannot read property of undefined".
 */

export class DecodeError extends Error {}

function fail(path: string, expected: string, got: unknown): never {
  throw new DecodeError(`${path}: expected ${expected}, got ${describe(got)}`);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "an object", value);
  return value as Record<string, unknown>;
}

export function asArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "an array", value);
  return value;
}

export function asString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "a string", value);
  return value;
}

export function asNumber(value: unknown, path: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return fail(path, "a number", value);
}

/**
 * Integers arrive as decimal strings from JSON and from GraphQL, because they routinely
 * exceed 2^53. Accepting a number too would silently lose precision, so it is rejected.
 */
export function asBigint(value: unknown, path: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return fail(path, "an integer (decimal string preferred)", value);
}

export function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "a boolean", value);
  return value;
}

export function field(source: Record<string, unknown>, key: string, path: string): unknown {
  const value = source[key];
  if (value === undefined) throw new DecodeError(`${path}.${key}: missing`);
  return value;
}

export function optionalField(source: Record<string, unknown>, key: string): unknown {
  const value = source[key];
  return value === null ? undefined : value;
}
