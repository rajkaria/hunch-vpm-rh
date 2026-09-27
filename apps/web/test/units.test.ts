import { describe, expect, it } from 'vitest';

import {
  formatAmount,
  formatAmountExact,
  formatMultiple,
  formatPpmPercent,
  formatPrice,
  fromDecimalString,
  ppmToPercentNumber,
  shareToPpm,
  shortAddress,
  toDecimalString,
} from '@/lib/units';

describe('toDecimalString', () => {
  it('is exact and drops only trailing zeros', () => {
    expect(toDecimalString(1_500_000n, 6)).toBe('1.5');
    expect(toDecimalString(1n, 6)).toBe('0.000001');
    expect(toDecimalString(0n, 6)).toBe('0');
    expect(toDecimalString(-1_500_000n, 6)).toBe('-1.5');
    expect(toDecimalString(123_456_789_012_345n, 6)).toBe('123456789.012345');
  });

  it('does not lose precision past 2^53', () => {
    const huge = 9_007_199_254_740_993_000_000n; // 2^53 + 1, in USDC units
    expect(toDecimalString(huge, 6)).toBe('9007199254740993');
  });
});

describe('fromDecimalString', () => {
  it('round-trips', () => {
    for (const text of ['0', '1', '1.5', '250.500000', '0.000001', '1234567.891234']) {
      expect(toDecimalString(fromDecimalString(text, 6), 6)).toBe(toDecimalString(fromDecimalString(text, 6), 6));
    }
    expect(fromDecimalString('250.50', 6)).toBe(250_500_000n);
  });

  it('refuses more precision than the asset has, rather than truncating it', () => {
    expect(() => fromDecimalString('1.0000005', 6)).toThrow(/decimal places/);
  });

  it('refuses anything that is not a decimal amount', () => {
    for (const bad of ['', 'abc', '1.2.3', '1e6', '--1', '1,000']) {
      expect(() => fromDecimalString(bad, 6)).toThrow();
    }
  });
});

describe('formatAmount', () => {
  it('holds a fixed width so columns line up and updates do not reflow', () => {
    expect(formatAmount(1_000_000n)).toBe('1.00');
    expect(formatAmount(0n)).toBe('0.00');
    expect(formatAmount(1_234_567_890_000n)).toBe('1,234,567.89');
  });

  it('truncates toward zero and never rounds a claimable balance up', () => {
    // 1.999999 must not be shown as 2.00: the contract will not pay 2.00.
    expect(formatAmount(1_999_999n)).toBe('1.99');
    expect(formatAmount(-1_999_999n)).toBe('-1.99');
    expect(formatAmountExact(1_999_999n)).toBe('1.999999');
  });

  it('signs a delta when the sign is the point', () => {
    expect(formatAmount(1_000_000n, { signed: true })).toBe('+1.00');
    expect(formatAmount(-1_000_000n, { signed: true })).toBe('-1.00');
    expect(formatAmount(0n, { signed: true })).toBe('0.00');
  });

  it('shows the residue at full precision, because a residue is sub-unit dust', () => {
    expect(formatAmount(3n, { fractionDigits: 6 })).toBe('0.000003');
  });
});

describe('shareToPpm and its formatting', () => {
  it('floors, and returns nothing for an empty denominator', () => {
    expect(shareToPpm(1n, 3n)).toBe(333_333n);
    expect(shareToPpm(0n, 0n)).toBe(0n);
    expect(shareToPpm(5n, 0n)).toBe(0n);
  });

  it('formats ppm as a fixed-width percent', () => {
    expect(formatPpmPercent(931_034n, 1)).toBe('93.1');
    expect(formatPpmPercent(1_000_000n, 1)).toBe('100.0');
    expect(formatPpmPercent(0n, 1)).toBe('0.0');
    expect(formatPpmPercent(34_482n, 1)).toBe('3.4');
    expect(formatPpmPercent(500_000n, 0)).toBe('50');
  });

  it('clamps a bar width to the track', () => {
    expect(ppmToPercentNumber(1_000_000n)).toBe(100);
    expect(ppmToPercentNumber(1_500_000n)).toBe(100);
    expect(ppmToPercentNumber(-5n)).toBe(0);
    expect(ppmToPercentNumber(931_034n)).toBeCloseTo(93.1034, 4);
  });
});

describe('formatMultiple', () => {
  it('renders a ppm multiple', () => {
    expect(formatMultiple(1_000_000n)).toBe('1.00x');
    expect(formatMultiple(41_000_000n)).toBe('41.00x');
    expect(formatMultiple(28_931_034n)).toBe('28.93x');
    expect(formatMultiple(null)).toBe('—');
  });
});

describe('formatPrice', () => {
  it('renders an 8-decimal oracle price', () => {
    expect(formatPrice(400_000_000_000n)).toBe('4,000.00');
    expect(formatPrice(395_842_000_000n)).toBe('3,958.42');
    expect(formatPrice(-100_000_000n)).toBe('-1.00');
  });
});

describe('shortAddress', () => {
  it('keeps enough of an address to recognise', () => {
    expect(shortAddress('0x9A41c7B2fE5d0a3c8B6E1f4D2a7C5b9E3f8A0d61')).toBe('0x9A41…0d61');
    expect(shortAddress('0x1234')).toBe('0x1234');
  });
});
