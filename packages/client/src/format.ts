import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { ET_TIME_ZONE } from './calendar.js';

/**
 * Time formatting in America/New_York. Every user-facing time on the venue is ET, and
 * says so ("9:30 am ET").
 */

function et(sec: number): TZDate {
  return new TZDate(sec * 1000, ET_TIME_ZONE);
}

/** date-fns pattern on the ET wall clock of `sec`. */
export function formatEt(sec: number, pattern: string): string {
  return format(et(sec), pattern);
}

/** "9:30 am ET" (minutes always shown). */
export function formatEtTime(sec: number, options: { suffix?: boolean } = {}): string {
  const s = format(et(sec), 'h:mm aaa');
  return options.suffix === false ? s : `${s} ET`;
}

/** "Tue Sep 29" */
export function formatEtDate(sec: number): string {
  return format(et(sec), 'EEE MMM d');
}

/** "Tuesday, September 29" */
export function formatEtDateLong(sec: number): string {
  return format(et(sec), 'EEEE, MMMM d');
}

/** "Tue Sep 29, 9:30 am ET" */
export function formatEtDateTime(sec: number): string {
  return `${formatEtDate(sec)}, ${formatEtTime(sec)}`;
}

/** "Tuesday" */
export function formatEtWeekday(sec: number): string {
  return format(et(sec), 'EEEE');
}

/** ISO-8601 with the ET offset, for machine-readable attributes: "2026-09-29T09:30:00-04:00". */
export function formatEtIso(sec: number): string {
  return format(et(sec), "yyyy-MM-dd'T'HH:mm:ssxxx");
}

/**
 * A duration in words, truncated (never rounded up): 45 → "45 s", 750 → "12 min",
 * 11_100 → "3 h 5 min", 187_200 → "2 d 4 h".
 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d} d` : `${d} d ${h % 24} h`;
}

/** Age of a reading: "updated 12 min ago". */
export function formatAge(updatedAtSec: number, nowSec: number): string {
  return `${formatDuration(nowSec - updatedAtSec)} ago`;
}

/** Countdown clock: "2:05:09" under a day, "3 d 4 h" beyond. "0:00:00" once passed. */
export function formatCountdown(targetSec: number, nowSec: number): string {
  const s = Math.max(0, Math.floor(targetSec - nowSec));
  if (s >= 86_400) return formatDuration(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h}:${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`;
}

/** An age bound in words, for the rules box: 93600 → "26 hours", 3600 → "1 hour", 5400 → "90 minutes". */
export function formatAgeBound(seconds: number): string {
  if (seconds % 3600 === 0) {
    const h = seconds / 3600;
    return `${h} ${h === 1 ? 'hour' : 'hours'}`;
  }
  if (seconds % 60 === 0) {
    const m = seconds / 60;
    return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
  }
  return `${seconds} seconds`;
}
