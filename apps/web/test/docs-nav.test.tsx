import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/docs/payouts' }));

import { DocsNav } from '@/components/docs/DocsNav';
import { DOCS, docHref } from '@/content/docs-nav';

afterEach(cleanup);

describe('docs nav', () => {
  it('has every section the brief asks for, in order', () => {
    expect(DOCS.map((doc) => doc.title)).toEqual([
      'Overview',
      'Getting started',
      'How payouts work',
      'Markets and settlement',
      'Gasless betting',
      'Contracts',
      'Keeper and operations',
      'API',
      'Risks and limits',
      'FAQ',
      'Glossary',
    ]);
  });

  it('renders a link to every docs page and marks the current one', () => {
    render(<DocsNav />);
    for (const doc of DOCS) {
      const link = screen.getByRole('link', { name: doc.title });
      expect(link.getAttribute('href')).toBe(docHref(doc.slug));
    }
    expect(screen.getByRole('link', { name: 'How payouts work' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getAllByRole('link')).toHaveLength(DOCS.length);
  });
});
