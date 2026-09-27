/**
 * Header reading, normalised across the three shapes an HTTP layer hands us: a fetch
 * `Headers`, a Node `IncomingHttpHeaders` record (values may be arrays), or a Map.
 *
 * The proof header's name is configurable. `agentkit` is what AgentKit's own client
 * attaches, and it is the default; a deployment that terminates behind something which
 * renames or namespaces headers changes configuration rather than code.
 */

import type { HeaderSource } from './types.js';

export const DEFAULT_PROOF_HEADER = 'agentkit';

export type NormalizedHeaders = ReadonlyMap<string, string>;

export class ConflictingHeaderError extends Error {
  constructor(readonly headerName: string) {
    super(`header "${headerName}" was supplied more than once with conflicting values`);
    this.name = 'ConflictingHeaderError';
  }
}

export interface HeaderNormalization {
  readonly headers: NormalizedHeaders;
  /**
   * The proof header's name, as it arrived, when it was supplied twice with conflicting
   * values. Null otherwise. When it is set, that header is absent from `headers`: there
   * is no non-arbitrary way to pick which of the two values was the proof.
   */
  readonly conflictingHeader: string | null;
}

/**
 * Lowercases names, trims values, and merges duplicates.
 *
 * Only the proof header treats conflicting duplicates as a problem. Two different values
 * under that one name mean somebody is trying to make this server and a proxy disagree
 * about which proof was checked, and there is no safe way to guess. Every other name is
 * joined the way a fetch `Headers` joins it, because a request that carries two `accept`
 * values is an ordinary request that has nothing to do with the proof — treating it as a
 * proof failure would answer 401 to a caller that presented no proof at all.
 */
export function tryNormalizeHeaders(
  source: HeaderSource,
  proofHeader: string = DEFAULT_PROOF_HEADER,
): HeaderNormalization {
  const strict = proofHeader.toLowerCase();
  const out = new Map<string, string>();
  let conflictingHeader: string | null = null;

  if (typeof Headers !== 'undefined' && source instanceof Headers) {
    // `Headers` has already merged duplicates into a comma-joined value. Splitting that
    // back apart would corrupt any header whose value legitimately contains a comma, so
    // the merged string is taken as-is; a duplicated proof header shows up as a value
    // that simply fails to decode, which is the outcome we want anyway.
    source.forEach((value, key) => {
      const collapsed = value.trim();
      if (collapsed.length > 0) out.set(key.toLowerCase(), collapsed);
    });
    return { headers: out, conflictingHeader };
  }

  const entries: Iterable<readonly [string, string | readonly string[] | undefined]> =
    source instanceof Map ? source : Object.entries(source);

  for (const [key, value] of entries) {
    if (value === undefined) continue;
    const name = key.toLowerCase();
    const values = (Array.isArray(value) ? value : [value as string])
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    const first = values[0];
    if (first === undefined) continue;

    if (name !== strict) {
      out.set(name, values.length === 1 ? first : values.join(', '));
      continue;
    }
    // A repeated proof header with one consistent value is harmless.
    if (values.some((v) => v !== first)) {
      conflictingHeader = key;
      out.delete(name);
      continue;
    }
    out.set(name, first);
  }

  return { headers: out, conflictingHeader };
}

/**
 * {@link tryNormalizeHeaders}, throwing {@link ConflictingHeaderError} when the proof
 * header is ambiguous. Callers that have to produce an answer for every request want the
 * `try` form; this one is for code that would rather not check.
 */
export function normalizeHeaders(
  source: HeaderSource,
  proofHeader: string = DEFAULT_PROOF_HEADER,
): NormalizedHeaders {
  const { headers, conflictingHeader } = tryNormalizeHeaders(source, proofHeader);
  if (conflictingHeader !== null) throw new ConflictingHeaderError(conflictingHeader);
  return headers;
}

export function readProofHeader(headers: NormalizedHeaders, name: string): string | undefined {
  return headers.get(name.toLowerCase());
}

/**
 * First hop of `x-forwarded-for`, or `x-real-ip`. Used only as a last-resort
 * rate-limit subject for anonymous callers; see `subject` in the gate options for why
 * you should supply something better in production.
 */
export function forwardedClientAddress(headers: NormalizedHeaders): string | undefined {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded !== undefined) {
    const first = forwarded.split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  const real = headers.get('x-real-ip')?.trim();
  return real !== undefined && real.length > 0 ? real : undefined;
}
