'use client';

import { useEffect, useState } from 'react';

import { formatCountdown } from '@/lib/time';

/**
 * The time left until a market freezes.
 *
 * The first render uses the number the server computed, so the markup the
 * browser receives is the markup it renders and nothing flashes. The clock
 * only takes over after mount. The string is fixed width by construction, so
 * a row containing one does not reflow every second.
 */
export function Countdown({
  deadline,
  initialSeconds,
  className = '',
}: {
  /** Unix seconds. */
  deadline: number;
  /** Seconds remaining as of the server render. */
  initialSeconds: number;
  className?: string;
}) {
  const [seconds, setSeconds] = useState(initialSeconds);

  useEffect(() => {
    const tick = (): void => {
      setSeconds(Math.max(0, deadline - Math.floor(Date.now() / 1000)));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);

  if (seconds <= 0) {
    return <span className={`num ${className}`}>frozen</span>;
  }

  return (
    <span className={`num tabular-nums ${className}`}>
      <span className="sr-only">Time until the market freezes: </span>
      {formatCountdown(seconds)}
    </span>
  );
}
