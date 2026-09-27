import { describe, expect, it } from 'vitest';

import {
  closeHour,
  currentOrNextSession,
  etParts,
  etToUnix,
  formatEtAsOf,
  formatEtDateTime,
  formatEtDayTime,
  formatEtTime,
  isTradingDay,
  marketClock,
} from '@/lib/et';

const utc = (y: number, m: number, d: number, h = 0, min = 0): number => Date.UTC(y, m - 1, d, h, min) / 1000;

describe('New York time', () => {
  it('converts across the November 1 switch from EDT to EST', () => {
    expect(etToUnix(2026, 9, 28, 9, 30)).toBe(utc(2026, 9, 28, 13, 30));
    expect(etToUnix(2026, 10, 30, 16, 0)).toBe(utc(2026, 10, 30, 20, 0));
    expect(etToUnix(2026, 11, 2, 9, 30)).toBe(utc(2026, 11, 2, 14, 30));
    expect(etParts(utc(2026, 11, 2, 14, 30))).toMatchObject({ year: 2026, month: 11, day: 2, hour: 9, minute: 30, weekday: 1 });
  });

  it('knows the 2026 NYSE closures and early closes', () => {
    expect(isTradingDay(2026, 9, 28)).toBe(true);
    expect(isTradingDay(2026, 9, 27)).toBe(false); // Sunday
    expect(isTradingDay(2026, 11, 26)).toBe(false); // Thanksgiving
    expect(closeHour(2026, 11, 27)).toBe(13);
    expect(closeHour(2026, 11, 30)).toBe(16);
  });

  it('finds the current or next regular session', () => {
    // Sunday afternoon: Monday's session.
    expect(currentOrNextSession(utc(2026, 9, 27, 20, 0))).toEqual({ open: utc(2026, 9, 28, 13, 30), close: utc(2026, 9, 28, 20, 0) });
    // During Monday's session: still Monday's.
    expect(currentOrNextSession(utc(2026, 9, 28, 15, 0)).open).toBe(utc(2026, 9, 28, 13, 30));
    // After Friday's close: Monday's.
    expect(currentOrNextSession(utc(2026, 10, 2, 20, 30)).open).toBe(utc(2026, 10, 5, 13, 30));
    // Thanksgiving: the half day after, closing at 1:00 pm ET.
    expect(currentOrNextSession(utc(2026, 11, 26, 15, 0))).toEqual({ open: utc(2026, 11, 27, 14, 30), close: utc(2026, 11, 27, 18, 0) });
  });

  it('knows when Chainlink stock prices update (Sunday 8 pm to Friday 8 pm ET)', () => {
    expect(marketClock(utc(2026, 9, 26, 15, 0)).feedsUpdating).toBe(false); // Saturday
    expect(marketClock(utc(2026, 9, 27, 23, 30)).feedsUpdating).toBe(false); // Sunday 7:30 pm ET
    expect(marketClock(utc(2026, 9, 28, 0, 30)).feedsUpdating).toBe(true); // Sunday 8:30 pm ET
    expect(marketClock(utc(2026, 10, 2, 23, 30)).feedsUpdating).toBe(true); // Friday 7:30 pm ET
    expect(marketClock(utc(2026, 10, 3, 0, 30)).feedsUpdating).toBe(false); // Friday 8:30 pm ET
    expect(marketClock(utc(2026, 9, 28, 15, 0)).sessionOpen).toBe(true);
    expect(marketClock(utc(2026, 9, 28, 21, 0)).sessionOpen).toBe(false);
  });

  it('formats a price age honestly, the same on server and client', () => {
    const friday = utc(2026, 9, 25, 19, 56); // NVDA's last Friday print
    expect(formatEtTime(friday)).toBe('3:56 pm ET');
    expect(formatEtDayTime(friday)).toBe('Fri 3:56 pm ET');
    expect(formatEtDateTime(friday)).toBe('Fri Sep 25, 3:56 pm ET');
    expect(formatEtAsOf(friday, utc(2026, 9, 26, 12, 0))).toBe('Fri 3:56 pm ET');
    expect(formatEtAsOf(friday, utc(2026, 9, 25, 21, 0))).toBe('3:56 pm ET');
    expect(formatEtTime(utc(2026, 9, 28, 4, 5))).toBe('12:05 am ET');
    expect(formatEtTime(utc(2026, 9, 28, 16, 0))).toBe('12:00 pm ET');
  });
});
