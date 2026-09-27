'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ConnectSlot } from '@/components/wallet/ConnectSlot';

import { NAV, isActive } from './nav';

/** Desktop tabs: 600 and a 2px lime underline on the active one (design system §4). */
export function DesktopNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="hidden items-center gap-1 lg:flex">
      {NAV.map((item) => {
        const active = isActive(pathname, item.match);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`relative inline-flex min-h-11 items-center px-3 text-sm transition-colors ${
              active ? 'font-semibold text-paper' : 'text-muted hover:text-paper'
            }`}
          >
            {item.label}
            {active ? <span aria-hidden className="absolute inset-x-3 bottom-1.5 h-0.5 rounded-pill bg-lime" /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

/** Below 1024 px: a 44 px menu button that opens the same links as full-width rows. */
export function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close on navigation.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mobile-menu"
        aria-label={open ? 'Close menu' : 'Open menu'}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-11 w-11 items-center justify-center rounded-control border border-edge text-paper transition-colors hover:bg-paper/5"
      >
        <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6">
          {open ? <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" /> : <path d="M3 6h14M3 10h14M3 14h14" strokeLinecap="round" />}
        </svg>
      </button>
      {open ? (
        <nav
          id="mobile-menu"
          aria-label="Primary"
          className="absolute inset-x-0 top-full z-40 border-b border-edge bg-ink px-4 pb-4 pt-2"
        >
          <ul className="flex flex-col">
            {NAV.map((item) => {
              const active = isActive(pathname, item.match);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    aria-current={active ? 'page' : undefined}
                    className={`flex min-h-12 items-center justify-between border-b border-edge-soft text-[15px] ${
                      active ? 'font-semibold text-paper' : 'text-muted'
                    }`}
                  >
                    {item.label}
                    {active ? <span aria-hidden className="h-1.5 w-1.5 rounded-pill bg-lime" /> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 sm:hidden">
            <ConnectSlot />
          </div>
        </nav>
      ) : null}
    </div>
  );
}
