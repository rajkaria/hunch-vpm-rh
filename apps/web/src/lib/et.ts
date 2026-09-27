/**
 * New York time, computed the same way on the server and in the browser.
 *
 * Market times are defined in America/New_York (docs/spec/04-markets-and-resolution.md).
 * Every string here is assembled by hand from `formatToParts` rather than taken whole from
 * `Intl.DateTimeFormat#format`, because ICU versions disagree on details such as the narrow
 * no-break space before "PM", and a server string that differs from the browser's by one
 * invisible character is a hydration error.
 *
 * S7: replace the calendar below with the NYSE calendar in @hunch-rh/client / @hunch-rh/keeper
 * (packages/keeper/calendar/nyse-2026.json) so the site and the keeper share one source.
 */

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

/** NYSE full-day closures, 2026 (docs/spec/04-markets-and-resolution.md). */
const HOLIDAYS = new Set([
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
]);

/** NYSE early closes (13:00 ET), 2026. */
const EARLY_CLOSES = new Set(['2026-11-27', '2026-12-24']);

export function isTradingDay(year: number, month: number, day: number): boolean {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !HOLIDAYS.has(key(year, month, day));
}

export function closeHour(year: number, month: number, day: number): 13 | 16 {
  return EARLY_CLOSES.has(key(year, month, day)) ? 13 : 16;
}

function addDays(year: number, month: number, day: number, days: number): [number, number, number] {
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
}

export interface Session {
  open: number;
  close: number;
}

/** The regular session that is in progress at `now`, or the next one to start. */
export function currentOrNextSession(now: number): Session {
  const today = etParts(now);
  for (let offset = 0; offset < 15; offset += 1) {
    const [y, m, d] = addDays(today.year, today.month, today.day, offset);
    if (!isTradingDay(y, m, d)) continue;
    const open = etToUnix(y, m, d, 9, 30);
    const close = etToUnix(y, m, d, closeHour(y, m, d), 0);
    if (now < close) return { open, close };
  }
  // Unreachable with a sane calendar; fall back to "tomorrow 9:30".
  const [y, m, d] = addDays(today.year, today.month, today.day, 1);
  return { open: etToUnix(y, m, d, 9, 30), close: etToUnix(y, m, d, 16, 0) };
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
  if (feedsUpdating && et.weekday !== 0 && HOLIDAYS.has(key(et.year, et.month, et.day))) feedsUpdating = false;
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
