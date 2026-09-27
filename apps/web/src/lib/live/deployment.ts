// TODO(S7): replace with @hunch-rh/client's deployment loader (deployments/robinhood-mainnet.json).
/**
 * The deployment, as the site reads it.
 *
 * `deployments/robinhood-mainnet.json` is the single source of addresses (docs/spec/00-README.md).
 * It does not exist until the contracts agent writes it (status "not-deployed" until the operator
 * deploys), so this module carries the same shape with every one of our addresses empty. A
 * rehearsal can override it with the full JSON in `HUNCH_DEPLOYMENT_JSON` (server) or
 * `NEXT_PUBLIC_HUNCH_DEPLOYMENT_JSON` (browser), per .ocean/DECISIONS.md.
 */

import { TICKERS, type Ticker } from '@/content/tickers';
import { MULTICALL3, ROBINHOOD_CHAIN, USDG } from '@/lib/site';

export interface DeployedContract {
  address: string | null;
  deployTx: string | null;
  block: number | null;
}

export interface DeploymentFeed {
  ticker: Ticker;
  feed: string;
  aggregator: string;
  stockToken: string;
  maxStrikeAge: number;
  maxFinalAge: number;
  families: ('daily' | 'weekly')[];
}

export interface Deployment {
  network: string;
  chainId: number;
  status: 'not-deployed' | 'deployed';
  deployedAt: string | null;
  gitCommit: string | null;
  startBlock: number | null;
  contracts: {
    HunchVPM: DeployedContract;
    StockRoundResolver: DeployedContract;
    HunchMarketFactory: DeployedContract;
  };
  safe: string | null;
  keeper: string | null;
  usdg: string;
  multicall3: string;
  explorer: string;
  /** Venue parameters. Before deployment these are the planned values from docs/spec/02-mechanism.md. */
  params: {
    kappa: number;
    feeBps: number;
    voidTimeoutSec: number;
    seedPerLeg: string;
    minEntry: string;
    maxEntry: string;
  };
  feeds: DeploymentFeed[];
}

const EMPTY: DeployedContract = { address: null, deployTx: null, block: null };

/** 26 h: the feed heartbeat plus 2 h (docs/spec/04-markets-and-resolution.md). */
const AGE_BOUND = 93_600;

export const NOT_DEPLOYED: Deployment = {
  network: 'robinhood-mainnet',
  chainId: ROBINHOOD_CHAIN.id,
  status: 'not-deployed',
  deployedAt: null,
  gitCommit: null,
  startBlock: null,
  contracts: { HunchVPM: EMPTY, StockRoundResolver: EMPTY, HunchMarketFactory: EMPTY },
  safe: null,
  keeper: null,
  usdg: USDG.address,
  multicall3: MULTICALL3,
  explorer: ROBINHOOD_CHAIN.explorerUrl,
  params: {
    kappa: 30,
    feeBps: 200,
    voidTimeoutSec: 72 * 3600,
    seedPerLeg: '10000000',
    minEntry: '1000000',
    maxEntry: '100000000',
  },
  feeds: TICKERS.map((entry) => ({
    ticker: entry.ticker,
    feed: entry.feed,
    aggregator: entry.aggregator,
    stockToken: entry.stockToken,
    maxStrikeAge: AGE_BOUND,
    maxFinalAge: AGE_BOUND,
    families: entry.v1 === 'yes' ? ['daily', 'weekly'] : [],
  })),
};

function contract(value: unknown): DeployedContract {
  if (typeof value !== 'object' || value === null) return EMPTY;
  const record = value as Record<string, unknown>;
  return {
    address: typeof record.address === 'string' ? record.address : null,
    deployTx: typeof record.deployTx === 'string' ? record.deployTx : null,
    block: typeof record.block === 'number' ? record.block : null,
  };
}

/**
 * Parse a deployment JSON string. Anything malformed falls back to "not deployed": a site
 * that claims a deployment it cannot read is worse than one that says it is launching.
 */
export function parseDeployment(text: string | undefined): Deployment {
  if (text === undefined || text.trim() === '') return NOT_DEPLOYED;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw.chainId !== ROBINHOOD_CHAIN.id) return NOT_DEPLOYED;
    const contracts = (raw.contracts ?? {}) as Record<string, unknown>;
    const params = { ...NOT_DEPLOYED.params, ...((raw.params ?? {}) as Partial<Deployment['params']>) };
    return {
      ...NOT_DEPLOYED,
      network: typeof raw.network === 'string' ? raw.network : NOT_DEPLOYED.network,
      status: raw.status === 'deployed' ? 'deployed' : 'not-deployed',
      deployedAt: typeof raw.deployedAt === 'string' ? raw.deployedAt : null,
      gitCommit: typeof raw.gitCommit === 'string' ? raw.gitCommit : null,
      startBlock: typeof raw.startBlock === 'number' ? raw.startBlock : null,
      contracts: {
        HunchVPM: contract(contracts.HunchVPM),
        StockRoundResolver: contract(contracts.StockRoundResolver),
        HunchMarketFactory: contract(contracts.HunchMarketFactory),
      },
      safe: typeof raw.safe === 'string' ? raw.safe : null,
      keeper: typeof raw.keeper === 'string' ? raw.keeper : null,
      params: {
        kappa: Number(params.kappa),
        feeBps: Number(params.feeBps),
        voidTimeoutSec: Number(params.voidTimeoutSec),
        seedPerLeg: String(params.seedPerLeg),
        minEntry: String(params.minEntry),
        maxEntry: String(params.maxEntry),
      },
      feeds: Array.isArray(raw.feeds) ? (raw.feeds as DeploymentFeed[]) : NOT_DEPLOYED.feeds,
    };
  } catch {
    return NOT_DEPLOYED;
  }
}

export function readDeployment(): Deployment {
  return parseDeployment(process.env.HUNCH_DEPLOYMENT_JSON ?? process.env.NEXT_PUBLIC_HUNCH_DEPLOYMENT_JSON);
}
