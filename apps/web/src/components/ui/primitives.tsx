import type { ReactNode } from 'react';

import { formatAmount, formatAmountExact, formatPpmPercent, type AmountFormat } from '@/lib/units';

/**
 * A panel. One hairline edge, a translucent surface, and a single highlight
 * along the top — that highlight is the entire depth model on this surface,
 * and there are no shadows and no blur anywhere in it.
 *
 * `bg-raised` is an alpha rather than a hex, so a panel nested inside a panel
 * is one legible step brighter without either one being a different colour.
 * That is deliberate; do not "fix" it by reaching for `raised-2` unless the
 * nested thing has no panel of its own to sit on.
 */
export function Panel({
  children,
  className = '',
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article' | 'aside';
}) {
  return (
    <Tag className={`lift rounded-card border border-edge bg-raised ${className}`}>{children}</Tag>
  );
}

export function PanelHeader({
  title,
  hint,
  right,
}: {
  title: string;
  hint?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-edge px-4 py-3.5 sm:px-5">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-[0.06em] text-paper uppercase">{title}</h2>
        {hint === undefined ? null : <p className="mt-1 max-w-prose text-sm text-muted">{hint}</p>}
      </div>
      {right === undefined ? null : <div className="shrink-0">{right}</div>}
    </div>
  );
}

/**
 * A USDC amount.
 *
 * Fixed fraction digits so columns line up and a value that updates does not
 * change width, truncated rather than rounded up, with the exact chain value
 * on the title for anyone who needs the last four digits.
 */
export function Amount({
  value,
  className = '',
  ...format
}: { value: bigint; className?: string } & AmountFormat) {
  return (
    <span className={`num ${className}`} title={`${formatAmountExact(value)} USDC`}>
      {formatAmount(value, format)}
    </span>
  );
}

/** A percentage from parts per million, at a fixed width. */
export function Percent({ ppm, digits = 1, className = '' }: { ppm: bigint; digits?: number; className?: string }) {
  return (
    <span className={`num ${className}`}>
      {formatPpmPercent(ppm, digits)}
      <span className="text-muted">%</span>
    </span>
  );
}

export type Tone = 'up' | 'down' | 'neutral' | 'quiet' | 'info' | 'note';

/*
 * The product's tag, to the pixel: 11px Inter at 600, uppercase, 0.05em of
 * tracking, 4px over 10px of padding and a 6px corner. The fill is the accent
 * at a tenth, the edge is the same accent at just over a third, and the text
 * is the accent at full strength. Three alphas of one hue is what makes these
 * read as a set instead of as six unrelated chips.
 *
 * Note it is Inter and not mono. Tags are words; the mono face is for numerals
 * and reading a word in it costs width and legibility for nothing.
 */
const TONE_TINT: Record<Tone, string> = {
  up: 'border-lime/35 bg-lime/10 text-lime',
  down: 'border-coral/35 bg-coral/10 text-coral',
  neutral: 'border-paper/20 bg-paper/8 text-paper',
  quiet: 'border-edge bg-paper/4 text-muted',
  info: 'border-violet/35 bg-violet/15 text-violet',
  note: 'border-sky/35 bg-sky/10 text-sky',
};

const TONE_SOLID: Record<Tone, string> = {
  up: 'bg-lime text-ink',
  down: 'bg-coral text-ink',
  neutral: 'bg-paper text-ink',
  quiet: 'bg-paper text-ink',
  info: 'bg-violet text-ink',
  note: 'bg-sky text-ink',
};

/**
 * A small label. Tinted by default; solid only for the one thing on a page
 * that has to be read before anything else.
 */
export function Badge({
  children,
  tone = 'quiet',
  solid = false,
  className = '',
}: {
  children: ReactNode;
  tone?: Tone;
  solid?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-tag px-2.5 py-1 text-[11px] leading-none font-semibold tracking-[0.05em] whitespace-nowrap uppercase ${
        solid ? TONE_SOLID[tone] : `border ${TONE_TINT[tone]}`
      } ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * A button, or a link wearing one. Primary is the lime fill the product uses
 * for its one call to action per view; ghost is the near-invisible surface
 * with the slightly stronger edge that sits beside it. Both are 12px corners,
 * because on this surface anything you can click is a control.
 *
 * There is no third variant. If a third thing on the page needs to look
 * clickable, it is a link.
 */
export function Button({
  children,
  href,
  variant = 'primary',
  size = 'md',
  className = '',
  ...rest
}: {
  children: ReactNode;
  href?: string;
  variant?: 'primary' | 'ghost';
  size?: 'sm' | 'md';
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<'button'>, 'className' | 'children'>) {
  const look =
    variant === 'primary'
      ? 'bg-lime text-ink hover:bg-lime/90'
      : 'border border-edge-strong bg-ghost text-paper/80 hover:bg-paper/6 hover:text-paper';
  const metrics = size === 'sm' ? 'px-3.5 py-2 text-[13px]' : 'px-6 py-4 text-sm';
  const shape = `inline-flex items-center justify-center gap-2 rounded-control font-semibold transition-colors ${metrics} ${look} ${className}`;

  return href === undefined ? (
    <button className={shape} {...rest}>
      {children}
    </button>
  ) : (
    <a href={href} className={shape}>
      {children}
    </a>
  );
}

/** A label above a number, which is most of this surface. */
export function Stat({
  label,
  children,
  hint,
  className = '',
}: {
  label: string;
  children: ReactNode;
  hint?: string | undefined;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-xs uppercase tracking-[0.12em] text-faint">{label}</dt>
      <dd className="mt-1.5 text-lg leading-none">{children}</dd>
      {hint === undefined ? null : <p className="mt-1.5 text-xs leading-snug text-muted">{hint}</p>}
    </div>
  );
}

/**
 * What a list says when it has nothing in it. Every list on this surface has
 * one: an empty market board and a broken market board should not look alike.
 */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="lift rounded-card border border-edge bg-raised px-5 py-10 text-center">
      <p className="font-display text-base">{title}</p>
      {children === undefined ? null : (
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">{children}</p>
      )}
      {action === undefined ? null : <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

/** A calm placeholder. It does not shimmer, and it does not outlive the data. */
export function LoadingBlock({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div className="lift rounded-card border border-edge bg-raised px-5 py-6" role="status" aria-live="polite">
      <p className="text-sm text-muted">{label}</p>
      <div className="mt-4 space-y-2" aria-hidden>
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="h-3 rounded-tag bg-paper/6" style={{ width: `${86 - index * 14}%` }} />
        ))}
      </div>
    </div>
  );
}
