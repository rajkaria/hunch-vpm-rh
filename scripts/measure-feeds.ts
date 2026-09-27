/**
 * Feed check before allow-listing a ticker (docs/spec/04 §Tickers, "Feed check").
 *
 *   pnpm exec tsx scripts/measure-feeds.ts                          # v1 feeds (+ SPY for reference)
 *   pnpm exec tsx scripts/measure-feeds.ts COIN                     # one ticker
 *   pnpm exec tsx scripts/measure-feeds.ts --out deployments/feeds-4663.json
 *   RH_RPC_URL=<keyed rpc> pnpm exec tsx scripts/measure-feeds.ts   # faster, fewer limits
 *
 * For each feed, read-only on chain 4663:
 *   1. description(), decimals() == 8, latest answer > 0.
 *   2. Over the last 20 NYSE sessions: the largest in-week gap between rounds, and the
 *      daily FLAT rate (the round in effect at 09:30 ET is the round in effect at the
 *      close, or has the same answer). Over the last 12 complete weeks: the weekly FLAT
 *      rate (first open vs last close). Allow daily markets only if daily FLAT <= 25%,
 *      weekly markets only if weekly FLAT <= 10%. Readings older than 26 h are counted.
 *   3. The Stock Token's `oraclePaused()` now and its OraclePaused / OracleUnpaused events
 *      over the last 90 days (topics verified in the Stock implementation's bytecode).
 * `getRoundData` of past rounds reads current state, so the public RPC works; the log scan
 * is sparse and chunked.
 */
import { writeFileSync } from 'node:fs';
import {
  aggregatorRoundOf,
  aggregatorV3Abi,
  callMany,
  etDateOf,
  formatDuration,
  formatPriceExact,
  getLogsChunked,
  isTradingDay,
  loadDeployment,
  makePublicClient,
  phaseOf,
  previousSession,
  proxyRoundId,
  redactRpcUrl,
  stockTokenAbi,
  weeklyWindow,
  addDays,
  type Call,
  type RoundData,
} from '../packages/client/src/index.ts';
import { getAbiItem, type AbiEvent, type Address } from 'viem';

const DAILY_FLAT_MAX = 0.25;
const WEEKLY_FLAT_MAX = 0.1;
const MAX_AGE = 93_600;
const SESSIONS = 20;
const WEEKS = 12;

const SPY = { ticker: 'SPY', feed: '0x319724394D3A0e3669269846abE664Cd621f9f6A', stockToken: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', pendingFlatRateCheck: false } as const;

/** The public RPC rate-limits bursts: retry a feed's reads with backoff before giving up. */
async function withRetry<T>(what: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i >= attempts) throw error;
      console.warn(`${what}: ${(error as Error).message.split('\n')[0]}; retrying in ${2 ** i} s`);
      await new Promise((r) => setTimeout(r, 2 ** i * 1000));
    }
  }
}

function lastAtOrBefore(rounds: RoundData[], t: number): RoundData | null {
  let lo = 0;
  let hi = rounds.length - 1;
  let best: RoundData | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(rounds[mid]!.updatedAt) <= t) {
      best = rounds[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx === -1 ? null : args[outIdx + 1];
  const wanted = args.filter((a, i) => !a.startsWith('--') && (outIdx === -1 || i !== outIdx + 1)).map((a) => a.toUpperCase());
  const d = loadDeployment();
  const rpc = process.env.RH_RPC_URL;
  const client = makePublicClient({ rpcUrl: rpc, multicallBatch: false });
  const head = await client.getBlock({ blockTag: 'latest' });
  const now = Number(head.timestamp);
  const feeds = [...d.feeds, SPY].filter((f) => wanted.length === 0 || wanted.includes(f.ticker));

  // The last SESSIONS completed sessions.
  const sessions: { date: string; open: number; close: number }[] = [];
  let s = previousSession(now);
  while (sessions.length < SESSIONS) {
    sessions.unshift({ date: s.date, open: s.open, close: s.close });
    s = previousSession(s.open - 1);
  }
  // The last WEEKS completed weeks.
  const weeks: { weekOf: string; strike: number; final: number }[] = [];
  let probe = etDateOf(sessions[sessions.length - 1]!.close);
  while (weeks.length < WEEKS) {
    const w = weeklyWindow(probe);
    if (w !== null && w.finalTime <= now && !weeks.some((x) => x.weekOf === w.weekOf)) weeks.unshift({ weekOf: w.weekOf, strike: w.strikeTime, final: w.finalTime });
    probe = addDays(probe, -7);
  }

  // ~90 days of L2 blocks at ~10 blocks/s.
  const toBlock = head.number!;
  const fromBlock = toBlock > 90n * 86_400n * 10n ? toBlock - 90n * 86_400n * 10n : 0n;
  const paused = getAbiItem({ abi: stockTokenAbi, name: 'OraclePaused' }) as AbiEvent;
  const unpaused = getAbiItem({ abi: stockTokenAbi, name: 'OracleUnpaused' }) as AbiEvent;

  const results = [];
  for (const f of feeds) {
    const meta = await withRetry(`${f.ticker} metadata`, async () => {
      const m = await callMany(client, [
      { address: f.feed, abi: aggregatorV3Abi, functionName: 'description' },
      { address: f.feed, abi: aggregatorV3Abi, functionName: 'decimals' },
      { address: f.feed, abi: aggregatorV3Abi, functionName: 'latestRoundData' },
      { address: f.stockToken, abi: stockTokenAbi, functionName: 'oraclePaused' },
      { address: f.stockToken, abi: stockTokenAbi, functionName: 'symbol' },
      ]);
      if (!m[2]?.ok) throw new Error('latestRoundData failed');
      return m;
    });
    const latest = meta[2]!.ok ? (meta[2]!.value as readonly bigint[]) : null;
    if (latest === null) throw new Error(`${f.ticker}: latestRoundData failed`);
    const phase = phaseOf(latest[0]!);
    const last = aggregatorRoundOf(latest[0]!);
    const calls: Call[] = [];
    for (let r = 1n; r <= last; r++) calls.push({ address: f.feed, abi: aggregatorV3Abi, functionName: 'getRoundData', args: [proxyRoundId(phase, r)] });
    const rounds: RoundData[] = (await withRetry(`${f.ticker} rounds`, async () => {
      const r = await callMany(client, calls, 250);
      if (r.filter((x) => !x.ok).length > r.length / 2) throw new Error('most getRoundData reads failed');
      return r;
    }))
      .filter((r) => r.ok)
      .map((r) => {
        const [roundId, answer, startedAt, updatedAt, answeredInRound] = (r as { value: readonly bigint[] }).value as [bigint, bigint, bigint, bigint, bigint];
        return { roundId, answer, startedAt, updatedAt, answeredInRound };
      })
      .filter((r) => r.updatedAt > 0n);

    const verdict = (strike: number, final: number) => {
      const a = lastAtOrBefore(rounds, strike);
      const b = lastAtOrBefore(rounds, final);
      if (a === null || b === null) return 'none' as const;
      if (strike - Number(a.updatedAt) > MAX_AGE || final - Number(b.updatedAt) > MAX_AGE) return 'stale' as const;
      return a.roundId === b.roundId || a.answer === b.answer ? ('flat' as const) : ('moved' as const);
    };
    const daily = sessions.map((x) => ({ date: x.date, result: verdict(x.open, x.close) }));
    const weekly = weeks.map((w) => ({ weekOf: w.weekOf, result: verdict(w.strike, w.final) }));
    const rate = (xs: { result: string }[]) => {
      const n = xs.filter((x) => x.result !== 'none').length;
      return n === 0 ? null : xs.filter((x) => x.result === 'flat').length / n;
    };

    // Largest in-week gap in the session window: consecutive rounds whose ET dates, and
    // every date between them, are trading days (so weekends, the Sunday-evening reopen and
    // holidays are excluded; the weekend gap is a separate, known quantity).
    const windowStart = sessions[0]!.open - 86_400;
    let maxGap = { seconds: 0, from: 0, to: 0 };
    for (let i = 1; i < rounds.length; i++) {
      const a = Number(rounds[i - 1]!.updatedAt);
      const b = Number(rounds[i]!.updatedAt);
      if (a < windowStart) continue;
      let inWeek = true;
      for (let t = etDateOf(a); t <= etDateOf(b); t = addDays(t, 1)) if (!isTradingDay(t)) inWeek = false;
      if (inWeek && b - a > maxGap.seconds) maxGap = { seconds: b - a, from: a, to: b };
    }

    let pauseEvents: { event: string; block: string }[] | string = [];
    try {
      const logs = await withRetry(`${f.ticker} OraclePaused logs`, () => getLogsChunked(client, { address: f.stockToken as Address, event: paused, fromBlock, toBlock }));
      const logs2 = await withRetry(`${f.ticker} OracleUnpaused logs`, () => getLogsChunked(client, { address: f.stockToken as Address, event: unpaused, fromBlock, toBlock }));
      pauseEvents = [
        ...logs.map((l) => ({ event: 'OraclePaused', block: String(l.blockNumber) })),
        ...logs2.map((l) => ({ event: 'OracleUnpaused', block: String(l.blockNumber) })),
      ].sort((x, y) => Number(BigInt(x.block) - BigInt(y.block)));
    } catch (error) {
      pauseEvents = `log scan failed (use a keyed RH_RPC_URL): ${(error as Error).message.split('\n')[0]}`;
    }

    const dailyFlat = rate(daily);
    const weeklyFlat = rate(weekly);
    const decimalsOk = meta[1]!.ok && Number(meta[1]!.value) === 8;
    const answerOk = latest[1]! > 0n;
    const result = {
      ticker: f.ticker,
      feed: f.feed,
      stockToken: f.stockToken,
      description: meta[0]!.ok ? meta[0]!.value : null,
      decimals: meta[1]!.ok ? Number(meta[1]!.value) : null,
      stockSymbol: meta[4]!.ok ? meta[4]!.value : null,
      latest: { roundId: latest[0]!.toString(), answer: formatPriceExact(latest[1]!), updatedAt: new Date(Number(latest[3]!) * 1000).toISOString() },
      rounds: rounds.length,
      sessions: { from: sessions[0]!.date, to: sessions[sessions.length - 1]!.date, count: sessions.length },
      dailyFlatRate: dailyFlat,
      dailyStale: daily.filter((x) => x.result === 'stale').map((x) => x.date),
      weeks: { from: weeks[0]!.weekOf, to: weeks[weeks.length - 1]!.weekOf, count: weeks.length },
      weeklyFlatRate: weeklyFlat,
      weeklyStale: weekly.filter((x) => x.result === 'stale').map((x) => x.weekOf),
      maxInWeekGap: {
        seconds: maxGap.seconds,
        human: formatDuration(maxGap.seconds),
        from: maxGap.from ? new Date(maxGap.from * 1000).toISOString() : null,
        to: maxGap.to ? new Date(maxGap.to * 1000).toISOString() : null,
      },
      oraclePausedNow: meta[3]!.ok ? meta[3]!.value : null,
      oraclePauseEvents90d: pauseEvents,
      verdict: {
        basic: decimalsOk && answerOk,
        daily: decimalsOk && answerOk && dailyFlat !== null && dailyFlat <= DAILY_FLAT_MAX,
        weekly: decimalsOk && answerOk && weeklyFlat !== null && weeklyFlat <= WEEKLY_FLAT_MAX,
      },
      detail: { daily, weekly },
    };
    results.push(result);
    const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
    console.log(
      `${f.ticker.padEnd(5)} ${String(result.description).padEnd(22)} rounds ${String(rounds.length).padStart(5)} · daily FLAT ${pct(dailyFlat)} (${sessions.length} sessions) · weekly FLAT ${pct(weeklyFlat)} (${weeks.length} weeks) · max in-week gap ${result.maxInWeekGap.human} · paused now ${result.oraclePausedNow} · pause events ${typeof pauseEvents === 'string' ? pauseEvents : pauseEvents.length} → daily ${result.verdict.daily ? 'OK' : 'NO'}, weekly ${result.verdict.weekly ? 'OK' : 'NO'}`,
    );
  }

  const report = {
    chainId: 4663,
    measuredAt: new Date(now * 1000).toISOString(),
    block: Number(head.number),
    rpc: redactRpcUrl(rpc ?? 'https://rpc.mainnet.chain.robinhood.com'),
    rules: { dailyFlatMax: DAILY_FLAT_MAX, weeklyFlatMax: WEEKLY_FLAT_MAX, maxAgeSec: MAX_AGE, sessions: SESSIONS, weeks: WEEKS },
    feeds: results,
  };
  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${outPath}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message.split('\n')[0] : error);
  process.exit(1);
});

