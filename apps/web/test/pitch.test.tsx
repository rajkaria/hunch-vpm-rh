import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { metadata } from '@/app/pitch/page';
import { CANVAS, bootScript, fit } from '@/components/pitch/boot';
import { Deck } from '@/components/pitch/Deck';
import { SLIDE_COUNT } from '@/components/pitch/parts';
import { SLIDES, SLIDE_LABELS } from '@/components/pitch/slides';
import {
  CHAIN_FACTS,
  CONTACT,
  EXAMPLE_FACTS,
  FEED_TICKERS,
  FEE_SCENARIOS,
  LIVE,
  MORE_FROM_HUNCH,
  PAPER,
  PROBLEM,
  TAILWINDS,
  TEAM,
  TRACK_RECORD,
  USE_OF_FUNDS,
  VISION,
  WAVE,
  entryCurve,
} from '@/content/pitch';
import { publicDeployment } from '@/lib/deployment';
import { LINKS } from '@/lib/site';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

/**
 * The investor deck (/pitch). The numbers on it are the ones the rest of the repository already
 * holds: the worked example from the contract mirror, the addresses from the deployment file, and
 * the dated production reads in content/pitch.ts. These tests pin the deck to them.
 */
describe('pitch deck: facts', () => {
  it('shows the worked example the contract pays, truncated to the cent', () => {
    expect(EXAMPLE_FACTS.mei.payout).toBe('69.16');
    expect(EXAMPLE_FACTS.mei.multiple).toBe('3.45×');
    expect(EXAMPLE_FACTS.mei.classic).toBe('42.50');
    expect(EXAMPLE_FACTS.ben.payout).toBe('56.25');
    expect(EXAMPLE_FACTS.ben.multiple).toBe('1.12×');
    expect(EXAMPLE_FACTS.ben.gain).toBe('6.25');
    expect(EXAMPLE_FACTS.ben.classic).toBe('106.25');
    expect(EXAMPLE_FACTS.classicMultiple).toBe('2.12×');
  });

  it("Dan's DOWN bet is paid straight to the UP side already standing", () => {
    expect(EXAMPLE_FACTS.dan).toMatchObject({ stake: '30', meiBefore: '20', meiAfter: '40', seedAfter: '20' });
  });

  it('draws the entry curve from the accumulators: down only on DOWN bets, ending at exactly 1x', () => {
    const curve = entryCurve();
    expect(curve.map((step) => step.ppm)).toEqual([3_458_333n, 2_458_333n, 1_125_000n, 1_000_000n]);
    expect(curve[0]!.from).toBe(0);
    expect(curve.at(-1)!.to).toBe(EXAMPLE_FACTS.weekHours);
    for (let i = 1; i < curve.length; i += 1) {
      expect(curve[i]!.from).toBe(curve[i - 1]!.to);
      expect(curve[i]!.ppm < curve[i - 1]!.ppm).toBe(true);
    }
    // A bet in the last window is paid what Ben was: his stake plus his share of Lee's 10.
    expect(curve[2]!.ppm).toBe(EXAMPLE_FACTS.ben.multiplePpm);
  });

  it('lists the deployed contracts and tickers from the deployment file', () => {
    const deployment = publicDeployment();
    expect(LIVE.chainId).toBe(4663);
    expect(LIVE.contracts.map((contract) => contract.address)).toEqual([
      deployment.contracts.HunchVPM.address,
      deployment.contracts.StockRoundResolver.address,
      deployment.contracts.HunchMarketFactory.address,
    ]);
    expect(LIVE.tickers).toEqual(['NVDA', 'TSLA', 'AAPL', 'COIN']);
    expect(LIVE.feeBps).toBe(200);
  });

  it('keeps the track record and the chain facts as dated reads', () => {
    expect(TRACK_RECORD.asOf).toBe('Sep 29, 2026');
    expect(TRACK_RECORD.engine.map((stat) => stat.value)).toEqual(['78,501', '1,034,149']);
    expect(TRACK_RECORD.money.map((stat) => stat.value)).toEqual(['119', '28', '69', '$931']);
    for (const fact of CHAIN_FACTS) expect(fact.note).toMatch(/2026|gwei/);
  });

  it('shows Hunch Cup and Bazaar as production reads, with no Bazaar count and no repeated Cup trade count', () => {
    expect(MORE_FROM_HUNCH.cup.stats.map((stat) => stat.value)).toEqual(['470,983', '58,341', '$0']);
    expect(MORE_FROM_HUNCH.cup.stats[0].label).toMatch(/agents/);
    expect(MORE_FROM_HUNCH.cup.status).toBe('Season 1 · Jul 8 to Aug 5');
    // The 2% fee is the same 200 bps every Bazaar market charges, half of it to the creator.
    expect(MORE_FROM_HUNCH.bazaar.stats.map((stat) => stat.value)).toEqual(['~1 min', '50%', '48 h']);
    expect(MORE_FROM_HUNCH.bazaar.stats[1].label).toContain(`${LIVE.feeBps / 100}% fee`);
    const cupText = JSON.stringify(MORE_FROM_HUNCH.cup);
    expect(cupText).not.toContain(TRACK_RECORD.engine[1].value);
  });

  it('names a source for every market figure, and keeps the wave chart in order', () => {
    for (const answer of PROBLEM.answers) expect(answer.source).toMatch(/2026/);
    for (const wind of TAILWINDS) expect(wind.source).toMatch(/2026/);
    expect(WAVE.source).toMatch(/Pew Research Center/);
    expect(WAVE.months.map((month) => month.value)).toEqual([5, 24, 25.7, 47.7, 53, 47]);
    expect(TAILWINDS[2].value).toBe(CHAIN_FACTS[0].value);
  });

  it('lists every Chainlink-priced Stock Token once, the live four first', () => {
    expect(FEED_TICKERS).toHaveLength(36);
    expect(new Set(FEED_TICKERS).size).toBe(FEED_TICKERS.length);
    expect(FEED_TICKERS.slice(0, LIVE.tickers.length)).toEqual(LIVE.tickers);
    expect(VISION.map((step) => step.count).slice(0, 2)).toEqual(['4', '36']);
  });

  it('quotes the paper as published, with the tournament caveat next to its numbers', () => {
    expect(PAPER.edition).toBe('2nd edition, Sep 2026');
    expect(PAPER.properties).toHaveLength(7);
    expect(PAPER.tape.trades).toBe('779,549');
    expect(PAPER.results.map((result) => result.value)).toEqual(['70.1% → 0.08%', '0 of 5,173']);
    expect(PAPER.caveat).toMatch(/paper-money tournament.*agents deployed by participants/);
  });

  it('works the fee scenarios out at 1% of volume, a year at a time', () => {
    expect(FEE_SCENARIOS).toEqual([
      { monthly: '$10M', yearly: '$1.2M' },
      { monthly: '$100M', yearly: '$12M' },
      { monthly: '$1B', yearly: '$120M' },
    ]);
  });

  it('splits the use of funds into exactly 100%', () => {
    expect(USE_OF_FUNDS.reduce((sum, use) => sum + use.share, 0)).toBe(100);
  });

  it('names both founders, full time', () => {
    expect(TEAM.map((person) => `${person.name}, ${person.role}`)).toEqual(['Raj Karia, Co-founder & CEO', 'Prachi Sahani, Co-founder & CTO']);
  });

  it("gives Raj's email, Telegram and X on the close, each with its link", () => {
    expect(`${CONTACT.name}, ${CONTACT.role}`).toBe('Raj Karia, Co-founder & CEO');
    expect(CONTACT.channels.map((channel) => [channel.kind, channel.handle, channel.href])).toEqual([
      ['Email', 'raj@playhunch.xyz', 'mailto:raj@playhunch.xyz'],
      ['Telegram', 't.me/rajkaria', 'https://t.me/rajkaria'],
      ['X', 'x.com/rajkaria_', 'https://x.com/rajkaria_'],
    ]);
  });
});

describe('pitch deck: slides', () => {
  it('has fifteen slides, each with a label, ending on the thanks', () => {
    expect(SLIDES).toHaveLength(SLIDE_COUNT);
    expect(SLIDE_LABELS).toHaveLength(SLIDE_COUNT);
    expect(SLIDE_COUNT).toBe(15);
    expect(SLIDE_LABELS.at(-1)).toBe('Thank you');
  });

  it('renders every slide with its page number, and no em dash', () => {
    SLIDES.forEach((Slide, i) => {
      const { container, unmount } = render(
        <div className="pitch-slide">
          <Slide />
        </div>,
      );
      const text = container.textContent ?? '';
      expect(text.length).toBeGreaterThan(120);
      expect(text).not.toContain('—');
      if (i > 0) expect(text).toContain(`${String(i + 1).padStart(2, '0')} / ${SLIDE_COUNT}`);
      unmount();
    });
  });

  it('puts the numbers on the slides they belong to', () => {
    const textOf = (index: number): string => {
      const Slide = SLIDES[index]!;
      const { container, unmount } = render(<Slide />);
      const text = container.textContent ?? '';
      unmount();
      return text;
    };
    expect(textOf(0)).toContain('every stock, every day');
    expect(textOf(0)).toContain('Will NVDA close UP today?');
    expect(textOf(0)).toContain('Bazaar');
    expect(textOf(0)).toContain('Hunch Cup');
    expect(textOf(0)).toContain('The Vested Parimutuel');
    expect(textOf(1)).toContain('$53B');
    expect(textOf(1)).toContain('$156M');
    expect(textOf(2)).toContain('9 in 10');
    expect(textOf(2)).toContain('65%');
    expect(textOf(3)).toContain('70.1%');
    expect(textOf(4)).toContain(EXAMPLE_FACTS.mei.multiple);
    expect(textOf(4)).toContain(EXAMPLE_FACTS.ben.multiple);
    expect(textOf(5)).toContain('70.1% → 0.08%');
    expect(textOf(5)).toContain('779,549');
    expect(textOf(7)).toContain('Hunch Cup');
    expect(textOf(7)).toContain('bazaar.playhunch.xyz');
    expect(textOf(7)).toContain('470,983');
    expect(textOf(8)).toContain('0x1c23…3576');
    expect(textOf(8)).toContain('78,501');
    expect(textOf(8)).toContain('$931');
    expect(textOf(9)).toContain('$120M');
    expect(textOf(10)).toContain('We price everything else');
    expect(textOf(12)).toContain('Prachi Sahani');
    expect(textOf(13)).toContain('Use of funds');
    expect(textOf(14)).toContain('Thank you');
    expect(textOf(14)).toContain('raj@playhunch.xyz');
    expect(textOf(14)).toContain('t.me/rajkaria');
    expect(textOf(14)).toContain('x.com/rajkaria_');
  });

  it('makes every contact on the close a working link', () => {
    const Slide = SLIDES[SLIDE_COUNT - 1]!;
    const { container, unmount } = render(<Slide />);
    const links = [...container.querySelectorAll('a')].map((a) => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), text: a.textContent ?? '' }));
    unmount();
    for (const channel of CONTACT.channels) {
      const link = links.find((candidate) => candidate.href === channel.href);
      expect(link?.text).toContain(channel.handle);
      // A mail link opens the mail app in place; the others open in a new tab.
      expect(link?.target).toBe(channel.kind === 'Email' ? null : '_blank');
    }
    expect(links.map((link) => link.href)).toEqual(expect.arrayContaining(['https://vpm.playhunch.xyz', LINKS.paper]));
  });

  it('is unlisted: noindex, nofollow', () => {
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
  });
});

describe('pitch deck: controller', () => {
  const slides = ['One', 'Two', 'Three'].map((word) => <p key={word}>{word}</p>);

  it('fits the 16:9 canvas to the window, and stacks on a narrow portrait screen', () => {
    expect(fit(1920, 1080)).toEqual({ mode: 'deck', scale: 1 });
    expect(fit(1440, 900).scale).toBeCloseTo(0.75);
    expect(fit(1000, 1200)).toEqual({ mode: 'deck', scale: 1000 / CANVAS.width });
    expect(fit(390, 844)).toEqual({ mode: 'stack', scale: 390 / CANVAS.width });
    expect(bootScript).toContain(`${CANVAS.width}`);
  });

  it('moves with the keys and keeps the slide number in the hash', () => {
    render(<Deck slides={slides} labels={['One', 'Two', 'Three']} />);
    const active = (): string | null => document.querySelector('[data-state="active"]')?.textContent ?? null;
    expect(active()).toBe('One');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(active()).toBe('Two');
    expect(window.location.hash).toBe('#2');
    fireEvent.keyDown(window, { key: 'End' });
    expect(active()).toBe('Three');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(active()).toBe('Three');
    fireEvent.keyDown(window, { key: 'Home' });
    expect(active()).toBe('One');
    fireEvent.keyDown(window, { key: '3' });
    expect(active()).toBe('Three');
  });

  it('opens on the slide named in the hash', () => {
    window.location.hash = '#2';
    render(<Deck slides={slides} labels={['One', 'Two', 'Three']} />);
    expect(document.querySelector('[data-state="active"]')?.textContent).toBe('Two');
  });

  it('has an overview that jumps to a slide', () => {
    render(<Deck slides={slides} labels={['One', 'Two', 'Three']} />);
    fireEvent.click(screen.getByRole('button', { name: 'All slides' }));
    const thumbs = screen.getByRole('dialog', { name: 'All slides' }).querySelectorAll('button');
    expect(thumbs).toHaveLength(3);
    fireEvent.click(thumbs[2]!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[data-state="active"]')?.textContent).toBe('Three');
  });

  it('labels the controls and offers the PDF', () => {
    render(<Deck slides={slides} labels={['One', 'Two', 'Three']} />);
    expect(screen.getByRole('button', { name: 'Previous slide' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('link', { name: 'Download as PDF' }).getAttribute('href')).toBe('/hunch-pitch-deck.pdf');
  });
});
