/**
 * Exact integer arithmetic and display formatting.
 *
 * Every token amount on this surface is a `bigint` in USDC's smallest unit. No
 * amount is ever routed through a JS `number`: a float round-trip on a balance
 * would silently move someone's money, and the numbers here are the ones a
 * person decides on. Formatting is digit surgery on the decimal string, so it
 * loses nothing it does not say it is losing.
 */

/** USDC on Arc reports 6 decimals through the ERC-20 interface. */
export const USDC_DECIMALS = 6;

/** Parts per million, the fixed-point base for every ratio reported here. */
export const PPM = 1_000_000n;

/** Fixed-point scale S of the settler's reward-per-share accumulator. */
export const ACC_SCALE = 10n ** 18n;

/** `VestedParimutuel.KAPPA_UNBOUNDED` — the sentinel for an unbounded capacity. */
export const KAPPA_UNBOUNDED = 2n ** 256n - 1n;

/** The price feed and strike in `FeedResolver` are scaled to 8 decimals. */
export const PRICE_DECIMALS = 8;

export function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function absBigInt(a: bigint): bigint {
  return a < 0n ? -a : a;
}

/**
 * bigint -> exact decimal string. `toDecimalString(1500000n, 6)` is "1.5".
 * Nothing is rounded; this is the value the chain holds.
 */
export function toDecimalString(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new RangeError(`decimals must be an integer in [0, 77], got ${decimals}`);
  }
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = magnitude / base;
  const fraction = magnitude % base;
  const fractionDigits = decimals === 0 ? '' : fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  const sign = negative && magnitude !== 0n ? '-' : '';
  return fractionDigits.length > 0 ? `${sign}${whole}.${fractionDigits}` : `${sign}${whole}`;
}

/**
 * Decimal string -> bigint, exact, rejecting more fraction digits than the
 * asset has rather than truncating them. A caller who types "1.0000005" USDC
 * has made a mistake and should be told so.
 */
export function fromDecimalString(value: string, decimals: number): bigint {
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

export interface ParsedAmount {
  /** The amount in smallest units, or `null` when the text is not one. */
  value: bigint | null;
  /** What to tell the user, or `null` when there is nothing wrong. */
  problem: string | null;
}

/**
 * Parse a typed USDC amount.
 *
 * Amounts are parsed, not coerced. An input with more than six decimal places
 * is a mistake worth telling someone about rather than quietly truncating,
 * because the truncation would change what they were about to send — and on
 * this surface what they are about to send is a signed transaction.
 *
 * Empty is not an error: it is the initial state of every amount field, and
 * showing a validation message before anyone has typed is noise.
 */
export function parseUsdcAmount(text: string): ParsedAmount {
  const trimmed = text.trim();
  if (trimmed === '') return { value: 0n, problem: null };
  try {
    const value = fromDecimalString(trimmed, USDC_DECIMALS);
    if (value < 0n) return { value: null, problem: 'A stake cannot be negative.' };
    return { value, problem: null };
  } catch {
    return {
      value: null,
      problem: `Enter an amount like 250 or 250.50. USDC has ${USDC_DECIMALS} decimal places.`,
    };
  }
}

export interface AmountFormat {
  /** Fraction digits to show. Fixed, so columns of numbers line up. Default 2. */
  fractionDigits?: number;
  /** Group the integer part with thin separators. Default true. */
  group?: boolean;
  /** Prefix a `+` on positive values, for deltas where the sign is the point. */
  signed?: boolean;
}

/**
 * Smallest-units -> a display string with a FIXED number of fraction digits.
 *
 * Fixed width is the point: these numbers sit in columns and update in place,
 * and a value that changes its digit count shifts the layout under the reader's
 * eye. The fraction is TRUNCATED toward zero, never rounded up — a claimable
 * balance shown as more than the contract will pay is a bug report, and the
 * exact value is always available from `toDecimalString`.
 */
export function formatAmount(value: bigint, options: AmountFormat = {}): string {
  const fractionDigits = options.fractionDigits ?? 2;
  const group = options.group ?? true;
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const base = 10n ** BigInt(USDC_DECIMALS);
  const whole = magnitude / base;
  const fraction = magnitude % base;

  const allDigits = fraction.toString().padStart(USDC_DECIMALS, '0');
  const shown = fractionDigits === 0 ? '' : `.${allDigits.slice(0, fractionDigits)}`;
  const wholeText = group ? groupDigits(whole.toString()) : whole.toString();
  const sign = negative ? '-' : options.signed === true && value > 0n ? '+' : '';
  return `${sign}${wholeText}${shown}`;
}

/** Exact USDC string for a `title` attribute, so the display truncation is never the last word. */
export function formatAmountExact(value: bigint): string {
  return toDecimalString(value, USDC_DECIMALS);
}

function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `part / whole` in parts per million, floored. A zero denominator has no share. */
export function shareToPpm(part: bigint, whole: bigint): bigint {
  if (whole === 0n) return 0n;
  return (part * PPM) / whole;
}

/** ppm -> percent string with a fixed number of decimals, for aligned columns. */
export function formatPpmPercent(ppm: bigint, fractionDigits = 1): string {
  const negative = ppm < 0n;
  const magnitude = negative ? -ppm : ppm;
  const whole = magnitude / 10_000n;
  const rest = (magnitude % 10_000n).toString().padStart(4, '0');
  const shown = fractionDigits === 0 ? '' : `.${rest.slice(0, fractionDigits)}`;
  return `${negative ? '-' : ''}${whole}${shown}`;
}

/**
 * ppm -> a `number` in [0, 100] for a CSS width.
 *
 * This is the one place a ratio becomes a float, and it is safe because the
 * result is a bar width and nothing downstream is money. Clamped, because a
 * book that has taken more than its capacity through rounding should paint a
 * full bar rather than overflow its track.
 */
export function ppmToPercentNumber(ppm: bigint): number {
  const clamped = ppm < 0n ? 0n : ppm > PPM ? PPM : ppm;
  return Number(clamped) / 10_000;
}

/** A multiple in ppm -> "1.84x". `1_840_000n` is 1.84 times the stake. */
export function formatMultiple(ppm: bigint | null, fractionDigits = 2): string {
  if (ppm === null) return '—';
  const negative = ppm < 0n;
  const magnitude = negative ? -ppm : ppm;
  const whole = magnitude / PPM;
  const rest = (magnitude % PPM).toString().padStart(6, '0');
  const shown = fractionDigits === 0 ? '' : `.${rest.slice(0, fractionDigits)}`;
  return `${negative ? '-' : ''}${whole}${shown}x`;
}

/** Feed price or strike (8dp, signed) -> a grouped decimal string. */
export function formatPrice(value: bigint, fractionDigits = 2): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const base = 10n ** BigInt(PRICE_DECIMALS);
  const whole = magnitude / base;
  const fraction = (magnitude % base).toString().padStart(PRICE_DECIMALS, '0');
  const shown = fractionDigits === 0 ? '' : `.${fraction.slice(0, fractionDigits)}`;
  return `${negative ? '-' : ''}${groupDigits(whole.toString())}${shown}`;
}

/** `0x1234…cdef` — enough of an address to recognise, short enough to sit in a row. */
export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** `0xabcd…7890` for a 32-byte value, which is too long to show whole anywhere. */
export function shortHex(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}
