import type { CSSProperties, ReactNode } from 'react';

import { HunchLockup } from '@/components/brand/HunchLockup';
import { PITCH } from '@/content/pitch';

/**
 * The deck's building blocks, in canvas pixels (1920 x 1080). A slide is a `Shell`: the
 * atmosphere, a header with its section, the content area, and a footer with the page number.
 */

export const SLIDE_COUNT = 11;

export type Tone = 'lime' | 'violet' | 'sky' | 'coral';

/** Staggered entrance: put `className="rv"` on the element and `style={rv(d)}`, d in 85 ms steps. */
export function rv(d: number): CSSProperties {
  return { '--d': d } as CSSProperties;
}

export function Atmosphere({ tone }: { tone: Tone }) {
  return <div className="pitch-atmos" data-tone={tone} aria-hidden />;
}

export function Shell({ n, section, tone = 'lime', children }: { n: number; section: string; tone?: Tone; children: ReactNode }) {
  return (
    <>
      <Atmosphere tone={tone} />
      <header className="absolute left-[120px] right-[120px] top-[64px] flex items-center justify-between">
        <p className="pitch-kicker flex items-center gap-4 text-faint">
          <span className="text-lime">{String(n).padStart(2, '0')}</span>
          <span className="h-px w-10 bg-edge-strong" aria-hidden />
          <span>{section}</span>
        </p>
        <HunchLockup className="h-[30px] w-auto opacity-90" />
      </header>
      <div className="absolute bottom-[112px] left-[120px] right-[120px] top-[150px] flex flex-col">{children}</div>
      <footer className="absolute bottom-[52px] left-[120px] right-[120px] flex items-center justify-between border-t border-edge pt-5 text-[17px] text-faint">
        <span>
          Hunch · {PITCH.round} · {PITCH.dateline}
        </span>
        <span className="flex items-center gap-6">
          <span>{PITCH.domain}</span>
          <span className="num text-muted">
            {String(n).padStart(2, '0')} / {String(SLIDE_COUNT).padStart(2, '0')}
          </span>
        </span>
      </footer>
    </>
  );
}

export function Title({ children, className = '', d = 0 }: { children: ReactNode; className?: string; d?: number }) {
  return (
    <h2 className={`rv pitch-title text-[76px] text-paper ${className}`} style={rv(d)}>
      {children}
    </h2>
  );
}

export function Lead({ children, className = '', d = 1 }: { children: ReactNode; className?: string; d?: number }) {
  return (
    <p className={`rv pitch-lead text-[28px] leading-[1.45] text-muted ${className}`} style={rv(d)}>
      {children}
    </p>
  );
}

/** A lime full stop: the brand's one flourish, used on the cover and the close. */
export function Dot() {
  return <span className="text-lime">.</span>;
}

export function Tag({ children, tone = 'paper' }: { children: ReactNode; tone?: 'paper' | 'lime' | 'coral' | 'violet' | 'sky' }) {
  const tones = {
    paper: 'border-paper/20 text-muted',
    lime: 'border-lime/40 text-lime',
    coral: 'border-coral/40 text-coral',
    violet: 'border-violet/40 text-violet',
    sky: 'border-sky/40 text-sky',
  } as const;
  return (
    <span className={`pitch-kicker inline-flex items-center rounded-[8px] border px-3 py-[7px] text-[14px] leading-none ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Check({ className = 'text-lime' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`h-[26px] w-[26px] shrink-0 ${className}`} aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Cross({ className = 'text-coral' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`h-[24px] w-[24px] shrink-0 ${className}`} aria-hidden>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function Arrow({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`h-[28px] w-[28px] shrink-0 ${className}`} aria-hidden>
      <path d="M4 12h15M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
