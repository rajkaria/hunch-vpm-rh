import { OG_SIZE, renderShareCard } from '@/lib/og';
import { PITCH } from '@/content/pitch';

export const alt = `${PITCH.title}. Call it early. Get paid more.`;
export const size = OG_SIZE;
export const contentType = 'image/png';

/** The deck's link preview: the cover's line, the round and the date. */
export default function TwitterImage() {
  return renderShareCard({
    title: 'Call it early. Get paid more.',
    sub: PITCH.share,
    foot: `Investor deck · ${PITCH.round} · ${PITCH.dateline}`,
    tag: 'LIVE ON ROBINHOOD CHAIN',
    domain: `${PITCH.domain}/pitch`,
  });
}
