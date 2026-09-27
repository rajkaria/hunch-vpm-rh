import type { Metadata } from 'next';
import Link from 'next/link';

// S7: the market page (rules box, price panel, bet panel, book, resolution) replaces this.

export const metadata: Metadata = { title: 'Market', robots: { index: false } };

export default function MarketPage() {
  return (
    <section className="py-16">
      <h1 className="text-2xl">The market page ships with the venue launch.</h1>
      <p className="mt-3 max-w-prose text-sm text-muted">
        Markets open at the next opening bell once the venue is live. Until then nothing here takes a bet.
      </p>
      <Link href="/" className="mt-6 inline-flex min-h-11 items-center text-sm font-semibold text-lime">
        Back to the home page
      </Link>
    </section>
  );
}
