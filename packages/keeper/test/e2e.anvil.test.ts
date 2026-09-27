import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DOWN,
  MARKET_STATUS,
  MULTICALL3_ADDRESS,
  UP,
  USDG_ADDRESS,
  approveUsdgCall,
  buildEnterAuthorization,
  closingBell,
  enterCall,
  makePublicClient,
  openingBell,
  parseDeployment,
  randomSalt,
  readMarket,
  readPositionsByOwner,
  readProof,
  readVenue,
  robinhoodChain,
  usdgAbi,
  type Deployment,
} from '@hunch-rh/client';
import { createTestClient, createWalletClient, http, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { generatePrivateKey, nonceManager, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chainRelayReads,
  evaluateHealth,
  readKeeperState,
  relayEnter,
  runDrill,
  runJob,
  silentLogger,
  walletRelaySender,
  RateLimiter,
  type RunContext,
} from '../src/index.js';

/**
 * End to end against the REAL contracts (contracts/out) on a local anvil with chain id
 * 4663: MockUSDG's code at USDG's canonical address (so the hardcoded EIP-712 domain is
 * the one that verifies), Multicall3's captured runtime code at its canonical address, a
 * MockAggregator standing in for a Chainlink proxy. The keeper lists markets, a bettor
 * enters gasless through the relayer and another pays gas, the bell passes, the keeper
 * resolves with proven rounds and delivers every payout; then the refund drill voids on a
 * provably stale Saturday reading and refunds everyone.
 *
 * Needs `anvil` (Foundry) and `forge build --root contracts`; skipped otherwise.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const out = (name: string) => `${ROOT}contracts/out/${name}.sol/${name}.json`;
const hasAnvil = spawnSync('anvil', ['--version']).status === 0;
const hasOut = ['HunchVPM', 'StockRoundResolver', 'HunchMarketFactory', 'MockUSDG', 'MockAggregator', 'MockStockToken'].every((n) => existsSync(out(n)));

function artifact(name: string): { abi: Abi; bytecode: Hex; deployed: Hex } {
  const j = JSON.parse(readFileSync(out(name), 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object, deployed: j.deployedBytecode.object };
}

const utc = (y: number, m: number, d: number, h: number, min = 0, s = 0) => Date.UTC(y, m - 1, d, h, min, s) / 1000;
const PORT = 18_545 + Math.floor(Math.random() * 1000);
const URL_ = `http://127.0.0.1:${PORT}`;
const T0 = utc(2026, 10, 5, 11, 0); // Mon 07:00 ET, before the bell

describe.skipIf(!hasAnvil || !hasOut)('E2E on anvil (chain 4663) against contracts/out', () => {
  let anvil: ChildProcess;
  let client: PublicClient;
  const test = createTestClient({ mode: 'anvil', chain: robinhoodChain, transport: http(URL_) });
  const keys = { deployer: generatePrivateKey(), keeper: generatePrivateKey(), safe: generatePrivateKey(), alice: generatePrivateKey(), bob: generatePrivateKey() };
  const acct = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, privateKeyToAccount(v, { nonceManager })])) as Record<keyof typeof keys, ReturnType<typeof privateKeyToAccount>>;
  const wallet = (who: keyof typeof keys): WalletClient => createWalletClient({ account: acct[who], chain: robinhoodChain, transport: http(URL_) });
  let d: Deployment;
  let agg: Address;
  const ctx = (over: Partial<RunContext> = {}): RunContext => ({
    deployment: d,
    publicClient: client,
    fallbackClient: client,
    walletClient: wallet('keeper'),
    log: silentLogger,
    corporateActions: [],
    ...over,
  });

  async function send(who: keyof typeof keys, call: { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] }) {
    const { request } = await client.simulateContract({ ...call, account: acct[who] } as never);
    const hash = await wallet(who).writeContract(request as never);
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    return receipt;
  }

  async function deploy(name: string, args: readonly unknown[] = []): Promise<Address> {
    const a = artifact(name);
    const hash = await wallet('deployer').deployContract({ abi: a.abi, bytecode: a.bytecode, args } as never);
    const r = await client.waitForTransactionReceipt({ hash });
    return r.contractAddress!;
  }

  async function warp(t: number) {
    await test.setNextBlockTimestamp({ timestamp: BigInt(t) });
    await test.mine({ blocks: 1 });
  }

  const addRound = (answer: bigint, updatedAt: number) =>
    send('deployer', { address: agg, abi: artifact('MockAggregator').abi, functionName: 'addRound', args: [answer, BigInt(updatedAt)] });

  const usdgOf = (a: Address) => client.readContract({ address: USDG_ADDRESS, abi: usdgAbi, functionName: 'balanceOf', args: [a] });

  beforeAll(async () => {
    anvil = spawn('anvil', ['--chain-id', '4663', '--port', String(PORT), '--timestamp', String(T0), '--silent'], { stdio: 'ignore' });
    client = makePublicClient({ rpcUrl: URL_, excludePublicRpc: true, retryCount: 0, pollingIntervalMs: 50 }) as PublicClient;
    for (let i = 0; i < 100; i++) {
      try {
        await client.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    for (const a of Object.values(acct)) await test.setBalance({ address: a.address, value: 10n ** 20n });
    // USDG and Multicall3 at their canonical addresses.
    await test.setCode({ address: USDG_ADDRESS, bytecode: artifact('MockUSDG').deployed });
    const mc3 = JSON.parse(readFileSync(`${ROOT}packages/client/test/fixtures/multicall3-runtime.json`, 'utf8')) as { code: Hex };
    await test.setCode({ address: MULTICALL3_ADDRESS, bytecode: mc3.code });

    agg = await deploy('MockAggregator', ['RHNVDA / USD']);
    const stock = await deploy('MockStockToken', ['NVDA']);
    const resolver = await deploy('StockRoundResolver');
    const vpm = await deploy('HunchVPM', [acct.safe.address, acct.safe.address]);
    const factory = await deploy('HunchMarketFactory', [vpm, resolver, USDG_ADDRESS, acct.deployer.address, acct.safe.address]);
    const fAbi = artifact('HunchMarketFactory').abi;
    await send('deployer', { address: factory, abi: fAbi, functionName: 'setFeed', args: [agg, stock, 'NVDA', 93_600, 93_600, true] });
    await send('deployer', { address: factory, abi: fAbi, functionName: 'setOpener', args: [acct.keeper.address, true] });
    const mint = artifact('MockUSDG').abi;
    for (const [who, amount] of [['keeper', 1_000_000_000n], ['alice', 100_000_000n], ['bob', 100_000_000n]] as const) {
      await send('deployer', { address: USDG_ADDRESS, abi: mint, functionName: 'mint', args: [acct[who].address, amount] });
    }
    const block = Number(await client.getBlockNumber());
    d = parseDeployment({
      network: 'anvil-4663',
      chainId: 4663,
      status: 'deployed',
      deployedAt: new Date(T0 * 1000).toISOString(),
      gitCommit: 'e2e',
      startBlock: 0,
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
    // Sunday-night and pre-market prints.
    await addRound(22_000_000_000n, T0 - 50_000);
    await addRound(22_100_000_000n, T0 - 600);
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
  });

  it('golden path: list → gasless + pay-gas bets → bell → resolve with proven rounds → deliver', async () => {
    // 1. The keeper lists Monday's daily and the week's weekly (approving USDG first).
    const [open] = await runJob('open', ctx());
    expect(open!.actions.map((a) => `${a.status} ${a.kind}`)).toEqual(['confirmed approve', 'confirmed openUpDown', 'confirmed openUpDown']);
    let venue = await readVenue(client, d);
    expect(venue.markets.map((m) => [m.family, m.status])).toEqual([
      ['weekly', 'Opens'],
      ['daily', 'Opens'],
    ]);
    const daily = venue.markets.find((m) => m.family === 'daily')!;
    expect(daily.question).toBe('Will NVDA close UP today? · Mon Oct 5');
    expect(daily.totals.pool).toBe(20_000_000n);
    expect(daily.headroom.up).toBe(290_000_000n);
    // Idempotent: a second run lists nothing.
    const [again] = await runJob('open', ctx());
    expect(again!.actions).toEqual([]);

    // 2. Alice bets 20 UP with no ETH spent: a signed USDG authorization, relayed by the keeper.
    const now = Number((await client.getBlock()).timestamp);
    const salt = randomSalt();
    const auth = buildEnterAuthorization({
      from: acct.alice.address,
      hunchVpm: d.contracts.HunchVPM.address,
      marketId: daily.id,
      outcome: UP,
      amount: 20_000_000n,
      validAfter: 0n,
      validBefore: BigInt(now + 1800),
      salt,
    });
    const signature = await acct.alice.signTypedData(auth);
    const aliceEthBefore = await client.getBalance({ address: acct.alice.address });
    const relayed = await relayEnter(
      { from: acct.alice.address, marketId: `${daily.id}`, outcome: UP, amount: '20000000', validAfter: '0', validBefore: `${now + 1800}`, salt, signature },
      {
        deployment: d,
        chain: chainRelayReads(client, d, acct.keeper.address),
        nowSec: now,
        country: 'IN',
        ip: '203.0.113.9',
        limiter: new RateLimiter(),
        sender: walletRelaySender(wallet('keeper'), client, d),
      },
    );
    expect(relayed.ok).toBe(true);
    if (!relayed.ok) return;
    expect((await client.waitForTransactionReceipt({ hash: relayed.txHash })).status).toBe('success');
    expect(await client.getBalance({ address: acct.alice.address })).toBe(aliceEthBefore);
    // Replaying the same authorization is refused before it reaches the chain.
    const replay = await relayEnter(
      { from: acct.alice.address, marketId: `${daily.id}`, outcome: UP, amount: '20000000', validAfter: '0', validBefore: `${now + 1800}`, salt, signature },
      { deployment: d, chain: chainRelayReads(client, d, acct.keeper.address), nowSec: now, limiter: new RateLimiter(), sender: walletRelaySender(wallet('keeper'), client, d) },
    );
    expect(replay).toMatchObject({ ok: false, code: 'nonce-used' });

    // 3. Bob pays gas himself: approve, then enter 30 DOWN.
    await send('bob', approveUsdgCall(d, { amount: 30_000_000n }));
    await send('bob', enterCall(d, { marketId: daily.id, outcome: DOWN, amount: 30_000_000n }));

    let m = (await readMarket(client, d, daily.id))!;
    const alice = m.positions.find((p) => p.owner === acct.alice.address)!;
    expect(alice.accepted).toBe(20_000_000n); // finalized by Bob's entry in a later block
    // Bob's vintage is still open, so nothing has vested to Alice yet…
    expect(m.positions.find((p) => p.owner === acct.bob.address)!.accepted).toBeNull();
    expect(alice.accrued).toBe(20_000_000n);
    // …until the keeper's deliver job finalizes it in a later block: Bob's 30 vests into
    // UP pro-rata (UP principal 30 = seed 10 + Alice 20), so Alice's win payout is 20 + 20.
    await test.mine({ blocks: 1 }); // the next block (on 4663: the next L1 block, ~12 s)
    const [fin] = await runJob('deliver', ctx());
    expect(fin!.actions.map((a) => `${a.status} ${a.kind}`)).toEqual(['confirmed finalizeVintage']);
    m = (await readMarket(client, d, daily.id))!;
    expect(m.positions.find((p) => p.owner === acct.alice.address)!.accrued).toBe(40_000_000n);
    expect(m.positions.find((p) => p.owner === acct.bob.address)!.accepted).toBe(30_000_000n);

    // 4. The session: a print mid-day, then the bell.
    await warp(utc(2026, 10, 5, 13, 45));
    venue = await readVenue(client, d);
    expect(venue.markets.find((x) => x.id === daily.id)!.status).toBe('Live');
    expect(venue.markets.find((x) => x.id === daily.id)!.strike?.price).toBe(22_100_000_000n);
    await addRound(22_400_000_000n, utc(2026, 10, 5, 13, 45));
    await warp(utc(2026, 10, 5, 19, 30));
    await addRound(22_500_000_000n, utc(2026, 10, 5, 19, 30));
    await warp(closingBell('2026-10-05') + 70);
    expect((await readVenue(client, d)).markets.find((x) => x.id === daily.id)!.status).toBe('Frozen');

    // 5. The keeper resolves with the two proven rounds (strike 22.10 → final 22.50: UP).
    m = (await readMarket(client, d, daily.id))!;
    expect(m.resolution?.rounds.ok && m.resolution.rounds.expected).toBe('UP');
    expect(m.resolution?.preview?.status).toBe(1);
    const [resolve] = await runJob('resolve', ctx());
    expect(resolve!.actions.find((a) => a.target.includes(`#${daily.id} `))).toMatchObject({ kind: 'resolve', status: 'confirmed' });

    // 6. Delivery: every payout pushed to its owner, one call each; the fee accrues.
    m = (await readMarket(client, d, daily.id))!;
    expect(m.status).toBe('Resolved UP');
    const due = m.positions.filter((p) => p.settlement.deliverable);
    const aliceDue = m.positions.find((p) => p.owner === acct.alice.address)!.settlement;
    expect(aliceDue.fee).toBe(((aliceDue.gross - 20_000_000n) * 200n) / 10_000n);
    const aliceBefore = await usdgOf(acct.alice.address);
    const [deliver] = await runJob('deliver', ctx());
    const claims = deliver!.actions.filter((a) => a.kind === 'claimFor');
    expect(claims.length).toBe(due.length);
    expect(claims.every((a) => a.status === 'confirmed')).toBe(true);
    expect(await usdgOf(acct.alice.address)).toBe(aliceBefore + aliceDue.total);
    const [nothing] = await runJob('deliver', ctx());
    expect(nothing!.actions.filter((a) => a.kind === 'claimFor')).toEqual([]);

    const pf = await readPositionsByOwner(client, d, acct.alice.address);
    expect(pf.totals.paidOut).toBe(aliceDue.net);
    const proof = await readProof(client, d, { strikes: false });
    expect(proof.counts).toMatchObject({ marketsOpened: 2, marketsResolved: 1 });
    expect(proof.bettors.distinct).toBe(2);
    // Fees on every claimed winner (Alice and the seed UP leg), recomputed off chain, equal
    // what the contract accrued.
    expect(proof.usdg.feesTaken).toBe(due.reduce((s, p) => s + p.settlement.fee, 0n));
    expect(proof.usdg.feesTaken).toBe(proof.usdg.feesAccrued);
    expect(proof.usdg.feesAccrued).toBeGreaterThan(aliceDue.fee);
  }, 120_000);

  it('refund drill: Friday open → Saturday 06:00 UTC voids on a provably stale reading and refunds everyone', async () => {
    const plan = await runDrill(ctx(), { plan: true });
    expect(plan.notes[0]).toBe("Refund drill: NVDA UP from Friday's open to 2:00 am ET Saturday?");
    const opened = await runDrill(ctx());
    expect(opened.actions.at(-1), JSON.stringify(opened.actions.map((a) => a.error ?? a.status))).toMatchObject({ kind: 'openUpDown', status: 'confirmed' });
    const drill = (await readVenue(client, d)).markets.find((m) => m.family === 'drill')!;
    expect(drill.maxFinalAge).toBe(3600);
    await send('bob', approveUsdgCall(d, { amount: 5_000_000n }));
    await send('bob', enterCall(d, { marketId: drill.id, outcome: DOWN, amount: 5_000_000n }));

    // Friday: fresh prints, the last one at 19:50 UTC. Then nothing on Saturday.
    await warp(utc(2026, 10, 9, 13, 0));
    await addRound(22_300_000_000n, utc(2026, 10, 9, 13, 0));
    await warp(utc(2026, 10, 9, 19, 50));
    await addRound(22_600_000_000n, utc(2026, 10, 9, 19, 50));
    await warp(utc(2026, 10, 10, 6, 1, 10));

    // Within 15 min of the bell the keeper only waits (and resolves the weekly).
    const [early] = await runJob('resolve', ctx());
    expect(early!.actions.find((a) => a.target.includes(`#${drill.id} `))).toMatchObject({ kind: 'wait' });
    const weekly = (await readVenue(client, d)).markets.find((m) => m.family === 'weekly')!;
    expect(weekly.status).toBe('Resolved UP');

    await warp(utc(2026, 10, 10, 6, 16));
    const [late] = await runJob('resolve', ctx());
    expect(late!.actions.find((a) => a.target.includes(`#${drill.id} `))).toMatchObject({ kind: 'voidStale', status: 'confirmed' });
    const bobBefore = await usdgOf(acct.bob.address);
    await runJob('deliver', ctx());
    const after = (await readMarket(client, d, drill.id))!;
    expect(after.status).toBe('Void');
    expect(after.positions.every((p) => p.claimed)).toBe(true);
    expect(await usdgOf(acct.bob.address)).toBe(bobBefore + 5_000_000n);

    // Health is green once everything is settled and delivered.
    const state = await readKeeperState(client, d);
    const health = evaluateHealth(state, d);
    expect(health.checks.find((c) => c.name === 'settlement')!.ok).toBe(true);
    expect(health.checks.find((c) => c.name === 'delivery')!.ok).toBe(true);
  }, 120_000);
});
