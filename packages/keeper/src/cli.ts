#!/usr/bin/env node
import { formatDuration, formatPrice, isDeployed, loadDeployment, readChainHead, readPrices } from '@hunch-rh/client';
import { makeAlerter } from './alerts.js';
import { checkHealth } from './health.js';
import { consoleLogger, formatReports, runDrill, runJob, JOBS, NOT_DEPLOYED_NOTE, type JobName } from './runner.js';
import { makeKeeperClients, type EnvLike } from './wallet.js';

/**
 * pnpm --filter @hunch-rh/keeper keeper run-once [open|resolve|deliver|all] [--dry-run] [--now <unix>] [--json]
 * pnpm --filter @hunch-rh/keeper keeper plan-drill [--ticker NVDA] [--now <unix>]      (read-only)
 * pnpm --filter @hunch-rh/keeper keeper open-drill [--ticker NVDA] [--dry-run]          (lists it with the keeper key)
 * pnpm --filter @hunch-rh/keeper keeper health [--now <unix>] [--json]
 *
 * Env (names only; values never printed): KEEPER_PRIVATE_KEY, RH_RPC_URL,
 * RH_FALLBACK_RPC_URL, HUNCH_DEPLOYMENT_JSON, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
 */

const USAGE = `usage:
  keeper run-once [open|resolve|deliver|all] [--dry-run] [--now <unix>] [--json]
  keeper plan-drill [--ticker NVDA] [--now <unix>]
  keeper open-drill [--ticker NVDA] [--dry-run] [--now <unix>]
  keeper health [--now <unix>] [--json]`;

interface Args {
  command: string | undefined;
  positional: string[];
  dryRun: boolean;
  json: boolean;
  now: number | undefined;
  ticker: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { command: argv[0], positional: [], dryRun: false, json: false, now: undefined, ticker: undefined };
  for (let i = 1; i < argv.length; i++) {
    const x = argv[i]!;
    if (x === '--dry-run') a.dryRun = true;
    else if (x === '--json') a.json = true;
    else if (x === '--now') a.now = Number(argv[++i]);
    else if (x === '--ticker') a.ticker = argv[++i];
    else if (x.startsWith('--')) throw new Error(`unknown flag ${x}`);
    else a.positional.push(x);
  }
  if (a.now !== undefined && !Number.isSafeInteger(a.now)) throw new Error('--now takes unix seconds');
  return a;
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env as EnvLike;
  const deployment = loadDeployment({ env });
  const needsKey = (args.command === 'run-once' || args.command === 'open-drill') && !args.dryRun;
  const clients = makeKeeperClients({ deployment, env, withWallet: needsKey });
  const log = consoleLogger(clients.redact);
  const alerter = makeAlerter(env, { redact: clients.redact });

  switch (args.command) {
    case 'run-once': {
      const job = (args.positional[0] ?? 'all') as JobName | 'all';
      if (job !== 'all' && !JOBS.includes(job)) throw new Error(`unknown job ${job}\n${USAGE}`);
      if (!isDeployed(deployment)) {
        // Still prove the read path works: chain head and the v1 feeds, read-only.
        const [head, prices] = await Promise.all([readChainHead(clients.publicClient), readPrices(clients.publicClient, deployment)]);
        console.log(NOT_DEPLOYED_NOTE);
        console.log(`chain 4663 · L2 block ${head.blockNumber} · L1 block ${head.l1BlockNumber} · ${clients.describe}`);
        for (const r of prices.rows) {
          const price = r.price === null ? 'unreadable' : formatPrice(r.price);
          const age = r.ageSec === null ? '' : ` (updated ${formatDuration(r.ageSec)} ago)`;
          console.log(`  ${r.ticker.padEnd(5)} ${price}${age}${r.pendingFlatRateCheck ? ' · held back until its FLAT-rate check passes' : ''}`);
        }
        return 0;
      }
      if (needsKey && clients.walletClient === null) throw new Error('KEEPER_PRIVATE_KEY is not set: use --dry-run, or set it to send transactions');
      log.info(`keeper run-once ${job}${args.dryRun ? ' (dry run)' : ''} · ${clients.describe}`);
      const reports = await runJob(job, {
        deployment,
        publicClient: clients.publicClient,
        fallbackClient: clients.fallbackClient,
        walletClient: args.dryRun ? null : clients.walletClient,
        dryRun: args.dryRun,
        log,
        alerter,
        redact: clients.redact,
        ...(args.now === undefined ? {} : { nowSec: args.now }),
      });
      console.log(clients.redact(args.json ? json(reports) : formatReports(reports)));
      return reports.some((r) => r.actions.some((a) => a.status === 'failed')) ? 1 : 0;
    }
    case 'plan-drill':
    case 'open-drill': {
      const plan = args.command === 'plan-drill';
      if (!plan && !args.dryRun && isDeployed(deployment) && clients.walletClient === null) {
        throw new Error('KEEPER_PRIVATE_KEY is not set: use --dry-run, or set it to list the drill');
      }
      const report = await runDrill(
        {
          deployment,
          publicClient: clients.publicClient,
          walletClient: plan || args.dryRun ? null : clients.walletClient,
          dryRun: plan || args.dryRun,
          log,
          alerter,
          redact: clients.redact,
          ...(args.now === undefined ? {} : { nowSec: args.now }),
        },
        { ...(args.ticker === undefined ? {} : { ticker: args.ticker }), plan },
      );
      console.log(clients.redact(args.json ? json(report) : formatReports([report])));
      return report.actions.some((a) => a.status === 'failed') ? 1 : 0;
    }
    case 'health': {
      const report = await checkHealth(clients.publicClient, deployment, { redact: clients.redact, ...(args.now === undefined ? {} : { nowSec: args.now }) });
      if (args.json) console.log(json(report));
      else {
        console.log(`health: ${report.ok ? 'OK' : 'FAILING'}${report.deployed ? '' : ' (not deployed)'}`);
        for (const c of report.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
      }
      return report.ok ? 0 : 2;
    }
    default:
      console.error(USAGE);
      return 64;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // Never print a stack that could carry a URL with a key: message only, redacted by the
    // same rules (the key itself was never read into a message).
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.replace(/0x[0-9a-fA-F]{64}/g, '0x***'));
    process.exit(1);
  });
