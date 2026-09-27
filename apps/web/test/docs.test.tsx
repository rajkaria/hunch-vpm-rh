/**
 * The docs page claims it is not a simplification of the paper, so the formulas
 * printed on it are load-bearing: they are what an integrator copies. These
 * tests hold the prose to the arithmetic in `src/lib/vpm.ts`, which is itself
 * pinned to the settler by `vpm.test.ts`.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import DocsPage from '@/app/docs/page';
import { simulateEntry, type BookMath } from '@/lib/vpm';

afterEach(cleanup);

const usdc = (whole: number): bigint => BigInt(whole) * 1_000_000n;

function text(): string {
  return render(<DocsPage />).container.textContent ?? '';
}

describe('the acceptance rule on /docs', () => {
  it('rations against a demand that already includes the offer', () => {
    const rendered = text();
    expect(rendered).toContain('accepted = D_w > H_w ? floor(c × H_w / D_w) : c');
    // The wrong form tests D + c but divides by D, which over-accepts.
    expect(rendered).not.toContain('D + c > H');
  });

  it('says out loud that the offer is inside the denominator', () => {
    const rendered = text();
    expect(rendered).toContain('this entry’s own');
    expect(rendered).toContain('on both sides of the test and in the denominator');
  });

  it('states a worked number the settler agrees with', () => {
    // The page's example: 20,000 offered into 15,000 of headroom, nothing else
    // queued, is accepted at 15,000. H = C - V = 66,000 - 51,000.
    const books: BookMath[] = [
      { outcome: 0, principal: usdc(66_000), vested: usdc(2_200), capacity: usdc(1_980_000), demand: 0n, acc: 0n },
      { outcome: 1, principal: usdc(2_200), vested: usdc(51_000), capacity: usdc(66_000), demand: 0n, acc: 0n },
    ];
    expect(simulateEntry(books, 0, usdc(20_000)).accepted).toBe(usdc(15_000));
    expect(text()).toContain('accepted at 15,000');
  });

  it('keeps the other two formulas the settler’s', () => {
    const rendered = text();
    expect(rendered).toContain('H_w = C_w − V_w');
    expect(rendered).toContain('payout = floor(s × (S + A_ω(T) − A_ω(τ)) / S)');
    expect(rendered).toContain('floor(pool × stake / winningPrincipal)');
  });
});
