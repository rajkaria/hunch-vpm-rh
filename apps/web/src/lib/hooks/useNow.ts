'use client';

import { useEffect, useState } from 'react';

/**
 * Unix seconds, ticking every `intervalMs`. The first render uses the server's `now`, so the
 * markup the browser hydrates matches the server's; the clock takes over after mount.
 */
export function useNow(serverNow: number, intervalMs = 1000): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const tick = (): void => setNow(Math.floor(Date.now() / 1000));
    tick();
    const timer = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
