import {
  DOWN,
  MARKET_STATUS,
  UP,
  aggregatorV3Abi,
  callMany,
  decodeBook,
  decodeFeedInfo,
  decodeMarket,
  decodeRound,
  decodeTerms,
  family,
  feedByAddress,
  headCalls,
  hunchMarketFactoryAbi,
  hunchVpmAbi,
  isDeployed,
  maybe,
  must,
  readAllPositions,
  readListings,
  settlementOf,
  stockRoundResolverAbi,
  usdgAbi,
  type Book,
  type Call,
  type Deployment,
  type Listing,
  type MarketFamily,
  type Position,
  type Settlement,
} from '@hunch-rh/client';
import type { Address, PublicClient } from 'viem';

/**
 * One read of everything the keeper jobs and the health check decide on, through view
 * calls (no logs). Jobs are then pure functions of this snapshot.
 */

export interface KeeperMarket {
  listing: Listing;
  ticker: string;
  family: MarketFamily;
  statusCode: number;
  winner: number;
  settledByResolver: boolean;
  resolutionTime: number;
  pendingCount: bigint;
  feeBps: number;
  books: [Book, Book];
  /** Read for open markets and markets whose final bell is within `positionWindowSec`. */
  positions: { id: bigint; position: Position; settlement: Settlement }[] | null;
  /** The open vintage's L1 block (from the first pending position), null when none. */
  vintageBlock: bigint | null;
}

export interface FeedState {
  ticker: string;
  feed: Address;
  allowed: boolean | null;
  updatedAt: number | null;
  answer: bigint | null;
}

/** Who holds the venue's powers, read back from the chain (health's ownership and wiring checks). */
export interface VenueWiring {
  factoryOwner: Address | null;
  factoryPendingOwner: Address | null;
  /** `HunchVPM.factory()`: the only address that may create markets (D10). */
  settlerFactory: Address | null;
  /** `HunchVPM.pauser()`: may pause, never unpause (D10). */
  pauser: Address | null;
  /** `factory.openers(keeper)`; null without a keeper address. */
  keeperIsOpener: boolean | null;
}

export interface KeeperState {
  deployed: boolean;
  nowSec: number;
  head: { blockNumber: bigint; l1BlockNumber: bigint; timestamp: number };
  entriesPaused: boolean;
  feesAccrued: bigint;
  markets: KeeperMarket[];
  feeds: FeedState[];
  keeper: { address: Address; eth: bigint; usdg: bigint; allowanceToFactory: bigint } | null;
  /** Read when deployed; absent in hand-built states (tests). */
  wiring?: VenueWiring | null;
}

export interface ReadStateOptions {
  nowSec?: number;
  /** Keeper address for balances (defaults to the deployment's keeper). */
  keeper?: Address | null;
  /** Read positions of settled markets whose final bell is within this window (default 7 days). */
  positionWindowSec?: number;
  /** Read positions at all (default true; the resolve job does not need them). */
  withPositions?: boolean;
}

export async function readKeeperState(client: PublicClient, d: Deployment, options: ReadStateOptions = {}): Promise<KeeperState> {
  const deployed = isDeployed(d);
  const keeper = options.keeper === undefined ? (deployed ? d.keeper : null) : options.keeper;
  const f = d.contracts.HunchMarketFactory.address;
  const v = d.contracts.HunchVPM.address;

  const base: Call[] = [...headCalls()];
  for (const feed of d.feeds) base.push({ address: feed.feed, abi: aggregatorV3Abi, functionName: 'latestRoundData' });
  if (deployed) {
    base.push({ address: v, abi: hunchVpmAbi, functionName: 'entriesPaused' });
    base.push({ address: v, abi: hunchVpmAbi, functionName: 'feesAccrued', args: [d.usdg] });
    for (const feed of d.feeds) base.push({ address: f, abi: hunchMarketFactoryAbi, functionName: 'feeds', args: [feed.feed] });
    base.push(
      { address: f, abi: hunchMarketFactoryAbi, functionName: 'owner' },
      { address: f, abi: hunchMarketFactoryAbi, functionName: 'pendingOwner' },
      { address: v, abi: hunchVpmAbi, functionName: 'factory' },
      { address: v, abi: hunchVpmAbi, functionName: 'pauser' },
    );
    if (keeper !== null) base.push({ address: f, abi: hunchMarketFactoryAbi, functionName: 'openers', args: [keeper] });
  }
  if (keeper !== null) {
    base.push({ address: d.usdg, abi: usdgAbi, functionName: 'balanceOf', args: [keeper] });
    base.push({ address: d.usdg, abi: usdgAbi, functionName: 'allowance', args: [keeper, f] });
  }
  const [block, r, eth] = await Promise.all([
    client.getBlock({ blockTag: 'latest' }),
    callMany(client, base),
    keeper === null ? Promise.resolve(0n) : client.getBalance({ address: keeper }),
  ]);
  const head = { blockNumber: block.number ?? 0n, l1BlockNumber: must<bigint>(r[0], 'getBlockNumber'), timestamp: Number(block.timestamp) };
  const nowSec = options.nowSec ?? head.timestamp;
  let k = 2;
  const latest = d.feeds.map(() => {
    const round = maybe(r[k++]);
    return round === null ? null : decodeRound(round);
  });
  let entriesPaused = false;
  let feesAccrued = 0n;
  const allowed: (boolean | null)[] = d.feeds.map(() => null);
  let wiring: VenueWiring | null = null;
  if (deployed) {
    entriesPaused = must<boolean>(r[k++], 'entriesPaused');
    feesAccrued = must<bigint>(r[k++], 'feesAccrued');
    d.feeds.forEach((_, i) => {
      const info = maybe(r[k++]);
      allowed[i] = info === null ? false : decodeFeedInfo(info).allowed;
    });
    wiring = {
      factoryOwner: maybe<Address>(r[k++]),
      factoryPendingOwner: maybe<Address>(r[k++]),
      settlerFactory: maybe<Address>(r[k++]),
      pauser: maybe<Address>(r[k++]),
      keeperIsOpener: keeper === null ? null : maybe<boolean>(r[k++]),
    };
  }
  const keeperState =
    keeper === null
      ? null
      : { address: keeper, eth, usdg: maybe<bigint>(r[k++]) ?? 0n, allowanceToFactory: maybe<bigint>(r[k++]) ?? 0n };

  const feeds: FeedState[] = d.feeds.map((feed, i) => ({
    ticker: feed.ticker,
    feed: feed.feed,
    allowed: allowed[i] ?? null,
    updatedAt: latest[i] === null || latest[i] === undefined ? null : Number(latest[i]!.updatedAt),
    answer: latest[i]?.answer ?? null,
  }));

  if (!deployed) return { deployed, nowSec, head, entriesPaused, feesAccrued, markets: [], feeds, keeper: keeperState, wiring };

  const listings = await readListings(client, d);
  const per: Call[] = [];
  for (const l of listings) {
    per.push(
      { address: v, abi: hunchVpmAbi, functionName: 'getMarket', args: [l.marketId] },
      { address: v, abi: hunchVpmAbi, functionName: 'marketTerms', args: [l.marketId] },
      { address: v, abi: hunchVpmAbi, functionName: 'pendingCount', args: [l.marketId] },
      { address: v, abi: hunchVpmAbi, functionName: 'getBook', args: [l.marketId, UP] },
      { address: v, abi: hunchVpmAbi, functionName: 'getBook', args: [l.marketId, DOWN] },
      { address: d.contracts.StockRoundResolver.address, abi: stockRoundResolverAbi, functionName: 'settled', args: [l.specId] },
    );
  }
  const pr = await callMany(client, per);
  const window = options.positionWindowSec ?? 7 * 86_400;
  const markets: KeeperMarket[] = listings.map((l, i) => {
    const m = decodeMarket(must(pr[i * 6], `getMarket(${l.marketId})`));
    const terms = decodeTerms(must(pr[i * 6 + 1], 'marketTerms'));
    return {
      listing: l,
      ticker: feedByAddress(d, l.feed)?.ticker ?? 'UNKNOWN',
      family: family(l),
      statusCode: m.status,
      winner: m.winner,
      settledByResolver: maybe<boolean>(pr[i * 6 + 5]) ?? false,
      resolutionTime: m.resolutionTime,
      pendingCount: must<bigint>(pr[i * 6 + 2], 'pendingCount'),
      feeBps: terms.feeBps,
      books: [decodeBook(must(pr[i * 6 + 3], 'getBook')), decodeBook(must(pr[i * 6 + 4], 'getBook'))],
      positions: null,
      vintageBlock: null,
    };
  });

  if (options.withPositions === false) return { deployed, nowSec, head, entriesPaused, feesAccrued, markets, feeds, keeper: keeperState, wiring };
  const wanted = markets.filter((m) => m.statusCode === MARKET_STATUS.Open || m.listing.finalTime >= nowSec - window);
  const all = await readAllPositions(client, d, wanted.map((m) => m.listing));
  for (const m of wanted) {
    const winnerBook = m.statusCode === MARKET_STATUS.Resolved ? m.books[m.winner === UP ? 0 : 1] : null;
    const mine = all.filter((p) => p.listing.marketId === m.listing.marketId);
    m.positions = mine.map(({ id, position }) => ({ id, position, settlement: settlementOf(position, { status: m.statusCode, winner: m.winner }, winnerBook, m.feeBps) }));
    const pending = mine.find((p) => !p.position.finalized);
    m.vintageBlock = pending === undefined ? null : pending.position.vintage;
  }
  return { deployed, nowSec, head, entriesPaused, feesAccrued, markets, feeds, keeper: keeperState, wiring };
}
