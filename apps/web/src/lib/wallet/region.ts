/** The country verdict `proxy.ts` leaves for client islands (cookie `hunch_region`). */

export type Region = 'restricted' | 'open';

export function regionFromCookie(cookie: string): Region | null {
  const match = /(?:^|;\s*)hunch_region=(restricted|open)(?:;|$)/.exec(cookie);
  return match === null ? null : (match[1] as Region);
}

export function readRegion(): Region | null {
  try {
    return regionFromCookie(document.cookie);
  } catch {
    return null;
  }
}
