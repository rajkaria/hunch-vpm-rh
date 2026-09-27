import type { Metadata } from 'next';

import { DocPage } from '@/components/docs/DocPage';
import { FaqList } from '@/components/faq/FaqList';
import { FAQ } from '@/content/faq';

export const metadata: Metadata = {
  title: 'FAQ',
  description: 'Short answers to the questions a first-time Hunch bettor asks: early payouts, late bets, gas, settlement, refunds, fees, safety.',
  alternates: { canonical: '/docs/faq' },
};

export default function FaqDoc() {
  return (
    <DocPage slug="faq">
      <FaqList items={FAQ} headingLevel="h2" />
    </DocPage>
  );
}
