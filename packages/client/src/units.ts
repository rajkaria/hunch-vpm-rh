import { ONE_USDG, PRICE_DECIMALS, USDG_DECIMALS } from './constants.js';

/**
 * Exact integer money. Every amount is a `bigint` in base units (USDG: 6 decimals,
 * Chainlink equity prices: 8 decimals). Nothing is ever converted through a JS number,
 * and nothing is ever rounded up: a payout shown to the cent is floored to the cent.
 */

export function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function checkDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new RangeError(`decimals must be an integer in [0, 77], got ${decimals}`);
  }
}

/** bigint → exact decimal string, trailing zeros trimmed. `formatUnitsExact(1500000n, 6)` is "1.5". */
export function formatUnitsExact(value: bigint, decimals: number): string {
  checkDecimals(decimals);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = magnitude / base;
  const fraction = (magnitude % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  const sign = negative && magnitude !== 0n ? '-' : '';
  return fraction.length > 0 ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

/**
 * Decimal string → bigint, exact. Rejects more fraction digits than the unit has rather
 * than silently truncating someone's input.
 */
export function parseUnitsExact(value: string, decimals: number): bigint {
  checkDecimals(decimals);
  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (match === null) throw new RangeError(`not a decimal amount: ${JSON.stringify(value)}`);
  const whole = match[2] ?? '';
  const fraction = match[3] ?? '';
  if (whole === '' && fraction === '') throw new RangeError(`not a decimal amount: ${JSON.stringify(value)}`);
  if (fraction.length > decimals) {
    throw new RangeError(`${JSON.stringify(value)} has more than ${decimals} decimal places`);
  }
  const scaled = BigInt(whole === '' ? '0' : whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  return match[1] === '-' ? -scaled : scaled;
}

/** "12.5" → 12500000n. Throws on more than 6 decimals, a sign, or junk. */
export function parseUsdg(value: string): bigint {
  const amount = parseUnitsExact(value, USDG_DECIMALS);
  if (amount < 0n) throw new RangeError('amount cannot be negative');
  return amount;
}

export type ParsedAmount =
  | { ok: true; amount: bigint }
  | { ok: false; reason: 'empty' | 'invalid' | 'too-many-decimals' | 'zero' };

/**
 * Lenient parse for an amount input box: trims, drops thousands separators and a
 * trailing "USDG", and reports why an input is unusable instead of throwing.
 */
export function parseUsdgInput(raw: string): ParsedAmount {
  const cleaned = raw.trim().replace(/usdg$/i, '').replace(/[,\s_]/g, '');
  if (cleaned === '') return { ok: false, reason: 'empty' };
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '.') return { ok: false, reason: 'invalid' };
  const fraction = cleaned.split('.')[1] ?? '';
  if (fraction.length > USDG_DECIMALS) return { ok: false, reason: 'too-many-decimals' };
  const amount = parseUnitsExact(cleaned, USDG_DECIMALS);
  if (amount === 0n) return { ok: false, reason: 'zero' };
  return { ok: true, amount };
}

function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface FixedOptions {
  /** Digits after the point (default 2). The value is FLOORED (toward zero) to this. */
  decimals?: number;
  /** Thousands separators (default true). */
  grouping?: boolean;
}

/** Floor `value` (in units of `unitDecimals`) to `decimals` places and render it with exactly that many. */
export function formatFixedFloor(value: bigint, unitDecimals: number, options: FixedOptions = {}): string {
  checkDecimals(unitDecimals);
  const decimals = options.decimals ?? 2;
  checkDecimals(decimals);
  const negative = value < 0n;
  let magnitude = negative ? -value : value;
  if (decimals < unitDecimals) {
    const cut = 10n ** BigInt(unitDecimals - decimals);
    magnitude = magnitude / cut;
  } else if (decimals > unitDecimals) {
    magnitude = magnitude * 10n ** BigInt(decimals - unitDecimals);
  }
  const base = 10n ** BigInt(decimals);
  const whole = (magnitude / base).toString();
  const fraction = decimals === 0 ? '' : (magnitude % base).toString().padStart(decimals, '0');
  const w = options.grouping === false ? whole : group(whole);
  const sign = negative && magnitude !== 0n ? '-' : '';
  return decimals === 0 ? `${sign}${w}` : `${sign}${w}.${fraction}`;
}

/**
 * USDG to the cent, floored, never rounded up: `formatUsdg(69_166_666n)` is "69.16".
 * Pass `{ decimals: 6 }` for the exact amount.
 */
export function formatUsdg(amount: bigint, options: FixedOptions = {}): string {
  return formatFixedFloor(amount, USDG_DECIMALS, options);
}

/** `formatUsdg` plus the unit: "69.16 USDG". */
export function formatUsdgWithUnit(amount: bigint, options: FixedOptions = {}): string {
  return `${formatUsdg(amount, options)} USDG`;
}

/** Whole USDG → base units: `usdg(10)` is 10000000n. */
export function usdg(whole: number | bigint): bigint {
  if (typeof whole === 'number' && !Number.isInteger(whole)) throw new RangeError('usdg() takes whole units; use parseUsdg for fractions');
  return BigInt(whole) * ONE_USDG;
}

/** Chainlink 8-decimal answer → "225.66" (floored to `decimals`, default 2). */
export function formatPrice(answer: bigint, options: FixedOptions = {}): string {
  return formatFixedFloor(answer, PRICE_DECIMALS, options);
}

/** Exact 8-decimal price string ("225.66018707"). */
export function formatPriceExact(answer: bigint): string {
  return formatUnitsExact(answer, PRICE_DECIMALS);
}

export interface MultipleOptions {
  /** At most this many decimals (default 3), floored. */
  maxDecimals?: number;
  /** At least this many decimals (default 2); zeros beyond it are trimmed. */
  minDecimals?: number;
  /** Suffix (default "×"). */
  suffix?: string;
}

/**
 * `payout / stake` as a multiple, floored: `formatMultiple(56_250_000n, 50_000_000n)` is
 * "1.125×", `formatMultiple(69_166_666n, 20_000_000n)` is "3.458×". `null` for a zero stake.
 */
export function formatMultiple(numerator: bigint, denominator: bigint, options: MultipleOptions = {}): string | null {
  if (denominator <= 0n || numerator < 0n) return null;
  const maxDecimals = options.maxDecimals ?? 3;
  const minDecimals = Math.min(options.minDecimals ?? 2, maxDecimals);
  const scaled = (numerator * 10n ** BigInt(maxDecimals)) / denominator;
  const whole = scaled / 10n ** BigInt(maxDecimals);
  let fraction = maxDecimals === 0 ? '' : (scaled % 10n ** BigInt(maxDecimals)).toString().padStart(maxDecimals, '0');
  while (fraction.length > minDecimals && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  const suffix = options.suffix ?? '×';
  return `${whole}${fraction === '' ? '' : `.${fraction}`}${suffix}`;
}

/** `part / whole` in parts per million, floored; 0 for an empty whole. */
export function ppm(part: bigint, whole: bigint): bigint {
  if (whole === 0n) return 0n;
  return (part * 1_000_000n) / whole;
}

/** Percent with `decimals` places, floored toward zero: `formatPercent(1n, 3n)` is "33.3%". */
export function formatPercent(part: bigint, whole: bigint, decimals = 1): string {
  if (whole === 0n) return '0%';
  const scaled = (part * 100n * 10n ** BigInt(decimals)) / whole;
  return `${formatUnitsExactFixed(scaled, decimals)}%`;
}

function formatUnitsExactFixed(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = magnitude / base;
  const frac = decimals === 0 ? '' : `.${(magnitude % base).toString().padStart(decimals, '0')}`;
  return `${negative && magnitude !== 0n ? '-' : ''}${whole}${frac}`;
}

/** Fee in basis points as a percent string: 200 → "2%", 250 → "2.5%". */
export function formatBps(bps: number | bigint): string {
  return `${formatUnitsExact(BigInt(bps), 2)}%`;
}

export interface PriceChange {
  direction: 'UP' | 'DOWN' | 'FLAT';
  /** Signed change in basis points, truncated toward zero. */
  bps: number;
  /** "+1.23%", "-0.40%", "0.00%" (truncated toward zero). */
  text: string;
}

/** Change of `live` versus `strike` (both 8-decimal answers). `null` if the strike is not positive. */
export function priceChange(strike: bigint, live: bigint): PriceChange | null {
  if (strike <= 0n) return null;
  const diff = live - strike;
  const bps = Number((diff * 10_000n) / strike);
  const hundredths = (diff * 10_000n) / strike; // percent × 100
  const direction = diff > 0n ? 'UP' : diff < 0n ? 'DOWN' : 'FLAT';
  const sign = diff > 0n ? '+' : diff < 0n ? '-' : '';
  const mag = hundredths < 0n ? -hundredths : hundredths;
  return { direction, bps, text: `${sign}${mag / 100n}.${(mag % 100n).toString().padStart(2, '0')}%` };
}
