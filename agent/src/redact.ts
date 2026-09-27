/**
 * Printing an endpoint URL is handling a credential.
 *
 * The Graph's gateway carries its API key as a *path segment*, not a header:
 *
 *   https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>
 *
 * so `HUNCH_SUBGRAPH_URL` — and anything else an operator might point at a keyed
 * gateway, `HUNCH_INTEL_URL` included — is a secret in a variable that does not look
 * like one. Anything that writes it to stdout, to a log file or into an error message
 * has published a key.
 *
 * `redactUrl` is the only form of an endpoint this package prints. It keeps what an
 * operator actually needs from a startup banner — *which host am I pointed at, and does
 * the path have the shape I expect* — and drops everything that could be the key.
 *
 * The rule is a whitelist, deliberately, because a blocklist of "things that look like a
 * key" is a guess and a wrong guess prints a credential. A path segment survives only if:
 *
 *   - it is lowercase, starts with a letter, and is at most 16 characters of
 *     `[a-z0-9-]` — the shape of a structural word like `api`, `subgraphs`, `id`,
 *     `query`, `graphql`, `v1`; and
 *   - the segment before it does not name a credential (`api`, `key`, `token`, …),
 *     which catches a short key in the one position the gateway shape puts it.
 *
 * Everything else — high-entropy ids, mixed case, digits-first, anything with a dot or
 * an underscore — becomes `***`. Userinfo is replaced wholesale, and a query string or
 * fragment is collapsed to a single marker rather than parsed, because `?api_key=` is
 * just as common as a path segment.
 *
 * What this does NOT defend against: a credential in the *host* (`https://<key>.example`),
 * and a lowercase key of 16 characters or fewer sitting in a path position with no
 * credential-naming parent. Neither is the shape any endpoint we integrate with uses.
 */

/** The shape of a path segment that names an endpoint's structure rather than identifying it. */
const STRUCTURAL_SEGMENT = /^[a-z][a-z0-9-]{0,15}$/;

/** Whatever follows one of these is a credential by convention, however innocent it looks. */
const CREDENTIAL_PARENTS: ReadonlySet<string> = new Set([
  "api",
  "apikey",
  "api-key",
  "api_key",
  "key",
  "keys",
  "token",
  "tokens",
  "auth",
  "secret",
  "secrets",
]);

export const REDACTED = "***";

/** What we print when a value is set but cannot be parsed. The value itself is never printed. */
const UNPARSEABLE = `[set, but not a URL — ${REDACTED}]`;

/**
 * A printable form of `raw`: scheme, host, and a path whose identifying segments are
 * replaced by `***`. Never returns any part of the input that could be a key.
 */
export function redactUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return UNPARSEABLE;
  }

  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  const safe = segments.map((segment, index) => {
    const parent = index === 0 ? "" : (segments[index - 1] ?? "").toLowerCase();
    if (CREDENTIAL_PARENTS.has(parent)) return REDACTED;
    return STRUCTURAL_SEGMENT.test(segment) ? segment : REDACTED;
  });

  // `host` carries the port and excludes userinfo, which is handled separately.
  const userinfo = parsed.username !== "" || parsed.password !== "" ? `${REDACTED}@` : "";
  const path = safe.length === 0 ? "" : `/${safe.join("/")}`;
  const tail = parsed.search !== "" || parsed.hash !== "" ? `?${REDACTED}` : "";
  return `${parsed.protocol}//${userinfo}${parsed.host}${path}${tail}`;
}

/**
 * The substrings of `raw` that `redactUrl` hides: the key candidates, for feeding to
 * `ConsoleLogger`'s scrubber. That way a key which escapes into an error message thrown
 * by a dependency — where no redaction of ours ever runs — still does not reach a
 * terminal or a CI log.
 *
 * Values shorter than eight characters are dropped: the logger would refuse them anyway,
 * and a short string replaced everywhere would mangle unrelated output.
 */
export function urlSecrets(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return [];
  }

  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  const candidates = segments.filter((segment, index) => {
    const parent = index === 0 ? "" : (segments[index - 1] ?? "").toLowerCase();
    return CREDENTIAL_PARENTS.has(parent) || !STRUCTURAL_SEGMENT.test(segment);
  });
  if (parsed.password !== "") candidates.push(parsed.password);
  return candidates.filter((candidate) => candidate.length >= 8);
}
