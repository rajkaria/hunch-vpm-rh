/**
 * New York time, computed the same way on the server and in the browser.
 *
 * Market times are defined in America/New_York (docs/spec/04-markets-and-resolution.md).
 * Every string here is assembled by hand from `formatToParts` rather than taken whole from
 * `Intl.DateTimeFormat#format`, because ICU versions disagree on details such as the narrow
 * no-break space before "PM", and a server string that differs from the browser's by one
 * invisible character is a hydration error.
 *
 * Sessions and holidays come from `@hunch-rh/client`'s NYSE calendar; this module only adds the
 * hydration-safe formatting and the numeric wrappers the components use.
 */

import {
  CalendarRangeError,
  addDays,
  currentOrNextSession as clientCurrentOrNextSession,
  earlyCloseOn,
  etDateOf,
  etTimeOn,
  holidayOn,
  isCovered,
  isTradingDay as clientIsTradingDay,
  isWeekend,
  nextSession,
} from '@hunch-rh/client';

const ZONE = 'America/New_York';

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
  weekday: 'short',
});

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export interface EtParts {
  year: number;
  month: number; // 1-12
  day: number;
  weekday: number; // 0 = Sunday
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of a unix time in New York. */
export function etParts(unixSeconds: number): EtParts {
  const parts = PARTS.formatToParts(new Date(unixSeconds * 1000));
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '0';
  const weekdayText = get('weekday');
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: Math.max(0, WEEKDAYS.indexOf(weekdayText as (typeof WEEKDAYS)[number])),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

/** Unix seconds of a New York wall-clock time. Correct across the DST switches. */
export function etToUnix(year: number, month: number, day: number, hour = 0, minute = 0): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  // New York is UTC-4 or UTC-5. Guess -5, read back the wall clock, correct by the difference.
  let guess = naive + 5 * 3600;
  for (let i = 0; i < 2; i += 1) {
    const wall = etParts(guess);
    const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) / 1000;
    guess += naive - wallAsUtc;
  }
  return guess;
}

function key(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The NYSE calendar is `@hunch-rh/client`'s (read from nyse.com, shared with the keeper, so the
 * site and the keeper never disagree about a holiday). For a year the calendar does not cover
 * the site falls back to "every weekday, 9:30 to 4:00" for display only; the keeper refuses to
 * list anything there.
 */
function covered(date: string): boolean {
  return isCovered(date);
}

export function isTradingDay(year: number, month: number, day: number): boolean {
  const date = key(year, month, day);
  if (!covered(date)) return !isWeekend(date);
  return clientIsTradingDay(date);
}

export function closeHour(year: number, month: number, day: number): 13 | 16 {
  const date = key(year, month, day);
  if (!covered(date)) return 16;
  return earlyCloseOn(date) === null ? 16 : 13;
}

export interface Session {
  open: number;
  close: number;
}

function fallbackSession(now: number): Session {
  let date = etDateOf(now);
  for (let offset = 0; offset < 15; offset += 1, date = addDays(date, 1)) {
    if (isWeekend(date)) continue;
    const open = etTimeOn(date, '09:30');
    const close = etTimeOn(date, '16:00');
    if (now < close) return { open, close };
  }
  const tomorrow = addDays(etDateOf(now), 1);
  return { open: etTimeOn(tomorrow, '09:30'), close: etTimeOn(tomorrow, '16:00') };
}

/** The regular session that is in progress at `now`, or the next one to start. */
export function currentOrNextSession(now: number): Session {
  try {
    const session = clientCurrentOrNextSession(now);
    return { open: session.open, close: session.close };
  } catch (error) {
    if (error instanceof CalendarRangeError) return fallbackSession(now);
    throw error;
  }
}

/** The first session whose opening bell is strictly after `now`. */
export function nextOpeningBell(now: number): Session {
  try {
    const session = nextSession(now);
    return { open: session.open, close: session.close };
  } catch (error) {
    if (error instanceof CalendarRangeError) return fallbackSession(now + 1);
    throw error;
  }
}

export interface MarketClock {
  /** The US regular session (9:30 to the closing bell) is in progress. */
  sessionOpen: boolean;
  session: Session;
  /**
   * Chainlink's US equity feeds update Sunday 8 pm to Friday 8 pm ET, except US market
   * holidays. Outside that window a price does not move, and its age says so.
   */
  feedsUpdating: boolean;
}

export function marketClock(now: number): MarketClock {
  const session = currentOrNextSession(now);
  const sessionOpen = now >= session.open && now < session.close;
  const et = etParts(now);
  const minutes = et.hour * 60 + et.minute;
  let feedsUpdating: boolean;
  if (et.weekday === 6) feedsUpdating = false;
  else if (et.weekday === 0) feedsUpdating = minutes >= 20 * 60;
  else if (et.weekday === 5) feedsUpdating = minutes < 20 * 60;
  else feedsUpdating = true;
  const today = key(et.year, et.month, et.day);
  if (feedsUpdating && et.weekday !== 0 && covered(today) && holidayOn(today) !== null) feedsUpdating = false;
  return { sessionOpen, session, feedsUpdating };
}

function clock(parts: EtParts): string {
  const hour12 = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
  const suffix = parts.hour < 12 ? 'am' : 'pm';
  return `${hour12}:${String(parts.minute).padStart(2, '0')} ${suffix}`;
}

/** "3:56 pm ET" */
export function formatEtTime(unixSeconds: number): string {
  return `${clock(etParts(unixSeconds))} ET`;
}

/** "Fri 3:56 pm ET" */
export function formatEtDayTime(unixSeconds: number): string {
  const parts = etParts(unixSeconds);
  return `${WEEKDAYS[parts.weekday]} ${clock(parts)} ET`;
}

/** "Fri Sep 25, 3:56 pm ET" */
export function formatEtDateTime(unixSeconds: number): string {
  const parts = etParts(unixSeconds);
  return `${WEEKDAYS[parts.weekday]} ${MONTHS[parts.month - 1]} ${parts.day}, ${clock(parts)} ET`;
}

/** "Fri Sep 25" */
export function formatEtDate(unixSeconds: number): string {
  const parts = etParts(unixSeconds);
  return `${WEEKDAYS[parts.weekday]} ${MONTHS[parts.month - 1]} ${parts.day}`;
}

/**
 * How a price's time reads next to it: the clock time if it is from today (New York),
 * the weekday if it is from this week, the date otherwise.
 */
export function formatEtAsOf(unixSeconds: number, now: number): string {
  const then = etParts(unixSeconds);
  const today = etParts(now);
  const sameDay = then.year === today.year && then.month === today.month && then.day === today.day;
  if (sameDay) return formatEtTime(unixSeconds);
  if (now - unixSeconds < 6 * 86_400) return formatEtDayTime(unixSeconds);
  return formatEtDateTime(unixSeconds);
}
