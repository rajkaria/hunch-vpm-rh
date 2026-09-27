import { describe, expect, it } from 'vitest';
import {
  closingBell,
  formatAge,
  formatAgeBound,
  formatBps,
  formatCountdown,
  formatDuration,
  formatEtDate,
  formatEtDateTime,
  formatEtTime,
  formatMultiple,
  formatPercent,
  formatPrice,
  formatPriceExact,
  formatUnitsExact,
  formatUsdg,
  formatUsdgWithUnit,
  openingBell,
  parseUsdg,
  parseUsdgInput,
  priceChange,
  usdg,
} from '../src/index.js';

describe('USDG amounts', () => {
  it('parses exactly and refuses sub-micro precision', () => {
    expect(parseUsdg('12.5')).toBe(12_500_000n);
    expect(parseUsdg('0.000001')).toBe(1n);
    expect(parseUsdg('.5')).toBe(500_000n);
    expect(() => parseUsdg('1.0000001')).toThrow();
    expect(() => parseUsdg('-1')).toThrow();
    expect(() => parseUsdg('abc')).toThrow();
  });

  it('lenient input parsing for the amount box', () => {
    expect(parseUsdgInput(' 1,000.25 USDG ')).toEqual({ ok: true, amount: 1_000_250_000n });
    expect(parseUsdgInput('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseUsdgInput('1.2345678')).toEqual({ ok: false, reason: 'too-many-decimals' });
    expect(parseUsdgInput('0')).toEqual({ ok: false, reason: 'zero' });
    expect(parseUsdgInput('1e3')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('formats to the cent, floored, grouped', () => {
    expect(formatUsdg(69_166_666n)).toBe('69.16');
    expect(formatUsdg(69_169_999n)).toBe('69.16');
    expect(formatUsdg(1_234_567_890_000n)).toBe('1,234,567.89');
    expect(formatUsdg(0n)).toBe('0.00');
    expect(formatUsdg(5n)).toBe('0.00');
    expect(formatUsdg(69_166_666n, { decimals: 6 })).toBe('69.166666');
    expect(formatUsdgWithUnit(usdg(10))).toBe('10.00 USDG');
    expect(formatUnitsExact(1_500_000n, 6)).toBe('1.5');
  });
});

describe('prices and ratios', () => {
  it('prices are 8-decimal Chainlink answers', () => {
    expect(formatPrice(22_566_018_707n)).toBe('225.66');
    expect(formatPriceExact(22_566_018_707n)).toBe('225.66018707');
    expect(formatPrice(22_566_018_707n, { decimals: 4 })).toBe('225.6601');
  });

  it('multiples floor, 2–3 decimals', () => {
    expect(formatMultiple(56_250_000n, 50_000_000n)).toBe('1.125×');
    expect(formatMultiple(69_166_666n, 20_000_000n)).toBe('3.458×');
    expect(formatMultiple(69_166_666n, 20_000_000n, { maxDecimals: 2 })).toBe('3.45×');
    expect(formatMultiple(20n, 20n)).toBe('1.00×');
    expect(formatMultiple(1n, 0n)).toBeNull();
  });

  it('percent, bps, change vs strike', () => {
    expect(formatPercent(1n, 3n)).toBe('33.3%');
    expect(formatBps(200)).toBe('2%');
    expect(formatBps(250)).toBe('2.5%');
    expect(priceChange(100_00000000n, 101_23000000n)).toEqual({ direction: 'UP', bps: 123, text: '+1.23%' });
    expect(priceChange(100_00000000n, 99_60000000n)).toEqual({ direction: 'DOWN', bps: -40, text: '-0.40%' });
    expect(priceChange(100_00000000n, 100_00000000n)?.direction).toBe('FLAT');
    expect(priceChange(0n, 1n)).toBeNull();
  });
});

describe('ET time formatting', () => {
  it('bells read in ET', () => {
    expect(formatEtTime(openingBell('2026-09-29'))).toBe('9:30 am ET');
    expect(formatEtTime(closingBell('2026-11-27'))).toBe('1:00 pm ET');
    expect(formatEtDate(openingBell('2026-09-29'))).toBe('Tue Sep 29');
    expect(formatEtDateTime(closingBell('2026-11-02'))).toBe('Mon Nov 2, 4:00 pm ET');
  });

  it('durations truncate, never round up', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(750)).toBe('12 min');
    expect(formatDuration(11_100)).toBe('3 h 5 min');
    expect(formatDuration(187_200)).toBe('2 d 4 h');
    expect(formatAge(100, 820)).toBe('12 min ago');
    expect(formatCountdown(7509, 0)).toBe('2:05:09');
    expect(formatCountdown(0, 10)).toBe('0:00:00');
    expect(formatAgeBound(93_600)).toBe('26 hours');
    expect(formatAgeBound(3600)).toBe('1 hour');
  });
});
