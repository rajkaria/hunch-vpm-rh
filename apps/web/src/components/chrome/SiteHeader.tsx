'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { ConnectWallet } from '@/components/wallet/ConnectWallet';
import { NetworkToggle } from '@/components/wallet/NetworkToggle';

const LINKS = [
  { href: '/', label: 'Markets' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/agents', label: 'Agents' },
  { href: '/claim', label: 'Claim' },
  { href: '/docs', label: 'How it works' },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/' || pathname.startsWith('/m/');
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteHeader() {
  const pathname = usePathname();

  /*
   * Translucent over the ground with a blur behind it, which is how the
   * product's own header behaves. The fallback matters: `supports-` keeps a
   * browser without backdrop-filter on an opaque bar rather than letting the
   * board scroll through the navigation.
   */
  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-ink/85 supports-[backdrop-filter]:bg-ink/70 supports-[backdrop-filter]:backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-[1180px] items-center gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-3 py-1" aria-label="Hunch VPM, home">
          {/*
            The staged lockup, used as it was drawn. It is never recoloured,
            never stretched — width and height move together — and never given
            a shadow or a glow. The padding around it is well over the 17-unit
            clear space the guidelines ask for.
          */}
          <img src="/brand/hunch-lockup.svg" alt="Hunch" width={113} height={24} className="h-6 w-auto" />
          <span className="hidden rounded-tag border border-lime/30 bg-lime/10 px-2 py-1 text-[10px] leading-none font-semibold tracking-[0.12em] text-lime uppercase sm:inline-block">
            VPM
          </span>
        </Link>

        <nav className="scroll-x -mx-1 flex min-w-0 flex-1 items-center gap-1" aria-label="Primary">
          {LINKS.map((link) => {
            const active = isActive(pathname, link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={`shrink-0 rounded-pill px-3.5 py-2 text-sm transition-colors ${
                  active
                    ? 'bg-paper/10 font-semibold text-paper'
                    : 'text-muted hover:bg-paper/5 hover:text-paper'
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <NetworkToggle />

        <ConnectWallet />
      </div>
    </header>
  );
}
