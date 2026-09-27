import { formatReport, runKeeper, type KeeperOptions } from './run.js';
import { createChainReader, createChainWriter } from './chain.js';

/**
 * The keeper's own entry point, separate from the agent's.
 *
 * They are different jobs with different risk. The agent holds a bankroll and
 * decides what to trade; the keeper holds only gas money and decides nothing —
 * anyone may call `resolve`, the caller has no influence on the answer and earns
 * nothing for it. Threading the keeper through the agent's CLI would put a
 * settlement key in a process that has no need of one.
 */

export interface KeeperEnv {
  ARC_RPC_URL?: string | undefined;
  FEED_RESOLVER?: string | undefined;
  KEEPER_SPEC_IDS?: string | undefined;
  KEEPER_PRIVATE_KEY?: string | undefined;
  ARC_CHAIN_ID?: string | undefined;
}

export interface KeeperCliDeps {
  env: KeeperEnv;
  log: (line: string) => void;
  error: (line: string) => void;
}

const USAGE = `hunch-keeper — settle frozen markets from the feed

  hunch-keeper [--live] [--allow-void] [--void-after <seconds>]

Reads every spec in KEEPER_SPEC_IDS and, for each, resolves it if the feed says
it is ready. Dry run unless --live. One pass per invocation, for cron.

  --live          actually send. Needs KEEPER_PRIVATE_KEY
  --allow-void    permit voidStale on a feed that has gone quiet past its bound.
                  OFF by default: resolve reverts rather than voids precisely so
                  a keeper retrying through a brief outage cannot destroy a
                  market that still had a good answer coming
  --void-after N  extra seconds past the bound before a void is considered

Environment:
  ARC_RPC_URL          required
  FEED_RESOLVER        required, the deployed FeedResolver
  KEEPER_SPEC_IDS      required, comma-separated bytes32 spec ids
  ARC_CHAIN_ID         default 5042002
  KEEPER_PRIVATE_KEY   only with --live. Gas money and nothing else`;

export async function runKeeperCli(
  argv: readonly string[],
  deps: KeeperCliDeps,
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    deps.log(USAGE);
    return 0;
  }

  const live = argv.includes('--live');
  const allowVoid = argv.includes('--allow-void');

  const voidAfterIndex = argv.indexOf('--void-after');
  let voidAfter = 0n;
  if (voidAfterIndex !== -1) {
    const raw = argv[voidAfterIndex + 1];
    if (raw === undefined || !/^\d+$/.test(raw)) {
      deps.error('--void-after needs a whole number of seconds');
      return 2;
    }
    voidAfter = BigInt(raw);
  }

  const rpcUrl = deps.env.ARC_RPC_URL ?? '';
  const resolver = deps.env.FEED_RESOLVER ?? '';
  const specIds = (deps.env.KEEPER_SPEC_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');

  const missing = [
    rpcUrl === '' ? 'ARC_RPC_URL' : null,
    resolver === '' ? 'FEED_RESOLVER' : null,
    specIds.length === 0 ? 'KEEPER_SPEC_IDS' : null,
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    deps.error(`missing: ${missing.join(', ')}`);
    return 2;
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(resolver)) {
    deps.error('FEED_RESOLVER is not an address');
    return 2;
  }

  const bad = specIds.filter((id) => !/^0x[0-9a-fA-F]{64}$/.test(id));
  if (bad.length > 0) {
    deps.error(`not bytes32 spec ids: ${bad.join(', ')}`);
    return 2;
  }

  const chainId = Number(deps.env.ARC_CHAIN_ID ?? '5042002');
  const reader = createChainReader({ rpcUrl, resolver: resolver as `0x${string}`, chainId });

  let writer = null;
  if (live) {
    const key = deps.env.KEEPER_PRIVATE_KEY ?? '';
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      deps.error('--live needs KEEPER_PRIVATE_KEY. Refusing to run live without one.');
      return 2;
    }
    writer = createChainWriter({
      rpcUrl,
      resolver: resolver as `0x${string}`,
      privateKey: key as `0x${string}`,
      chain: {
        id: chainId,
        name: 'Arc',
        // Native view of USDC, which is what gas is paid in: 18 decimals.
        nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      } as never,
    });
  }

  const options: KeeperOptions = {
    dryRun: !live,
    allowVoid,
    voidAfterExtraSeconds: voidAfter,
  };

  const report = await runKeeper(specIds, reader, writer, options);
  deps.log(formatReport(report));

  // Non-zero when a call was attempted and reverted, so cron can alert on it.
  return report.failed > 0 ? 1 : 0;
}

export { USAGE as KEEPER_USAGE };
