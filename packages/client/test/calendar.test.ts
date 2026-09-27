import { describe, expect, it } from 'vitest';
import {
  CalendarRangeError,
  NYSE_CALENDAR,
  NotATradingDayError,
  closingBell,
  currentOrNextSession,
  earlyCloseOn,
  etDateOf,
  holidayOn,
  isTradingDay,
  nextSession,
  openingBell,
  previousSession,
  sessionInProgress,
  sessionsBetween,
  sessionsOfWeek,
  weeklyWindow,
} from '../src/index.js';

const utc = (y: number, m: number, d: number, h: number, min = 0) => Date.UTC(y, m - 1, d, h, min) / 1000;

describe('NYSE calendar data', () => {
  it('cites nyse.com and covers 2026 and 2027', () => {
    expect(NYSE_CALENDAR.source).toBe('https://www.nyse.com/markets/hours-calendars');
    expect(Object.keys(NYSE_CALENDAR.years)).toEqual(['2026', '2027']);
  });

  it('has the 2026 holidays and early closes of docs/spec/04', () => {
    const h = NYSE_CALENDAR.years['2026']!.holidays.map((x) => x.date);
    expect(h).toEqual([
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
      '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    ]);
    expect(NYSE_CALENDAR.years['2026']!.earlyCloses.map((x) => x.date)).toEqual(['2026-11-27', '2026-12-24']);
  });

  it('has the 2027 holidays (observed dates) and the single early close', () => {
    const h = NYSE_CALENDAR.years['2027']!.holidays.map((x) => x.date);
    expect(h).toEqual([
      '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
      '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
    ]);
    expect(NYSE_CALENDAR.years['2027']!.earlyCloses.map((x) => x.date)).toEqual(['2027-11-26']);
  });
});

describe('sessions', () => {
  it('build week: 13:30 → 20:00 UTC (EDT)', () => {
    for (const d of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']) expect(isTradingDay(d)).toBe(true);
    expect(openingBell('2026-09-28')).toBe(utc(2026, 9, 28, 13, 30));
    expect(closingBell('2026-10-02')).toBe(utc(2026, 10, 2, 20));
  });

  it('weekends and holidays are not sessions', () => {
    expect(isTradingDay('2026-10-03')).toBe(false);
    expect(isTradingDay('2026-10-04')).toBe(false);
    expect(isTradingDay('2026-11-26')).toBe(false);
    expect(holidayOn('2026-11-26')).toBe('Thanksgiving Day');
    expect(() => openingBell('2026-11-26')).toThrow(NotATradingDayError);
  });

  it('early close at 13:00 ET (EST after Nov 1)', () => {
    expect(earlyCloseOn('2026-11-27')).toBe('13:00');
    expect(closingBell('2026-11-27')).toBe(utc(2026, 11, 27, 18));
    expect(closingBell('2026-12-24')).toBe(utc(2026, 12, 24, 18));
    expect(closingBell('2027-11-26')).toBe(utc(2027, 11, 26, 18));
  });

  it('DST boundary Sun 2026-11-01: EDT Friday, EST Monday', () => {
    expect(openingBell('2026-10-30')).toBe(utc(2026, 10, 30, 13, 30));
    expect(closingBell('2026-10-30')).toBe(utc(2026, 10, 30, 20));
    expect(openingBell('2026-11-02')).toBe(utc(2026, 11, 2, 14, 30));
    expect(closingBell('2026-11-02')).toBe(utc(2026, 11, 2, 21));
    // and back to EDT on Sun 2027-03-14
    expect(openingBell('2027-03-12')).toBe(utc(2027, 3, 12, 14, 30));
    expect(openingBell('2027-03-15')).toBe(utc(2027, 3, 15, 13, 30));
  });

  it('ET dates of UTC instants', () => {
    expect(etDateOf(utc(2026, 9, 29, 3))).toBe('2026-09-28'); // 23:00 ET Monday
    expect(etDateOf(utc(2026, 11, 3, 4, 30))).toBe('2026-11-02'); // 23:30 EST
  });

  it('refuses years it does not know rather than guessing', () => {
    expect(() => isTradingDay('2028-01-03')).toThrow(CalendarRangeError);
    expect(() => isTradingDay('2025-12-31')).toThrow(CalendarRangeError);
  });
});

describe('session navigation', () => {
  it('nextSession is the first session whose open is after now', () => {
    expect(nextSession(utc(2026, 9, 27, 20)).date).toBe('2026-09-28'); // Sunday
    expect(nextSession(utc(2026, 9, 28, 15)).date).toBe('2026-09-29'); // mid-session Monday
    expect(nextSession(utc(2026, 11, 25, 22)).date).toBe('2026-11-27'); // skips Thanksgiving
    expect(nextSession(utc(2026, 7, 2, 21)).date).toBe('2026-07-06'); // skips Jul 3 and the weekend
  });

  it('currentOrNextSession / sessionInProgress / previousSession', () => {
    expect(currentOrNextSession(utc(2026, 9, 28, 15)).date).toBe('2026-09-28');
    expect(sessionInProgress(utc(2026, 9, 28, 15))?.date).toBe('2026-09-28');
    expect(sessionInProgress(utc(2026, 9, 28, 21))).toBeNull();
    expect(previousSession(utc(2026, 9, 28, 15)).date).toBe('2026-09-25');
    expect(previousSession(utc(2026, 9, 28, 20)).date).toBe('2026-09-28');
  });

  it('weekly window: first open → last close, holidays and early closes respected', () => {
    const build = weeklyWindow('2026-09-30')!;
    expect(build.strikeDate).toBe('2026-09-28');
    expect(build.finalDate).toBe('2026-10-02');
    expect(build.strikeTime).toBe(utc(2026, 9, 28, 13, 30));
    expect(build.finalTime).toBe(utc(2026, 10, 2, 20));
    const thanksgiving = weeklyWindow('2026-11-23')!;
    expect(thanksgiving.sessions.map((s) => s.date)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27']);
    expect(thanksgiving.finalTime).toBe(utc(2026, 11, 27, 18));
    const july = weeklyWindow('2026-07-01')!;
    expect(july.finalDate).toBe('2026-07-02');
    expect(sessionsOfWeek('2026-09-07').map((s) => s.date)).toEqual(['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']);
  });

  it('sessionsBetween', () => {
    expect(sessionsBetween(utc(2026, 9, 28, 0), utc(2026, 10, 3, 0)).length).toBe(5);
  });
});
