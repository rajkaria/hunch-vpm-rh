import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { metadata } from '@/app/pitch/page';
import { CANVAS, bootScript, fit } from '@/components/pitch/boot';
import { Deck } from '@/components/pitch/Deck';
import { SLIDE_COUNT } from '@/components/pitch/parts';
import { SLIDES, SLIDE_LABELS } from '@/components/pitch/slides';
import { CHAIN_FACTS, EXAMPLE_FACTS, LIVE, TEAM, TRACK_RECORD, USE_OF_FUNDS, entryCurve } from '@/content/pitch';
import { publicDeployment } from '@/lib/deployment';

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

  it('splits the use of funds into exactly 100%', () => {
    expect(USE_OF_FUNDS.reduce((sum, use) => sum + use.share, 0)).toBe(100);
  });

  it('names both founders, full time', () => {
    expect(TEAM.map((person) => `${person.name}, ${person.role}`)).toEqual(['Raj Karia, Co-founder & CEO', 'Prachi Sahani, Co-founder & CTO']);
  });
});

describe('pitch deck: slides', () => {
  it('has eleven slides, each with a label', () => {
    expect(SLIDES).toHaveLength(SLIDE_COUNT);
    expect(SLIDE_LABELS).toHaveLength(SLIDE_COUNT);
    expect(SLIDE_COUNT).toBe(11);
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
      if (i > 0) expect(text).toContain(`${String(i + 1).padStart(2, '0')} / 11`);
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
    expect(textOf(0)).toContain('Call it early.');
    expect(textOf(3)).toContain('69.16');
    expect(textOf(3)).toContain('106.25');
    expect(textOf(6)).toContain('0x1c23…3576');
    expect(textOf(7)).toContain('78,501');
    expect(textOf(7)).toContain('$931');
    expect(textOf(9)).toContain('Prachi Sahani');
    expect(textOf(10)).toContain('Use of funds');
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
