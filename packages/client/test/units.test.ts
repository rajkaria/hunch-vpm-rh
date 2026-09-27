import { describe, expect, it } from 'vitest';
import {
  formatPrice,
  formatUnitsExact,
  formatUsdc,
  parseUnitsExact,
  parseUsdc,
  ppmToPercent,
  shareToPpm,
} from '../src/units.js';

describe('formatUsdc', () => {
  it('formats without losing digits', () => {
    expect(formatUsdc(107_000000n)).toBe('107');
    expect(formatUsdc(1_500000n)).toBe('1.5');
    expect(formatUsdc(1n)).toBe('0.000001');
    expect(formatUsdc(0n)).toBe('0');
  });

  it('pads the fraction on request', () => {
    expect(formatUsdc(1_500000n, { trailingZeros: true })).toBe('1.500000');
    expect(formatUsdc(107_000000n, { trailingZeros: true })).toBe('107.000000');
  });

  it('stays exact past the float boundary', () => {
    // 10 billion USDC is 1e16 smallest-units, past 2^53. A number round-trip
    // would round this; the string must not.
    const huge = 10_000_000_000_000001n;
    expect(formatUsdc(huge)).toBe('10000000000.000001');
    expect(parseUsdc(formatUsdc(huge))).toBe(huge);
  });

  it('handles negatives', () => {
    expect(formatUsdc(-1_500000n)).toBe('-1.5');
    expect(parseUsdc('-1.5')).toBe(-1_500000n);
  });
});

describe('parseUsdc', () => {
  it('parses whole and fractional amounts', () => {
    expect(parseUsdc('107')).toBe(107_000000n);
    expect(parseUsdc('0.000001')).toBe(1n);
    expect(parseUsdc('1.5')).toBe(1_500000n);
  });

  it('refuses to silently truncate', () => {
    expect(() => parseUsdc('1.0000005')).toThrow(/more than 6 decimal places/);
  });

  it('refuses junk', () => {
    expect(() => parseUsdc('')).toThrow(/not a decimal amount/);
    expect(() => parseUsdc('1e6')).toThrow(/not a decimal amount/);
    expect(() => parseUsdc('0x10')).toThrow(/not a decimal amount/);
  });
});

describe('formatUnitsExact', () => {
  it('handles zero decimals', () => {
    expect(formatUnitsExact(42n, 0)).toBe('42');
    expect(parseUnitsExact('42', 0)).toBe(42n);
  });

  it('rejects an impossible precision', () => {
    expect(() => formatUnitsExact(1n, -1)).toThrow(RangeError);
    expect(() => parseUnitsExact('1', 99)).toThrow(RangeError);
  });
});

describe('shareToPpm', () => {
  it('floors', () => {
    expect(shareToPpm(6_000000n, 107_000000n)).toBe(56_074n);
    expect(shareToPpm(101_000000n, 107_000000n)).toBe(943_925n);
  });

  it('guards a zero denominator instead of throwing', () => {
    expect(shareToPpm(0n, 0n)).toBe(0n);
    expect(shareToPpm(5n, 0n)).toBe(0n);
  });
});

describe('ppmToPercent', () => {
  it('reads as a percent with four places', () => {
    expect(ppmToPercent(56_074n)).toBe('5.6074');
    expect(ppmToPercent(1_000_000n)).toBe('100.0000');
    expect(ppmToPercent(0n)).toBe('0.0000');
  });
});

describe('formatPrice', () => {
  it('reads a feed strike at 8 decimals', () => {
    expect(formatPrice(300_000000000n)).toBe('3000');
    expect(formatPrice(-1_00000000n)).toBe('-1');
  });
});
