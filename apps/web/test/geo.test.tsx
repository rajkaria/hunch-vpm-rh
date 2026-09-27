// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { proxy } from '@/proxy';
import { REGION_COOKIE, REGION_HEADER, clientIp, regionFromHeaders, regionOf } from '@/lib/server/geo';
import { blockedReason } from '@/lib/market/bet-flow';
import { regionFromCookie } from '@/lib/wallet/region';

describe('the country gate', () => {
  it('restricts the US, Canada, the UK and Switzerland, nowhere else', () => {
    for (const code of ['US', 'CA', 'GB', 'CH', 'us', ' gb ']) expect(regionOf(code)).toBe('restricted');
    for (const code of ['FR', 'IN', 'SG', 'DE', null, undefined, '']) expect(regionOf(code)).toBe('open');
  });

  it('proxy.ts forwards the verdict to pages (header) and islands (cookie); pages still render', () => {
    const response = proxy(new NextRequest('https://rh.playhunch.xyz/m/12', { headers: { 'x-vercel-ip-country': 'US' } }));
    expect(response.status).toBe(200);
    expect(response.headers.get(`x-middleware-request-${REGION_HEADER}`)).toBe('restricted');
    expect(response.cookies.get(REGION_COOKIE)?.value).toBe('restricted');

    const open = proxy(new NextRequest('https://rh.playhunch.xyz/', { headers: { 'x-vercel-ip-country': 'FR' } }));
    expect(open.headers.get(`x-middleware-request-${REGION_HEADER}`)).toBe('open');
    expect(open.cookies.get(REGION_COOKIE)?.value).toBe('open');
  });

  it('reads the verdict on the server, or the country header when the proxy did not run', () => {
    expect(regionFromHeaders(new Headers({ [REGION_HEADER]: 'restricted' }))).toBe('restricted');
    expect(regionFromHeaders(new Headers({ 'x-vercel-ip-country': 'CH' }))).toBe('restricted');
    expect(regionFromHeaders(new Headers({ 'x-vercel-ip-country': 'JP' }))).toBe('open');
    expect(regionFromCookie('a=1; hunch_region=restricted; b=2')).toBe('restricted');
    expect(regionFromCookie('hunch_region=open')).toBe('open');
    expect(regionFromCookie('other=1')).toBeNull();
  });

  it('takes the first forwarded IP for rate limiting', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
    expect(clientIp(new Headers({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2');
    expect(clientIp(new Headers())).toBeNull();
  });

  it('the bet panel refuses with "Not available in your country" before anything else', () => {
    const gate = blockedReason({ region: 'restricted', deployed: false, entriesPaused: true, phase: 'live', acceptingBets: true, finalTime: 2, nowSec: 1 });
    expect(gate?.short).toBe('Not available in your country');
  });
});
