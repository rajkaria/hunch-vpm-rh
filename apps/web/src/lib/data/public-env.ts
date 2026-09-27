/**
 * The guard on the `NEXT_PUBLIC_*` endpoint variables.
 *
 * `NEXT_PUBLIC_` is not a naming convention, it is an instruction: Next inlines the
 * value into every bundle that references it, so whatever is in one of these variables
 * is published to every visitor the moment the site builds. View-source is enough to
 * read it. There is no runtime, no header and no allowlist between it and the world.
 *
 * That collides with how The Graph's gateway authenticates. It takes its API key as a
 * path segment rather than a header:
 *
 *   https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>
 *
 * so pasting a working gateway URL into `NEXT_PUBLIC_HUNCH_SUBGRAPH_URL` — the obvious
 * thing to do, and the thing that makes the site work locally — ships a billable
 * credential to everyone who loads the page. Nothing about the variable's name says so,
 * and nothing in the build would have complained.
 *
 * So this module refuses. A value that looks keyed is not sanitised, not warned about
 * and not quietly downgraded to fixtures: it throws, at module load, which fails
 * `next build` and refuses to start the server. That is deliberate. A warning in a build
 * log is read once, by nobody; a deploy that will not come up is read immediately. The
 * failure names the variable, says why the value cannot be public, and never prints the
 * value itself — the error text goes to build logs, which are frequently public too.
 *
 * The supported ways to point the surface at live data:
 *
 *   - a keyless public endpoint (a Studio query URL, or a gateway URL that authenticates
 *     with an `Authorization` header rather than a path segment); or
 *   - a proxy you own: a route in this app, or any server you control, that holds the key
 *     server-side and forwards the query. Point `NEXT_PUBLIC_HUNCH_SUBGRAPH_URL` at the
 *     proxy. The key stays on the server, where a key belongs.
 *
 * What the check cannot see: a credential in the *host*, or a key short and plain enough
 * to pass for a path word. It is a guard against the mistake that is easy to make, not a
 * proof that a public variable is safe. The rule for that is older and simpler — do not
 * put a secret in a `NEXT_PUBLIC_` variable.
 */

/** A path segment shaped like a structural word (`api`, `subgraphs`, `id`) rather than an identifier. */
const STRUCTURAL_SEGMENT = /^[a-z][a-z0-9-]{0,15}$/;

/** Whatever follows one of these is a credential by convention, unless it is a structural word. */
const CREDENTIAL_PARENTS: ReadonlySet<string> = new Set([
  'api',
  'apikey',
  'api-key',
  'api_key',
  'key',
  'keys',
  'token',
  'tokens',
  'auth',
  'secret',
  'secrets',
]);

/** The shape of a Graph gateway API key: 32 lowercase hex characters. Subgraph ids are base58 or `0x`-prefixed, so they do not match. */
const HEX_KEY_SEGMENT = /^[0-9a-f]{24,}$/;

/** Query parameter names that carry a credential. */
const CREDENTIAL_PARAM = /(^|[_-])(key|apikey|token|secret|password|auth|access)([_-]|$)/i;

/**
 * Thrown at module load when a public variable holds something that must not be public.
 * The message never contains the value.
 */
export class PublicEnvError extends Error {
  readonly variable: string;

  constructor(variable: string, reason: string, remedy: string) {
    super(`${variable}: ${reason}\n\n${remedy}`);
    this.name = 'PublicEnvError';
    this.variable = variable;
  }
}

/**
 * Why a URL looks like it carries a credential, or `undefined` if it does not.
 * The reason describes the shape; it never quotes the part that looks like the key.
 */
export function keyedUrlReason(raw: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return 'it carries credentials in its userinfo (the `user:password@host` part)';
  }

  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  for (const [index, segment] of segments.entries()) {
    const parent = index === 0 ? '' : (segments[index - 1] ?? '').toLowerCase();
    if (CREDENTIAL_PARENTS.has(parent) && !STRUCTURAL_SEGMENT.test(segment)) {
      return `its path has an opaque segment directly after "${parent}", which is where The Graph's gateway puts the API key`;
    }
    if (HEX_KEY_SEGMENT.test(segment)) {
      return 'its path contains a long hexadecimal segment, the shape of a Graph gateway API key';
    }
  }

  for (const name of parsed.searchParams.keys()) {
    if (CREDENTIAL_PARAM.test(name)) {
      return `it carries a "${name}" query parameter`;
    }
  }

  return undefined;
}

/**
 * Read one `NEXT_PUBLIC_*` endpoint variable.
 *
 * Returns `undefined` when it is unset or empty — the caller falls back to fixtures,
 * which is the documented default. Throws `PublicEnvError` when it is set to something
 * that cannot safely be published or cannot be used: a keyed URL, a value that is not an
 * absolute URL, or a scheme other than http(s).
 */
export function readPublicEndpoint(variable: string, raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '') return undefined;

  const remedy =
    `Next inlines every NEXT_PUBLIC_* value into the browser bundle, so this one is published to every visitor.\n` +
    `Use a keyless endpoint (a Studio query URL, or a gateway URL that authenticates with an Authorization header),\n` +
    `or point this variable at a proxy you control that holds the key server-side.\n` +
    `Leave it unset to serve the fixture dataset. The value is not printed here, because build logs are not private either.`;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PublicEnvError(
      variable,
      `must be an absolute URL such as https://host/path — the value is ${value.length} character${value.length === 1 ? '' : 's'} and did not parse as one`,
      remedy,
    );
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new PublicEnvError(variable, `must be http(s); its scheme is "${parsed.protocol}"`, remedy);
  }

  const keyed = keyedUrlReason(value);
  if (keyed !== undefined) {
    throw new PublicEnvError(variable, `looks like it contains an API key — ${keyed}`, remedy);
  }

  return value;
}
