import type { Address, Hex } from 'viem';
import { aggregatorV3Abi, hunchMarketFactoryAbi, hunchVpmAbi, stockRoundResolverAbi } from '../abi/index.js';
import { DOWN, KAPPA_UNBOUNDED, MARKET_STATUS, UP, sideOf, type Outcome, type Side } from '../constants.js';
import { isDeployed, feedByAddress, type Deployment } from '../deployment/index.js';
import {
  accrued as accruedOf,
  classicPayouts,
  headroom as bookHeadroom,
  settlementOf,
  quoteEntry,
  type Book,
  type Position,
  type Quote,
  type Settlement,
} from '../mechanics.js';
import { family as familyOf, questionFor, rulesBox, type MarketFamily, type RulesBox } from '../questions.js';
import { cachedRoundReader, findLastAtOrBefore, findResolutionRounds, roundReaderFromClient, type ResolutionRounds, type RoundReader } from '../rounds.js';
import { priceChange, ppm, type PriceChange } from '../units.js';
import {
  callMany,
  decodeBook,
  decodeFeedInfo,
  decodeListing,
  decodeMarket,
  decodePosition,
  decodePreview,
  decodeRound,
  decodeSpec,
  decodeTerms,
  headCalls,
  mapLimit,
  maybe,
  must,
  type Call,
  type ChainHead,
  type FeedInfo,
  type Listing,
  type MarketTerms,
  type MarketTuple,
  type PreviewResult,
  type ReadClient,
  type Spec,
} from './shared.js';

export type MarketPhase = 'Opens' | 'Live' | 'Frozen' | 'Resolved UP' | 'Resolved DOWN' | 'Void';

export interface PricePoint {
  /** 8-decimal Chainlink answer. */
  price: bigint;
  roundId: bigint;
  /** Unix seconds. */
  updatedAt: number;
}

export interface MarketView {
  /** HunchVPM market id. */
  id: bigint;
  listing: Listing;
  specId: Hex;
  ticker: string;
  feed: Address;
  stockToken: Address;
  family: MarketFamily;
  question: string;
  rules: RulesBox;
  /** Opens (before the strike bell) · Live · Frozen (past the bell, not settled) · Resolved UP/DOWN · Void. */
  status: MarketPhase;
  /** `getMarket().status`: 0 Open, 1 Resolved, 2 Voided. */
  statusCode: number;
  winner: Outcome | null;
  /** `resolver.settled(specId)` (false for a market voided by the settler's timeout). */
  settledByResolver: boolean;
  /** Entries accepted right now (open, before the freeze, entries not paused). */
  acceptingBets: boolean;
  strikeTime: number;
  finalTime: number;
  maxStrikeAge: number;
  maxFinalAge: number;
  /** Anyone may void through the settler from this time (finalTime + voidTimeout). */
  voidableAt: number;
  /** The price in effect at the strike bell (null before the bell, or if it could not be proven). */
  strike: PricePoint | null;
  strikeProblem: string | null;
  /** The feed's latest round. */
  live: PricePoint | null;
  /** live vs strike. */
  change: PriceChange | null;
  kappa: bigint;
  books: [Book, Book];
  totals: {
    /** Accepted pool (both books' principal, seed included). */
    pool: bigint;
    /** Accepted principal on UP / DOWN (seed included). */
    up: bigint;
    down: bigint;
    /** Offered in the open vintage, not yet rationed. */
    pendingUp: bigint;
    pendingDown: bigint;
    /** Gross settlement payouts claimed so far. */
    paidOut: bigint;
    /** UP share of accepted principal, parts per million. */
    upPpm: bigint;
    downPpm: bigint;
  };
  /** Largest stake accepted in full right now on each side (the opposing book's room). */
  headroom: { up: bigint; down: bigint };
  pendingCount: bigint;
  feeBps: number;
  minEntry: bigint;
  maxEntry: bigint;
  seedPerLeg: bigint;
  opener: Address;
  openedAt: number;
}

export interface VenueSnapshot {
  deployed: boolean;
  head: ChainHead | null;
  nowSec: number;
  entriesPaused: boolean;
  listingCount: number;
  markets: MarketView[];
}

export interface ReadVenueOptions {
  /** "Now" for statuses (default: the chain head's timestamp). */
  nowSec?: number;
  /** Find the strike round of every market past its strike bell (default true). */
  strikes?: boolean;
  /** 'active' = markets not yet settled (default 'all'). */
  include?: 'all' | 'active';
  /** Only the newest N listings (default 500). */
  maxListings?: number;
  /** Shared round reader (to reuse a cache across reads). */
  roundReader?: RoundReader;
}

const nowWall = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------ raw loading

interface RawMarket {
  listing: Listing;
  market: MarketTuple;
  books: [Book, Book];
  terms: MarketTerms;
  pendingCount: bigint;
  settled: boolean;
  spec: Spec | null;
}

interface Loaded {
  head: ChainHead;
  entriesPaused: boolean;
  listingCount: number;
  raws: RawMarket[];
  feedInfo: Map<string, FeedInfo | null>;
  latest: Map<string, PricePoint | null>;
}

async function loadHeader(client: ReadClient, d: Deployment) {
  const f = d.contracts.HunchMarketFactory.address;
  const v = d.contracts.HunchVPM.address;
  const [block, r] = await Promise.all([
    client.getBlock({ blockTag: 'latest' }),
    callMany(client, [
      { address: f, abi: hunchMarketFactoryAbi, functionName: 'listingCount' },
      { address: v, abi: hunchVpmAbi, functionName: 'entriesPaused' },
      ...headCalls(),
    ]),
  ]);
  const head: ChainHead = {
    blockNumber: block.number ?? 0n,
    l1BlockNumber: must<bigint>(r[2], 'getBlockNumber'),
    timestamp: Number(block.timestamp),
  };
  return { head, listingCount: Number(must<bigint>(r[0], 'listingCount')), entriesPaused: must<boolean>(r[1], 'entriesPaused') };
}

async function loadListings(client: ReadClient, d: Deployment, indices: readonly number[]): Promise<Listing[]> {
  const f = d.contracts.HunchMarketFactory.address;
  const r = await callMany(
    client,
    indices.map((i) => ({ address: f, abi: hunchMarketFactoryAbi, functionName: 'listings', args: [BigInt(i)] })),
  );
  return indices.map((i, k) => decodeListing(must(r[k], `listings(${i})`), i));
}

async function loadMarkets(client: ReadClient, d: Deployment, listings: readonly Listing[]): Promise<Omit<Loaded, 'head' | 'entriesPaused' | 'listingCount'>> {
  const v = d.contracts.HunchVPM.address;
  const res = d.contracts.StockRoundResolver.address;
  const f = d.contracts.HunchMarketFactory.address;
  const PER = 7;
  const calls: Call[] = [];
  for (const l of listings) {
    calls.push(
      { address: v, abi: hunchVpmAbi, functionName: 'getMarket', args: [l.marketId] },
      { address: v, abi: hunchVpmAbi, functionName: 'getBook', args: [l.marketId, UP] },
      { address: v, abi: hunchVpmAbi, functionName: 'getBook', args: [l.marketId, DOWN] },
      { address: v, abi: hunchVpmAbi, functionName: 'marketTerms', args: [l.marketId] },
      { address: v, abi: hunchVpmAbi, functionName: 'pendingCount', args: [l.marketId] },
      { address: res, abi: stockRoundResolverAbi, functionName: 'settled', args: [l.specId] },
      { address: res, abi: stockRoundResolverAbi, functionName: 'getSpec', args: [l.specId] },
    );
  }
  const feeds = [...new Set(listings.map((l) => l.feed.toLowerCase()))].map((x) => listings.find((l) => l.feed.toLowerCase() === x)!.feed);
  for (const feed of feeds) {
    calls.push(
      { address: f, abi: hunchMarketFactoryAbi, functionName: 'feeds', args: [feed] },
      { address: feed, abi: aggregatorV3Abi, functionName: 'latestRoundData' },
    );
  }
  const r = await callMany(client, calls);
  const raws: RawMarket[] = listings.map((l, k) => {
    const b = k * PER;
    const spec = maybe(r[b + 6]);
    return {
      listing: l,
      market: decodeMarket(must(r[b], `getMarket(${l.marketId})`)),
      books: [decodeBook(must(r[b + 1], 'getBook UP')), decodeBook(must(r[b + 2], 'getBook DOWN'))],
      terms: decodeTerms(must(r[b + 3], 'marketTerms')),
      pendingCount: must<bigint>(r[b + 4], 'pendingCount'),
      settled: maybe<boolean>(r[b + 5]) ?? false,
      spec: spec === null ? null : decodeSpec(spec),
    };
  });
  const feedInfo = new Map<string, FeedInfo | null>();
  const latest = new Map<string, PricePoint | null>();
  const base = listings.length * PER;
  feeds.forEach((feed, j) => {
    const info = maybe(r[base + 2 * j]);
    feedInfo.set(feed.toLowerCase(), info === null ? null : decodeFeedInfo(info));
    const round = maybe(r[base + 2 * j + 1]);
    latest.set(feed.toLowerCase(), round === null ? null : toPoint(decodeRound(round)));
  });
  return { raws, feedInfo, latest };
}

function toPoint(round: { answer: bigint; roundId: bigint; updatedAt: bigint }): PricePoint {
  return { price: round.answer, roundId: round.roundId, updatedAt: Number(round.updatedAt) };
}

// ------------------------------------------------------------------ view assembly

function phaseOf(raw: RawMarket, nowSec: number): MarketPhase {
  const s = raw.market.status;
  if (s === MARKET_STATUS.Resolved) return raw.market.winner === UP ? 'Resolved UP' : 'Resolved DOWN';
  if (s === MARKET_STATUS.Voided) return 'Void';
  if (nowSec >= raw.listing.finalTime) return 'Frozen';
  if (nowSec < raw.listing.strikeTime) return 'Opens';
  return 'Live';
}

function tickerOf(d: Deployment, raw: RawMarket, info: FeedInfo | null | undefined): string {
  if (info !== null && info !== undefined && info.ticker !== '') return info.ticker;
  return feedByAddress(d, raw.listing.feed)?.ticker ?? 'UNKNOWN';
}

function buildView(
  d: Deployment,
  raw: RawMarket,
  nowSec: number,
  entriesPaused: boolean,
  info: FeedInfo | null | undefined,
  live: PricePoint | null | undefined,
  strike: { point: PricePoint | null; problem: string | null },
): MarketView {
  const l = raw.listing;
  const ticker = tickerOf(d, raw, info);
  const [up, down] = raw.books;
  const pool = raw.market.acceptedPool;
  const status = phaseOf(raw, nowSec);
  const room = (b: Book) => {
    const h = bookHeadroom(b);
    if (h === KAPPA_UNBOUNDED) return h;
    return h > b.demand ? h - b.demand : 0n;
  };
  const q = { ticker, strikeTime: l.strikeTime, finalTime: l.finalTime, maxFinalAge: l.maxFinalAge };
  return {
    id: l.marketId,
    listing: l,
    specId: l.specId,
    ticker,
    feed: l.feed,
    stockToken: raw.spec?.stockToken ?? info?.stockToken ?? feedByAddress(d, l.feed)?.stockToken ?? l.feed,
    family: familyOf(q),
    question: questionFor(q),
    rules: rulesBox({ ...q, maxStrikeAge: l.maxStrikeAge, feeBps: raw.terms.feeBps }),
    status,
    statusCode: raw.market.status,
    winner: raw.market.status === MARKET_STATUS.Resolved ? (raw.market.winner as Outcome) : null,
    settledByResolver: raw.settled,
    acceptingBets: raw.market.status === MARKET_STATUS.Open && nowSec < l.finalTime && !entriesPaused,
    strikeTime: l.strikeTime,
    finalTime: l.finalTime,
    maxStrikeAge: l.maxStrikeAge,
    maxFinalAge: l.maxFinalAge,
    voidableAt: raw.market.resolutionTime + raw.market.voidTimeout,
    strike: strike.point,
    strikeProblem: strike.problem,
    live: live ?? null,
    change: strike.point !== null && live !== null && live !== undefined ? priceChange(strike.point.price, live.price) : null,
    kappa: raw.market.kappa,
    books: [up, down],
    totals: {
      pool,
      up: up.principal,
      down: down.principal,
      pendingUp: down.demand,
      pendingDown: up.demand,
      paidOut: raw.market.paidOut,
      upPpm: ppm(up.principal, pool),
      downPpm: ppm(down.principal, pool),
    },
    headroom: { up: room(down), down: room(up) },
    pendingCount: raw.pendingCount,
    feeBps: raw.terms.feeBps,
    minEntry: raw.terms.minEntry,
    maxEntry: raw.terms.maxEntry,
    seedPerLeg: l.seedPerLeg,
    opener: l.opener,
    openedAt: l.openedAt,
  };
}

async function strikeFor(reader: RoundReader, raw: RawMarket, nowSec: number): Promise<{ point: PricePoint | null; problem: string | null }> {
  if (nowSec < raw.listing.strikeTime) return { point: null, problem: null };
  try {
    const found = await findLastAtOrBefore(reader, raw.listing.feed, raw.listing.strikeTime);
    if (found.kind !== 'found') return { point: null, problem: found.kind };
    if (!found.sane) return { point: null, problem: 'insane-answer' };
    return { point: toPoint(found.round), problem: null };
  } catch (error) {
    return { point: null, problem: `unreadable: ${(error as Error).message.split('\n')[0]}` };
  }
}

async function viewsFor(
  client: ReadClient,
  d: Deployment,
  listings: readonly Listing[],
  head: ChainHead,
  entriesPaused: boolean,
  options: ReadVenueOptions,
): Promise<{ views: MarketView[]; raws: RawMarket[] }> {
  if (listings.length === 0) return { views: [], raws: [] };
  const nowSec = options.nowSec ?? head.timestamp;
  const loaded = await loadMarkets(client, d, listings);
  const reader = options.roundReader ?? cachedRoundReader(roundReaderFromClient(client));
  const strikeMemo = new Map<string, Promise<{ point: PricePoint | null; problem: string | null }>>();
  const strikes = await mapLimit(loaded.raws, 8, (raw) => {
    if (options.strikes === false) return Promise.resolve({ point: null, problem: null });
    const key = `${raw.listing.feed.toLowerCase()}:${raw.listing.strikeTime}`;
    let p = strikeMemo.get(key);
    if (p === undefined) {
      p = strikeFor(reader, raw, nowSec);
      strikeMemo.set(key, p);
    }
    return p;
  });
  const views = loaded.raws.map((raw, i) =>
    buildView(d, raw, nowSec, entriesPaused, loaded.feedInfo.get(raw.listing.feed.toLowerCase()), loaded.latest.get(raw.listing.feed.toLowerCase()), strikes[i]!),
  );
  return { views, raws: loaded.raws };
}

// ------------------------------------------------------------------ public reads

/** Every listed market as a view model (newest first). Tolerates the not-deployed state. */
export async function readVenue(client: ReadClient, d: Deployment, options: ReadVenueOptions = {}): Promise<VenueSnapshot> {
  if (!isDeployed(d)) {
    return { deployed: false, head: null, nowSec: options.nowSec ?? nowWall(), entriesPaused: false, listingCount: 0, markets: [] };
  }
  const header = await loadHeader(client, d);
  const max = options.maxListings ?? 500;
  const indices: number[] = [];
  for (let i = header.listingCount - 1; i >= 0 && indices.length < max; i--) indices.push(i);
  const listings = await loadListings(client, d, indices);
  const { views } = await viewsFor(client, d, listings, header.head, header.entriesPaused, options);
  const markets = options.include === 'active' ? views.filter((m) => m.statusCode === MARKET_STATUS.Open) : views;
  return {
    deployed: true,
    head: header.head,
    nowSec: options.nowSec ?? header.head.timestamp,
    entriesPaused: header.entriesPaused,
    listingCount: header.listingCount,
    markets,
  };
}

/** Just the factory listings (cheap; used by the keeper). */
export async function readListings(client: ReadClient, d: Deployment): Promise<Listing[]> {
  if (!isDeployed(d)) return [];
  const count = Number(
    must<bigint>((await callMany(client, [{ address: d.contracts.HunchMarketFactory.address, abi: hunchMarketFactoryAbi, functionName: 'listingCount' }]))[0], 'listingCount'),
  );
  return loadListings(client, d, Array.from({ length: count }, (_, i) => i));
}

export interface PositionView {
  id: bigint;
  marketId: bigint;
  owner: Address;
  outcome: Outcome;
  side: Side;
  offered: bigint;
  /** null until the position's vintage is finalized. */
  accepted: bigint | null;
  /** offered − accepted once finalized (the part that comes back). */
  refused: bigint | null;
  finalized: boolean;
  refunded: boolean;
  claimed: boolean;
  /** L1 block of entry; 0 = the opening seed. */
  vintage: bigint;
  entryAcc: bigint;
  isSeed: boolean;
  /** Owned by the market's opener (seed legs, or the opener's own bets). */
  isOpener: boolean;
  /** If this side wins now: `accrued(positionId)` (monotone while open). */
  accrued: bigint;
  /** What a claim would move now (gross, fee, net, refund). Zero once claimed. */
  settlement: Settlement;
  /** Once claimed: the settlement payout that was sent (gross − fee; refunds excluded). */
  paidOut: bigint | null;
  /** What an ordinary pool would have paid (after resolution only). */
  classicPayout: bigint | null;
}

export interface ResolutionView {
  rounds: ResolutionRounds;
  preview: PreviewResult | null;
}

export interface MarketDetail extends MarketView {
  positions: PositionView[];
  head: ChainHead;
  entriesPaused: boolean;
  /** The open vintage's L1 block (null when none is open). */
  vintageBlock: bigint | null;
  /** Past the final bell: the two proven rounds and `preview()` (null before the bell). */
  resolution: ResolutionView | null;
}

export interface ReadMarketOptions extends ReadVenueOptions {
  /** Find rounds + preview after the final bell (default true). */
  resolution?: boolean;
}

/** One market with every position, the resolution panel data and the quote inputs. null if the factory never listed it. */
export async function readMarket(client: ReadClient, d: Deployment, marketId: bigint, options: ReadMarketOptions = {}): Promise<MarketDetail | null> {
  if (!isDeployed(d)) return null;
  const f = d.contracts.HunchMarketFactory.address;
  const v = d.contracts.HunchVPM.address;
  const header = await loadHeader(client, d);
  const idx = must<bigint>(
    (await callMany(client, [{ address: f, abi: hunchMarketFactoryAbi, functionName: 'listingIndexOf', args: [marketId] }]))[0],
    'listingIndexOf',
  );
  if (idx === 0n) return null;
  const [listing] = await loadListings(client, d, [Number(idx - 1n)]);
  const reader = options.roundReader ?? cachedRoundReader(roundReaderFromClient(client));
  const { views, raws } = await viewsFor(client, d, [listing!], header.head, header.entriesPaused, { ...options, roundReader: reader });
  const view = views[0]!;
  const raw = raws[0]!;
  const nowSec = options.nowSec ?? header.head.timestamp;

  const positions = await readMarketPositions(client, d, marketId);
  const extra = await callMany(
    client,
    positions.flatMap(({ id }) => [
      { address: v, abi: hunchVpmAbi, functionName: 'accrued', args: [id] },
      { address: v, abi: hunchVpmAbi, functionName: 'previewFee', args: [id] },
    ]),
  );
  const winnerBook = raw.market.status === MARKET_STATUS.Resolved ? raw.books[raw.market.winner === UP ? 0 : 1] : null;
  const classic =
    raw.market.status === MARKET_STATUS.Open
      ? null
      : classicPayouts(
          positions.map((p) => ({ outcome: p.position.outcome, accepted: p.position.accepted })),
          raw.market.status === MARKET_STATUS.Resolved ? raw.market.winner : null,
        );
  const views2: PositionView[] = positions.map(({ id, position }, i) => {
    const onchainAccrued = maybe<bigint>(extra[2 * i]);
    return positionView(id, position, raw, listing!.opener, winnerBook, onchainAccrued, classic?.[i] ?? null);
  });
  const pending = views2.filter((p) => !p.finalized);
  const vintageBlock = pending.length > 0 ? pending[0]!.vintage : null;

  let resolution: ResolutionView | null = null;
  if (options.resolution !== false && nowSec >= view.finalTime) {
    try {
      const rounds = await findResolutionRounds(reader, {
        feed: view.feed,
        strikeTime: view.strikeTime,
        finalTime: view.finalTime,
        maxStrikeAge: view.maxStrikeAge,
        maxFinalAge: view.maxFinalAge,
      });
      let preview: PreviewResult | null = null;
      if (rounds.ok) {
        const pr = await callMany(client, [
          {
            address: d.contracts.StockRoundResolver.address,
            abi: stockRoundResolverAbi,
            functionName: 'preview',
            args: [view.specId, rounds.strikeRound, rounds.finalRound],
          },
        ]);
        const value = maybe(pr[0]);
        preview = value === null ? null : decodePreview(value);
      }
      resolution = { rounds, preview };
    } catch {
      resolution = null;
    }
  }

  return { ...view, positions: views2, head: header.head, entriesPaused: header.entriesPaused, vintageBlock, resolution };
}

function positionView(
  id: bigint,
  p: Position,
  raw: RawMarket,
  opener: Address,
  winnerBook: Book | null,
  onchainAccrued: bigint | null,
  classic: bigint | null,
): PositionView {
  const own = raw.books[p.outcome === UP ? 0 : 1];
  const settlement = settlementOf(p, raw.market, winnerBook, raw.terms.feeBps);
  const accruedOff = accruedOf(p, own);
  return {
    id,
    marketId: p.marketId,
    owner: p.owner,
    outcome: p.outcome as Outcome,
    side: sideOf(p.outcome),
    offered: p.offered,
    accepted: p.finalized ? p.accepted : null,
    refused: p.finalized ? p.offered - p.accepted : null,
    finalized: p.finalized,
    refunded: p.refunded,
    claimed: p.claimed,
    vintage: p.vintage,
    entryAcc: p.entryAcc,
    isSeed: p.vintage === 0n,
    isOpener: p.owner.toLowerCase() === opener.toLowerCase(),
    accrued: onchainAccrued ?? accruedOff,
    settlement,
    paidOut: p.claimed ? settlementOf({ ...p, claimed: false, refunded: true }, raw.market, winnerBook, raw.terms.feeBps).net : null,
    classicPayout: classic,
  };
}

/** Every position id of a market (paginated `marketPositions`) with its `positions(id)` tuple. */
export async function readMarketPositions(client: ReadClient, d: Deployment, marketId: bigint): Promise<{ id: bigint; position: Position }[]> {
  const v = d.contracts.HunchVPM.address;
  const count = must<bigint>((await callMany(client, [{ address: v, abi: hunchVpmAbi, functionName: 'marketPositionCount', args: [marketId] }]))[0], 'marketPositionCount');
  const PAGE = 500n;
  const pages: Call[] = [];
  for (let from = 0n; from < count; from += PAGE) {
    pages.push({ address: v, abi: hunchVpmAbi, functionName: 'marketPositions', args: [marketId, from, count - from < PAGE ? count - from : PAGE] });
  }
  const ids = (await callMany(client, pages)).flatMap((r, i) => [...must<readonly bigint[]>(r, `marketPositions page ${i}`)]);
  const r = await callMany(
    client,
    ids.map((id) => ({ address: v, abi: hunchVpmAbi, functionName: 'positions', args: [id] })),
  );
  return ids.map((id, i) => ({ id, position: decodePosition(must(r[i], `positions(${id})`)) }));
}

/** Quote for the bet panel from a `MarketDetail` (handles the open vintage exactly). */
export function quoteForMarket(m: MarketDetail, amount: bigint, outcome: Outcome): Quote {
  const pending = m.positions.filter((p) => !p.finalized).map((p) => ({ outcome: p.outcome, offered: p.offered }));
  return quoteEntry({
    amount,
    outcome,
    books: m.books,
    kappa: m.kappa,
    minEntry: m.minEntry,
    maxEntry: m.maxEntry,
    pending,
    vintageBlock: m.vintageBlock,
    l1Block: m.head.l1BlockNumber,
  });
}

// internal hooks for other readers
export { loadHeader as _loadHeader, loadListings as _loadListings, viewsFor as _viewsFor, positionView as _positionView };
export type { RawMarket as _RawMarket };
