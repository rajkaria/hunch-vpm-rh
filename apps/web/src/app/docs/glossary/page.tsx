import type { Metadata } from 'next';

import { DocPage } from '@/components/docs/DocPage';
import { H2, P, Terms } from '@/components/docs/prose';
import { GLOSSARY } from '@/content/glossary';

export const metadata: Metadata = {
  title: 'Glossary',
  description: 'Every term the Hunch docs use, defined in plain words: accepted, accrued, round, seed, strike, vintage, κ and more.',
  alternates: { canonical: '/docs/glossary' },
};

const VENUE_TERMS = [
  {
    id: 'bell',
    term: 'Opening and closing bell',
    definition: '9:30 am and 4:00 pm New York time on a NYSE trading day (1:00 pm on an early-close day). Bets close at the closing bell.',
  },
  {
    id: 'stock-token',
    term: 'Stock Token',
    definition:
      "Robinhood's tokenized share on Robinhood Chain. Markets here are on its Chainlink price; the contracts never hold Stock Tokens.",
  },
  { id: 'usdg', term: 'USDG', definition: "Paxos's Global Dollar, the chain's native dollar, with 6 decimals. The only stake and payout asset." },
  { id: 'position', term: 'Position', definition: 'One bet: its owner, side, amount offered, amount accepted, and when it landed.' },
  {
    id: 'headroom',
    term: 'Room (headroom)',
    definition: 'How much more one side can accept right now, given what the other side can cover. The bet panel quotes it before you sign.',
  },
  { id: 'freeze', term: 'Freeze', definition: 'The moment a market stops taking bets: its closing bell. Fixed when the market is listed.' },
  {
    id: 'spec',
    term: 'Spec',
    definition:
      "A market's settlement terms: feed, Stock Token, both bell times and both age limits. Hashed into a spec id when listed and never changed.",
  },
  { id: 'keeper', term: 'Keeper', definition: "Hunch's scheduled program that lists, settles and pays out markets. Anyone can do what it does." },
  {
    id: 'relayer',
    term: 'Relayer',
    definition: 'The service that sends a signed bet and pays its gas. It cannot change the market, side or amount you signed.',
  },
  {
    id: 'safe',
    term: 'Safe',
    definition: 'A multi-signature wallet. Hunch\'s Safe can pause new bets and allow-list feeds and listers, and receives fees.',
  },
  {
    id: 'ordinary-pool',
    term: 'Ordinary pool',
    definition: 'A pool that splits the pot at the end in proportion to stake, whenever the stake arrived. Shown after settlement for comparison.',
  },
] as const;

export default function GlossaryDoc() {
  return (
    <DocPage slug="glossary">
      <H2 id="venue">The venue</H2>
      <Terms items={VENUE_TERMS} />
      <H2 id="mechanism">The payout rule</H2>
      <P>The vocabulary of the design itself, also on How it works under For the curious.</P>
      <Terms items={GLOSSARY} />
    </DocPage>
  );
}
