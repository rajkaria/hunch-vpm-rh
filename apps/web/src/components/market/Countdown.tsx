'use client';

import { useEffect, useState } from 'react';

import { formatCountdown } from '@/lib/time';

/**
 * Time left until a deadline (the opening bell, the closing bell).
 *
 * The first render uses the server's `now`, so the markup the browser receives is the markup
 * it hydrates and nothing flashes; the clock takes over after mount. The string is fixed width
 * ("2d 04:31:07"), so a row holding one does not reflow every second.
 */
export function Countdown({
  deadline,
  now,
  label,
  endedText = 'now',
  urgentBelow = 0,
  className = '',
}: {
  /** Unix seconds. */
  deadline: number;
  /** Unix seconds at server render. */
  now: number;
  /** What the countdown counts to, for screen readers ("until the closing bell"). */
  label: string;
  /** Shown once the deadline has passed. */
  endedText?: string;
  /** Seconds under which the countdown turns coral (the design system's urgent state). 0 = never. */
  urgentBelow?: number;
  className?: string;
}) {
  const [seconds, setSeconds] = useState(Math.max(0, deadline - now));

  useEffect(() => {
    const tick = (): void => setSeconds(Math.max(0, deadline - Math.floor(Date.now() / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);

  if (seconds <= 0) return <span className={`num ${className}`}>{endedText}</span>;

  const urgent = urgentBelow > 0 && seconds < urgentBelow;
  return (
    <span className={`num tabular-nums ${urgent ? 'text-coral' : ''} ${className}`}>
      <span className="sr-only">Time {label}: </span>
      {formatCountdown(seconds)}
    </span>
  );
}
