/**
 * Presentation helpers. Everything monetary is a bigint of USDC base units until the
 * last moment: USDC has 6 decimals and a market's arithmetic is exact integer
 * arithmetic on-chain, so converting to `number` anywhere upstream of display would
 * lose units that the settler counts.
 */

/** USDC exposes 6 decimals through the ERC-20 interface, on Arc as everywhere else. */
export const USDC_DECIMALS = 6;

const USDC_UNIT = 10n ** BigInt(USDC_DECIMALS);

/**
 * The settler's κ → ∞ sentinel (`type(uint256).max`). A book created with unbounded κ
 * has unbounded capacity, so its headroom never runs out.
 */
export const UNBOUNDED = (1n << 256n) - 1n;

/**
 * Anything above this is the unbounded sentinel or an arithmetic shadow of it. Total
 * USDC in existence is on the order of 1e17 base units, so no real book is within
 * thirty orders of magnitude of 2^255; an indexer that computed `capacity - vested`
 * itself and shaved a few units off the sentinel still lands above the threshold.
 */
const UNBOUNDED_THRESHOLD = 1n << 255n;

export function isUnbounded(value: bigint): boolean {
  return value >= UNBOUNDED_THRESHOLD;
}

/** A money value in the two forms a model needs: exact base units, and something readable. */
export interface MoneyView {
  /** Exact base units, as a decimal string — JSON cannot carry a bigint. */
  readonly base: string;
  /** The same value in USDC, e.g. "1250.5". */
  readonly usdc: string;
  /** Ready to drop into prose, e.g. "1250.5 USDC". */
  readonly display: string;
  /** True when the value is the unbounded sentinel rather than a real amount. */
  readonly unbounded?: true;
}

export function money(base: bigint): MoneyView {
  if (isUnbounded(base)) {
    return { base: base.toString(), usdc: "unbounded", display: "unbounded", unbounded: true };
  }
  const usdc = formatUsdc(base);
  return { base: base.toString(), usdc, display: `${usdc} USDC` };
}

/** Base units to a plain decimal string with no trailing zeros: 1_234_500n -> "1.2345". */
export function formatUsdc(base: bigint): string {
  const negative = base < 0n;
  const abs = negative ? -base : base;
  const whole = abs / USDC_UNIT;
  const fraction = abs % USDC_UNIT;
  const sign = negative ? "-" : "";
  if (fraction === 0n) return `${sign}${whole.toString()}`;
  const padded = fraction.toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${sign}${whole.toString()}.${padded}`;
}

/**
 * Parse a human USDC amount into base units. Deliberately strict: a stake written with
 * more precision than USDC has is a mistake worth reporting, not something to round
 * silently, because the number the agent then signs would not be the number it asked for.
 */
export function parseUsdc(input: string): bigint {
  const trimmed = input.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (match === null) {
    throw new Error(`"${input}" is not a plain decimal USDC amount (expected e.g. "250" or "250.5").`);
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > USDC_DECIMALS) {
    throw new Error(`"${input}" has ${fraction.length} decimal places; USDC has ${USDC_DECIMALS}.`);
  }
  return BigInt(whole) * USDC_UNIT + BigInt(fraction.padEnd(USDC_DECIMALS, "0") || "0");
}

/** Percentage with one decimal, e.g. 0.6237 -> "62.4%". */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "n/a";
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * Decimal odds implied by a probability: what one unit returns in total if it wins.
 * Reported because "1.6x" is the number a staking decision is actually made on.
 */
export function decimalOdds(probability: number): number | null {
  if (!Number.isFinite(probability) || probability <= 0) return null;
  return Number((1 / probability).toFixed(4));
}

export function toIso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/** "3d 4h", "2h 14m", "45s". Coarse on purpose: two units is all a decision needs. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.abs(Math.trunc(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const units: Array<[string, number]> = [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
  ];
  const parts: string[] = [];
  let rest = seconds;
  for (const [suffix, size] of units) {
    const count = Math.floor(rest / size);
    if (count > 0 || parts.length > 0) {
      if (count > 0) parts.push(`${count}${suffix}`);
      if (parts.length === 2) break;
    }
    rest -= count * size;
  }
  return parts.length > 0 ? parts.join(" ") : `${seconds}s`;
}

/** "in 2h 14m" / "2h 14m ago" / "now". */
export function formatRelative(deltaSeconds: number): string {
  if (Math.abs(deltaSeconds) < 1) return "now";
  return deltaSeconds > 0 ? `in ${formatDuration(deltaSeconds)}` : `${formatDuration(deltaSeconds)} ago`;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isAddress(value: string): boolean {
  return ADDRESS_RE.test(value);
}

/** Addresses are compared and keyed lowercase; the subgraph indexes them that way. */
export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

export function shortAddress(value: string): string {
  const normalized = normalizeAddress(value);
  return isAddress(normalized) ? `${normalized.slice(0, 6)}…${normalized.slice(-4)}` : normalized;
}

/** The zero address is the placeholder in configs until contracts are deployed. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * A fixed-width table. Models read a small aligned table more reliably than the same
 * numbers spread over a paragraph, and it costs fewer tokens than repeating the labels.
 */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length), 0),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}
