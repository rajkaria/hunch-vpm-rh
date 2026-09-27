/**
 * The country gate (docs/spec/05-web-app.md §Geo). `proxy.ts` reads Vercel's
 * `x-vercel-ip-country` and forwards the result as `x-hunch-region` (and a cookie for client
 * islands). Stock-price markets are not offered in the US, Canada, the UK or Switzerland: pages
 * still render, the bet panel says "Not available in your country", and the relay refuses.
 * The contracts are permissionless; this is a front-end control, and the site says so.
 */

import { isRestrictedCountry } from '@hunch-rh/client';

export const REGION_HEADER = 'x-hunch-region';
export const REGION_COOKIE = 'hunch_region';
export const COUNTRY_HEADER = 'x-vercel-ip-country';

export type Region = 'restricted' | 'open';

export function regionOf(country: string | null | undefined): Region {
  return isRestrictedCountry(country) ? 'restricted' : 'open';
}

/** The region for a request's headers: the proxy's verdict, else the country header itself. */
export function regionFromHeaders(headers: Pick<Headers, 'get'>): Region {
  const forwarded = headers.get(REGION_HEADER);
  if (forwarded === 'restricted' || forwarded === 'open') return forwarded;
  return regionOf(headers.get(COUNTRY_HEADER));
}

/** The client IP for rate limiting (never logged, never stored beyond the limiter's window). */
export function clientIp(headers: Pick<Headers, 'get'>): string | null {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded !== undefined && forwarded !== '') return forwarded;
  const real = headers.get('x-real-ip')?.trim();
  return real === undefined || real === '' ? null : real;
}
