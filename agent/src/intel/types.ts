/** The paid research surface, and what a call to it costs. */

export interface FeedQuote {
  readonly feedKey: string;
  /** Reading at 8 decimals — the `IPriceOracle.read` convention the resolver uses. */
  readonly price8: bigint;
  /** Annualised volatility as a fraction. The second input a digital needs. */
  readonly volAnnualised: number;
  /** Unix seconds the reading was taken. */
  readonly observedAt: number;
  readonly source: string;
}

export interface IntelProvider {
  readonly name: string;
  /** Price per call in micro-USDC (1e-6 USDC). Sub-cent by design. */
  readonly pricePerCallMicroUsdc: bigint;
  quote(feedKey: string): Promise<FeedQuote>;
}
