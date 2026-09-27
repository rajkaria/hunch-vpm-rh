import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARC_USDC, UNDEPLOYED, defaultAddressesFor } from '../src/addresses.js';
import { arcMainnet, arcTestnet, CAIP2, GRAPH_NETWORK_SLUG } from '../src/chains.js';
import { defineConfig, gatewayUrl } from '../src/config.js';
import { fixtureTransport } from './support/transport.js';

const transport = fixtureTransport({});

describe('gatewayUrl', () => {
  it('builds the documented gateway shape', () => {
    expect(gatewayUrl('KEY', 'SUBGRAPH')).toBe('https://gateway.thegraph.com/api/KEY/subgraphs/id/SUBGRAPH');
  });

  it('refuses an empty part rather than producing a broken URL', () => {
    expect(() => gatewayUrl('', 'SUBGRAPH')).toThrow(/apiKey is empty/);
    expect(() => gatewayUrl('KEY', '')).toThrow(/subgraphId is empty/);
  });
});

describe('defineConfig', () => {
  it('defaults to Arc testnet with its known addresses', () => {
    const config = defineConfig({ subgraphUrl: 'https://subgraph.invalid/x', transport });

    expect(config.chain.id).toBe(arcTestnet.id);
    expect(config.chain.id).toBe(5042002);
    expect(config.addresses.usdc).toBe(ARC_USDC);
    expect(config.addresses.identityRegistry).toBe('0x8004A818BFB912233c491871b3d84c89A494BD9e');
    expect(config.addresses.storkOracle).toBe('0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62');
    // Ours are deployed to testnet, and the defaults are the deployment record — not a copy
    // that can drift from it. `scripts/wire-deployment.mjs --check` holds the same line in CI.
    const deployment = JSON.parse(
      readFileSync(new URL('../../../deployments/arc-testnet.json', import.meta.url), 'utf8'),
    ) as Record<string, string>;
    expect(config.addresses.vestedParimutuel).toBe(deployment['vestedParimutuel']);
    expect(config.addresses.classicParimutuel).toBe(deployment['classicParimutuel']);
    expect(config.addresses.feedResolver).toBe(deployment['feedResolver']);
    expect(config.addresses.marketFactory).toBe(deployment['marketFactory']);
  });

  it('holds no mainnet address of ours, because nothing is deployed there', () => {
    const mainnet = defaultAddressesFor(arcMainnet.id);
    for (const key of ['vestedParimutuel', 'classicParimutuel', 'feedResolver', 'marketFactory'] as const) {
      expect(mainnet[key]).toBe(UNDEPLOYED);
    }
  });

  it('builds the gateway URL from a subgraph id and an api key', () => {
    const config = defineConfig({ subgraphId: 'ABC', apiKey: 'KEY', transport });
    expect(config.subgraphUrl).toBe('https://gateway.thegraph.com/api/KEY/subgraphs/id/ABC');
  });

  it('prefers an explicit URL over the gateway form', () => {
    const config = defineConfig({ subgraphUrl: 'https://self-hosted.invalid/x', subgraphId: 'ABC', apiKey: 'KEY', transport });
    expect(config.subgraphUrl).toBe('https://self-hosted.invalid/x');
  });

  it('refuses to be constructed without an endpoint', () => {
    expect(() => defineConfig({ transport })).toThrow(/no subgraph endpoint/);
    // A subgraph id with no key cannot address the gateway.
    expect(() => defineConfig({ subgraphId: 'ABC', transport })).toThrow(/no subgraph endpoint/);
  });

  it('has no reputation source unless one is configured', () => {
    expect(defineConfig({ subgraphUrl: 'https://subgraph.invalid/x', transport }).erc8004SubgraphUrl).toBeNull();
  });

  it('overrides addresses without dropping the rest', () => {
    const config = defineConfig({
      subgraphUrl: 'https://subgraph.invalid/x',
      transport,
      addresses: { vestedParimutuel: '0x1111111111111111111111111111111111111111' },
    });
    expect(config.addresses.vestedParimutuel).toBe('0x1111111111111111111111111111111111111111');
    expect(config.addresses.usdc).toBe(ARC_USDC);
  });

  it('rejects a page size the gateway would refuse', () => {
    expect(() => defineConfig({ subgraphUrl: 'https://subgraph.invalid/x', transport, pageSize: 0 })).toThrow(
      RangeError,
    );
    expect(() => defineConfig({ subgraphUrl: 'https://subgraph.invalid/x', transport, pageSize: 1001 })).toThrow(
      RangeError,
    );
  });

  it('has no defaults for a chain it does not know', () => {
    expect(() => defaultAddressesFor(1)).toThrow(/no default addresses for chain 1/);
  });
});

describe('chains', () => {
  it('records the verified Arc identifiers', () => {
    expect(arcTestnet.id).toBe(5042002);
    expect(arcMainnet.id).toBe(5042);
    // Circle's docs name rpc.testnet.arc.io as the primary endpoint now. The older
    // rpc.testnet.arc.network still answers chain 5042002; .io is the documented one.
    expect(arcTestnet.rpcUrls.default.http[0]).toBe('https://rpc.testnet.arc.io');
    expect(arcTestnet.blockExplorers?.default.url).toBe('https://testnet.arcscan.app');
    expect(GRAPH_NETWORK_SLUG[arcTestnet.id]).toBe('arc-testnet');
    expect(GRAPH_NETWORK_SLUG[arcMainnet.id]).toBe('arc');
    expect(CAIP2[arcTestnet.id]).toBe('eip155:5042002');
  });

  it('denominates in USDC, which is the gas token, at its NATIVE 18 decimals', () => {
    // Two views of one balance: 18 natively, 6 through the ERC-20 interface.
    // nativeCurrency is the native view; amounts use USDC_DECIMALS (6).
    expect(arcTestnet.nativeCurrency.symbol).toBe('USDC');
    expect(arcTestnet.nativeCurrency.decimals).toBe(18);
    expect(arcMainnet.nativeCurrency.decimals).toBe(18);
  });
});
