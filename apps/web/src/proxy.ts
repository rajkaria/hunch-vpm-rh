/**
 * The country gate (docs/spec/05-web-app.md §Geo and eligibility). Next.js 16 calls this file
 * `proxy.ts` (it was `middleware.ts` before 16; same behaviour).
 *
 * Vercel sets `x-vercel-ip-country` on every request. For the US, Canada, the UK and Switzerland
 * the site still renders every page, read-only: the bet panel says "Not available in your
 * country", and the relay refuses (the keeper checks the same header). This forwards the verdict
 * to server components as `x-hunch-region` and to client islands as the `hunch_region` cookie.
 * It is a front-end control; the contracts are permissionless, and the site says so.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { COUNTRY_HEADER, REGION_COOKIE, REGION_HEADER, regionOf } from '@/lib/server/geo';

export function proxy(request: NextRequest): NextResponse {
  const region = regionOf(request.headers.get(COUNTRY_HEADER));
  const headers = new Headers(request.headers);
  headers.set(REGION_HEADER, region);
  const response = NextResponse.next({ request: { headers } });
  if (request.cookies.get(REGION_COOKIE)?.value !== region) {
    response.cookies.set(REGION_COOKIE, region, { path: '/', sameSite: 'lax', maxAge: 3600, httpOnly: false, secure: request.nextUrl.protocol === 'https:' });
  }
  return response;
}

export const config = {
  // Pages only: API routes read the country header themselves, and static files need no verdict.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|icon|apple-icon|brand|manifest|robots.txt|sitemap.xml|opengraph-image|twitter-image).*)'],
};
