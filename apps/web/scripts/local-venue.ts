/**
 * A local venue for rehearsing the web app end to end, and a scripted check of it.
 *
 * `setup` deploys the compiled contracts on a local anvil that uses Robinhood Chain's chain id
 * (MockUSDG's code at USDG's canonical address, so USDG's hardcoded EIP-712 domain verifies;
 * Multicall3's captured code at its canonical address; a MockAggregator standing in for the
 * NVDA feed), funds anvil's first two default accounts (the E2E mock wallet's accounts) with ETH
 * and USDG, lists a short market that is open now (bell in 20 minutes) and writes an env file for
 * the web app. Every key it uses is generated for this run and exists only on this anvil.
 *
 * `check` drives a running web server built and started with that env file: the pages and the
 * API, a gasless bet signed by anvil account 0 and relayed through /api/relay/enter, the country
 * gate, a pay-gas bet from account 1, then it moves the chain past the bell and runs the cron
 * jobs (resolve, deliver) through /api/cron with the secret, and reads the settlement back.
 *
 *   anvil --chain-id 4663 --port 8545
 *   forge build --root contracts                      # or --out <dir>, then pass --forge-out <dir>
 *   pnpm --filter @hunch-rh/web exec tsx scripts/local-venue.ts setup --env /tmp/hunch-local.env
 *   set -a; . /tmp/hunch-local.env; set +a
 *   NEXT_DIST_DIR=.next/e2e pnpm --filter @hunch-rh/web exec next build
 *   NEXT_DIST_DIR=.next/e2e pnpm --filter @hunch-rh/web exec next start -p 3218
 *   pnpm --filter @hunch-rh/web exec tsx scripts/local-venue.ts check --env /tmp/hunch-local.env --web http://localhost:3218
 *
 * With that build, the browser's wallet list offers "Mock Connector" (NEXT_PUBLIC_E2E=1), whose
 * accounts are anvil's unlocked accounts: connect, sign, relay and confirm work without an
 * extension. Never set NEXT_PUBLIC_E2E for a real deployment.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  MULTICALL3_ADDRESS,
  UP,
  USDG_ADDRESS,
  approveUsdgCall,
  buildEnterAuthorization,
  enterCall,
  makePublicClient,
  openUpDownCall,
  parseDeployment,
  randomSalt,
  robinhoodChain,
  type Deployment,
} from '@hunch-rh/client';
import { createTestClient, createWalletClient, http, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const USDG = 1_000_000n;
/** Anvil's first two default accounts: unlocked on anvil, so the E2E mock wallet can sign with them. */
const E2E_ACCOUNTS: readonly Address[] = ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}

const ROOT = resolve(import.meta.dirname, '../../..');
const rpc = arg('rpc', 'http://127.0.0.1:8545');
const envFile = resolve(arg('env', '/tmp/hunch-local.env'));

function artifact(name: string): { abi: Abi; bytecode: Hex; deployed: Hex } {
  const out = resolve(ROOT, arg('forge-out', 'contracts/out'));
  const path = `${out}/${name}.sol/${name}.json`;
  if (!existsSync(path)) throw new Error(`${path} not found: run forge build --root contracts (or pass --forge-out)`);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  return { abi: json.abi, bytecode: json.bytecode.object, deployed: json.deployedBytecode.object };
}

function readEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)='(.*)'$/.exec(line.trim());
    if (m !== null) out[m[1]!] = m[2]!;
  }
  return out;
}

const publicClient = (): PublicClient => makePublicClient({ rpcUrl: rpc, excludePublicRpc: true, retryCount: 0, pollingIntervalMs: 50 }) as unknown as PublicClient;
const testClient = () => createTestClient({ mode: 'anvil', chain: robinhoodChain, transport: http(rpc) });

async function setup(): Promise<void> {
  const client = publicClient();
  const test = testClient();
  const chainId = await client.getChainId();
  if (chainId !== 4663) throw new Error(`anvil must run with --chain-id 4663 (got ${chainId})`);

  const keys = { deployer: generatePrivateKey(), keeper: generatePrivateKey(), safe: generatePrivateKey() };
  const acct = { deployer: privateKeyToAccount(keys.deployer), keeper: privateKeyToAccount(keys.keeper), safe: privateKeyToAccount(keys.safe) };
  for (const a of [...Object.values(acct).map((x) => x.address), ...E2E_ACCOUNTS]) await test.setBalance({ address: a, value: 10n ** 20n });

  const wallet = (who: keyof typeof acct) => createWalletClient({ account: acct[who], chain: robinhoodChain, transport: http(rpc) });
  const send = async (who: keyof typeof acct, call: { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] }) => {
    const { request } = await client.simulateContract({ ...call, account: acct[who] } as never);
    const hash = await wallet(who).writeContract(request as never);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${call.functionName} reverted`);
    return receipt;
  };
  const deploy = async (name: string, args: readonly unknown[] = []): Promise<Address> => {
    const a = artifact(name);
    const hash = await wallet('deployer').deployContract({ abi: a.abi, bytecode: a.bytecode, args } as never);
    return (await client.waitForTransactionReceipt({ hash })).contractAddress!;
  };

  await test.setCode({ address: USDG_ADDRESS, bytecode: artifact('MockUSDG').deployed });
  const mc3 = JSON.parse(readFileSync(resolve(ROOT, 'packages/client/test/fixtures/multicall3-runtime.json'), 'utf8')) as { code: Hex };
  await test.setCode({ address: MULTICALL3_ADDRESS, bytecode: mc3.code });

  const startBlock = Number(await client.getBlockNumber());
  const agg = await deploy('MockAggregator', ['RHNVDA / USD']);
  const stock = await deploy('MockStockToken', ['NVDA']);
  const resolver = await deploy('StockRoundResolver');
  const vpm = await deploy('HunchVPM', [acct.safe.address, acct.safe.address]);
  const factory = await deploy('HunchMarketFactory', [vpm, resolver, USDG_ADDRESS, acct.deployer.address, acct.safe.address]);
  const fAbi = artifact('HunchMarketFactory').abi;
  await send('deployer', { address: factory, abi: fAbi, functionName: 'setFeed', args: [agg, stock, 'NVDA', 93_600, 93_600, true] });
  await send('deployer', { address: factory, abi: fAbi, functionName: 'setOpener', args: [acct.keeper.address, true] });
  const mint = artifact('MockUSDG').abi;
  await send('deployer', { address: USDG_ADDRESS, abi: mint, functionName: 'mint', args: [acct.keeper.address, 1_000n * USDG] });
  for (const a of E2E_ACCOUNTS) await send('deployer', { address: USDG_ADDRESS, abi: mint, functionName: 'mint', args: [a, 500n * USDG] });

  const now = Number((await client.getBlock()).timestamp);
  const aggAbi = artifact('MockAggregator').abi;
  await send('deployer', { address: agg, abi: aggAbi, functionName: 'addRound', args: [22_000_000_000n, BigInt(now - 50_000)] });
  await send('deployer', { address: agg, abi: aggAbi, functionName: 'addRound', args: [22_100_000_000n, BigInt(now - 600)] });

  const block = Number(await client.getBlockNumber());
  const deployment: Deployment = parseDeployment({
    network: 'anvil-4663',
    chainId: 4663,
    status: 'deployed',
    deployedAt: new Date(now * 1000).toISOString(),
    gitCommit: 'local',
    startBlock,
    contracts: {
      HunchVPM: { address: vpm, deployTx: `0x${'1'.repeat(64)}`, block },
      StockRoundResolver: { address: resolver, deployTx: `0x${'2'.repeat(64)}`, block },
      HunchMarketFactory: { address: factory, deployTx: `0x${'3'.repeat(64)}`, block },
    },
    safe: acct.safe.address,
    keeper: acct.keeper.address,
    usdg: USDG_ADDRESS,
    multicall3: MULTICALL3_ADDRESS,
    explorer: 'https://robinhoodchain.blockscout.com',
    params: { kappa: 30, feeBps: 200, voidTimeoutSec: 259_200, seedPerLeg: '10000000', minEntry: '1000000', maxEntry: '100000000' },
    feeds: [{ ticker: 'NVDA', feed: agg, aggregator: agg, stockToken: stock, maxStrikeAge: 93_600, maxFinalAge: 93_600, families: ['daily', 'weekly'] }],
  });

  // A market that is open now: its opening price is the round 10 minutes ago, its bell is in 20 minutes.
  await send('keeper', approveUsdgCall(deployment, { amount: 20n * USDG, spender: factory }));
  await send(
    'keeper',
    openUpDownCall(deployment, {
      feed: agg,
      strikeTime: BigInt(now - 300),
      finalTime: BigInt(now + 1_200),
      maxStrikeAge: 0,
      maxFinalAge: 0,
      seedPerLeg: 10n * USDG,
      minEntry: 1n * USDG,
      maxEntry: 100n * USDG,
    }),
  );

  const json = JSON.stringify(deployment);
  const lines = {
    HUNCH_DEPLOYMENT_JSON: json,
    NEXT_PUBLIC_HUNCH_DEPLOYMENT_JSON: json,
    RH_RPC_URL: rpc,
    NEXT_PUBLIC_RH_RPC_URL: rpc,
    NEXT_PUBLIC_E2E: '1',
    // Generated for this run; it holds value only on this local anvil.
    KEEPER_PRIVATE_KEY: keys.keeper,
    CRON_SECRET: randomBytes(24).toString('hex'),
    LOCAL_VENUE_MARKET: '0',
    LOCAL_VENUE_AGGREGATOR: agg,
    LOCAL_VENUE_DEPLOYER_KEY: keys.deployer,
    LOCAL_VENUE_FINAL_TIME: String(now + 1_200),
  };
  writeFileSync(envFile, `${Object.entries(lines).map(([k, v]) => `${k}='${v}'`).join('\n')}\n`, { mode: 0o600 });
  console.log(`local venue on ${rpc}: HunchVPM ${vpm}, factory ${factory}, market 0 (bell in 20 min)`);
  console.log(`E2E accounts funded with 500 USDG: ${E2E_ACCOUNTS.join(', ')}`);
  console.log(`env written to ${envFile}`);
}

// ------------------------------------------------------------------ check

let failures = 0;
function expect(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` :: ${detail}`}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function check(): Promise<void> {
  const web = arg('web', 'http://localhost:3218');
  const env = readEnv();
  const deployment = parseDeployment(env.HUNCH_DEPLOYMENT_JSON!);
  const marketId = BigInt(env.LOCAL_VENUE_MARKET ?? '0');
  const client = publicClient();
  const test = testClient();
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${web}${path}`, { headers });
    const text = await res.text();
    return { status: res.status, text, json: () => JSON.parse(text) as Record<string, unknown> };
  };

  const markets = await get('/api/markets');
  const list = (markets.json().markets as { id: string; question: string; phase: string }[]) ?? [];
  expect('GET /api/markets lists the local market', markets.status === 200 && list.some((m) => m.id === marketId.toString()), list.map((m) => `${m.id} ${m.phase}`).join(', '));
  const page = await get(`/m/${marketId}`);
  expect('GET /m/[id] renders the market with its rules box and bet panel', page.status === 200 && page.text.includes('How this market settles.') && page.text.includes('Place a bet'));
  expect('GET /m/999 is a 404', (await get('/m/999')).status === 404);

  // A gasless bet from anvil account 0: one signature (anvil signs for its unlocked account), relayed.
  const signer = createWalletClient({ account: E2E_ACCOUNTS[0]!, chain: robinhoodChain, transport: http(rpc) });
  const relayBody = async (amount: bigint) => {
    const salt = randomSalt();
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
    const auth = buildEnterAuthorization({ from: E2E_ACCOUNTS[0]!, hunchVpm: deployment.contracts.HunchVPM.address, marketId, outcome: UP, amount, validAfter: 0n, validBefore, salt });
    const signature = await signer.signTypedData({ account: E2E_ACCOUNTS[0]!, ...auth });
    return JSON.stringify({ from: E2E_ACCOUNTS[0], marketId: marketId.toString(), outcome: UP, amount: amount.toString(), validAfter: '0', validBefore: validBefore.toString(), salt, signature, chainId: 4663, hunchVpm: deployment.contracts.HunchVPM.address });
  };
  const post = (body: string, country: string) => fetch(`${web}/api/relay/enter`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-vercel-ip-country': country }, body });

  const blocked = await post(await relayBody(5n * USDG), 'US');
  expect('the relay refuses a US request with 403', blocked.status === 403, (await blocked.text()).slice(0, 120));
  const relayed = await post(await relayBody(20n * USDG), 'FR');
  const relayedBody = (await relayed.json()) as { ok: boolean; txHash?: Hex; receipt?: string; message?: string };
  expect('a signed bet is relayed and confirmed (200)', relayed.status === 200 && relayedBody.ok && relayedBody.receipt === 'confirmed', JSON.stringify(relayedBody).slice(0, 160));
  const ethBefore = await client.getBalance({ address: E2E_ACCOUNTS[0]! });

  // A pay-gas bet from anvil account 1: approve the exact amount, then enter DOWN.
  const payer = createWalletClient({ account: E2E_ACCOUNTS[1]!, chain: robinhoodChain, transport: http(rpc) });
  for (const call of [approveUsdgCall(deployment, { amount: 30n * USDG }), enterCall(deployment, { marketId, outcome: 1, amount: 30n * USDG })]) {
    const hash = await payer.writeContract({ ...call, account: E2E_ACCOUNTS[1]! } as never);
    expect(`pay-gas ${call.functionName} confirmed`, (await client.waitForTransactionReceipt({ hash })).status === 'success');
  }
  expect('the gasless bettor spent no ETH', (await client.getBalance({ address: E2E_ACCOUNTS[0]! })) === ethBefore);

  await test.mine({ blocks: 1 });
  const cron = (job: string) => get(`/api/cron/${job}`, { authorization: `Bearer ${env.CRON_SECRET}` });
  expect('cron without the secret is 401', (await get('/api/cron/deliver')).status === 401);
  const finalize = await cron('deliver');
  expect('cron deliver runs (finalizes the open batch)', finalize.status === 200, finalize.text.slice(0, 200));
  await sleep(6_000);

  const detail = (await get(`/api/markets/${marketId}?t=${Date.now()}`)).json() as { positions: { owner: string; accepted: string | null; side: string; seed: boolean }[] };
  const mine = detail.positions.filter((p) => !p.seed);
  expect(
    'GET /api/markets/[id] shows the bets, each accepted',
    mine.length >= 2 && mine.some((p) => p.side === 'UP') && mine.some((p) => p.side === 'DOWN') && mine.every((p) => p.accepted !== null),
    mine.map((p) => `${p.side} ${p.accepted}`).join(', '),
  );
  const portfolio = await get(`/api/positions?owner=${E2E_ACCOUNTS[0]}`);
  expect('GET /api/positions shows the bettor’s position', portfolio.status === 200 && (portfolio.json().positions as unknown[]).length >= 1, portfolio.text.slice(0, 160));

  // The bell: a final print, then past the bell; the keeper resolves and delivers.
  const finalTime = Number(env.LOCAL_VENUE_FINAL_TIME);
  const aggAbi = artifact('MockAggregator').abi;
  const deployer = createWalletClient({ account: privateKeyToAccount(env.LOCAL_VENUE_DEPLOYER_KEY as Hex), chain: robinhoodChain, transport: http(rpc) });
  await test.setNextBlockTimestamp({ timestamp: BigInt(finalTime - 60) });
  const print = await deployer.writeContract({ address: env.LOCAL_VENUE_AGGREGATOR as Address, abi: aggAbi, functionName: 'addRound', args: [22_500_000_000n, BigInt(finalTime - 60)] } as never);
  await client.waitForTransactionReceipt({ hash: print });
  await test.setNextBlockTimestamp({ timestamp: BigInt(finalTime + 90) });
  await test.mine({ blocks: 1 });

  const resolved = await cron('resolve');
  expect('cron resolve settles the market with the proven rounds', resolved.status === 200 && resolved.text.includes('"status":"confirmed"'), resolved.text.slice(0, 240));
  const delivered = await cron('deliver');
  expect('cron deliver pays every winner', delivered.status === 200 && delivered.text.includes('claimFor'), delivered.text.slice(0, 240));
  await sleep(6_000);

  const settled = (await get(`/api/markets/${marketId}?t=${Date.now()}`)).json() as {
    market: { phase: string; winner: string };
    resolution: { outcome: string; tx: string | null } | null;
    positions: { payoutTx: string | null; side: string; seed: boolean; claimed: boolean }[];
    finder: { ok: boolean } | null;
  };
  expect('the market reads Resolved UP', settled.market.phase === 'resolved' && settled.market.winner === 'UP', JSON.stringify(settled.resolution));
  expect('the resolve transaction is linked', settled.resolution?.tx !== null && settled.resolution?.tx !== undefined);
  expect('every winning bet has its payout transaction', settled.positions.filter((p) => p.side === 'UP').every((p) => p.claimed && p.payoutTx !== null));
  const settledPage = await get(`/m/${marketId}`);
  expect('the market page shows the settlement', settledPage.text.includes('Settlement') && settledPage.text.includes('Resolved'));
  const proof = await get('/api/proof');
  const counts = proof.json().counts as { marketsResolved?: number } | null;
  const bettors = proof.json().bettors as { distinct?: number } | null;
  expect('/api/proof counts the settlement and both bettors', counts?.marketsResolved === 1 && bettors?.distinct === 2, JSON.stringify({ counts, bettors }));
  const health = await get('/api/health');
  expect('/api/health answers (200 or 503 with checks)', [200, 503].includes(health.status) && health.text.includes('"checks"'), health.text.slice(0, 300));

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

const command = process.argv[2];
if (command === 'setup') await setup();
else if (command === 'check') await check();
else {
  console.error('usage: tsx scripts/local-venue.ts setup|check [--rpc URL] [--env FILE] [--web URL] [--forge-out DIR]');
  process.exitCode = 2;
}
