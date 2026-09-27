import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Hero } from '@/components/landing/Hero';
import { HERO_SUB, HERO_TITLE } from '@/lib/site';

afterEach(cleanup);

/**
 * The first screen's copy is fixed by docs/spec/05-web-app.md. The snapshot is the lint: any
 * change to the hero's words has to be made here on purpose, and copy-lint.test.ts holds the
 * same words to the jargon and em-dash rules.
 */
describe('landing hero', () => {
  it('says exactly the spec headline and sub', () => {
    render(<Hero live={false} />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Call it early.Get paid more.');
    expect(HERO_TITLE).toBe('Call it early. Get paid more.');
    expect(HERO_SUB).toBe(
      'Prediction markets on Robinhood Stock Tokens, in USDG on Robinhood Chain. Open until the closing bell. Settled by Chainlink.',
    );
    expect(screen.getByText(HERO_SUB)).toBeTruthy();
  });

  it('matches the first-screen copy snapshot before launch', () => {
    const { container } = render(<Hero live={false} />);
    const lines = [...container.querySelectorAll('h1 > span, p, a, li, span.uppercase')].map((node) => node.textContent?.trim());
    expect(lines).toMatchInlineSnapshot(`
      [
        "Launching on Robinhood Chain",
        "USDG · no ETH needed",
        "Call it early.",
        "Get paid more.",
        "Prediction markets on Robinhood Stock Tokens, in USDG on Robinhood Chain. Open until the closing bell. Settled by Chainlink.",
        "Get set up in 2 minutes",
        "How it works",
        "Open until the bell",
        "One signature per bet",
        "No one types in a price",
      ]
    `);
  });

  it('switches its one primary action to the live markets once they exist', () => {
    render(<Hero live />);
    expect(screen.getByText('Live on Robinhood Chain')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See live markets' }).getAttribute('href')).toBe('#markets');
    expect(screen.queryByText('Launching on Robinhood Chain')).toBeNull();
  });
});
