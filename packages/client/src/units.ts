/**
 * Exact integer arithmetic and formatting.
 *
 * Every token amount in this package is a `bigint` in the settlement asset's
 * smallest unit. No amount is ever converted to a JS `number`: USDC balances
 * routinely exceed 2^53 smallest-units once you are past ~9 billion USDC, and
 * more importantly a float round-trip would silently move someone's money.
 * The formatters below go bigint -> decimal string by digit surgery, so they
 * lose nothing.
 */

/** USDC on Arc reports 6 decimals through the ERC-20 interface. */
export const USDC_DECIMALS = 6;

/** Parts per million, the fixed-point base used for every ratio we report. */
export const PPM = 1_000_000n;

/**
 * Fixed-point scale S of the settler's reward-per-share accumulator (§6 of the
 * paper, `VestedParimutuel.SCALE`). A position's earned vesting is
 * `floor(accepted * (A_now - A_entry) / S)`.
 */
export const ACC_SCALE = 10n ** 18n;

/**
 * The settler's sentinel for an unbounded capacity coefficient
 * (`VestedParimutuel.KAPPA_UNBOUNDED`, i.e. `type(uint256).max`). It appears
 * both as a market's kappa and as a book's capacity. The paper prescribes it
 * for n-way markets, where capacity rationing is not the binding constraint.
 */
export const KAPPA_UNBOUNDED = 2n ** 256n - 1n;

/**
 * How the index spells that same sentinel.
 *
 * The subgraph rewrites `2^256-1` to `-1` on `kappa`, `Book.capacity` and
 * `Book.headroom`, so that a consumer rendering a `BigInt` as a number cannot
 * put 1.16e77 on a chart. Reads decode it to `null` instead, and branch on the
 * companion booleans (`kappaIsUnbounded`, `capacityIsUnbounded`) rather than on
 * the value — the constant is exported for anyone reading the raw index.
 */
export const UNBOUNDED_SENTINEL = -1n;

export function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export interface FormatOptions {
  /** Keep trailing zeros in the fraction, so 1500000 at 6dp reads "1.500000". */
  trailingZeros?: boolean;
}

/**
 * bigint -> decimal string, exact. `formatUnitsExact(1500000n, 6)` is "1.5".
 */
export function formatUnitsExact(value: bigint, decimals: number, options: FormatOptions = {}): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new RangeError(`decimals must be an integer in [0, 77], got ${decimals}`);
  }
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = magnitude / base;
  const fraction = magnitude % base;

  let fractionDigits = decimals === 0 ? '' : fraction.toString().padStart(decimals, '0');
  if (options.trailingZeros !== true) {
    fractionDigits = fractionDigits.replace(/0+$/, '');
  }

  const sign = negative && (whole !== 0n || fraction !== 0n) ? '-' : '';
  return fractionDigits.length > 0 ? `${sign}${whole}.${fractionDigits}` : `${sign}${whole}`;
}

/**
 * Decimal string -> bigint, exact. Rejects more fraction digits than the asset
 * has, rather than truncating: a caller who writes "1.0000005" for USDC has a
 * bug, and silently dropping the digit would hide it.
 */
export function parseUnitsExact(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new RangeError(`decimals must be an integer in [0, 77], got ${decimals}`);
  }
  const match = /^(-)?(\d+)(?:\.(\d*))?$/.exec(value.trim());
  const whole = match?.[2];
  if (match === null || whole === undefined) {
    throw new RangeError(`not a decimal amount: ${JSON.stringify(value)}`);
  }
  const fraction = match[3] ?? '';
  if (fraction.length > decimals) {
    throw new RangeError(`${JSON.stringify(value)} has more than ${decimals} decimal places`);
  }
  const scaled = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  return match[1] === '-' ? -scaled : scaled;
}

/** Smallest-units -> USDC string. `formatUsdc(107_000000n)` is "107". */
export function formatUsdc(value: bigint, options: FormatOptions = {}): string {
  return formatUnitsExact(value, USDC_DECIMALS, options);
}

/** USDC string -> smallest-units. `parseUsdc("107")` is 107000000n. */
export function parseUsdc(value: string): bigint {
  return parseUnitsExact(value, USDC_DECIMALS);
}

/**
 * `part / whole` in parts per million, floored. Returns 0 for a zero
 * denominator instead of throwing: an empty book has no share, and every
 * caller here would otherwise have to guard the same way.
 */
export function shareToPpm(part: bigint, whole: bigint): bigint {
  if (whole === 0n) return 0n;
  return (part * PPM) / whole;
}

/** ppm -> percent with four decimal places. `ppmToPercent(56074n)` is "5.6074". */
export function ppmToPercent(ppm: bigint): string {
  return formatUnitsExact(ppm, 4, { trailingZeros: true });
}

/**
 * The price feed and strike in `FeedResolver` are scaled to 8 decimals, which
 * is what Chainlink's USD feeds use.
 */
export const PRICE_DECIMALS = 8;

/** Feed price or strike (8dp, signed) -> decimal string. */
export function formatPrice(value: bigint): string {
  return formatUnitsExact(value, PRICE_DECIMALS);
}
