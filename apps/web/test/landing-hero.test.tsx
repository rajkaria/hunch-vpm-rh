import { cleanup, render, screen } from '@testing-library/react';
import { deploymentParams } from '@hunch-rh/client';
import { afterEach, describe, expect, it } from 'vitest';

import { Hero } from '@/components/landing/Hero';
import { publicDeployment } from '@/lib/deployment';
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
    const lines = [...container.querySelectorAll('h1 > span, p, a, li, span.uppercase, dt, dd')].map((node) => node.textContent?.trim());
    expect(lines).toMatchInlineSnapshot(`
      [
        "Launching on Robinhood ChainNVDA · TSLA",
        "Launching on Robinhood Chain",
        "Call it early.",
        "Get paid more.",
        "Prediction markets on Robinhood Stock Tokens, in USDG on Robinhood Chain. Open until the closing bell. Settled by Chainlink.",
        "Get set up in 2 minutes",
        "How it works",
        "Bets close",
        "At the bell",
        "Per bet",
        "1–25 USDG",
        "ETH needed",
        "None",
      ]
    `);
  });

  it('switches its one primary action to the live markets once they exist', () => {
    render(<Hero live liveCount={2} />);
    expect(screen.getByText('Live on Robinhood Chain')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See live markets' }).getAttribute('href')).toBe('#markets');
    expect(screen.queryByText('Launching on Robinhood Chain')).toBeNull();
  });

  it('never says "live" about markets between sessions, when none is taking bets', () => {
    render(<Hero live liveCount={0} />);
    expect(screen.getByRole('link', { name: 'See the markets' }).getAttribute('href')).toBe('#markets');
    expect(screen.queryByRole('link', { name: 'See live markets' })).toBeNull();
    expect(screen.queryByText('Live now')).toBeNull();
    expect(screen.getByText('At the bell')).toBeTruthy();
  });

  it('counts the live markets in the fact strip once the venue is live, and only then', () => {
    const { container, unmount } = render(<Hero live liveCount={6} />);
    const strip = container.querySelector('dl');
    expect(strip?.textContent).toContain('Live now');
    expect(strip?.textContent).toContain('6');
    unmount();
    render(<Hero live={false} liveCount={6} />);
    expect(screen.queryByText('Live now')).toBeNull();
    expect(screen.getByText('At the bell')).toBeTruthy();
  });

  it('takes the bet limits in the strip from the deployment, not from a literal', () => {
    const { container } = render(<Hero live={false} />);
    const perBet = [...container.querySelectorAll('dt')].find((node) => node.textContent === 'Per bet')?.nextElementSibling;
    const p = deploymentParams(publicDeployment());
    expect(perBet?.textContent).toBe(`${p.minEntry / 1_000_000n}–${p.maxEntry / 1_000_000n} USDG`);
  });
});
