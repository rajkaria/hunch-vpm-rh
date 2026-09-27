/**
 * Time formatting that produces the same string on the server and in the
 * browser.
 *
 * Anything derived from the viewer's locale or timezone renders differently in
 * the two places and React tears the tree down to fix it, which is a visible
 * flash on every page that shows a deadline. Everything here is UTC and
 * explicit; the only clock-dependent value is the countdown, and that is a
 * client component that starts from a server-rendered number.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function pad(value: number, width = 2): string {
  return value.toString().padStart(width, '0');
}

/** Unix seconds -> "12 Sep 2026 14:30 UTC". */
export function formatUtc(unixSeconds: bigint | number): string {
  const date = new Date(Number(unixSeconds) * 1000);
  const month = MONTHS[date.getUTCMonth()] ?? '???';
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(
    date.getUTCMinutes(),
  )} UTC`;
}

/** Unix seconds -> "2026-09-12", for compact columns. */
export function formatUtcDate(unixSeconds: bigint | number): string {
  const date = new Date(Number(unixSeconds) * 1000);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export interface Countdown {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** True once the deadline has passed, in which case every field is 0. */
  elapsed: boolean;
}

export function splitDuration(totalSeconds: number): Countdown {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, elapsed: true };
  }
  const whole = Math.floor(totalSeconds);
  return {
    days: Math.floor(whole / 86_400),
    hours: Math.floor((whole % 86_400) / 3_600),
    minutes: Math.floor((whole % 3_600) / 60),
    seconds: whole % 60,
    elapsed: false,
  };
}

/**
 * A fixed-width countdown: "2d 04:31:07", "04:31:07", "00:00:00".
 *
 * Fixed width because it updates once a second in place. A string that grows
 * and shrinks drags the rest of the row with it.
 */
export function formatCountdown(totalSeconds: number): string {
  const { days, hours, minutes, seconds, elapsed } = splitDuration(totalSeconds);
  if (elapsed) return '00:00:00';
  const clock = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

/** A coarse, non-ticking version for list rows: "2d 4h", "31m", "closed". */
export function formatTimeRemaining(totalSeconds: number): string {
  const { days, hours, minutes, elapsed } = splitDuration(totalSeconds);
  if (elapsed) return 'closed';
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m`;
  return 'under a minute';
}

/**
 * Seconds -> "30s", "5m", "1h 30m", "1d 1h" for durations like a staleness bound.
 *
 * Exact, never rounded: a bound is hashed into a market's spec and decides whether it settles
 * or voids, so 5400 s must read "1h 30m" — rounding it to "2h" would overstate how old a
 * reading the market will accept.
 */
export function formatDuration(totalSeconds: bigint | number): string {
  const seconds = Math.floor(Number(totalSeconds));
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const units: [number, string][] = [
    [Math.floor(seconds / 86_400), 'd'],
    [Math.floor((seconds % 86_400) / 3_600), 'h'],
    [Math.floor((seconds % 3_600) / 60), 'm'],
    [seconds % 60, 's'],
  ];
  return units
    .filter(([count]) => count > 0)
    .map(([count, unit]) => `${count}${unit}`)
    .join(' ');
}
