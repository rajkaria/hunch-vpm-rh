'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { DOCS, DOC_GROUPS, docHref } from '@/content/docs-nav';

/** The docs sidebar: grouped links, the current page marked with the lime rule. */
export function DocsNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Docs">
      <div className="grid gap-7">
        {DOC_GROUPS.map((group) => (
          <div key={group}>
            <p className="eyebrow">{group}</p>
            <ul className="mt-1 grid border-l border-edge">
              {DOCS.filter((doc) => doc.group === group).map((doc) => {
                const href = docHref(doc.slug);
                const active = pathname === href;
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      onClick={() => onNavigate?.()}
                      aria-current={active ? 'page' : undefined}
                      className={`-ml-px flex min-h-11 items-center border-l pl-3 text-sm transition-colors ${
                        active ? 'border-lime font-semibold text-paper' : 'border-transparent text-muted hover:border-paper/40 hover:text-paper'
                      }`}
                    >
                      {doc.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

/**
 * Below 1024 px: a full-width button naming the current page, which opens the same nav as a
 * sheet from the bottom. Escape and the scrim close it; focus moves into it and back.
 */
export function DocsMobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = DOCS.find((doc) => docHref(doc.slug) === pathname);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const trigger = triggerRef.current;
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
      trigger?.focus();
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls="docs-drawer"
        aria-label={`Docs contents. Current page: ${current?.title ?? 'none'}`}
        onClick={() => setOpen(true)}
        className="flex min-h-12 w-full items-center justify-between gap-3 rounded-control border border-edge bg-raised px-4 text-left text-sm"
      >
        <span className="min-w-0 truncate">
          <span className="text-faint">Docs · </span>
          <span className="font-semibold text-paper">{current?.title ?? 'Contents'}</span>
        </span>
        <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-muted" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="fixed inset-0 z-50" id="docs-drawer" role="dialog" aria-modal="true" aria-label="Docs contents">
          <button type="button" aria-label="Close docs contents" tabIndex={-1} onClick={() => setOpen(false)} className="absolute inset-0 bg-ink/72" />
          <div className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-[20px] border-t border-edge-strong bg-[#111114] px-5 pb-8 pt-3">
            <div className="flex items-center justify-between pb-3">
              <p className="text-sm font-semibold text-paper">Docs</p>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-control text-muted hover:bg-paper/5 hover:text-paper"
                aria-label="Close"
              >
                <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <DocsNav onNavigate={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
