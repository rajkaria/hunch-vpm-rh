import Link from 'next/link';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { formatAmount, formatAmountExact, formatPpmPercent, type AmountFormat } from '@/lib/units';

/**
 * A panel. One hairline edge, a translucent surface, and a single highlight along the top:
 * that highlight is the entire depth model on this surface. No shadows, no blur.
 *
 * `bg-raised` is an alpha rather than a hex, so a panel nested inside a panel is one legible
 * step brighter without either one being a different colour.
 */
export function Panel({
  children,
  className = '',
  as: Tag = 'section',
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article' | 'aside' | 'figure';
} & Omit<ComponentPropsWithoutRef<'div'>, 'className' | 'children'>) {
  return (
    <Tag className={`lift rounded-card border border-edge bg-raised ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

export function PanelHeader({ title, hint, right }: { title: string; hint?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-edge px-4 py-3.5 sm:px-5">
      <div className="min-w-0">
        <h3 className="font-body text-[15px] font-semibold tracking-normal text-paper">{title}</h3>
        {hint === undefined ? null : <p className="mt-1 max-w-prose text-sm text-muted">{hint}</p>}
      </div>
      {right === undefined ? null : <div className="shrink-0">{right}</div>}
    </div>
  );
}

/**
 * A USDG amount: fixed fraction digits so columns line up, truncated rather than rounded up
 * (a payout shown as more than the contract pays is a bug), exact value on the title.
 */
export function Amount({
  value,
  unit = false,
  className = '',
  ...format
}: { value: bigint; unit?: boolean; className?: string } & AmountFormat) {
  const exact = `${formatAmountExact(value)} USDG`;
  return (
    <span className={`num ${className}`} title={exact} aria-label={exact}>
      {formatAmount(value, format)}
      {unit ? <span className="ml-1 text-[0.85em] text-faint">USDG</span> : null}
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
 * The product's tag: 11px Inter 600, uppercase, 0.05em tracking, a 6px corner. Tinted fill,
 * tinted edge, full-strength text: three alphas of one hue. Tags are words, so not mono.
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
      className={`inline-flex items-center gap-1.5 rounded-tag px-2 py-1 text-[11px] leading-none font-semibold tracking-[0.05em] whitespace-nowrap uppercase ${
        solid ? TONE_SOLID[tone] : `border ${TONE_TINT[tone]}`
      } ${className}`}
    >
      {children}
    </span>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

const VARIANT: Record<ButtonVariant, string> = {
  // The single solid-accent control per view region.
  primary: 'bg-lime text-ink hover:bg-lime/90',
  secondary: 'border border-edge-strong bg-ghost text-paper hover:border-paper/20 hover:bg-paper/5',
  ghost: 'text-muted hover:bg-paper/5 hover:text-paper',
};

export function buttonClass(variant: ButtonVariant = 'primary', size: 'sm' | 'md' = 'md', className = ''): string {
  const metrics = size === 'sm' ? 'min-h-11 px-4 text-sm' : 'min-h-12 px-5 text-[15px]';
  return `inline-flex items-center justify-center gap-2 rounded-control font-semibold whitespace-nowrap transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.98] ${metrics} ${VARIANT[variant]} ${className}`;
}

/**
 * A button. One primary per view region (design system §4); `secondary` is the outline beside
 * it; `ghost` is text. Every size is at least 44 px tall.
 */
export function Button({
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  type = 'button',
  ...rest
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  className?: string;
} & Omit<ComponentPropsWithoutRef<'button'>, 'className' | 'children'>) {
  return (
    <button type={type} className={buttonClass(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}

/** A link that looks like a button. Internal paths use next/link; anything else opens a new tab. */
export function ButtonLink({
  children,
  href,
  variant = 'primary',
  size = 'md',
  className = '',
}: {
  children: ReactNode;
  href: string;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const classes = buttonClass(variant, size, className);
  if (href.startsWith('/') || href.startsWith('#')) {
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={classes} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

/** An inline text link: paper at 65%, a hairline underline that strengthens on hover. */
export function TextLink({
  href,
  children,
  className = '',
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const classes = `text-paper underline decoration-paper/25 underline-offset-4 transition-colors hover:decoration-lime ${className}`;
  if (href.startsWith('/') || href.startsWith('#')) {
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={classes} target="_blank" rel="noreferrer noopener">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
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
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-2 text-xl leading-none">{children}</dd>
      {hint === undefined ? null : <p className="mt-2 text-xs leading-snug text-muted">{hint}</p>}
    </div>
  );
}

/**
 * What a list says when it has nothing in it: what happened, what it means, at most one
 * action. An empty list and a broken list never look alike.
 */
export function EmptyState({
  title,
  children,
  action,
  className = '',
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-card border border-dashed border-edge-strong px-5 py-8 text-center ${className}`}>
      <p className="text-[15px] font-semibold text-paper">{title}</p>
      {children === undefined ? null : (
        <div className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">{children}</div>
      )}
      {action === undefined ? null : <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

/** A section's heading block: one eyebrow, one display heading, one lead paragraph. */
export function SectionHeading({
  eyebrow,
  title,
  lead,
  id,
  className = '',
  as: Tag = 'h2',
}: {
  eyebrow?: string;
  title: ReactNode;
  lead?: ReactNode;
  id?: string;
  className?: string;
  as?: 'h1' | 'h2';
}) {
  return (
    <div className={`max-w-2xl ${className}`}>
      {eyebrow === undefined ? null : <p className="eyebrow mb-3">{eyebrow}</p>}
      <Tag id={id} className={Tag === 'h1' ? 'text-[34px] leading-[1.05] sm:text-5xl' : 'text-[28px] leading-[1.1] sm:text-4xl'}>
        {title}
      </Tag>
      {lead === undefined ? null : <p className="mt-4 text-[15px] leading-relaxed text-muted sm:text-base">{lead}</p>}
    </div>
  );
}

/** The outcome as a word, reinforced by colour. Never colour alone. */
export function SideWord({ side, className = '' }: { side: 'UP' | 'DOWN'; className?: string }) {
  return (
    <span className={`font-semibold tracking-[0.02em] ${side === 'UP' ? 'text-lime' : 'text-coral'} ${className}`}>
      {side}
    </span>
  );
}

/**
 * Three (or so) facts in one hairline strip, label over value: the strip under the Hunch
 * landing page's headline. A `live` fact gets the pulsing lime dot; its value is the caller's.
 */
export function FactStrip({
  facts,
  label,
  className = '',
}: {
  facts: readonly { label: string; value: ReactNode; live?: boolean }[];
  /** What the strip is, for screen readers. */
  label: string;
  className?: string;
}) {
  return (
    <dl
      aria-label={label}
      className={`grid divide-x divide-edge rounded-card border border-edge bg-raised ${className}`}
      style={{ gridTemplateColumns: `repeat(${facts.length}, minmax(0, 1fr))` }}
    >
      {facts.map((fact) => (
        <div key={fact.label} className="flex min-w-0 flex-col justify-between gap-1.5 px-3 py-3 sm:px-4">
          <dt className="eyebrow flex items-center gap-1.5">
            {fact.live === true ? <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-pill bg-lime motion-safe:animate-pulse" /> : null}
            {fact.label}
          </dt>
          <dd className="text-[15px] leading-tight font-semibold text-paper sm:text-base">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
