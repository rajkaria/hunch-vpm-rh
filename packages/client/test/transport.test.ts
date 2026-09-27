import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/transport.js';
import { GraphQLHttpError, GraphQLRequestError, fetchTransport, redactUrl } from '../src/transport.js';

interface StubCall {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function stubFetch(response: { ok?: boolean; status?: number; statusText?: string; body: unknown }): {
  fetch: FetchLike;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      statusText: response.statusText ?? 'OK',
      text: async () => (typeof response.body === 'string' ? response.body : JSON.stringify(response.body)),
    };
  };
  return { fetch, calls };
}

/** The gateway's real shape: 32 lowercase hex characters as a path segment. */
const KEY = '0123456789abcdef0123456789abcdef';
const request = {
  url: `https://gateway.invalid/api/${KEY}/subgraphs/id/QmSubgraphId`,
  query: '{ x }',
  operation: 'market',
};

describe('fetchTransport', () => {
  it('posts the query and returns the data', async () => {
    const { fetch, calls } = stubFetch({ body: { data: { market: { id: 'm' } } } });
    const result = await fetchTransport({ fetch }).request<{ market: { id: string } }>(request);

    expect(result.market.id).toBe('m');
    expect(calls[0]?.url).toBe(request.url);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ query: '{ x }', variables: {} });
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('passes extra headers through', async () => {
    const { fetch, calls } = stubFetch({ body: { data: {} } });
    await fetchTransport({ fetch, headers: { authorization: 'Bearer t' } }).request(request);
    expect(calls[0]?.headers['authorization']).toBe('Bearer t');
  });

  it('raises GraphQL errors', async () => {
    const { fetch } = stubFetch({ body: { errors: [{ message: 'bad field' }] } });
    await expect(fetchTransport({ fetch }).request(request)).rejects.toBeInstanceOf(GraphQLRequestError);
  });

  it('keeps the api key out of the error message', async () => {
    const { fetch } = stubFetch({ body: { errors: [{ message: 'bad field' }] } });
    const error = await fetchTransport({ fetch })
      .request(request)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphQLRequestError);
    expect((error as Error).message).not.toContain(KEY);
  });

  // Keeping the URL off the message is not enough on its own: Node's error formatter
  // appends an error's own enumerable properties, so `console.error(err)` and every crash
  // dump print them. The error may not hold the unredacted URL at all.
  it('holds a redacted endpoint, never the key, whichever way the error is printed', async () => {
    const { fetch } = stubFetch({ body: { errors: [{ message: 'bad field' }] } });
    const error = (await fetchTransport({ fetch })
      .request(request)
      .catch((caught: unknown) => caught)) as GraphQLRequestError;

    expect(error.url).toBe('https://gateway.invalid/api/***/subgraphs/id/***');
    // How `console.error(err)` renders it, and how a JSON log line would.
    expect(inspect(error, { depth: null })).not.toContain(KEY);
    expect(JSON.stringify({ ...error })).not.toContain(KEY);
    expect(Object.values(error).join(' ')).not.toContain(KEY);
    // Nothing anywhere on the error carries it, own properties or not.
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain(KEY);
    // And it is still useful: the failing endpoint is identifiable.
    expect(error.url).toContain('gateway.invalid');
    expect(error.operation).toBe('market');
  });

  it('redacts the endpoint on the empty-data failure too, not just on GraphQL errors', async () => {
    const { fetch } = stubFetch({ body: { data: null } });
    const error = (await fetchTransport({ fetch })
      .request(request)
      .catch((caught: unknown) => caught)) as GraphQLRequestError;

    expect(inspect(error, { depth: null })).not.toContain(KEY);
    expect(error.url).toBe('https://gateway.invalid/api/***/subgraphs/id/***');
  });

  it('sends the real URL even though the error only ever holds the redacted one', async () => {
    const { fetch, calls } = stubFetch({ body: { data: {} } });
    await fetchTransport({ fetch }).request(request);
    expect(calls[0]?.url).toBe(request.url);
  });

  it('does not put the endpoint on an HTTP failure at all', async () => {
    const { fetch } = stubFetch({ ok: false, status: 500, statusText: 'Server Error', body: 'boom' });
    const error = await fetchTransport({ fetch })
      .request(request)
      .catch((caught: unknown) => caught);
    expect(inspect(error, { depth: null })).not.toContain(KEY);
  });

  it('raises HTTP failures with their status', async () => {
    const { fetch } = stubFetch({ ok: false, status: 429, statusText: 'Too Many Requests', body: 'slow down' });
    const error = await fetchTransport({ fetch })
      .request(request)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphQLHttpError);
    expect((error as GraphQLHttpError).status).toBe(429);
  });

  it('treats a null data envelope as a failure, not as an empty result', async () => {
    const { fetch } = stubFetch({ body: { data: null } });
    await expect(fetchTransport({ fetch }).request(request)).rejects.toThrow(/no data/);
  });
});

describe('redactUrl', () => {
  it('keeps the shape of a gateway URL and loses the key', () => {
    expect(redactUrl(`https://gateway.thegraph.com/api/${KEY}/subgraphs/id/QmSubgraphId`)).toBe(
      'https://gateway.thegraph.com/api/***/subgraphs/id/***',
    );
  });

  it('never returns the key, whatever the URL looks like', () => {
    const shapes = [
      `https://gateway.thegraph.com/api/${KEY}/subgraphs/id/Qm1`,
      `https://gateway.thegraph.com/api/${KEY}`,
      `https://example.test/graphql?api_key=${KEY}`,
      `https://example.test/graphql#${KEY}`,
      `https://alice:${KEY}@example.test/graphql`,
      `https://example.test/${KEY}/`,
      `not-a-url-${KEY}`,
    ];
    for (const shape of shapes) {
      expect(redactUrl(shape), shape).not.toContain(KEY);
    }
  });

  it('leaves a keyless endpoint readable', () => {
    expect(redactUrl('https://example.test:8443/v1/graphql')).toBe('https://example.test:8443/v1/graphql');
  });

  it('collapses a query string rather than reading it, since ?api_key= is just as common', () => {
    expect(redactUrl('https://example.test/graphql?api_key=abcdef&page=2')).toBe('https://example.test/graphql?***');
  });
});
