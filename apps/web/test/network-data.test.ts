import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as claimable } from '@/app/api/claimable/route';
import { GET as positions } from '@/app/api/positions/route';
import { NETWORK_COOKIE, parseNetwork } from '@/lib/network';

const WALLET = '0x6D2a4c1b9E0f3A8d5C7b2E1f4A9c8B3d6E5f0a42';
const STUDIO = (slug: string) => `https://api.studio.thegraph.com/query/45678/${slug}/v0.0.1`;
const KEYED = 'https://gateway.thegraph.com/api/0123456789abcdef0123456789abcdef/subgraphs/id/QmVpmSubgraphId';

const ENDPOINT_VARIABLES = [
  'NEXT_PUBLIC_HUNCH_SUBGRAPH_URL',
  'NEXT_PUBLIC_HUNCH_SUBGRAPH_URL_TESTNET',
  'NEXT_PUBLIC_HUNCH_SUBGRAPH_URL_MAINNET',
  'NEXT_PUBLIC_ERC8004_SUBGRAPH_URL',
  'NEXT_PUBLIC_ERC8004_SUBGRAPH_URL_TESTNET',
  'NEXT_PUBLIC_ERC8004_SUBGRAPH_URL_MAINNET',
];

describe('parseNetwork', () => {
  it('accepts exactly the two Arcs', () => {
    expect(parseNetwork('testnet')).toBe('testnet');
    expect(parseNetwork('mainnet')).toBe('mainnet');
  });

  it('refuses everything else rather than guessing', () => {
    for (const junk of ['', 'Testnet', 'arc', 'ethereum', null, undefined]) {
      expect(parseNetwork(junk)).toBeNull();
    }
  });

  it('names the cookie the server reads', () => {
    expect(NETWORK_COOKIE).toBe('hunch-vpm.network');
  });
});

describe.each([
  ['/api/positions', positions],
  ['/api/claimable', claimable],
])('%s, per network', (path, GET) => {
  const get = (query: string) => GET(new Request(`http://x${path}?${query}`));

  it('refuses a network that is not an Arc', async () => {
    const response = await get(`network=ethereum&address=${WALLET}`);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/testnet or mainnet/);
  });

  it('answers for either Arc and says which one answered', async () => {
    for (const network of ['testnet', 'mainnet']) {
      const response = await get(`network=${network}&address=${WALLET}`);
      expect(response.status).toBe(200);
      expect((await response.json()).network).toBe(network);
    }
  });

  it('reads the deployment default when no network is named', async () => {
    const response = await get(`address=${WALLET}`);
    expect((await response.json()).network).toBe('testnet');
  });

  it('still refuses a bad address before it looks at the network', async () => {
    expect((await get('network=mainnet&address=nope')).status).toBe(400);
  });
});

describe('each network reads its own index', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const load = async (env: Record<string, string>) => {
    for (const name of ENDPOINT_VARIABLES) vi.stubEnv(name, env[name] ?? '');
    vi.resetModules();
    return import('@/lib/data');
  };

  it('goes live on the network that has an endpoint, and stays on fixtures on the one that does not', async () => {
    const data = await load({ NEXT_PUBLIC_HUNCH_SUBGRAPH_URL_MAINNET: STUDIO('hunch-vpm-arc') });
    expect(data.dataSourceFor('mainnet').kind).toBe('live');
    expect(data.dataSourceFor('testnet').kind).toBe('fixture');
  });

  it('still reads the unsuffixed variable as testnet', async () => {
    const data = await load({ NEXT_PUBLIC_HUNCH_SUBGRAPH_URL: STUDIO('hunch-vpm-arc-testnet') });
    expect(data.dataSourceFor('testnet').kind).toBe('live');
  });

  it('never lets mainnet fall back to the unsuffixed testnet variable', async () => {
    const data = await load({ NEXT_PUBLIC_HUNCH_SUBGRAPH_URL: STUDIO('hunch-vpm-arc-testnet') });
    expect(data.dataSourceFor('mainnet').kind).toBe('fixture');
  });

  it('refuses to load with a keyed mainnet endpoint', async () => {
    await expect(load({ NEXT_PUBLIC_HUNCH_SUBGRAPH_URL_MAINNET: KEYED })).rejects.toThrow(
      /NEXT_PUBLIC_HUNCH_SUBGRAPH_URL_MAINNET/,
    );
  });

  it('refuses a keyed variable even when a more specific one shadows it', async () => {
    await expect(
      load({
        NEXT_PUBLIC_HUNCH_SUBGRAPH_URL_TESTNET: STUDIO('hunch-vpm-arc-testnet'),
        NEXT_PUBLIC_HUNCH_SUBGRAPH_URL: KEYED,
      }),
    ).rejects.toThrow(/NEXT_PUBLIC_HUNCH_SUBGRAPH_URL/);
  });

  it('keeps `dataSource` as the default network’s source', async () => {
    const data = await load({ NEXT_PUBLIC_HUNCH_SUBGRAPH_URL_TESTNET: STUDIO('hunch-vpm-arc-testnet') });
    expect(data.dataSource).toBe(data.dataSourceFor('testnet'));
  });
});
