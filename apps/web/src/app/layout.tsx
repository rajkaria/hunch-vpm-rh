import { Analytics } from '@vercel/analytics/next';
import type { Metadata, Viewport } from 'next';
import { Archivo, Inter, JetBrains_Mono } from 'next/font/google';

import { SiteFooter } from '@/components/chrome/SiteFooter';
import { SiteHeader } from '@/components/chrome/SiteHeader';
import { ConnectModalHost } from '@/components/wallet/ConnectModalHost';
import { HERO_TITLE, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from '@/lib/site';
import './globals.css';

/*
 * Archivo for display, Inter for body, JetBrains Mono for numerals, each with only the weights
 * this surface uses. 800 is the display ceiling; there is no 900 in the system.
 */
const archivo = Archivo({ subsets: ['latin'], weight: ['800'], variable: '--font-archivo', display: 'swap' });
const inter = Inter({ subsets: ['latin'], weight: ['400', '600'], variable: '--font-inter', display: 'swap' });
const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains',
  display: 'swap',
});

const TITLE = `${SITE_NAME} · ${HERO_TITLE}`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: TITLE,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: SITE_DESCRIPTION,
  },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '32x32' },
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  formatDetection: { telephone: false, address: false, email: false },
};

export const viewport: Viewport = {
  themeColor: '#08080A',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${inter.variable} ${jetbrains.variable}`}>
      <body className="min-h-dvh overflow-x-clip bg-ink text-paper antialiased">
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
        <Analytics />
      </body>
    </html>
  );
}
