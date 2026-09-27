import { createHunchClient } from '../../src/client.js';
import type { HunchClient } from '../../src/client.js';
import type { HunchClientConfig } from '../../src/config.js';
import type { FixtureTransport } from './transport.js';
import { fixtureTransport } from './transport.js';

export const TEST_SETTLER = '0x1111111111111111111111111111111111111111';
export const CREATOR = '0x2222222222222222222222222222222222222222';
export const ALICE = '0x4444444444444444444444444444444444444444';
export const BOB = '0x5555555555555555555555555555555555555555';
export const MARKET_A = '0x1111111111111111111111111111111111111111-0';
export const MARKET_TIGHT = '0x1111111111111111111111111111111111111111-1';
export const MARKET_UNBOUNDED = '0x1111111111111111111111111111111111111111-2';
export const MARKET_EMPTY = '0x1111111111111111111111111111111111111111-3';
export const MARKET_VOIDED = '0x1111111111111111111111111111111111111111-4';

/** A client wired to recorded responses. `.invalid` is reserved and unroutable. */
export function testClient(
  responses: Record<string, unknown>,
  config: HunchClientConfig = {},
): { client: HunchClient; transport: FixtureTransport } {
  const transport = fixtureTransport(responses);
  const client = createHunchClient({
    subgraphUrl: 'https://subgraph.invalid/hunch-vpm',
    erc8004SubgraphUrl: 'https://subgraph.invalid/erc8004-arc',
    transport,
    addresses: { vestedParimutuel: TEST_SETTLER, marketFactory: '0x9999999999999999999999999999999999999999' },
    ...config,
  });
  return { client, transport };
}
