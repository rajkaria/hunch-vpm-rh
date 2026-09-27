import type { Metadata } from 'next';

import { Portfolio } from '@/components/portfolio/Portfolio';

export const metadata: Metadata = {
  title: 'Portfolio',
  description: 'Every position an address holds — open, frozen and settled.',
};

export default function PortfolioPage() {
  return (
    <div>
      <header className="mb-6">
        <h1 className="display-xl text-3xl sm:text-4xl">Portfolio</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
          Everything this address holds, open or not. The claim page lists only what can be pulled
          right now; most of a position&rsquo;s life is before that.
        </p>
      </header>

      <Portfolio />
    </div>
  );
}
