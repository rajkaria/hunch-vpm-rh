import type { Metadata } from 'next';
import Link from 'next/link';

// S7: the connected wallet's positions across all markets replace this.

export const metadata: Metadata = { title: 'Portfolio', robots: { index: false } };

export default function PortfolioPage() {
  return (
    <section className="py-16">
      <h1 className="text-2xl">Your portfolio ships with the venue launch.</h1>
      <p className="mt-3 max-w-prose text-sm text-muted">
        Once markets are live, every position your wallet holds shows here with what it has earned so far.
      </p>
      <Link href="/" className="mt-6 inline-flex min-h-11 items-center text-sm font-semibold text-lime">
        Back to the home page
      </Link>
    </section>
  );
}
