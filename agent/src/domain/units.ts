/**
 * Money arithmetic.
 *
 * USDC is the stake asset and the gas token on Arc, and it is 6 decimals through the
 * ERC-20 interface the settler uses. Every amount in this package is a `bigint` of those
 * base units. Floats appear only where the quantity really is an estimate (a probability,
 * a bankroll fraction), and the crossing point between the two is `scaleByFraction`.
 */

export const USDC_DECIMALS = 6;
const USDC_UNIT = 10n ** BigInt(USDC_DECIMALS);

/** Denominator used to turn a float fraction into exact integer arithmetic. */
const FRACTION_SCALE = 1_000_000_000n;

export class AmountError extends Error {}

/** `"12.5"` -> `12_500_000n`. Rejects anything that is not a plain decimal. */
export function parseUsdc(input: string): bigint {
  const text = input.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) throw new AmountError(`not a USDC amount: ${JSON.stringify(input)}`);
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2] ?? "0");
  const fracText = (match[3] ?? "").slice(0, USDC_DECIMALS).padEnd(USDC_DECIMALS, "0");
  return sign * (whole * USDC_UNIT + BigInt(fracText === "" ? "0" : fracText));
}

/** `12_500_000n` -> `"12.50"`. Trailing zeros beyond two decimals are dropped. */
export function formatUsdc(amount: bigint): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = abs / USDC_UNIT;
  const frac = (abs % USDC_UNIT).toString().padStart(USDC_DECIMALS, "0");
  const trimmed = frac.replace(/0+$/, "").padEnd(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${trimmed}`;
}

/** USDC with a unit, for log lines. */
export function usdc(amount: bigint): string {
  return `${formatUsdc(amount)} USDC`;
}

/**
 * Nanopayments are quoted in micro-USDC. USDC is 6 decimals, so one micro-USDC is exactly
 * one USDC base unit: the amounts are perfectly expressible on chain. What makes them
 * uneconomical to settle one at a time is gas, not representation — a 250 µUSDC quote is
 * 0.00025 USDC, and any transaction that moved it would cost far more than that to send.
 * This renders the count as USDC.
 */
export function formatMicroUsdc(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac === "" ? `${whole.toString()}` : `${whole.toString()}.${frac}`;
}

/** Both units at once, because a bare micro-USDC figure is hard to feel the size of. */
export function describeMicroUsdc(micro: bigint): string {
  return `${micro.toString()} µUSDC (${formatMicroUsdc(micro)} USDC)`;
}

/**
 * `value * fraction`, floored, without ever putting a token amount through a float.
 * A negative fraction is clamped to zero: no policy knob should be able to produce a
 * negative stake.
 */
export function scaleByFraction(value: bigint, fraction: number): bigint {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0n;
  const numerator = BigInt(Math.round(Math.min(fraction, 1e9) * Number(FRACTION_SCALE)));
  return (value * numerator) / FRACTION_SCALE;
}

export function minBigint(...values: readonly bigint[]): bigint {
  let best = values[0];
  if (best === undefined) throw new AmountError("minBigint needs at least one value");
  for (const v of values) if (v < best) best = v;
  return best;
}

export function maxBigint(...values: readonly bigint[]): bigint {
  let best = values[0];
  if (best === undefined) throw new AmountError("maxBigint needs at least one value");
  for (const v of values) if (v > best) best = v;
  return best;
}

/** Ratio as a float, for display and for probability arithmetic. 0/0 reads as 0. */
export function ratio(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return 0;
  // Divide in bigint first so the conversion to Number happens on a bounded quantity.
  const scaled = (numerator * FRACTION_SCALE) / denominator;
  return Number(scaled) / Number(FRACTION_SCALE);
}

export function clamp(value: number, low: number, high: number): number {
  if (Number.isNaN(value)) return low;
  return value < low ? low : value > high ? high : value;
}

/** Percent with one decimal, for tables. */
export function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
