import { SiteFooter } from '@/components/chrome/SiteFooter';
import { SiteHeader } from '@/components/chrome/SiteHeader';
import { ConnectModalHost } from '@/components/wallet/ConnectModalHost';

/**
 * The venue's chrome: every page a bettor uses sits between the header and the footer. The
 * route group exists so a page that is not part of the venue (the investor deck at /pitch) can
 * take the whole screen without the header or the wallet host.
 */
export default function VenueLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-control focus:bg-lime focus:px-4 focus:py-3 focus:text-sm focus:font-semibold focus:text-ink"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="min-w-0">
        {children}
      </main>
      <SiteFooter />
      {/* Loads nothing until someone asks to connect a wallet. */}
      <ConnectModalHost />
    </>
  );
}
