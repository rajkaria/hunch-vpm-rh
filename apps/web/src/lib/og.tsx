import { ImageResponse } from 'next/og';

import { HERO_TITLE } from '@/lib/site';

/**
 * The share card (1200 x 630): the Hunch lockup, the hero line, the sub, the domain. Matte ink,
 * one lime accent, no glow, no gradient. The lockup is the staged SVG geometry, so the wordmark
 * in a link preview is always the real wordmark.
 *
 * Archivo 800 and Inter are fetched from Google Fonts at build time (the same place next/font
 * gets them), subset to the glyphs used. If that fetch fails the card still renders, in the
 * default face, rather than failing the build.
 */

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_ALT = `Hunch on Robinhood Chain. ${HERO_TITLE}`;

const LOCKUP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 396 84"><g transform="scale(0.84)"><path d="M6 6 H94 V94 H6 Z M33 94 V48 A17 17 0 0 1 67 48 V94 Z" fill="#C8F04F" fill-rule="evenodd"/></g><g transform="translate(101 -10)"><path d="M14 14 V90 M14 67 A17 17 0 0 1 48 67 V90 M71 44 V67 A17 17 0 0 0 105 67 V44 M128 90 V67 A17 17 0 0 1 162 67 V90 M212 50 H202 A17 17 0 1 0 202 84 H212 M229 14 V90 M229 67 A17 17 0 0 1 263 67 V90" fill="none" stroke="#F4F4F2" stroke-width="12"/></g></svg>`;

const LOCKUP_URI = `data:image/svg+xml;base64,${Buffer.from(LOCKUP_SVG).toString('base64')}`;

/** What a card says. The title is two sentences, one per line; its last full stop is lime. */
export interface ShareCard {
  title: string;
  sub: string;
  foot: string;
  tag: string;
  domain: string;
}

export const VENUE_CARD: ShareCard = {
  title: HERO_TITLE,
  sub: 'Prediction markets on Robinhood Stock Tokens, in USDG on Robinhood Chain.',
  foot: 'Open until the closing bell · Settled by Chainlink',
  tag: 'ON ROBINHOOD CHAIN',
  domain: 'vpm.playhunch.xyz',
};

async function googleFont(family: string, weight: number, text: string): Promise<ArrayBuffer | null> {
  try {
    const url = `https://fonts.googleapis.com/css2?family=${family}:wght@${weight}&text=${encodeURIComponent(text)}`;
    const css = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).text();
    const match = /src: url\((.+?)\) format\('(opentype|truetype)'\)/.exec(css);
    if (match?.[1] === undefined) return null;
    const font = await fetch(match[1], { signal: AbortSignal.timeout(8000) });
    return font.ok ? await font.arrayBuffer() : null;
  } catch {
    return null;
  }
}

export async function renderShareCard(card: ShareCard = VENUE_CARD): Promise<ImageResponse> {
  const [display, body] = await Promise.all([
    googleFont('Archivo', 800, card.title),
    googleFont('Inter', 600, `${card.sub}${card.foot}${card.tag}${card.domain}`),
  ]);
  const fonts = [
    ...(display === null ? [] : [{ name: 'Archivo', data: display, weight: 800 as const, style: 'normal' as const }]),
    ...(body === null ? [] : [{ name: 'Inter', data: body, weight: 600 as const, style: 'normal' as const }]),
  ];

  const [first, second] = card.title.split('. ');

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#08080A',
          padding: '64px 72px',
          fontFamily: 'Inter',
          color: '#F4F4F2',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={LOCKUP_URI} width={198} height={42} alt="" />
          <div
            style={{
              display: 'flex',
              border: '1.5px solid rgba(255,255,255,0.16)',
              borderRadius: 8,
              padding: '8px 12px',
              fontSize: 16,
              letterSpacing: 1.2,
              color: 'rgba(244,244,242,0.55)',
            }}
          >
            {card.tag}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              fontFamily: 'Archivo',
              fontSize: 108,
              lineHeight: 0.98,
              letterSpacing: -4,
            }}
          >
            <span>{`${first ?? ''}.`}</span>
            <span style={{ display: 'flex' }}>
              {(second ?? '').replace(/\.$/, '')}
              <span style={{ color: '#C8F04F' }}>.</span>
            </span>
          </div>
          <div style={{ display: 'flex', marginTop: 34, fontSize: 27, color: 'rgba(244,244,242,0.7)' }}>{card.sub}</div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderTop: '1.5px solid rgba(255,255,255,0.08)',
            paddingTop: 26,
            fontSize: 22,
            color: 'rgba(244,244,242,0.55)',
          }}
        >
          <span>{card.foot}</span>
          <span style={{ color: '#F4F4F2' }}>{card.domain}</span>
        </div>
      </div>
    ),
    { ...OG_SIZE, fonts },
  );
}
