/** Every docs page, in reading order. The sidebar, the mobile drawer, prev/next and the sitemap read this. */

export interface DocEntry {
  slug: string;
  title: string;
  description: string;
  group: 'Start here' | 'Using Hunch' | 'Under the hood' | 'Reference';
}

export const DOCS: readonly DocEntry[] = [
  {
    slug: '',
    title: 'Overview',
    description: 'What Hunch on Robinhood Chain is, the markets it runs, and the facts that matter before a first bet.',
    group: 'Start here',
  },
  {
    slug: 'getting-started',
    title: 'Getting started',
    description: 'A wallet, USDG on Robinhood Chain, and your first bet, step by step, with what each error means.',
    group: 'Start here',
  },
  {
    slug: 'payouts',
    title: 'How payouts work',
    description: 'Why an early call is paid more, the 1.00× late rule, partial fills and the fee, with the worked example.',
    group: 'Using Hunch',
  },
  {
    slug: 'markets',
    title: 'Markets and settlement',
    description: 'Daily and weekly markets, trading sessions, the price in effect at the bell, refunds, round proofs and settling a market yourself.',
    group: 'Using Hunch',
  },
  {
    slug: 'gasless',
    title: 'Gasless betting',
    description: 'The one signature a bet takes, what exactly you sign, and what the relayer can and cannot do with it.',
    group: 'Using Hunch',
  },
  {
    slug: 'contracts',
    title: 'Contracts',
    description: 'Addresses, the powers table, invariants, the changes from the reference contract and how to verify each one.',
    group: 'Under the hood',
  },
  {
    slug: 'keeper',
    title: 'Keeper and operations',
    description: 'The jobs that list, settle and pay out markets, the refund policy, health checks, and how anyone can do each job.',
    group: 'Under the hood',
  },
  {
    slug: 'api',
    title: 'API',
    description: 'The read-only endpoints and the relay endpoint, with request and response shapes.',
    group: 'Under the hood',
  },
  {
    slug: 'risks',
    title: 'Risks and limits',
    description: 'What can go wrong, in plain words: stablecoin freezes, the chain operator, price feeds, beta limits, legal limits.',
    group: 'Reference',
  },
  {
    slug: 'faq',
    title: 'FAQ',
    description: 'Short answers to the questions a first-time bettor asks.',
    group: 'Reference',
  },
  {
    slug: 'glossary',
    title: 'Glossary',
    description: 'Every term these docs use, defined in plain words.',
    group: 'Reference',
  },
];

export function docHref(slug: string): string {
  return slug === '' ? '/docs' : `/docs/${slug}`;
}

export function docBySlug(slug: string): DocEntry {
  const entry = DOCS.find((candidate) => candidate.slug === slug);
  if (entry === undefined) throw new Error(`no docs page ${slug}`);
  return entry;
}

export const DOC_GROUPS = ['Start here', 'Using Hunch', 'Under the hood', 'Reference'] as const;
