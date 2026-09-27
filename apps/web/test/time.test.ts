import { describe, expect, it } from 'vitest';

import { formatDuration } from '@/lib/time';

describe('formatDuration', () => {
  it('is exact, because a staleness bound decides whether a market settles or voids', () => {
    // The Arc testnet markets use 5400 s. It used to render as "2h".
    expect(formatDuration(5400)).toBe('1h 30m');
    expect(formatDuration(5400n)).toBe('1h 30m');
    expect(formatDuration(90_000)).toBe('1d 1h');
    expect(formatDuration(90_061)).toBe('1d 1h 1m 1s');
  });

  it('keeps round values short', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(300)).toBe('5m');
    expect(formatDuration(3_600)).toBe('1h');
    expect(formatDuration(7_200)).toBe('2h');
    expect(formatDuration(259_200)).toBe('3d');
  });

  it('reads nothing as zero', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
  });
});
