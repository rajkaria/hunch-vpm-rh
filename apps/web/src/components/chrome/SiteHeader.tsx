import Link from 'next/link';

import { HunchLockup } from '@/components/brand/HunchLockup';
import { ConnectSlot } from '@/components/wallet/ConnectSlot';

import { DesktopNav, MobileNav } from './NavLinks';

/**
 * 64 px, opaque ink, one hairline under it. No blur: the design system retired glass, and an
 * opaque bar is also the one that never lets the tape scroll through the navigation.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-ink">
      <div className="relative mx-auto flex h-16 w-full max-w-[1180px] items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="flex min-h-11 shrink-0 items-center gap-2.5" aria-label="Hunch on Robinhood Chain, home">
          <HunchLockup className="h-[22px] w-auto" title="Hunch" />
          <span className="hidden rounded-tag border border-edge px-1.5 py-1 text-[10px] leading-none font-semibold tracking-[0.06em] text-faint uppercase min-[360px]:inline-block">
            on Robinhood Chain
          </span>
        </Link>
        <div className="ml-auto flex items-center gap-2 lg:ml-6 lg:flex-1">
          <DesktopNav />
          <div className="flex items-center gap-2 lg:ml-auto">
            <div className="hidden sm:block">
              <ConnectSlot />
            </div>
            <MobileNav />
          </div>
        </div>
      </div>
    </header>
  );
}
