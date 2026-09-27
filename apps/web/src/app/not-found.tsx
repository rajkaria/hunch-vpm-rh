import type { Metadata } from 'next';
import Link from 'next/link';

import { Container } from '@/components/ui/Container';
import { ButtonLink } from '@/components/ui/primitives';

export const metadata: Metadata = { title: 'Not found', robots: { index: false } };

export default function NotFound() {
  return (
    <Container className="py-20 sm:py-28">
      <div className="max-w-xl">
        <p className="num text-sm text-faint">404</p>
        <h1 className="mt-3 text-[34px] leading-[1.05] sm:text-5xl">Nothing at this address.</h1>
        <p className="mt-4 text-[15px] leading-relaxed text-muted">
          No page or market lives here. If you followed a link to a market, it may have been mistyped; every market is
          listed on the home page.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <ButtonLink href="/#markets" variant="secondary">
            See the markets
          </ButtonLink>
          <Link href="/docs" className="inline-flex min-h-12 items-center px-2 text-[15px] font-semibold text-paper underline decoration-paper/25 underline-offset-4 hover:decoration-lime">
            Read the docs
          </Link>
        </div>
      </div>
    </Container>
  );
}
