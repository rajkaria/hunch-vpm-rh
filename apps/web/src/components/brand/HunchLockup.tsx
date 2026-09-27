/**
 * The Hunch lockup as the family draws it: the lime mark and the wordmark in paper. Inline SVG
 * from the staged brand geometry (public/brand/hunch-lockup.svg), so it costs no request and the
 * wordmark is always the real stroked path. Never recoloured beyond these two, never given a
 * shadow or a glow; width and height scale together.
 */
export function HunchLockup({ className = 'h-6 w-auto', title = 'Hunch' }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 396 84" className={className} role="img" aria-label={title}>
      <g transform="scale(0.84)">
        <path d="M6 6 H94 V94 H6 Z M33 94 V48 A17 17 0 0 1 67 48 V94 Z" fill="#C8F04F" fillRule="evenodd" />
      </g>
      <g transform="translate(101 -10)">
        <path
          d="M14 14 V90 M14 67 A17 17 0 0 1 48 67 V90 M71 44 V67 A17 17 0 0 0 105 67 V44 M128 90 V67 A17 17 0 0 1 162 67 V90 M212 50 H202 A17 17 0 1 0 202 84 H212 M229 14 V90 M229 67 A17 17 0 0 1 263 67 V90"
          fill="none"
          stroke="#F4F4F2"
          strokeWidth="12"
        />
      </g>
    </svg>
  );
}

/** The mark alone (lime block with the arch). */
export function HunchMark({ className = 'h-6 w-6', title }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} role={title === undefined ? undefined : 'img'} aria-label={title} aria-hidden={title === undefined ? true : undefined}>
      <path d="M6 6 H94 V94 H6 Z M33 94 V48 A17 17 0 0 1 67 48 V94 Z" fill="#C8F04F" fillRule="evenodd" />
    </svg>
  );
}
