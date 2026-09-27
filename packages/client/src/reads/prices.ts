import type { Address } from 'viem';
import { aggregatorV3Abi, hunchMarketFactoryAbi, multicall3Abi, stockTokenAbi } from '../abi/index.js';
import { MULTICALL3_ADDRESS } from '../constants.js';
import { isDeployed, type Deployment } from '../deployment/index.js';
import { callMany, decodeFeedInfo, decodeRound, maybe, must, type ReadClient } from './shared.js';

export interface PriceRow {
  ticker: string;
  feed: Address;
  stockToken: Address;
  /** 8-decimal answer of the latest round (null if the read failed). */
  price: bigint | null;
  roundId: bigint | null;
  /** Unix seconds. */
  updatedAt: number | null;
  /** Chain time − updatedAt. */
  ageSec: number | null;
  /** Robinhood's corporate-action flag on the Stock Token. */
  oraclePaused: boolean | null;
  /** Allow-listed on the factory (null before deployment). */
  allowListed: boolean | null;
  /** Listed in deployments/robinhood-mainnet.json (the v1 table). */
  v1: boolean;
  pendingFlatRateCheck: boolean;
}

export interface PricesSnapshot {
  deployed: boolean;
  /** Chain time (block timestamp) of the read. */
  nowSec: number;
  rows: PriceRow[];
}

/**
 * Latest Chainlink price for every v1 feed in the deployment table (works before
 * deployment, so the landing page shows live prices pre-launch) plus any other feed the
 * factory allow-lists once deployed.
 */
export async function readPrices(client: ReadClient, d: Deployment): Promise<PricesSnapshot> {
  const deployed = isDeployed(d);
  const f = d.contracts.HunchMarketFactory.address;
  type Row = { ticker: string; feed: Address; stockToken: Address; v1: boolean; pendingFlatRateCheck: boolean };
  const rows: Row[] = d.feeds.map((x) => ({
    ticker: x.ticker,
    feed: x.feed,
    stockToken: x.stockToken,
    v1: true,
    pendingFlatRateCheck: x.pendingFlatRateCheck === true,
  }));
  const allowed = new Map<string, boolean>();

  if (deployed) {
    const count = Number(must<bigint>((await callMany(client, [{ address: f, abi: hunchMarketFactoryAbi, functionName: 'feedCount' }]))[0], 'feedCount'));
    const addrs = await callMany(
      client,
      Array.from({ length: count }, (_, i) => ({ address: f, abi: hunchMarketFactoryAbi, functionName: 'feedAt', args: [BigInt(i)] })),
    );
    const feedAddrs = addrs.map((r, i) => must<Address>(r, `feedAt(${i})`));
    const infos = await callMany(
      client,
      feedAddrs.map((feed) => ({ address: f, abi: hunchMarketFactoryAbi, functionName: 'feeds', args: [feed] })),
    );
    feedAddrs.forEach((feed, i) => {
      const info = decodeFeedInfo(must(infos[i], 'feeds'));
      allowed.set(feed.toLowerCase(), info.allowed);
      if (!rows.some((r) => r.feed.toLowerCase() === feed.toLowerCase())) {
        rows.push({ ticker: info.ticker, feed, stockToken: info.stockToken, v1: false, pendingFlatRateCheck: false });
      }
    });
  }

  const results = await callMany(client, [
    { address: MULTICALL3_ADDRESS, abi: multicall3Abi, functionName: 'getCurrentBlockTimestamp' },
    ...rows.flatMap((r) => [
      { address: r.feed, abi: aggregatorV3Abi, functionName: 'latestRoundData' },
      { address: r.stockToken, abi: stockTokenAbi, functionName: 'oraclePaused' },
    ]),
  ]);
  const nowSec = Number(maybe<bigint>(results[0]) ?? BigInt(Math.floor(Date.now() / 1000)));
  return {
    deployed,
    nowSec,
    rows: rows.map((r, i) => {
      const round = maybe(results[1 + 2 * i]);
      const decoded = round === null ? null : decodeRound(round);
      const updatedAt = decoded === null ? null : Number(decoded.updatedAt);
      return {
        ...r,
        price: decoded?.answer ?? null,
        roundId: decoded?.roundId ?? null,
        updatedAt,
        ageSec: updatedAt === null ? null : nowSec - updatedAt,
        oraclePaused: maybe<boolean>(results[2 + 2 * i]),
        allowListed: deployed ? (allowed.get(r.feed.toLowerCase()) ?? false) : null,
      };
    }),
  };
}
