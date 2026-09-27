import type { Metadata, Viewport } from 'next';
import { Archivo, Inter, JetBrains_Mono } from 'next/font/google';

import { SiteFooter } from '@/components/chrome/SiteFooter';
import { SiteHeader } from '@/components/chrome/SiteHeader';
import { HERO_TITLE, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from '@/lib/site';
import './globals.css';

const archivo = Archivo({ subsets: ['latin'], weight: ['800'], variable: '--font-archivo', display: 'swap' });
const inter = Inter({ subsets: ['latin'], weight: ['400', '600'], variable: '--font-inter', display: 'swap' });
const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${SITE_NAME} · ${HERO_TITLE}`, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
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
      <body className="min-h-dvh bg-ink text-paper antialiased">
        <SiteHeader />
        <main id="main" className="mx-auto w-full max-w-[1180px] px-4 pb-24 pt-6 sm:px-6">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
