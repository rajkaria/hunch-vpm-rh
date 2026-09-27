/**
 * Capture REAL Chainlink round series from Robinhood Chain (4663) for the round-finder
 * tests (docs/spec/07-testing.md T8r). Fixtures are never hand-written: this script is
 * the only thing that writes packages/client/test/fixtures/rounds-<ticker>.json.
 *
 *   pnpm exec tsx scripts/capture-rounds.ts                 # NVDA TSLA AAPL COIN SPY
 *   pnpm exec tsx scripts/capture-rounds.ts NVDA TSLA       # a subset
 *   RH_RPC_URL=<keyed rpc> pnpm exec tsx scripts/capture-rounds.ts
 *
 * Every round of the proxy's CURRENT phase is captured (1 … latest), so the binary search
 * in `findLastAtOrBefore` replays against exactly what the chain would answer. SPY's
 * phase 1 starts with 18-decimal garbage answers (rounds 1–7), kept on purpose.
 * Reads current state only (`getRoundData` of past rounds works on the public RPC).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aggregatorV3Abi,
  aggregatorRoundOf,
  callMany,
  loadDeployment,
  makePublicClient,
  phaseOf,
  proxyRoundId,
  redactRpcUrl,
  type Call,
} from '../packages/client/src/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'packages', 'client', 'test', 'fixtures');

const SPY = {
  ticker: 'SPY',
  feed: '0x319724394D3A0e3669269846abE664Cd621f9f6A',
  stockToken: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C',
} as const;

async function main() {
  const d = loadDeployment();
  const rpc = process.env.RH_RPC_URL;
  const client = makePublicClient({ rpcUrl: rpc, multicallBatch: false });
  const wanted = process.argv.slice(2).map((t) => t.toUpperCase());
  const feeds = [...d.feeds.map((f) => ({ ticker: f.ticker, feed: f.feed, stockToken: f.stockToken })), SPY].filter(
    (f) => wanted.length === 0 || wanted.includes(f.ticker),
  );
  mkdirSync(OUT, { recursive: true });

  for (const f of feeds) {
    const head = await client.getBlock({ blockTag: 'latest' });
    const meta = await callMany(client, [
      { address: f.feed, abi: aggregatorV3Abi, functionName: 'latestRoundData' },
      { address: f.feed, abi: aggregatorV3Abi, functionName: 'decimals' },
      { address: f.feed, abi: aggregatorV3Abi, functionName: 'description' },
      { address: f.feed, abi: aggregatorV3Abi, functionName: 'aggregator' },
    ]);
    if (!meta[0]?.ok) throw new Error(`${f.ticker}: latestRoundData failed`);
    const latest = meta[0].value as readonly [bigint, bigint, bigint, bigint, bigint];
    const phase = phaseOf(latest[0]);
    const last = aggregatorRoundOf(latest[0]);
    const calls: Call[] = [];
    for (let r = 1n; r <= last; r++) {
      calls.push({ address: f.feed, abi: aggregatorV3Abi, functionName: 'getRoundData', args: [proxyRoundId(phase, r)] });
    }
    const results = await callMany(client, calls, 250);
    const rounds: [number, string, number, number, string][] = [];
    const missing: number[] = [];
    results.forEach((res, i) => {
      const agg = i + 1;
      if (!res.ok) return missing.push(agg);
      const [, answer, startedAt, updatedAt, answeredInRound] = res.value as readonly [bigint, bigint, bigint, bigint, bigint];
      if (updatedAt === 0n) return missing.push(agg);
      rounds.push([agg, answer.toString(), Number(startedAt), Number(updatedAt), answeredInRound.toString()]);
    });
    const fixture = {
      ticker: f.ticker,
      chainId: 4663,
      feed: f.feed,
      aggregator: meta[3]?.ok ? meta[3].value : null,
      stockToken: f.stockToken,
      description: meta[2]?.ok ? meta[2].value : null,
      decimals: meta[1]?.ok ? Number(meta[1].value) : null,
      capturedAt: new Date(Number(head.timestamp) * 1000).toISOString(),
      capturedAtBlock: Number(head.number),
      capturedAtTimestamp: Number(head.timestamp),
      rpc: redactRpcUrl(rpc ?? 'https://rpc.mainnet.chain.robinhood.com'),
      phase: Number(phase),
      latestRoundId: latest[0].toString(),
      columns: ['aggregatorRound', 'answer', 'startedAt', 'updatedAt', 'answeredInRound'],
      missing,
      rounds,
    };
    const path = join(OUT, `rounds-${f.ticker.toLowerCase()}.json`);
    writeFileSync(path, `${JSON.stringify(fixture)}\n`);
    console.log(`${f.ticker}: phase ${phase}, rounds 1..${last} (${rounds.length} present, ${missing.length} missing) → ${path}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
