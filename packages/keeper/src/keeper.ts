import { loadDeployment, type Deployment } from '@hunch-rh/client';
import { makeAlerter, type Alerter } from './alerts.js';
import { loadCorporateActions } from './calendar.js';
import { checkHealth, type HealthReport } from './health.js';
import { chainRelayReads, defaultRelayLimiter, relayEnter, walletRelaySender, type RateLimiter, type RelayResult } from './relay.js';
import { consoleLogger, runDrill, runJob, type JobName, type JobReport, type Logger } from './runner.js';
import { makeKeeperClients, type EnvLike, type KeeperClients } from './wallet.js';
import { finalizeWhenDue, type FinalizeOptions, type FinalizeOutcome } from './finalize.js';

/**
 * One object for route handlers (apps/web `/api/cron/[job]`, `/api/relay/enter`,
 * `/api/health`) and scripts: deployment + transports + wallet + alerts from env.
 *
 *   const keeper = createKeeper(process.env);
 *   await keeper.run('resolve');                       // cron
 *   await keeper.relay(body, { country, ip });         // POST /api/relay/enter
 *   await keeper.health();                             // GET /api/health
 */
export interface Keeper {
  deployment: Deployment;
  clients: KeeperClients;
  alerter: Alerter;
  log: Logger;
  run(job: JobName | 'all', options?: { dryRun?: boolean; nowSec?: number }): Promise<JobReport[]>;
  relay(body: unknown, meta: { country?: string | null; ip?: string | null; nowSec?: number; limiter?: RateLimiter }): Promise<RelayResult>;
  health(options?: { nowSec?: number }): Promise<HealthReport>;
  planDrill(options?: { ticker?: string; nowSec?: number }): Promise<JobReport>;
  openDrill(options?: { ticker?: string; nowSec?: number; dryRun?: boolean }): Promise<JobReport>;
  /** After a bet: write the market's open batch on chain once its Ethereum block has passed. */
  finalizeSoon(marketId: bigint, l1BlockAtEntry: bigint, options?: FinalizeOptions): Promise<FinalizeOutcome>;
}

export function createKeeper(env: EnvLike = (globalThis as { process?: { env?: EnvLike } }).process?.env ?? {}, options: { deployment?: Deployment; log?: Logger } = {}): Keeper {
  const deployment = options.deployment ?? loadDeployment({ env });
  const clients = makeKeeperClients({ deployment, env });
  const log = options.log ?? consoleLogger(clients.redact);
  const alerter = makeAlerter(env, { redact: clients.redact });
  const base = {
    deployment,
    publicClient: clients.publicClient,
    fallbackClient: clients.fallbackClient,
    log,
    alerter,
    redact: clients.redact,
  };
  return {
    deployment,
    clients,
    alerter,
    log,
    run: (job, o = {}) =>
      runJob(job, {
        ...base,
        walletClient: o.dryRun === true ? null : clients.walletClient,
        dryRun: o.dryRun === true,
        corporateActions: loadCorporateActions(),
        ...(o.nowSec === undefined ? {} : { nowSec: o.nowSec }),
      }),
    relay: (body, meta) =>
      relayEnter(body, {
        deployment,
        chain: chainRelayReads(clients.publicClient, deployment, clients.relayerAccount ?? undefined),
        nowSec: meta.nowSec ?? Math.floor(Date.now() / 1000),
        country: meta.country ?? null,
        ip: meta.ip ?? null,
        limiter: meta.limiter ?? defaultRelayLimiter,
        sender: clients.relayerWalletClient === null ? null : walletRelaySender(clients.relayerWalletClient, clients.publicClient, deployment),
      }),
    health: (o = {}) =>
      checkHealth(clients.publicClient, deployment, {
        redact: clients.redact,
        corporateActions: loadCorporateActions(),
        // The wallets this deployment actually sends from (after a key rotation, not the JSON's).
        keeper: clients.account,
        relayer: clients.relayerAccount,
        ...(o.nowSec === undefined ? {} : { nowSec: o.nowSec }),
      }),
    planDrill: (o = {}) => runDrill({ ...base, dryRun: true, ...(o.nowSec === undefined ? {} : { nowSec: o.nowSec }) }, { ...(o.ticker === undefined ? {} : { ticker: o.ticker }), plan: true }),
    openDrill: (o = {}) =>
      runDrill(
        { ...base, walletClient: o.dryRun === true ? null : clients.walletClient, dryRun: o.dryRun === true, ...(o.nowSec === undefined ? {} : { nowSec: o.nowSec }) },
        { ...(o.ticker === undefined ? {} : { ticker: o.ticker }) },
      ),
    // Runs right after a relayed bet, on the relay's instance: the relayer's wallet and nonces.
    finalizeSoon: (marketId, l1BlockAtEntry, o = {}) => finalizeWhenDue(clients.publicClient, clients.relayerWalletClient, deployment, marketId, l1BlockAtEntry, o),
  };
}
