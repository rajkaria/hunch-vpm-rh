/**
 * The adapters are structurally typed so this package depends on no framework. That
 * only means anything if a real framework actually satisfies the structure, so the Hono
 * case here mounts the middleware on a real `Hono` app and drives a real request
 * through it. If the structural types drift out of line with Hono's `Context`, this
 * file stops compiling, which is the point.
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createFetchAgentTierGuard, toVerifiableRequest, withAgentTierHeaders } from '../src/adapters/fetch.js';
import { agentTierOf, createHonoAgentTierMiddleware } from '../src/adapters/hono.js';
import {
  agentTierOf as nodeAgentTierOf,
  createNodeAgentTierMiddleware,
  toVerifiableRequest as nodeToVerifiableRequest,
  type NodeLikeRequest,
  type NodeLikeResponse,
} from '../src/adapters/node.js';
import type { GateDecision } from '../src/gate.js';
import { buildTierPolicies } from '../src/tiers.js';
import { createHarness, impostor, makeProof, registeredAgent } from './support/harness.js';

const tightPolicies = buildTierPolicies({ baseRequests: 1, windowMs: 60_000 });

describe('Hono adapter', () => {
  function appFor(gate: ReturnType<typeof createHarness>['gate']) {
    const app = new Hono();
    app.use('*', createHonoAgentTierMiddleware(gate));
    app.get('/v1/markets', (c) => {
      const decision = agentTierOf(c);
      return c.json({ tier: decision?.tier ?? 'unknown', badged: decision?.policy.leaderboard.badged });
    });
    return app;
  }

  it('lets an anonymous request through and tags the response', async () => {
    const { gate } = createHarness();

    const response = await appFor(gate).request('/v1/markets');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tier: 'anonymous', badged: false });
    expect(response.headers.get('x-agent-tier')).toBe('anonymous');
    expect(response.headers.get('ratelimit-limit')).toBe('60');
  });

  it('lets a human-backed request through with the badged policy', async () => {
    const { gate, clock } = createHarness();
    // The proof's URI names /v1/markets, which is the route the request hits.
    const proof = await makeProof(clock);

    const response = await appFor(gate).request('/v1/markets', {
      headers: new Headers(proof.headers as Record<string, string>),
    });

    expect(await response.json()).toEqual({ tier: 'human-backed', badged: true });
    expect(response.headers.get('ratelimit-limit')).toBe('600');
  });

  it('short-circuits with a problem document when the limit is spent', async () => {
    const { gate } = createHarness({ policies: tightPolicies });
    const app = appFor(gate);

    expect((await app.request('/v1/markets')).status).toBe(200);
    const blocked = await app.request('/v1/markets');

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('content-type')).toBe('application/problem+json');
    expect(blocked.headers.get('retry-after')).not.toBeNull();
    const body = (await blocked.json()) as { status: number; tier: string };
    expect(body.status).toBe(429);
    expect(body.tier).toBe('anonymous');
  });

  it('answers 401 for a broken proof when the gate is set to reject', async () => {
    const { gate, clock } = createHarness({ onInvalidProof: 'reject' });
    const proof = await makeProof(clock, { signAs: impostor });

    const response = await appFor(gate).request('/v1/markets', {
      headers: new Headers(proof.headers as Record<string, string>),
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { title: string };
    expect(body.title).toBe('Invalid agent proof');
  });

  it('also writes the decision into a Hono variable for apps that prefer c.get', async () => {
    const { gate } = createHarness();
    const app = new Hono<{ Variables: { agentTier: GateDecision } }>();
    app.use('*', createHonoAgentTierMiddleware(gate));
    app.get('/v1/markets', (c) => c.json({ tier: c.get('agentTier').tier }));

    const response = await app.request('/v1/markets');

    expect(await response.json()).toEqual({ tier: 'anonymous' });
  });
});

describe('Node adapter', () => {
  interface FakeResponse extends NodeLikeResponse {
    readonly headers: Record<string, string>;
    body: string | undefined;
  }

  function fakeResponse(): FakeResponse {
    const headers: Record<string, string> = {};
    return {
      headers,
      statusCode: 200,
      body: undefined,
      setHeader(name, value) {
        headers[name] = value;
      },
      end(chunk) {
        this.body = chunk;
      },
    };
  }

  function fakeRequest(headers: Record<string, string | string[]>, url = '/v1/markets'): NodeLikeRequest {
    return { headers, method: 'GET', url };
  }

  it('calls next and attaches the decision for an allowed request', async () => {
    const { gate } = createHarness();
    const middleware = createNodeAgentTierMiddleware(gate);
    const req = fakeRequest({});
    const res = fakeResponse();
    const next = vi.fn();

    await new Promise<void>((resolve) => {
      middleware(req, res, () => {
        next();
        resolve();
      });
    });

    expect(next).toHaveBeenCalledOnce();
    expect(nodeAgentTierOf(req)?.tier).toBe('anonymous');
    expect(res.headers['x-agent-tier']).toBe('anonymous');
  });

  it('recognises a human-backed caller', async () => {
    const { gate, clock } = createHarness();
    const proof = await makeProof(clock);
    const req = fakeRequest(proof.headers as Record<string, string>);
    const res = fakeResponse();

    await new Promise<void>((resolve) => {
      createNodeAgentTierMiddleware(gate)(req, res, () => resolve());
    });

    expect(nodeAgentTierOf(req)?.identity?.wallet).toBe(registeredAgent.address.toLowerCase());
  });

  it('writes a problem document and does not call next when blocked', async () => {
    const { gate } = createHarness({ policies: tightPolicies });
    const middleware = createNodeAgentTierMiddleware(gate);
    const next = vi.fn();

    await new Promise<void>((resolve) => {
      middleware(fakeRequest({}), fakeResponse(), () => resolve());
    });

    const res = fakeResponse();
    await new Promise<void>((resolve) => {
      const original = res.end.bind(res);
      res.end = (chunk?: string) => {
        original(chunk);
        resolve();
      };
      middleware(fakeRequest({}), res, next);
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect(JSON.parse(res.body ?? '{}')).toMatchObject({ status: 429, tier: 'anonymous' });
  });

  it('hands a blocked request to a caller-supplied responder when one is given', async () => {
    const { gate } = createHarness({ policies: tightPolicies });
    const onBlocked = vi.fn<(req: NodeLikeRequest, res: NodeLikeResponse, d: GateDecision) => void>();
    const middleware = createNodeAgentTierMiddleware(gate, { onBlocked });

    await new Promise<void>((resolve) => {
      middleware(fakeRequest({}), fakeResponse(), () => resolve());
    });
    await new Promise<void>((resolve) => {
      onBlocked.mockImplementation(() => resolve());
      middleware(fakeRequest({}), fakeResponse(), vi.fn());
    });

    expect(onBlocked).toHaveBeenCalledOnce();
  });

  it('routes an unexpected failure to the error handler rather than passing it off as anonymous', async () => {
    const { gate } = createHarness();
    const exploding = {
      ...gate,
      evaluate: () => Promise.reject(new Error('boom')),
    };
    const middleware = createNodeAgentTierMiddleware(exploding);

    const error = await new Promise<unknown>((resolve) => {
      middleware(fakeRequest({}), fakeResponse(), (err) => resolve(err));
    });

    expect(error).toBeInstanceOf(Error);
  });

  it('strips the query string before checking a request binding', () => {
    expect(nodeToVerifiableRequest(fakeRequest({}, '/v1/markets?limit=10&cursor=abc')).path).toBe(
      '/v1/markets',
    );
  });

  it('copes with a request that has no url at all', () => {
    expect(nodeToVerifiableRequest({ headers: {} }).path).toBe('/');
  });
});

describe('fetch adapter', () => {
  it('returns no response when the request may proceed', async () => {
    const { gate } = createHarness();
    const guard = createFetchAgentTierGuard(gate);

    const { decision, response } = await guard(new Request('https://api.hunch.test/v1/markets'));

    expect(response).toBeNull();
    expect(decision.tier).toBe('anonymous');
  });

  it('returns a problem response when the request may not', async () => {
    const { gate } = createHarness({ policies: tightPolicies });
    const guard = createFetchAgentTierGuard(gate);

    await guard(new Request('https://api.hunch.test/v1/markets'));
    const { response } = await guard(new Request('https://api.hunch.test/v1/markets'));

    expect(response?.status).toBe(429);
  });

  it('drops the query string from the path it checks a binding against', () => {
    expect(toVerifiableRequest(new Request('https://api.hunch.test/v1/markets?limit=10')).path).toBe(
      '/v1/markets',
    );
  });

  it('merges the advisory headers onto a handler response', async () => {
    const { gate } = createHarness();
    const decision = await gate.evaluate({ headers: {} });

    const merged = withAgentTierHeaders(
      new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } }),
      decision,
    );

    expect(merged.status).toBe(201);
    expect(merged.headers.get('content-type')).toBe('application/json');
    expect(merged.headers.get('x-agent-tier')).toBe('anonymous');
  });
});
