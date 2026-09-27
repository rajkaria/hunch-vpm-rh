import type { FaqItem } from '@/content/faq';

/**
 * Questions as native disclosures: keyboard and screen-reader behaviour for free, no client
 * code, and every answer is in the HTML for search and for anyone with scripts off.
 */
export function FaqList({ items, headingLevel = 'h3' }: { items: readonly FaqItem[]; headingLevel?: 'h2' | 'h3' }) {
  const Heading = headingLevel;
  return (
    <div className="divide-y divide-edge-soft overflow-hidden rounded-card border border-edge bg-raised">
      {items.map((item) => (
        <details key={item.id} id={item.id} className="group">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-paper/3 sm:px-5 [&::-webkit-details-marker]:hidden">
            <Heading className="font-body text-[15px] leading-snug font-semibold tracking-normal text-paper">{item.q}</Heading>
            <span
              aria-hidden
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-tag border border-edge text-muted transition-transform duration-150 group-open:rotate-45"
            >
              <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M6 1v10M1 6h10" strokeLinecap="round" />
              </svg>
            </span>
          </summary>
          <div className="grid gap-3 px-4 pb-5 text-sm leading-relaxed text-muted sm:px-5">
            {item.a.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
