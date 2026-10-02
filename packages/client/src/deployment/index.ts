import { getAddress, isAddress, type Address } from 'viem';
import { CHAIN_ID, MULTICALL3_ADDRESS, USDG_ADDRESS, ZERO_ADDRESS } from '../constants.js';
import { EMBEDDED_DEPLOYMENT } from './embedded.js';
import type { Deployment, DeploymentParamsBig, FeedConfig } from './types.js';

export type * from './types.js';
export { EMBEDDED_DEPLOYMENT };

/**
 * The single source of Hunch's addresses: `deployments/robinhood-mainnet.json`,
 * embedded in this package by `scripts/wire-deployment.mjs`, overridable for
 * rehearsals (an anvil fork) with a full JSON string in:
 *   - `HUNCH_DEPLOYMENT_JSON` (server, keeper), or
 *   - `NEXT_PUBLIC_HUNCH_DEPLOYMENT_JSON` (browser bundle).
 *
 * Next.js inlines `process.env.NEXT_PUBLIC_*` only where the expression is written
 * literally, so browser code should pass it explicitly:
 *   `loadDeployment({ json: process.env.NEXT_PUBLIC_HUNCH_DEPLOYMENT_JSON })`.
 */

export class DeploymentError extends Error {
  readonly problems: string[];
  constructor(problems: string[], source: string) {
    super(`invalid deployment (${source}): ${problems.join('; ')}`);
    this.name = 'DeploymentError';
    this.problems = problems;
  }
}

type EnvLike = Record<string, string | undefined>;

function defaultEnv(): EnvLike {
  try {
    const env = (globalThis as { process?: { env?: EnvLike } }).process?.env;
    return env ?? {};
  } catch {
    return {};
  }
}

export interface LoadDeploymentOptions {
  /** A full deployment JSON string (takes precedence over env). Empty/undefined = ignore. */
  json?: string | null | undefined;
  /** Environment to read the override from (defaults to `globalThis.process?.env`). */
  env?: EnvLike | undefined;
}

let embeddedCache: Deployment | null = null;

/** The committed deployment, or the override from `json` / env. Throws on an invalid override. */
export function loadDeployment(options: LoadDeploymentOptions = {}): Deployment {
  const explicit = options.json?.trim();
  if (explicit !== undefined && explicit !== '') return parseDeployment(explicit, 'argument');
  const env = options.env ?? defaultEnv();
  const fromEnv = (env.HUNCH_DEPLOYMENT_JSON ?? env.NEXT_PUBLIC_HUNCH_DEPLOYMENT_JSON)?.trim();
  if (fromEnv !== undefined && fromEnv !== '') {
    const name = env.HUNCH_DEPLOYMENT_JSON?.trim() ? 'HUNCH_DEPLOYMENT_JSON' : 'NEXT_PUBLIC_HUNCH_DEPLOYMENT_JSON';
    return parseDeployment(fromEnv, name);
  }
  embeddedCache ??= parseDeployment(EMBEDDED_DEPLOYMENT, 'embedded deployments/robinhood-mainnet.json');
  return embeddedCache;
}

/** True when the three contracts have real addresses and the status says so. */
export function isDeployed(d: Deployment): boolean {
  return (
    d.status === 'deployed' &&
    d.contracts.HunchVPM.address !== ZERO_ADDRESS &&
    d.contracts.StockRoundResolver.address !== ZERO_ADDRESS &&
    d.contracts.HunchMarketFactory.address !== ZERO_ADDRESS
  );
}

/**
 * The same deployment in the "not deployed" state: zero contracts, Safe and keeper, no
 * receipts; feeds and params kept. For tests and previews of the pre-launch venue.
 */
export function notDeployed(d: Deployment): Deployment {
  const zero = { address: ZERO_ADDRESS, deployTx: null, block: null };
  return {
    ...d,
    status: 'not-deployed',
    deployedAt: null,
    gitCommit: null,
    startBlock: null,
    contracts: { HunchVPM: zero, StockRoundResolver: zero, HunchMarketFactory: zero },
    safe: ZERO_ADDRESS,
    keeper: ZERO_ADDRESS,
  };
}

export function deploymentParams(d: Deployment): DeploymentParamsBig {
  return {
    kappa: BigInt(d.params.kappa),
    feeBps: d.params.feeBps,
    voidTimeoutSec: BigInt(d.params.voidTimeoutSec),
    seedPerLeg: BigInt(d.params.seedPerLeg),
    minEntry: BigInt(d.params.minEntry),
    maxEntry: BigInt(d.params.maxEntry),
  };
}

export function feedByTicker(d: Deployment, ticker: string): FeedConfig | undefined {
  const wanted = ticker.trim().toUpperCase();
  return d.feeds.find((f) => f.ticker.toUpperCase() === wanted);
}

export function feedByAddress(d: Deployment, feed: Address): FeedConfig | undefined {
  const wanted = feed.toLowerCase();
  return d.feeds.find((f) => f.feed.toLowerCase() === wanted);
}

/** Parse + validate a deployment (JSON string or object). Addresses come back checksummed. */
export function parseDeployment(input: unknown, source = 'input'): Deployment {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown;
    } catch (error) {
      throw new DeploymentError([`not JSON: ${(error as Error).message}`], source);
    }
  }
  const problems = validateDeployment(value);
  if (problems.length > 0) throw new DeploymentError(problems, source);
  return normalize(value as Deployment);
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^\d+$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * Every problem with a deployment object, or `[]`. The same rules are implemented in
 * `scripts/wire-deployment.mjs` (no dependencies) plus EIP-55 checksums here.
 */
const TOP_LEVEL_KEYS = new Set([
  'network', 'chainId', 'status', 'deployedAt', 'gitCommit', 'startBlock', 'contracts',
  'safe', 'keeper', 'usdg', 'multicall3', 'explorer', 'params', 'feeds',
]);

export function validateDeployment(value: unknown): string[] {
  const p: string[] = [];
  if (!isObj(value)) return ['not an object'];
  const d = value;
  const addr = (v: unknown, path: string, allowZero = true): boolean => {
    if (typeof v !== 'string' || !isAddress(v, { strict: false })) {
      p.push(`${path}: not an address`);
      return false;
    }
    if (v !== v.toLowerCase() && !isAddress(v, { strict: true })) p.push(`${path}: bad EIP-55 checksum`);
    if (!allowZero && v.toLowerCase() === ZERO_ADDRESS) p.push(`${path}: zero address`);
    return true;
  };

  for (const k of Object.keys(d)) if (!TOP_LEVEL_KEYS.has(k)) p.push(`${k}: unknown key`);
  if (typeof d.network !== 'string' || d.network === '') p.push('network: missing');
  if (d.chainId !== CHAIN_ID) p.push(`chainId: expected ${CHAIN_ID}`);
  if (d.status !== 'deployed' && d.status !== 'not-deployed') p.push('status: must be "deployed" or "not-deployed"');
  const deployed = d.status === 'deployed';
  if (d.deployedAt !== null && typeof d.deployedAt !== 'string') p.push('deployedAt: string or null');
  if (d.gitCommit !== null && typeof d.gitCommit !== 'string') p.push('gitCommit: string or null');
  if (d.startBlock !== null && !isInt(d.startBlock)) p.push('startBlock: integer or null');
  if (deployed) {
    if (typeof d.deployedAt !== 'string') p.push('deployedAt: required when deployed');
    if (!isInt(d.startBlock)) p.push('startBlock: required when deployed');
  }

  if (!isObj(d.contracts)) {
    p.push('contracts: missing');
  } else {
    for (const name of ['HunchVPM', 'StockRoundResolver', 'HunchMarketFactory'] as const) {
      const c = d.contracts[name];
      if (!isObj(c)) {
        p.push(`contracts.${name}: missing`);
        continue;
      }
      if (addr(c.address, `contracts.${name}.address`, !deployed) && !deployed && typeof c.address === 'string') {
        if (c.address.toLowerCase() !== ZERO_ADDRESS) p.push(`contracts.${name}.address: must be zero while not deployed`);
      }
      if (c.deployTx !== null && (typeof c.deployTx !== 'string' || !HEX32.test(c.deployTx))) {
        p.push(`contracts.${name}.deployTx: 32-byte hex or null`);
      }
      if (c.block !== null && !isInt(c.block)) p.push(`contracts.${name}.block: integer or null`);
      if (deployed && (c.deployTx === null || c.block === null)) p.push(`contracts.${name}: deployTx and block required when deployed`);
    }
  }

  addr(d.safe, 'safe', !deployed);
  addr(d.keeper, 'keeper', !deployed);
  if (addr(d.usdg, 'usdg') && typeof d.usdg === 'string' && d.usdg.toLowerCase() !== USDG_ADDRESS.toLowerCase()) {
    p.push(`usdg: expected ${USDG_ADDRESS}`);
  }
  if (addr(d.multicall3, 'multicall3') && typeof d.multicall3 === 'string' && d.multicall3.toLowerCase() !== MULTICALL3_ADDRESS.toLowerCase()) {
    p.push(`multicall3: expected ${MULTICALL3_ADDRESS}`);
  }
  if (typeof d.explorer !== 'string' || !/^https:\/\//.test(d.explorer)) p.push('explorer: https URL required');

  if (!isObj(d.params)) {
    p.push('params: missing');
  } else {
    const pr = d.params;
    if (!isInt(pr.kappa) || pr.kappa < 1) p.push('params.kappa: integer >= 1');
    if (!isInt(pr.feeBps) || pr.feeBps > 500) p.push('params.feeBps: integer 0..500');
    if (!isInt(pr.voidTimeoutSec)) p.push('params.voidTimeoutSec: integer');
    for (const k of ['seedPerLeg', 'minEntry', 'maxEntry'] as const) {
      if (typeof pr[k] !== 'string' || !UINT.test(pr[k] as string)) p.push(`params.${k}: decimal string of base units`);
    }
    if (typeof pr.minEntry === 'string' && typeof pr.maxEntry === 'string' && UINT.test(pr.minEntry) && UINT.test(pr.maxEntry)) {
      if (BigInt(pr.maxEntry) !== 0n && BigInt(pr.minEntry) > BigInt(pr.maxEntry)) p.push('params: minEntry > maxEntry');
    }
    if (typeof pr.seedPerLeg === 'string' && UINT.test(pr.seedPerLeg) && BigInt(pr.seedPerLeg) < 1_000_000n) {
      p.push('params.seedPerLeg: at least 1 USDG (1000000)');
    }
  }

  if (!Array.isArray(d.feeds)) {
    p.push('feeds: array required');
  } else {
    const tickers = new Set<string>();
    const feeds = new Set<string>();
    d.feeds.forEach((f: unknown, i: number) => {
      const at = `feeds[${i}]`;
      if (!isObj(f)) {
        p.push(`${at}: not an object`);
        return;
      }
      if (typeof f.ticker !== 'string' || !/^[A-Z][A-Z0-9.]{0,9}$/.test(f.ticker)) p.push(`${at}.ticker: upper-case symbol`);
      else if (tickers.has(f.ticker)) p.push(`${at}.ticker: duplicate ${f.ticker}`);
      else tickers.add(f.ticker);
      if (addr(f.feed, `${at}.feed`, false) && typeof f.feed === 'string') {
        if (feeds.has(f.feed.toLowerCase())) p.push(`${at}.feed: duplicate`);
        feeds.add(f.feed.toLowerCase());
      }
      addr(f.aggregator, `${at}.aggregator`, false);
      addr(f.stockToken, `${at}.stockToken`, false);
      for (const k of ['maxStrikeAge', 'maxFinalAge'] as const) {
        if (!isInt(f[k]) || (f[k] as number) === 0 || (f[k] as number) > 8 * 86_400) p.push(`${at}.${k}: seconds in 1..691200`);
      }
      if (!Array.isArray(f.families) || f.families.some((x: unknown) => x !== 'daily' && x !== 'weekly')) {
        p.push(`${at}.families: subset of ["daily","weekly"]`);
      }
      if (f.pendingFlatRateCheck !== undefined && typeof f.pendingFlatRateCheck !== 'boolean') p.push(`${at}.pendingFlatRateCheck: boolean`);
      if (f.description !== undefined && typeof f.description !== 'string') p.push(`${at}.description: string`);
    });
  }
  return p;
}

function normalize(d: Deployment): Deployment {
  const a = (x: Address) => getAddress(x);
  const c = (r: Deployment['contracts']['HunchVPM']) => ({ ...r, address: a(r.address) });
  return {
    ...d,
    contracts: {
      HunchVPM: c(d.contracts.HunchVPM),
      StockRoundResolver: c(d.contracts.StockRoundResolver),
      HunchMarketFactory: c(d.contracts.HunchMarketFactory),
    },
    safe: a(d.safe),
    keeper: a(d.keeper),
    usdg: a(d.usdg),
    multicall3: a(d.multicall3),
    feeds: d.feeds.map((f) => ({
      ...f,
      feed: a(f.feed),
      aggregator: a(f.aggregator),
      stockToken: a(f.stockToken),
      families: [...f.families],
    })),
  };
}
