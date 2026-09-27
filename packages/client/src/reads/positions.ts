import type { Address } from 'viem';
import { hunchVpmAbi } from '../abi/index.js';
import { MARKET_STATUS, UP } from '../constants.js';
import { isDeployed, type Deployment } from '../deployment/index.js';
import type { Position } from '../mechanics.js';
import { callMany, decodePosition, must, type Call, type Listing, type ReadClient } from './shared.js';
import { _loadHeader, _loadListings, _positionView, _viewsFor, type MarketView, type PositionView, type ReadVenueOptions } from './venue.js';

export interface IndexedPosition {
  id: bigint;
  position: Position;
  listing: Listing;
}

/**
 * Every position of every listed market, through views only: `marketPositionCount` →
 * `marketPositions` → `positions`. O(total positions) calls, batched through Multicall3.
 */
export async function readAllPositions(client: ReadClient, d: Deployment, listings: readonly Listing[]): Promise<IndexedPosition[]> {
  if (listings.length === 0) return [];
  const v = d.contracts.HunchVPM.address;
  const counts = await callMany(
    client,
    listings.map((l) => ({ address: v, abi: hunchVpmAbi, functionName: 'marketPositionCount', args: [l.marketId] })),
  );
  const PAGE = 500n;
  const pages: { call: Call; listing: Listing }[] = [];
  listings.forEach((l, i) => {
    const count = must<bigint>(counts[i], `marketPositionCount(${l.marketId})`);
    for (let from = 0n; from < count; from += PAGE) {
      pages.push({
        listing: l,
        call: { address: v, abi: hunchVpmAbi, functionName: 'marketPositions', args: [l.marketId, from, count - from < PAGE ? count - from : PAGE] },
      });
    }
  });
  const pageResults = await callMany(client, pages.map((p) => p.call));
  const ids: { id: bigint; listing: Listing }[] = [];
  pageResults.forEach((r, i) => {
    for (const id of must<readonly bigint[]>(r, 'marketPositions')) ids.push({ id, listing: pages[i]!.listing });
  });
  const pos = await callMany(
    client,
    ids.map(({ id }) => ({ address: v, abi: hunchVpmAbi, functionName: 'positions', args: [id] })),
  );
  return ids.map(({ id, listing }, i) => ({ id, listing, position: decodePosition(must(pos[i], `positions(${id})`)) }));
}

export interface OwnerPosition {
  market: MarketView;
  position: PositionView;
}

export interface OwnerPortfolio {
  deployed: boolean;
  owner: Address;
  positions: OwnerPosition[];
  totals: {
    /** Σ offered across every position. */
    staked: bigint;
    /** Σ accepted (finalized positions). */
    accepted: bigint;
    /** Σ what claims/refunds would deliver right now (settled markets + refused remainders). */
    deliverable: bigint;
    /** Σ settlement payouts already sent (claimed positions, net of fee). */
    paidOut: bigint;
    /** Positions in markets that are still open. */
    open: number;
  };
}

/** A wallet's positions across all markets, newest market first. No log scans. */
export async function readPositionsByOwner(
  client: ReadClient,
  d: Deployment,
  owner: Address,
  options: ReadVenueOptions = {},
): Promise<OwnerPortfolio> {
  const empty: OwnerPortfolio = {
    deployed: isDeployed(d),
    owner,
    positions: [],
    totals: { staked: 0n, accepted: 0n, deliverable: 0n, paidOut: 0n, open: 0 },
  };
  if (!isDeployed(d)) return empty;
  const header = await _loadHeader(client, d);
  const indices = Array.from({ length: header.listingCount }, (_, i) => header.listingCount - 1 - i);
  const listings = await _loadListings(client, d, indices);
  const all = await readAllPositions(client, d, listings);
  const mine = all.filter((p) => p.position.owner.toLowerCase() === owner.toLowerCase());
  if (mine.length === 0) return empty;

  const involved = listings.filter((l) => mine.some((p) => p.listing.marketId === l.marketId));
  const { views, raws } = await _viewsFor(client, d, involved, header.head, header.entriesPaused, options);
  const accrued = await callMany(
    client,
    mine.map((p) => ({ address: d.contracts.HunchVPM.address, abi: hunchVpmAbi, functionName: 'accrued', args: [p.id] })),
  );

  const out: OwnerPosition[] = mine.map((p, i) => {
    const k = involved.findIndex((l) => l.marketId === p.listing.marketId);
    const raw = raws[k]!;
    const winnerBook = raw.market.status === MARKET_STATUS.Resolved ? raw.books[raw.market.winner === UP ? 0 : 1] : null;
    const r = accrued[i];
    const view = _positionView(p.id, p.position, raw, p.listing.opener, winnerBook, r !== undefined && r.ok ? (r.value as bigint) : null, null);
    return { market: views[k]!, position: view };
  });

  const totals = out.reduce(
    (t, { market, position }) => ({
      staked: t.staked + position.offered,
      accepted: t.accepted + (position.accepted ?? 0n),
      deliverable: t.deliverable + position.settlement.total,
      paidOut: t.paidOut + (position.paidOut ?? 0n),
      open: t.open + (market.statusCode === MARKET_STATUS.Open ? 1 : 0),
    }),
    empty.totals,
  );
  return { deployed: true, owner, positions: out, totals };
}
