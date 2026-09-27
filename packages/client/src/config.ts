import type { Chain } from 'viem';
import type { HunchAddresses } from './addresses.js';
import { defaultAddressesFor } from './addresses.js';
import { arcTestnet } from './chains.js';
import type { GraphQLTransport } from './transport.js';
import { fetchTransport } from './transport.js';

export interface HunchClientConfig {
  /**
   * The `hunch-vpm` subgraph's query endpoint. Either a full URL or, with
   * `apiKey`, a Subgraph Studio id to be expanded into the gateway URL.
   */
  subgraphUrl?: string;
  /** Subgraph Studio deployment id, used with `apiKey` to build the gateway URL. */
  subgraphId?: string;
  /** The ERC-8004 subgraph for the same chain. Without it, reputation reads are unavailable. */
  erc8004SubgraphUrl?: string;
  /** ERC-8004 Subgraph Studio id, used with `apiKey`. */
  erc8004SubgraphId?: string;
  /**
   * The Graph gateway API key. It goes in the URL path, which is the shape the
   * gateway documents: keep it out of logs and out of client-side bundles.
   */
  apiKey?: string;
  /** Defaults to Arc testnet. */
  chain?: Chain;
  /** Overrides for the chain's default addresses. Everything not given keeps its default. */
  addresses?: Partial<HunchAddresses>;
  /** Swap in a recorded transport for tests, or a fetch with your own retry policy. */
  transport?: GraphQLTransport;
  /**
   * Whether a market read also pulls the open vintage and the entries queued
   * in it. That is what lets the client subtract stake already offered against
   * the book you need in the current block, which is the difference between
   * "this much will be accepted" and "this much would be accepted if nobody
   * else were in the same block". It costs one nested selection per market
   * read; with it off, every affected read says so in `demandUnknown` rather
   * than quietly reporting an upper bound. Defaults to true.
   */
  readOpenVintage?: boolean;
  /** How many entities to pull per page when a read has to walk a collection. Default 500. */
  pageSize?: number;
}

export interface ResolvedConfig {
  subgraphUrl: string;
  erc8004SubgraphUrl: string | null;
  chain: Chain;
  addresses: HunchAddresses;
  transport: GraphQLTransport;
  readOpenVintage: boolean;
  pageSize: number;
}

/**
 * The Graph gateway's URL shape. The API key is a path segment, not a header,
 * which is why it must never end up in a browser bundle or a log line.
 *
 *   https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>
 */
export function gatewayUrl(apiKey: string, subgraphId: string): string {
  if (apiKey === '') throw new Error('gatewayUrl: apiKey is empty');
  if (subgraphId === '') throw new Error('gatewayUrl: subgraphId is empty');
  return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`;
}

function resolveEndpoint(url: string | undefined, id: string | undefined, apiKey: string | undefined): string | null {
  if (url !== undefined && url !== '') return url;
  if (id !== undefined && id !== '' && apiKey !== undefined && apiKey !== '') return gatewayUrl(apiKey, id);
  return null;
}

export const DEFAULT_PAGE_SIZE = 500;

export function defineConfig(config: HunchClientConfig = {}): ResolvedConfig {
  const chain = config.chain ?? arcTestnet;
  const subgraphUrl = resolveEndpoint(config.subgraphUrl, config.subgraphId, config.apiKey);
  if (subgraphUrl === null) {
    throw new Error(
      'no subgraph endpoint: pass `subgraphUrl`, or `subgraphId` together with `apiKey` ' +
        'to build https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>',
    );
  }

  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    // The Graph refuses `first` above 1000.
    throw new RangeError(`pageSize must be an integer in [1, 1000], got ${pageSize}`);
  }

  return {
    subgraphUrl,
    erc8004SubgraphUrl: resolveEndpoint(config.erc8004SubgraphUrl, config.erc8004SubgraphId, config.apiKey),
    chain,
    addresses: { ...defaultAddressesFor(chain.id), ...config.addresses },
    transport: config.transport ?? fetchTransport(),
    readOpenVintage: config.readOpenVintage ?? true,
    pageSize,
  };
}
