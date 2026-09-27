import Link from 'next/link';
import type { ReactNode } from 'react';

import { DOCS, docBySlug, docHref } from '@/content/docs-nav';

import { Toc } from './prose';

/**
 * One docs page: the title block, an optional "On this page" list, the body, and prev/next.
 * Server component; the only client code in the docs is the nav.
 */
export function DocPage({
  slug,
  toc,
  children,
}: {
  slug: string;
  toc?: readonly { id: string; label: string }[];
  children: ReactNode;
}) {
  const doc = docBySlug(slug);
  const index = DOCS.findIndex((entry) => entry.slug === slug);
  const prev = index > 0 ? DOCS[index - 1] : undefined;
  const next = index < DOCS.length - 1 ? DOCS[index + 1] : undefined;

  return (
    <article className="min-w-0">
      <header className="border-b border-edge pb-8">
        <p className="eyebrow">{doc.group}</p>
        <h1 className="mt-3 text-[32px] leading-[1.08] sm:text-[40px]">{doc.title}</h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted sm:text-[17px]">{doc.description}</p>
      </header>

      <div className="grid gap-10 pt-10 xl:grid-cols-[minmax(0,1fr)_200px] xl:gap-12">
        <div className="min-w-0 max-w-3xl">
          {toc === undefined || toc.length < 3 ? null : (
            <div className="mb-10 rounded-card border border-edge p-4 xl:hidden">
              <Toc items={toc} />
            </div>
          )}
          {children}
        </div>
        {toc === undefined || toc.length < 3 ? null : (
          <aside className="hidden xl:block">
            <div className="sticky top-24">
              <Toc items={toc} />
            </div>
          </aside>
        )}
      </div>

      <nav aria-label="Previous and next" className="mt-16 grid gap-3 border-t border-edge pt-8 sm:grid-cols-2">
        {prev === undefined ? (
          <span />
        ) : (
          <Link href={docHref(prev.slug)} className="group rounded-card border border-edge p-4 transition-colors hover:border-paper/20 hover:bg-paper/3">
            <span className="text-xs text-faint">Previous</span>
            <span className="mt-1 block text-[15px] font-semibold text-paper">{prev.title}</span>
          </Link>
        )}
        {next === undefined ? null : (
          <Link
            href={docHref(next.slug)}
            className="group rounded-card border border-edge p-4 text-right transition-colors hover:border-paper/20 hover:bg-paper/3 sm:col-start-2"
          >
            <span className="text-xs text-faint">Next</span>
            <span className="mt-1 block text-[15px] font-semibold text-paper">{next.title}</span>
          </Link>
        )}
      </nav>
    </article>
  );
}
