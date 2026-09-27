/**
 * Printing an RPC URL is handling a credential: keyed providers put the key in the path
 * (`https://robinhood-mainnet.g.alchemy.com/v2/<KEY>`) or the host
 * (`https://<endpoint>.robinhood-mainnet.quiknode.pro/<TOKEN>`). `redactRpcUrl` keeps the
 * shape an operator needs (scheme, provider host, structural path words) and drops
 * everything that could be a key. Ported from hunch-vpm `agent/src/redact.ts`.
 *
 * The rule is a whitelist: a path segment survives only if it is lowercase, starts with a
 * letter, is at most 16 `[a-z0-9-]` characters and does not follow a credential-naming
 * segment. A host label that looks random (long, or mixing letters and digits) is hidden too.
 */

const STRUCTURAL_SEGMENT = /^[a-z][a-z0-9-]{0,15}$/;
const CREDENTIAL_PARENTS: ReadonlySet<string> = new Set([
  'api', 'apikey', 'api-key', 'api_key', 'key', 'keys', 'token', 'tokens', 'auth', 'secret', 'secrets', 'v2', 'v3',
]);
export const REDACTED = '***';

function suspiciousHostLabel(label: string): boolean {
  return label.length > 20 || (/\d/.test(label) && /[a-z]/i.test(label) && label.length > 12);
}

export function redactRpcUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return `[set, but not a URL: ${REDACTED}]`;
  }
  const segments = parsed.pathname.split('/').filter((s) => s !== '');
  const safe = segments.map((segment, i) => {
    const parent = i === 0 ? '' : (segments[i - 1] ?? '').toLowerCase();
    if (CREDENTIAL_PARENTS.has(parent)) return REDACTED;
    return STRUCTURAL_SEGMENT.test(segment) ? segment : REDACTED;
  });
  const host = parsed.host
    .split('.')
    .map((label) => (suspiciousHostLabel(label) ? REDACTED : label))
    .join('.');
  const userinfo = parsed.username !== '' || parsed.password !== '' ? `${REDACTED}@` : '';
  const path = safe.length === 0 ? '' : `/${safe.join('/')}`;
  const tail = parsed.search !== '' || parsed.hash !== '' ? `?${REDACTED}` : '';
  return `${parsed.protocol}//${userinfo}${host}${path}${tail}`;
}

/** The substrings of `raw` that `redactRpcUrl` hides (≥ 8 chars), for a log scrubber. */
export function urlSecrets(raw: string | undefined | null): string[] {
  if (raw === undefined || raw === null || raw.trim() === '') return [];
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw.length >= 8 ? [raw] : [];
  }
  const segments = parsed.pathname.split('/').filter((s) => s !== '');
  const out = segments.filter((segment, i) => {
    const parent = i === 0 ? '' : (segments[i - 1] ?? '').toLowerCase();
    return CREDENTIAL_PARENTS.has(parent) || !STRUCTURAL_SEGMENT.test(segment);
  });
  for (const label of parsed.host.split('.')) if (suspiciousHostLabel(label)) out.push(label);
  if (parsed.password !== '') out.push(parsed.password);
  if (parsed.username !== '') out.push(parsed.username);
  for (const [, v] of parsed.searchParams) out.push(v);
  return out.filter((s) => s.length >= 8);
}

/**
 * A scrubber that replaces every known secret (exact strings, e.g. the keeper key with
 * and without `0x`, and `urlSecrets` of each RPC URL) with `***`. Short strings (< 8
 * chars) are ignored so unrelated output is never mangled.
 */
export function makeRedactor(secrets: readonly (string | undefined | null)[]): (text: string) => string {
  const list = [...new Set(secrets.filter((s): s is string => typeof s === 'string' && s.length >= 8))].sort((a, b) => b.length - a.length);
  return (text: string) => {
    let out = text;
    for (const s of list) out = out.split(s).join(REDACTED);
    return out;
  };
}
