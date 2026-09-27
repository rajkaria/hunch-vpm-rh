/**
 * Product analytics (Vercel Web Analytics custom events): the funnel from a visit to a bet,
 * with no personal data. Only these six events exist, and a property that looks like an address
 * or a hash is dropped before anything leaves the browser.
 */

import { track } from '@vercel/analytics';

export type HunchEvent = 'connect_wallet' | 'switch_chain' | 'quote_shown' | 'bet_submitted' | 'bet_confirmed' | 'resolve_clicked';

type Props = Record<string, string | number | boolean | null>;

const HEXISH = /0x[0-9a-fA-F]{6,}/;

export function cleanProps(props: Props): Props {
  const out: Props = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'string' && HEXISH.test(value)) continue;
    if (/address|owner|account|from|wallet_address|signature|tx/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export function trackEvent(name: HunchEvent, props: Props = {}): void {
  try {
    track(name, cleanProps(props));
  } catch {
    // Analytics never gets in the way of a bet.
  }
}
