// TODO(S7): replace with @hunch-rh/client readVenue/readPrices
/**
 * What the venue holds right now, as the landing page reads it.
 *
 * Before deployment there is nothing to read: no markets, no settled market for the proof card.
 * This returns exactly that, and the page shows the honest launching state and the labelled
 * worked example. It never invents a market.
 *
 * S7 replaces the body with view-call enumeration (factory `listingCount` / `listings`, then
 * `getMarket`, `getBook`, `marketTerms`, `resolver.getSpec`) per .ocean/PLAN.md, mapping each
 * market into `MarketCardData` and the latest settled weekly and daily markets into
 * `EarlyVsLateProof`.
 */

import { readDeployment } from './deployment';
import type { VenueState } from './types';

export async function readVenue(): Promise<VenueState> {
  const deployment = readDeployment();
  return {
    status: deployment.status,
    markets: [],
    settled: { weekly: null, daily: null },
  };
}
