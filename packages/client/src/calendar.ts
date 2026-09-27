import { TZDate } from '@date-fns/tz';
import nyse from './calendar/nyse.json' with { type: 'json' };

/**
 * NYSE sessions in America/New_York, computed with an IANA time-zone library (never a
 * fixed offset): EDT (UTC−4) until Sun 2026-11-01 02:00 ET, EST (UTC−5) after.
 *
 * Dates are ET calendar dates as `YYYY-MM-DD` strings; times are unix seconds. The
 * holiday data (`calendar/nyse.json`) covers only the years read from nyse.com; asking
 * about any other year throws `CalendarRangeError` instead of guessing, so a keeper
 * can never list a market on an unknown holiday.
 */

export const ET_TIME_ZONE = 'America/New_York';
export type EtDate = string;

export interface CalendarEntry {
  date: EtDate;
  name: string;
  close?: string;
}

interface CalendarData {
  exchange: string;
  timezone: string;
  source: string;
  checked: string;
  sessions: { open: string; close: string; earlyClose: string };
  years: Record<string, { holidays: CalendarEntry[]; earlyCloses: CalendarEntry[] }>;
}

/** The raw calendar data (source URL, check date, holidays and early closes per year). */
export const NYSE_CALENDAR: CalendarData = nyse as CalendarData;

export class CalendarRangeError extends Error {
  constructor(date: string) {
    super(`the NYSE calendar does not cover ${date.slice(0, 4)} (covered: ${coveredYears().join(', ')})`);
    this.name = 'CalendarRangeError';
  }
}

export class NotATradingDayError extends Error {
  constructor(date: string) {
    super(`${date} is not an NYSE trading day`);
    this.name = 'NotATradingDayError';
  }
}

const HOLIDAYS = new Map<string, string>();
const EARLY = new Map<string, string>();
for (const year of Object.values(NYSE_CALENDAR.years)) {
  for (const h of year.holidays) HOLIDAYS.set(h.date, h.name);
  for (const e of year.earlyCloses) EARLY.set(e.date, e.close ?? NYSE_CALENDAR.sessions.earlyClose);
}

export function coveredYears(): number[] {
  return Object.keys(NYSE_CALENDAR.years)
    .map(Number)
    .sort((a, b) => a - b);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date: EtDate): [number, number, number] {
  const m = DATE_RE.exec(date);
  if (m === null) throw new RangeError(`not a YYYY-MM-DD date: ${JSON.stringify(date)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function pad(n: number, w = 2): string {
  return n.toString().padStart(w, '0');
}

/** Whether the holiday data covers `date`'s year. */
export function isCovered(date: EtDate): boolean {
  return Object.prototype.hasOwnProperty.call(NYSE_CALENDAR.years, date.slice(0, 4));
}

function assertCovered(date: EtDate): void {
  parts(date);
  if (!isCovered(date)) throw new CalendarRangeError(date);
}

/** The ET calendar date of a unix time. */
export function etDateOf(sec: number): EtDate {
  const t = new TZDate(sec * 1000, ET_TIME_ZONE);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** Unix seconds of `hh:mm` ET on `date` (DST-correct). */
export function etTimeOn(date: EtDate, hhmm: string): number {
  const [y, mo, d] = parts(date);
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (m === null) throw new RangeError(`not HH:MM: ${hhmm}`);
  const t = new TZDate(y, mo - 1, d, Number(m[1]), Number(m[2]), 0, ET_TIME_ZONE);
  return Math.floor(t.getTime() / 1000);
}

/** `date` plus `days` calendar days. */
export function addDays(date: EtDate, days: number): EtDate {
  const [y, mo, d] = parts(date);
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: EtDate): number {
  const [y, mo, d] = parts(date);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

export function isWeekend(date: EtDate): boolean {
  const w = weekdayOf(date);
  return w === 0 || w === 6;
}

/** The holiday name, or null. Throws for an uncovered year. */
export function holidayOn(date: EtDate): string | null {
  assertCovered(date);
  return HOLIDAYS.get(date) ?? null;
}

/** The early close time ("13:00"), or null. Throws for an uncovered year. */
export function earlyCloseOn(date: EtDate): string | null {
  assertCovered(date);
  return EARLY.get(date) ?? null;
}

/** A weekday that is not an NYSE holiday. Throws `CalendarRangeError` for an uncovered year. */
export function isTradingDay(date: EtDate): boolean {
  assertCovered(date);
  return !isWeekend(date) && !HOLIDAYS.has(date);
}

/** 09:30 ET on a trading day, unix seconds. */
export function openingBell(date: EtDate): number {
  if (!isTradingDay(date)) throw new NotATradingDayError(date);
  return etTimeOn(date, NYSE_CALENDAR.sessions.open);
}

/** 16:00 ET (13:00 on early-close days) on a trading day, unix seconds. */
export function closingBell(date: EtDate): number {
  if (!isTradingDay(date)) throw new NotATradingDayError(date);
  return etTimeOn(date, EARLY.get(date) ?? NYSE_CALENDAR.sessions.close);
}

export interface Session {
  date: EtDate;
  /** Opening bell, unix seconds. */
  open: number;
  /** Closing bell, unix seconds. */
  close: number;
  earlyClose: boolean;
}

/** The session on `date`, or null if it is not a trading day. */
export function sessionOn(date: EtDate): Session | null {
  if (!isTradingDay(date)) return null;
  return { date, open: openingBell(date), close: closingBell(date), earlyClose: EARLY.has(date) };
}

const SEARCH_DAYS = 21;

/** The first session whose opening bell is strictly after `nowSec`. */
export function nextSession(nowSec: number): Session {
  let date = etDateOf(nowSec);
  for (let i = 0; i <= SEARCH_DAYS; i++, date = addDays(date, 1)) {
    const s = sessionOn(date);
    if (s !== null && s.open > nowSec) return s;
  }
  throw new Error(`no session within ${SEARCH_DAYS} days of ${nowSec}`);
}

/** The session in progress at `nowSec` (open ≤ now < close), else the next one. */
export function currentOrNextSession(nowSec: number): Session {
  let date = etDateOf(nowSec);
  for (let i = 0; i <= SEARCH_DAYS; i++, date = addDays(date, 1)) {
    const s = sessionOn(date);
    if (s !== null && s.close > nowSec) return s;
  }
  throw new Error(`no session within ${SEARCH_DAYS} days of ${nowSec}`);
}

/** The session in progress at `nowSec`, or null. */
export function sessionInProgress(nowSec: number): Session | null {
  const s = sessionOn(etDateOf(nowSec));
  return s !== null && s.open <= nowSec && nowSec < s.close ? s : null;
}

/** The last session whose closing bell is at or before `nowSec`. */
export function previousSession(nowSec: number): Session {
  let date = etDateOf(nowSec);
  for (let i = 0; i <= SEARCH_DAYS; i++, date = addDays(date, -1)) {
    const s = sessionOn(date);
    if (s !== null && s.close <= nowSec) return s;
  }
  throw new Error(`no session within ${SEARCH_DAYS} days before ${nowSec}`);
}

/** Monday of the Mon–Sun week containing `date`. */
export function weekStartOf(date: EtDate): EtDate {
  const w = weekdayOf(date);
  return addDays(date, w === 0 ? -6 : 1 - w);
}

/** The trading sessions (Mon–Fri) of the week containing `date`, in order. */
export function sessionsOfWeek(date: EtDate): Session[] {
  const monday = weekStartOf(date);
  const out: Session[] = [];
  for (let i = 0; i < 5; i++) {
    const s = sessionOn(addDays(monday, i));
    if (s !== null) out.push(s);
  }
  return out;
}

export interface WeeklyWindow {
  weekOf: EtDate;
  sessions: Session[];
  /** Opening bell of the week's first session. */
  strikeTime: number;
  /** Closing bell of the week's last session. */
  finalTime: number;
  strikeDate: EtDate;
  finalDate: EtDate;
}

/** First session's open → last session's close of the week containing `date`; null for a week with no sessions. */
export function weeklyWindow(date: EtDate): WeeklyWindow | null {
  const sessions = sessionsOfWeek(date);
  const first = sessions[0];
  const last = sessions[sessions.length - 1];
  if (first === undefined || last === undefined) return null;
  return {
    weekOf: weekStartOf(date),
    sessions,
    strikeTime: first.open,
    finalTime: last.close,
    strikeDate: first.date,
    finalDate: last.date,
  };
}

/** Sessions with `fromSec < open` and `close <= toSec`… more precisely: every session overlapping [fromSec, toSec]. */
export function sessionsBetween(fromSec: number, toSec: number): Session[] {
  const out: Session[] = [];
  let date = etDateOf(fromSec);
  const last = etDateOf(toSec);
  for (let i = 0; i < 400 && date <= last; i++, date = addDays(date, 1)) {
    const s = sessionOn(date);
    if (s !== null && s.close > fromSec && s.open < toSec) out.push(s);
  }
  return out;
}
