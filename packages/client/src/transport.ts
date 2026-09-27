/**
 * The one place this package talks to a network. Everything else takes a
 * `GraphQLTransport`, so the whole read surface is testable against recorded
 * responses without a socket.
 */

export interface GraphQLRequest {
  url: string;
  query: string;
  variables?: Record<string, unknown>;
  /** Free-form label used in error messages, e.g. "market". */
  operation: string;
}

export interface GraphQLTransport {
  request<T>(request: GraphQLRequest): Promise<T>;
}

export interface GraphQLErrorEntry {
  message: string;
  path?: (string | number)[];
}

/**
 * A printable form of an endpoint URL: scheme, host, and a path whose identifying
 * segments become `***`.
 *
 * The Graph's gateway carries its API key as a path segment rather than a header —
 * `https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<ID>` — so the endpoint this
 * package is configured with *is* a credential. Keeping a URL off an error's message is
 * not enough on its own: Node's error formatter appends an error's own enumerable
 * properties, so `console.error(err)`, an unhandled rejection and any crash dump all
 * print them. Nothing here may hold the unredacted value.
 *
 * The rule is a whitelist, because a blocklist of "things that look like a key" is a
 * guess and a wrong guess prints a credential. A segment survives only if it is
 * lowercase, starts with a letter and is at most sixteen `[a-z0-9-]` characters — the
 * shape of a structural word like `api`, `subgraphs`, `id` — and only if the segment
 * before it does not name a credential. Userinfo and any query string go entirely.
 *
 * Six duplicated lines are the price of not making `@hunch-vpm/client` depend on another
 * package for this; the agent carries its own copy in `agent/src/redact.ts`.
 */
const STRUCTURAL_SEGMENT = /^[a-z][a-z0-9-]{0,15}$/;
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

export function redactUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return '[not a URL — ***]';
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  const safe = segments.map((segment, index) => {
    const parent = index === 0 ? '' : (segments[index - 1] ?? '').toLowerCase();
    if (CREDENTIAL_PARENTS.has(parent)) return '***';
    return STRUCTURAL_SEGMENT.test(segment) ? segment : '***';
  });
  const userinfo = parsed.username !== '' || parsed.password !== '' ? '***@' : '';
  const path = safe.length === 0 ? '' : `/${safe.join('/')}`;
  const tail = parsed.search !== '' || parsed.hash !== '' ? '?***' : '';
  return `${parsed.protocol}//${userinfo}${parsed.host}${path}${tail}`;
}

export class GraphQLRequestError extends Error {
  readonly operation: string;
  /**
   * The endpoint that failed, with every identifying path segment replaced by three
   * asterisks: a keyed gateway URL reads back as the host plus `api`, `subgraphs`, `id`.
   * Enough to tell which endpoint is misbehaving, and safe to print anywhere, which is
   * the point: this property *will* be printed, by a formatter nobody in this package
   * controls. The unredacted URL is never stored on the error; the caller configured it
   * and still has it.
   */
  readonly url: string;
  readonly errors: GraphQLErrorEntry[];

  constructor(operation: string, url: string, errors: GraphQLErrorEntry[]) {
    const detail = errors.map((error) => error.message).join('; ');
    super(`GraphQL ${operation} failed: ${detail}`);
    this.name = 'GraphQLRequestError';
    this.operation = operation;
    this.url = redactUrl(url);
    this.errors = errors;
  }
}

export class GraphQLHttpError extends Error {
  readonly status: number;

  constructor(operation: string, status: number, statusText: string, body: string) {
    super(`GraphQL ${operation} failed: HTTP ${status} ${statusText}${body === '' ? '' : ` — ${body}`}`);
    this.name = 'GraphQLHttpError';
    this.status = status;
  }
}

/**
 * The slice of `fetch` we use. Declared structurally rather than pulled from
 * the DOM lib, because this package compiles with `lib: ["ES2023"]` and has no
 * business dragging in DOM types.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
}>;

export interface FetchTransportOptions {
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Extra headers on every request, e.g. `Authorization`. */
  headers?: Record<string, string>;
}

interface GraphQLEnvelope<T> {
  data?: T | null;
  errors?: GraphQLErrorEntry[];
}

export function fetchTransport(options: FetchTransportOptions = {}): GraphQLTransport {
  const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
  const doFetch = options.fetch ?? globalFetch;
  if (doFetch === undefined) {
    throw new Error('no global fetch available; pass `fetch` to fetchTransport');
  }
  const extraHeaders = options.headers ?? {};

  return {
    async request<T>(request: GraphQLRequest): Promise<T> {
      const response = await doFetch(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...extraHeaders },
        body: JSON.stringify({ query: request.query, variables: request.variables ?? {} }),
      });

      const body = await response.text();
      if (!response.ok) {
        throw new GraphQLHttpError(request.operation, response.status, response.statusText, body.slice(0, 512));
      }

      const envelope = JSON.parse(body) as GraphQLEnvelope<T>;
      if (envelope.errors !== undefined && envelope.errors.length > 0) {
        throw new GraphQLRequestError(request.operation, request.url, envelope.errors);
      }
      if (envelope.data === undefined || envelope.data === null) {
        throw new GraphQLRequestError(request.operation, request.url, [{ message: 'response carried no data' }]);
      }
      return envelope.data;
    },
  };
}
