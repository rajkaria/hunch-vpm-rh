import {
  createPublicClient,
  defineChain,
  fallback,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from 'viem';
import { CHAIN_ID, EXPLORER_URL, MULTICALL3_ADDRESS, PUBLIC_RPC_URL } from './constants.js';

/**
 * Robinhood Chain mainnet (Arbitrum Orbit, parent chain Ethereum, ETH gas).
 *
 * Two facts every caller should know:
 * - `block.number` inside a contract (and Multicall3's `getBlockNumber()`) is the
 *   **L1 block estimate**, ~12 s steps, which is what the settler's vintages use. The
 *   RPC's `eth_blockNumber` is the L2 block number (~100 ms blocks).
 * - The public RPC keeps only ~10 minutes of historical state and caps `eth_getLogs`
 *   at 10k logs. Current-state reads (including `getRoundData` of any past round) work.
 */
export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [PUBLIC_RPC_URL] } },
  blockExplorers: {
    default: { name: 'Blockscout', url: EXPLORER_URL, apiUrl: `${EXPLORER_URL}/api` },
  },
  contracts: {
    multicall3: { address: MULTICALL3_ADDRESS },
  },
  blockTime: 100,
});

export type RobinhoodChain = typeof robinhoodChain;
export type HunchPublicClient = PublicClient<Transport, RobinhoodChain>;

export interface PublicClientOptions {
  /** Primary RPC (a keyed provider on servers). Defaults to the public RPC. */
  rpcUrl?: string | undefined;
  /** Further RPCs tried in order after the primary. The public RPC is always last. */
  fallbackRpcUrls?: readonly (string | undefined | null)[] | undefined;
  /** Leave the public RPC out of the fallback list (for a second, independent reader). */
  excludePublicRpc?: boolean | undefined;
  /** Per-request timeout in ms (default 8000). */
  timeoutMs?: number | undefined;
  /** Retries per transport before falling back (default 2). */
  retryCount?: number | undefined;
  /** Aggregate concurrent `readContract` calls into Multicall3 (default true). */
  multicallBatch?: boolean | undefined;
  /** Polling for receipts and watchers (default 250 ms: blocks come every ~100 ms). */
  pollingIntervalMs?: number | undefined;
}

/** The ordered, de-duplicated RPC list a client built with `options` will use. */
export function rpcUrlsFor(options: PublicClientOptions = {}): string[] {
  const urls: string[] = [];
  const push = (url: string | undefined | null) => {
    if (url === undefined || url === null) return;
    const trimmed = url.trim();
    if (trimmed === '' || urls.includes(trimmed)) return;
    urls.push(trimmed);
  };
  push(options.rpcUrl);
  for (const url of options.fallbackRpcUrls ?? []) push(url);
  if (options.excludePublicRpc !== true) push(PUBLIC_RPC_URL);
  if (urls.length === 0) throw new Error('no RPC URL: pass rpcUrl or allow the public RPC');
  return urls;
}

/**
 * A viem public client for chain 4663: `fallback([...http(url, { timeout: 8000,
 * retryCount: 2 })])` across the primary RPC, any extra fallbacks and the public RPC,
 * with Multicall3 batching of concurrent reads. Works in Node, a Next.js server and
 * the browser.
 */
export function makePublicClient(options: PublicClientOptions = {}): HunchPublicClient {
  const timeout = options.timeoutMs ?? 8_000;
  const retryCount = options.retryCount ?? 2;
  const transports = rpcUrlsFor(options).map((url) => http(url, { timeout, retryCount }));
  const transport = transports.length === 1 ? transports[0]! : fallback(transports);
  return createPublicClient({
    chain: robinhoodChain,
    transport,
    batch: options.multicallBatch === false ? undefined : { multicall: { wait: 0, batchSize: 4096 } },
    pollingInterval: options.pollingIntervalMs ?? 250,
  }) as HunchPublicClient;
}

/** Explorer links (Blockscout). */
export function explorerAddressUrl(address: Address, explorer: string = EXPLORER_URL): string {
  return `${explorer.replace(/\/$/, '')}/address/${address}`;
}

export function explorerTxUrl(hash: Hex, explorer: string = EXPLORER_URL): string {
  return `${explorer.replace(/\/$/, '')}/tx/${hash}`;
}

export function explorerBlockUrl(block: bigint | number, explorer: string = EXPLORER_URL): string {
  return `${explorer.replace(/\/$/, '')}/block/${block.toString()}`;
}

/** Parameters for `wallet_addEthereumChain` (EIP-3085), for add-then-switch flows. */
export function addChainParameters(rpcUrl: string = PUBLIC_RPC_URL): {
  chainId: Hex;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls: string[];
} {
  return {
    chainId: `0x${CHAIN_ID.toString(16)}`,
    chainName: robinhoodChain.name,
    nativeCurrency: { ...robinhoodChain.nativeCurrency },
    rpcUrls: [rpcUrl],
    blockExplorerUrls: [EXPLORER_URL],
  };
}

export type { Chain };
