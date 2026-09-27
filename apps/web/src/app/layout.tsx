import type { Metadata, Viewport } from 'next';
import { Archivo, Inter, JetBrains_Mono } from 'next/font/google';

import { SiteFooter } from '@/components/chrome/SiteFooter';
import { SiteHeader } from '@/components/chrome/SiteHeader';
import { MainnetNotice } from '@/components/wallet/MainnetNotice';
import { NetworkBanner } from '@/components/wallet/NetworkBanner';
import { NetworkSync } from '@/components/wallet/NetworkSync';
import { WalletProvider } from '@/components/wallet/WalletProvider';
import { NETWORKS, isDeployed } from '@/lib/chain';
import { dataSourceFor } from '@/lib/data';
import { selectedNetwork } from '@/lib/network-server';
import './globals.css';

/*
 * Archivo for display, Inter for body, JetBrains Mono for numerals. Each is
 * loaded with only the weights this surface uses — 800 is the display ceiling,
 * and there is no 900 in the system to reach for.
 */
const archivo = Archivo({
  subsets: ['latin'],
  weight: ['800'],
  variable: '--font-archivo',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '600'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains',
  display: 'swap',
});

const DESCRIPTION =
  'A parimutuel market where stake vests into the opposing books the moment it lands, and is accepted only up to the room those books have to cover it. Live on Arc, settled in USDC.';

export const metadata: Metadata = {
  metadataBase: new URL('https://vpm.playhunch.xyz'),
  title: {
    default: 'Hunch VPM — the vested parimutuel',
    template: '%s — Hunch VPM',
  },
  description: DESCRIPTION,
  applicationName: 'Hunch VPM',
  openGraph: {
    type: 'website',
    siteName: 'Hunch VPM',
    title: 'Hunch VPM — the vested parimutuel',
    description: DESCRIPTION,
    url: 'https://vpm.playhunch.xyz',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Hunch' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Hunch VPM — the vested parimutuel',
    description: DESCRIPTION,
    images: ['/og.png'],
  },
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  manifest: '/site.webmanifest',
};

export const viewport: Viewport = {
  themeColor: '#08080A',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const network = await selectedNetwork();
  const source = dataSourceFor(network);
  // Before launch, the mainnet notice already explains the sample; saying it twice is clutter.
  const mainnetPrelaunch = network === 'mainnet' && !isDeployed(NETWORKS.mainnet.addresses.vestedParimutuel);

  return (
    <html lang="en" className={`${archivo.variable} ${inter.variable} ${jetbrains.variable}`}>
      <body className="min-h-dvh bg-ink text-paper antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-lime focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink"
        >
          Skip to content
        </a>
        <WalletProvider initialNetwork={network}>
          <NetworkSync rendered={network} />
          <SiteHeader />
          <main id="main" className="mx-auto w-full max-w-[1180px] px-4 pb-24 pt-6 sm:px-6">
            {source.kind === 'fixture' && !mainnetPrelaunch ? <FixtureNotice /> : null}
            <MainnetNotice />
            <NetworkBanner />
            {children}
          </main>
          <SiteFooter network={network} />
        </WalletProvider>
      </body>
    </html>
  );
}

/**
 * The surface says where its numbers come from. Nothing is deployed yet, and a
 * page that looks like a live venue while reading a fixture is the one thing
 * that would make every other number on it untrustworthy.
 */
function FixtureNotice() {
  return (
    <div className="lift mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-edge bg-raised px-4 py-3 text-sm">
      <span className="inline-flex items-center rounded-tag border border-amber/35 bg-amber/10 px-2.5 py-1 text-[11px] leading-none font-semibold tracking-[0.05em] whitespace-nowrap text-amber uppercase">
        Sample data
      </span>
      <span className="text-muted">
        This network&rsquo;s index is not connected, so these markets are a sample. Every book is replayed through
        the settler&rsquo;s own rules, so the arithmetic is real even though the markets are not.
      </span>
    </div>
  );
}
