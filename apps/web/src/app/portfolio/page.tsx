import type { Metadata } from 'next';

import { PortfolioView } from '@/components/portfolio/PortfolioView';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/primitives';
import { readDeployment } from '@/lib/deployment';

export const metadata: Metadata = { title: 'Your positions', robots: { index: false } };

/** `/portfolio`: the connected wallet's positions across every market (a client island over `/api/positions`). */
export default function PortfolioPage() {
  return (
    <Container className="pb-24 pt-12 sm:pt-16">
      <SectionHeading
        as="h1"
        eyebrow="Portfolio"
        title="Your positions"
        lead="Every bet from the connected wallet, what each is worth if its side wins now, and what has been paid. Payouts arrive in your wallet automatically after settlement."
      />
      <div className="mt-10">
        <PortfolioView deploymentOverride={readDeployment()} />
      </div>
    </Container>
  );
}
