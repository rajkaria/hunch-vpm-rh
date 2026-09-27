// TODO(S7): replace with @hunch-rh/client readVenue/readPrices
/**
 * The live Chainlink price tape, read on the server from Robinhood Chain.
 *
 * One multicall of `latestRoundData` over the four standard proxies (docs/spec/04 §Tickers),
 * through the keyed RPC in `RH_RPC_URL` when it is set and the public RPC otherwise. The page
 * that renders it revalidates every 15 s, and `/api/prices` serves the same snapshot to the
 * tape's client island.
 *
 * A failed read never throws and never empties the tape: it returns the last good snapshot
 * with its age and status `stale-cache`, and the tape says "Price unavailable, retrying".
 */

import { createPublicClient, defineChain, fallback, http, parseAbi, type Address } from 'viem';

import { TICKERS } from '@/content/tickers';
import { MULTICALL3, ROBINHOOD_CHAIN } from '@/lib/site';

import type { PriceReading, PriceSnapshot } from './types';

const FEED_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

/** 8-decimal sanity band from docs/spec/03-contracts.md: 0 < answer < 1e14. */
const MAX_ANSWER = 10n ** 14n;

export interface RawRound {
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
}

/** Reads `latestRoundData` for each feed. A null entry is a feed whose read failed. */
export type FeedReader = (feeds: readonly Address[]) => Promise<(RawRound | null)[]>;

const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN.id,
  name: ROBINHOOD_CHAIN.name,
  nativeCurrency: ROBINHOOD_CHAIN.currency,
  rpcUrls: { default: { http: [ROBINHOOD_CHAIN.rpcUrl] } },
  blockExplorers: { default: { name: ROBINHOOD_CHAIN.explorerName, url: ROBINHOOD_CHAIN.explorerUrl } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

function rpcUrls(): string[] {
  const keyed = process.env.RH_RPC_URL?.trim();
  const urls = [keyed, ROBINHOOD_CHAIN.rpcUrl].filter((url): url is string => url !== undefined && url !== '');
  return [...new Set(urls)];
}

/** The default reader: one multicall through a fallback transport (8 s timeout, 2 retries). */
export const viemFeedReader: FeedReader = async (feeds) => {
  const client = createPublicClient({
    chain: robinhoodChain,
    transport: fallback(rpcUrls().map((url) => http(url, { timeout: 8_000, retryCount: 2 }))),
  });
  const results = await client.multicall({
    allowFailure: true,
    contracts: feeds.map((address) => ({ address, abi: FEED_ABI, functionName: 'latestRoundData' }) as const),
  });
  return results.map((result) => {
    if (result.status !== 'success') return null;
    const [roundId, answer, , updatedAt] = result.result;
    return { roundId, answer, updatedAt };
  });
};

function sane(round: RawRound | null): round is RawRound {
  return round !== null && round.answer > 0n && round.answer < MAX_ANSWER && round.updatedAt > 0n;
}

function emptyReadings(): PriceReading[] {
  return TICKERS.map((entry) => ({
    ticker: entry.ticker,
    name: entry.name,
    feed: entry.feed,
    answer: null,
    roundId: null,
    updatedAt: null,
  }));
}

/**
 * A price reader with its own memory of the last good snapshot. The memory lives as long as
 * the server instance, which is what "show the last good value with its age" can promise.
 */
export function createPriceReader(read: FeedReader = viemFeedReader, now: () => number = () => Date.now()) {
  let lastGood: PriceSnapshot | null = null;

  return async function readPrices(): Promise<PriceSnapshot> {
    const readAt = Math.floor(now() / 1000);
    let rounds: (RawRound | null)[];
    try {
      rounds = await read(TICKERS.map((entry) => entry.feed));
    } catch {
      rounds = TICKERS.map(() => null);
    }

    const anyFresh = rounds.some(sane);
    if (!anyFresh) {
      return lastGood === null
        ? { readings: emptyReadings(), readAt, status: 'unavailable' }
        : { ...lastGood, status: 'stale-cache' };
    }

    const previous = lastGood?.readings ?? emptyReadings();
    const readings = TICKERS.map((entry, index): PriceReading => {
      const round = rounds[index] ?? null;
      if (!sane(round)) {
        // Keep this feed's last good reading rather than blanking one cell of the tape.
        return previous[index] ?? { ticker: entry.ticker, name: entry.name, feed: entry.feed, answer: null, roundId: null, updatedAt: null };
      }
      return {
        ticker: entry.ticker,
        name: entry.name,
        feed: entry.feed,
        answer: round.answer.toString(),
        roundId: round.roundId.toString(),
        updatedAt: Number(round.updatedAt),
      };
    });

    lastGood = { readings, readAt, status: 'live' };
    return lastGood;
  };
}

/** The process-wide reader the pages and `/api/prices` share. */
export const readPrices = createPriceReader();
