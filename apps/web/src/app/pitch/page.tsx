import type { Metadata } from 'next';

import { bootScript } from '@/components/pitch/boot';
import { Deck } from '@/components/pitch/Deck';
import { SLIDES, SLIDE_LABELS } from '@/components/pitch/slides';
import { PITCH } from '@/content/pitch';

import './pitch.css';

/**
 * The investor deck. Unlisted: not in the header, the footer or the sitemap, and marked noindex,
 * so it is reachable only by its link. Outside the (venue) group, so it has the whole screen.
 */
export const metadata: Metadata = {
  title: { absolute: PITCH.title },
  description: PITCH.description,
  alternates: { canonical: '/pitch' },
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  openGraph: { type: 'website', title: PITCH.title, description: PITCH.description, url: '/pitch' },
  twitter: { card: 'summary_large_image', title: PITCH.title, description: PITCH.description },
};

export default function PitchPage() {
  return (
    <>
      {/* Scales the stage before first paint; the Deck keeps it current. */}
      <script dangerouslySetInnerHTML={{ __html: bootScript }} />
      <Deck slides={SLIDES.map((Slide, i) => <Slide key={SLIDE_LABELS[i]} />)} labels={[...SLIDE_LABELS]} />
    </>
  );
}
