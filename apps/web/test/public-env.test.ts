import { afterEach, describe, expect, it, vi } from 'vitest';

import { keyedUrlReason, PublicEnvError, readPublicEndpoint } from '@/lib/data/public-env';

/**
 * `NEXT_PUBLIC_*` values are inlined into the browser bundle, and The Graph's gateway
 * carries its API key as a path segment, so a working gateway URL in one of these
 * variables is a credential served to every visitor. The guard has to refuse loudly —
 * and has to refuse without printing the thing it is refusing, because build logs are
 * not private either.
 */
const KEY = '0123456789abcdef0123456789abcdef';
const GATEWAY = `https://gateway.thegraph.com/api/${KEY}/subgraphs/id/QmVpmSubgraphId`;
const SUBGRAPH_VAR = 'NEXT_PUBLIC_HUNCH_SUBGRAPH_URL';

describe('readPublicEndpoint', () => {
  it('refuses a keyed gateway URL', () => {
    expect(() => readPublicEndpoint(SUBGRAPH_VAR, GATEWAY)).toThrow(PublicEnvError);
  });

  it('refuses every shape that carries a credential', () => {
    const keyed = [
      GATEWAY,
      `https://gateway.thegraph.com/api/${KEY}`,
      `https://gateway.thegraph.com/api/${KEY}/deployments/id/0xabc`,
      `https://example.test/subgraphs/${KEY}`,
      `https://example.test/graphql?api_key=${KEY}`,
      `https://example.test/graphql?access_token=${KEY}`,
      `https://alice:${KEY}@example.test/graphql`,
    ];
    for (const url of keyed) {
      expect(() => readPublicEndpoint(SUBGRAPH_VAR, url), url).toThrow(PublicEnvError);
    }
  });

  it('never puts the value, or the key inside it, into the message it throws', () => {
    const bad = [GATEWAY, `https://example.test/graphql?api_key=${KEY}`, `not-a-url-${KEY}`, `ftp://host/${KEY}`];
    for (const url of bad) {
      const error = (() => {
        try {
          readPublicEndpoint(SUBGRAPH_VAR, url);
          return undefined;
        } catch (thrown) {
          return thrown as Error;
        }
      })();
      expect(error, url).toBeInstanceOf(PublicEnvError);
      expect(error?.message, url).not.toContain(KEY);
      expect(error?.message, url).not.toContain(url);
    }
  });

  it('says which variable, why it cannot be public, and what to do instead', () => {
    let message = '';
    try {
      readPublicEndpoint(SUBGRAPH_VAR, GATEWAY);
    } catch (thrown) {
      message = (thrown as Error).message;
    }
    expect(message).toContain(SUBGRAPH_VAR);
    expect(message).toContain('API key');
    expect(message).toContain('browser bundle');
    expect(message).toContain('proxy');
    expect(message).toContain('fixture');
  });

  it('throws rather than warning, so a bad deploy fails instead of leaking', () => {
    // The whole point: no sanitised value comes back, and there is no quiet fallback
    // to fixtures that would let a keyed URL sit unnoticed in production config.
    expect(() => readPublicEndpoint(SUBGRAPH_VAR, GATEWAY)).toThrow();
  });

  it('accepts a keyless endpoint unchanged', () => {
    const studio = 'https://api.studio.thegraph.com/query/45678/hunch-vpm/v0.0.1';
    expect(readPublicEndpoint(SUBGRAPH_VAR, studio)).toBe(studio);
    // The gateway's header-authenticated form has no key in the path and is allowed.
    const headerAuth = 'https://gateway.thegraph.com/api/subgraphs/id/QmVpmSubgraphId';
    expect(readPublicEndpoint(SUBGRAPH_VAR, headerAuth)).toBe(headerAuth);
    // A proxy of your own is the other supported answer.
    expect(readPublicEndpoint(SUBGRAPH_VAR, 'https://vpm.example.test/api/subgraph')).toBe(
      'https://vpm.example.test/api/subgraph',
    );
  });

  it('treats unset and blank as "use fixtures", which is the documented default', () => {
    expect(readPublicEndpoint(SUBGRAPH_VAR, undefined)).toBeUndefined();
    expect(readPublicEndpoint(SUBGRAPH_VAR, '')).toBeUndefined();
    expect(readPublicEndpoint(SUBGRAPH_VAR, '   ')).toBeUndefined();
  });

  it('refuses a value that is not an absolute URL, naming only its length', () => {
    let message = '';
    try {
      readPublicEndpoint(SUBGRAPH_VAR, 'gateway.thegraph.com/subgraphs');
    } catch (thrown) {
      message = (thrown as Error).message;
    }
    expect(message).toContain('absolute URL');
    expect(message).toContain('30 characters');
    expect(message).not.toContain('gateway.thegraph.com');
  });

  it('refuses a scheme the browser cannot fetch', () => {
    expect(() => readPublicEndpoint(SUBGRAPH_VAR, 'ftp://example.test/graphql')).toThrow(/scheme is "ftp:"/);
  });

  it('trims, so a trailing newline in a dashboard-pasted value is not a failure', () => {
    expect(readPublicEndpoint(SUBGRAPH_VAR, '  https://example.test/graphql\n')).toBe('https://example.test/graphql');
  });
});

describe('keyedUrlReason', () => {
  it('names the gateway path position specifically', () => {
    expect(keyedUrlReason(GATEWAY)).toContain('directly after "api"');
  });

  it('names a long hex segment wherever it sits', () => {
    expect(keyedUrlReason(`https://example.test/v1/${KEY}/graphql`)).toContain('hexadecimal');
  });

  it('names userinfo and query parameters', () => {
    expect(keyedUrlReason(`https://a:${KEY}@example.test/g`)).toContain('userinfo');
    expect(keyedUrlReason(`https://example.test/g?apiKey=${KEY}`)).toContain('apiKey');
  });

  it('never quotes the part it thinks is the key', () => {
    for (const url of [GATEWAY, `https://a:${KEY}@example.test/g`, `https://example.test/g?apiKey=${KEY}`]) {
      expect(keyedUrlReason(url), url).not.toContain(KEY);
    }
  });

  it('finds nothing to complain about in a keyless URL', () => {
    expect(keyedUrlReason('https://api.studio.thegraph.com/query/45678/hunch-vpm/v0.0.1')).toBeUndefined();
    expect(keyedUrlReason('https://gateway.thegraph.com/api/subgraphs/id/QmVpmSubgraphId')).toBeUndefined();
    expect(keyedUrlReason('https://vpm.example.test/api/subgraph')).toBeUndefined();
  });
});

/**
 * The guard is only worth anything where it is wired in. `dataSource` is a module-level
 * const, so a keyed variable makes importing the module fail — which fails `next build`
 * and refuses to start the server, rather than shipping the key to every visitor.
 */
describe('the data-source module', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('will not load at all when the public subgraph variable is keyed', async () => {
    vi.stubEnv('NEXT_PUBLIC_HUNCH_SUBGRAPH_URL', GATEWAY);
    vi.resetModules();
    await expect(import('@/lib/data')).rejects.toThrow(/NEXT_PUBLIC_HUNCH_SUBGRAPH_URL/);
  });

  it('will not load when the optional reputation endpoint is keyed either', async () => {
    vi.stubEnv('NEXT_PUBLIC_HUNCH_SUBGRAPH_URL', '');
    vi.stubEnv('NEXT_PUBLIC_ERC8004_SUBGRAPH_URL', GATEWAY);
    vi.resetModules();
    await expect(import('@/lib/data')).rejects.toThrow(/NEXT_PUBLIC_ERC8004_SUBGRAPH_URL/);
  });

  it('loads the fixture source when nothing is configured, as before', async () => {
    vi.stubEnv('NEXT_PUBLIC_HUNCH_SUBGRAPH_URL', '');
    vi.stubEnv('NEXT_PUBLIC_ERC8004_SUBGRAPH_URL', '');
    vi.resetModules();
    const loaded = await import('@/lib/data');
    expect(loaded.dataSource).toBeDefined();
    await expect(loaded.dataSource.listMarkets()).resolves.toBeInstanceOf(Array);
  });
});
