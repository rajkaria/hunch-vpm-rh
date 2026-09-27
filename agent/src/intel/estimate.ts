/**
 * Turning purchased data into the agent's own probability.
 *
 * The agent buys spot and a volatility, not a forecast. The forecast is the arithmetic
 * below, which is the part a reader can check.
 */

import { SECONDS_PER_YEAR, digitalAbove } from "../domain/probability.js";
import type { MarketSnapshot, OutcomeEstimate } from "../domain/types.js";

const PRICE8 = 1e8;

/**
 * A per-outcome probability for a binary feed market, or undefined when this model has
 * nothing honest to say.
 *
 * Returns undefined — and the policy then abstains with `no-estimate` — when:
 *   - the market is not binary. The digital model prices one threshold; an n-way market
 *     needs a different estimator, and guessing uniformly would be a fabricated edge.
 *   - the reading is older than the market's own staleness bound. That market is heading
 *     for `voidStale`, and a stale number is exactly what the resolver refuses to settle
 *     on, so the agent will not stake on it either.
 */
export function estimateFromFeed(
  market: MarketSnapshot,
  quote: FeedQuoteLike,
  now: number,
): OutcomeEstimate | undefined {
  if (market.books.length !== 2) return undefined;

  const age = Math.max(0, now - quote.observedAt);
  if (age > market.spec.maxStaleness) return undefined;

  const spot = Number(quote.price8) / PRICE8;
  const strike = Number(market.spec.strike8) / PRICE8;
  const years = Math.max(0, market.resolutionTime - now) / SECONDS_PER_YEAR;

  // `FeedResolver.winnerFor` treats the strike itself as "above", so the digital is
  // P(S_T >= K) and the two definitions agree at the boundary.
  const pAbove = digitalAbove({ spot, strike, volAnnualised: quote.volAnnualised, years });

  // direction 0: outcome 0 wins at or above the strike. direction 1: the other way round.
  const pOutcome0 = market.spec.direction === 0 ? pAbove : 1 - pAbove;

  return {
    probabilities: [pOutcome0, 1 - pOutcome0],
    basis: `${quote.source} spot=${spot.toPrecision(8)} vol=${quote.volAnnualised.toFixed(3)} t=${years.toExponential(3)}y`,
    observedAt: quote.observedAt,
  };
}

/** The part of a quote the estimator reads. Keeps this module independent of the provider. */
export interface FeedQuoteLike {
  readonly price8: bigint;
  readonly volAnnualised: number;
  readonly observedAt: number;
  readonly source: string;
}
