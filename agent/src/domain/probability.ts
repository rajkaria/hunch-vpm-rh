/**
 * The agent's own view of a price question.
 *
 * A Hunch feed market asks exactly one thing: will the feed read at or above the strike
 * when the market freezes? That is a digital option, so the agent prices it as one rather
 * than buying somebody's opinion. It buys the two inputs a price model needs — spot and a
 * volatility — and does the arithmetic itself. That matters for the decision procedure:
 * the estimate has to be independent of the book, or comparing it to the book's implied
 * odds proves nothing.
 */

import { clamp } from "./units.js";

export const SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60;

/**
 * Standard normal CDF, Abramowitz & Stegun 7.1.26 applied to erf.
 * Absolute error below 1.5e-7, which is four orders of magnitude finer than any edge
 * threshold the policy uses.
 */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-z * z));
}

export interface DigitalInput {
  /** Current feed reading, same units as the strike. */
  readonly spot: number;
  readonly strike: number;
  /** Annualised volatility as a fraction, e.g. 0.65 for 65%. */
  readonly volAnnualised: number;
  /** Time to the freeze, in years. */
  readonly years: number;
}

/**
 * P(S_T >= K) under a driftless geometric Brownian motion.
 *
 * Driftless on purpose: the agent has no view on the risk-free rate or on a carry, and
 * inventing one would put a systematic tilt into every market it touches. The model is
 * therefore deliberately humble — its job is to be an independent second opinion on the
 * book, not to be right about the asset.
 *
 * Degenerate inputs collapse to the honest answer rather than to NaN: with no time left
 * or no volatility, the question is already decided by where spot sits.
 */
export function digitalAbove(input: DigitalInput): number {
  const { spot, strike, volAnnualised, years } = input;
  if (!(spot > 0) || !(strike > 0)) return 0.5;

  const variance = volAnnualised * volAnnualised * years;
  if (!(variance > 0)) return spot >= strike ? 1 : 0;

  const sd = Math.sqrt(variance);
  const d2 = (Math.log(spot / strike) - 0.5 * variance) / sd;
  return clamp(normalCdf(d2), 0, 1);
}
