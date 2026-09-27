import type { Address, Hex } from 'viem';

/**
 * The schema of `deployments/robinhood-mainnet.json` (frozen in .ocean/PLAN.md).
 * `scripts/wire-deployment.mjs --check` validates the committed file against the same
 * rules as `validateDeployment()`, and embeds a copy in this package.
 */

export type DeploymentStatus = 'not-deployed' | 'deployed';
export type ListedFamily = 'daily' | 'weekly';

export interface ContractRecord {
  address: Address;
  deployTx: Hex | null;
  block: number | null;
}

export interface FeedConfig {
  ticker: string;
  /** Chainlink AggregatorV3 standard proxy (not the SVR proxy). */
  feed: Address;
  /** The proxy's current aggregator (emits AnswerUpdated). */
  aggregator: Address;
  /** The Robinhood Stock Token the feed prices (for `oraclePaused()`). */
  stockToken: Address;
  /** Seconds; the factory allow-list bound for `strikeTime - updatedAt(strike round)`. */
  maxStrikeAge: number;
  /** Seconds; the factory allow-list bound for `finalTime - updatedAt(final round)`. */
  maxFinalAge: number;
  /** Which market families the keeper lists for this ticker. */
  families: ListedFamily[];
  /** Allow-listed on chain but held back by the keeper until the FLAT-rate check passes. */
  pendingFlatRateCheck?: boolean;
  /** Optional: the feed's `description()`. */
  description?: string;
}

export interface DeploymentParams {
  kappa: number;
  feeBps: number;
  voidTimeoutSec: number;
  /** USDG base units, decimal string. */
  seedPerLeg: string;
  minEntry: string;
  maxEntry: string;
}

export interface Deployment {
  network: string;
  chainId: number;
  status: DeploymentStatus;
  deployedAt: string | null;
  gitCommit: string | null;
  /** L2 block number of the first deploy transaction (log scans start here). */
  startBlock: number | null;
  contracts: {
    HunchVPM: ContractRecord;
    StockRoundResolver: ContractRecord;
    HunchMarketFactory: ContractRecord;
  };
  safe: Address;
  keeper: Address;
  usdg: Address;
  multicall3: Address;
  explorer: string;
  params: DeploymentParams;
  feeds: FeedConfig[];
}

/** `params` as bigints, ready for contract calls. */
export interface DeploymentParamsBig {
  kappa: bigint;
  feeBps: number;
  voidTimeoutSec: bigint;
  seedPerLeg: bigint;
  minEntry: bigint;
  maxEntry: bigint;
}
