import { getAddress, parseAbi, type Address } from 'viem';
import { hunchVpmAbi } from '../abi/index.js';
import { MARKET_STATUS, UP, ZERO_ADDRESS } from '../constants.js';
import { isDeployed, type Deployment } from '../deployment/index.js';
import { settlementOf } from '../mechanics.js';
import { readAllPositions } from './positions.js';
import { callMany, maybe, type ReadClient } from './shared.js';
import { _loadHeader, _loadListings, _viewsFor, type MarketView, type ReadVenueOptions } from './venue.js';

/** The Safe views /proof shows (threshold and owners, read on chain). */
export const safeAbi = parseAbi([
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function VERSION() view returns (string)',
]);

export interface ProofSnapshot {
  deployed: boolean;
  nowSec: number;
  counts: {
    marketsOpened: number;
    marketsOpen: number;
    marketsResolved: number;
    marketsVoided: number;
    /** Resolved + voided. */
    marketsSettled: number;
  };
  bettors: {
    /** Distinct position owners, excluding openers, the keeper and the Safe. */
    distinct: number;
    /** Excluded addresses (openers, keeper, Safe). */
    excluded: Address[];
    /** Non-seed positions placed by excluded addresses (shown separately). */
    operatorBets: number;
    /** Non-seed positions by bettors. */
    bets: number;
  };
  usdg: {
    /** Σ offered by bettors (excludes seeds and operator bets). */
    staked: bigint;
    /** Σ accepted of bettors' finalized positions. */
    accepted: bigint;
    /** Σ accepted seed legs. */
    seeded: bigint;
    /** Σ settlement payouts sent to bettors (net of fee). */
    paidToBettors: bigint;
    /** Σ settlement payouts sent to anyone (net of fee, seeds included). */
    paidOut: bigint;
    /** Σ fees taken on claimed winners. */
    feesTaken: bigint;
    /** `feesAccrued(USDG)` now (not yet swept). */
    feesAccrued: bigint;
    /** feesTaken − feesAccrued: fees already swept to the treasury. */
    feesSwept: bigint;
  };
  safe: { address: Address; threshold: number | null; owners: Address[] | null } | null;
  markets: MarketView[];
}

/**
 * Live counters for /proof, read from chain views only. Every number can be recomputed
 * by anyone from `listingCount` → `marketPositions` → `positions` (+ `feesAccrued`).
 */
export async function readProof(client: ReadClient, d: Deployment, options: ReadVenueOptions = {}): Promise<ProofSnapshot> {
  const empty: ProofSnapshot = {
    deployed: false,
    nowSec: options.nowSec ?? Math.floor(Date.now() / 1000),
    counts: { marketsOpened: 0, marketsOpen: 0, marketsResolved: 0, marketsVoided: 0, marketsSettled: 0 },
    bettors: { distinct: 0, excluded: [], operatorBets: 0, bets: 0 },
    usdg: { staked: 0n, accepted: 0n, seeded: 0n, paidToBettors: 0n, paidOut: 0n, feesTaken: 0n, feesAccrued: 0n, feesSwept: 0n },
    safe: null,
    markets: [],
  };
  if (!isDeployed(d)) return empty;

  const header = await _loadHeader(client, d);
  const indices = Array.from({ length: header.listingCount }, (_, i) => header.listingCount - 1 - i);
  const listings = await _loadListings(client, d, indices);
  const [{ views, raws }, positions, extra] = await Promise.all([
    _viewsFor(client, d, listings, header.head, header.entriesPaused, options),
    readAllPositions(client, d, listings),
    callMany(client, [
      { address: d.contracts.HunchVPM.address, abi: hunchVpmAbi, functionName: 'feesAccrued', args: [d.usdg] },
      ...(d.safe === ZERO_ADDRESS
        ? []
        : [
            { address: d.safe, abi: safeAbi, functionName: 'getThreshold' },
            { address: d.safe, abi: safeAbi, functionName: 'getOwners' },
          ]),
    ]),
  ]);

  const excluded = new Set<string>([d.keeper.toLowerCase(), d.safe.toLowerCase()]);
  for (const l of listings) excluded.add(l.opener.toLowerCase());
  excluded.delete(ZERO_ADDRESS);

  const rawByMarket = new Map(raws.map((r) => [r.listing.marketId, r]));
  const bettors = new Set<string>();
  let operatorBets = 0;
  let bets = 0;
  const usdg = { ...empty.usdg };
  for (const { position: p, listing } of positions) {
    const raw = rawByMarket.get(listing.marketId);
    if (raw === undefined) continue;
    const isSeed = p.vintage === 0n;
    const isOperator = excluded.has(p.owner.toLowerCase());
    if (isSeed) usdg.seeded += p.accepted;
    else if (isOperator) operatorBets++;
    else {
      bets++;
      bettors.add(p.owner.toLowerCase());
      usdg.staked += p.offered;
      if (p.finalized) usdg.accepted += p.accepted;
    }
    if (p.claimed) {
      const winnerBook = raw.market.status === MARKET_STATUS.Resolved ? raw.books[raw.market.winner === UP ? 0 : 1] : null;
      const s = settlementOf({ ...p, claimed: false, refunded: true }, raw.market, winnerBook, raw.terms.feeBps);
      usdg.paidOut += s.net;
      usdg.feesTaken += s.fee;
      if (!isSeed && !isOperator) usdg.paidToBettors += s.net;
    }
  }
  usdg.feesAccrued = maybe<bigint>(extra[0]) ?? 0n;
  usdg.feesSwept = usdg.feesTaken > usdg.feesAccrued ? usdg.feesTaken - usdg.feesAccrued : 0n;

  const resolved = views.filter((m) => m.statusCode === MARKET_STATUS.Resolved).length;
  const voided = views.filter((m) => m.statusCode === MARKET_STATUS.Voided).length;
  const threshold = maybe<bigint>(extra[1]);
  const owners = maybe<readonly Address[]>(extra[2]);
  return {
    deployed: true,
    nowSec: options.nowSec ?? header.head.timestamp,
    counts: {
      marketsOpened: header.listingCount,
      marketsOpen: views.length - resolved - voided,
      marketsResolved: resolved,
      marketsVoided: voided,
      marketsSettled: resolved + voided,
    },
    bettors: { distinct: bettors.size, excluded: [...excluded].map((a) => getAddress(a)), operatorBets, bets },
    usdg,
    safe: d.safe === ZERO_ADDRESS ? null : { address: d.safe, threshold: threshold === null ? null : Number(threshold), owners: owners === null ? null : [...owners] },
    markets: views,
  };
}
