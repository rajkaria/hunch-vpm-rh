import { closingBell, loadDeployment, openingBell, deploymentParams, type FeedConfig } from '@hunch-rh/client';
import { describe, expect, it } from 'vitest';
import { decideOpen, planRefundDrill, type ExistingListing, type OpenInput } from '../src/index.js';

const d = loadDeployment({ env: {} });
const params = deploymentParams(d);
const utc = (y: number, m: number, day: number, h: number, min = 0) => Date.UTC(y, m - 1, day, h, min) / 1000;
// COIN passed its FLAT-rate check on 2026-09-28 and is live in the deployment; these tests pin it
// back to pending so the hold-back path stays covered.
const liveFeeds: FeedConfig[] = d.feeds.map((f) => (f.ticker === 'COIN' ? { ...f, pendingFlatRateCheck: true } : f));

function input(nowSec: number, over: Partial<OpenInput> = {}): OpenInput {
  return { nowSec, feeds: liveFeeds, listings: [], corporateActions: [], params, ...over };
}

const summary = (r: ReturnType<typeof decideOpen>) =>
  r.open.map((o) => `${o.ticker} ${o.family} ${new Date(Number(o.params.strikeTime) * 1000).toISOString().slice(5, 16)}→${new Date(Number(o.params.finalTime) * 1000).toISOString().slice(5, 16)}`);

describe('T9 · open: which markets to list for a given ET time', () => {
  it('Monday before the bell: daily + Mon→Fri weekly for every live ticker; COIN held back', () => {
    const r = decideOpen(input(utc(2026, 10, 5, 12, 0)));
    expect(summary(r)).toEqual([
      'NVDA daily 10-05T13:30→10-05T20:00',
      'TSLA daily 10-05T13:30→10-05T20:00',
      'AAPL daily 10-05T13:30→10-05T20:00',
      'NVDA weekly 10-05T13:30→10-09T20:00',
      'TSLA weekly 10-05T13:30→10-09T20:00',
      'AAPL weekly 10-05T13:30→10-09T20:00',
    ]);
    expect(r.skipped.filter((s) => s.ticker === 'COIN').map((s) => s.reason)).toEqual([
      'COIN is held back until its FLAT-rate check passes',
      'COIN is held back until its FLAT-rate check passes',
    ]);
    const nvda = r.open[0]!;
    expect(nvda.params).toMatchObject({ seedPerLeg: 10_000_000n, minEntry: 1_000_000n, maxEntry: 100_000_000n, maxStrikeAge: 0, maxFinalAge: 0 });
    expect(nvda.question).toBe('Will NVDA close UP today? · Mon Oct 5');
    expect(r.open[3]!.question).toBe('Will NVDA finish the week UP? · Mon Oct 5 → Fri Oct 9');
  });

  it('launch week: Monday after the bell opens the Tue → Fri catch-up weekly, not a daily', () => {
    const r = decideOpen(input(utc(2026, 9, 28, 15, 0)));
    expect(summary(r)).toEqual([
      'NVDA weekly 09-29T13:30→10-02T20:00',
      'TSLA weekly 09-29T13:30→10-02T20:00',
      'AAPL weekly 09-29T13:30→10-02T20:00',
    ]);
    expect(r.skipped.find((s) => s.ticker === 'NVDA' && s.family === 'daily')?.reason).toBe("past today's opening bell");
    expect(r.open[0]!.question).toBe('Will NVDA finish the week UP? · Tue Sep 29 → Fri Oct 2');
    expect(r.open[0]!.reason).toMatch(/catch-up/);
  });

  it('launch week: Tuesday before the bell opens the daily and the catch-up weekly (4 sessions left)', () => {
    const r = decideOpen(input(utc(2026, 9, 29, 12, 10)));
    expect(summary(r)).toContain('NVDA daily 09-29T13:30→09-29T20:00');
    expect(summary(r)).toContain('NVDA weekly 09-29T13:30→10-02T20:00');
  });

  it('no catch-up weekly with fewer than 3 sessions left', () => {
    const r = decideOpen(input(utc(2026, 10, 1, 12, 0)));
    expect(r.open.filter((o) => o.family === 'weekly')).toEqual([]);
    expect(r.skipped.find((s) => s.family === 'weekly')!.reason).toMatch(/2 session\(s\) remain/);
  });

  it('NYSE holiday: no daily; the holiday week has too few sessions left for a weekly', () => {
    const r = decideOpen(input(utc(2026, 11, 26, 12, 0)));
    expect(r.open).toEqual([]);
    expect(r.skipped.find((s) => s.family === 'daily')!.reason).toBe('2026-11-26 is not an NYSE trading day');
  });

  it('early close: the daily finals at 13:00 ET (18:00 UTC, EST)', () => {
    const r = decideOpen(input(utc(2026, 11, 27, 13, 0)));
    expect(summary(r).filter((s) => s.includes('daily'))).toEqual([
      'NVDA daily 11-27T14:30→11-27T18:00',
      'TSLA daily 11-27T14:30→11-27T18:00',
      'AAPL daily 11-27T14:30→11-27T18:00',
    ]);
  });

  it('DST boundary Sun 2026-11-01: Friday opens 13:30 UTC, Monday 14:30 UTC', () => {
    expect(summary(decideOpen(input(utc(2026, 10, 30, 12, 0)))).filter((s) => s.includes('daily'))[0]).toBe('NVDA daily 10-30T13:30→10-30T20:00');
    const mon = summary(decideOpen(input(utc(2026, 11, 2, 13, 0))));
    expect(mon).toContain('NVDA daily 11-02T14:30→11-02T21:00');
    expect(mon).toContain('NVDA weekly 11-02T14:30→11-06T21:00');
    // 13:40 UTC on Monday is still before the EST bell: the daily is still listable.
    expect(summary(decideOpen(input(utc(2026, 11, 2, 13, 40)))).some((s) => s.startsWith('NVDA daily'))).toBe(true);
  });

  it('weekend: no daily; next week’s weekly is listable ahead of its strike', () => {
    const r = decideOpen(input(utc(2026, 10, 3, 12, 0)));
    expect(r.open.every((o) => o.family === 'weekly')).toBe(true);
    expect(summary(r)[0]).toBe('NVDA weekly 10-05T13:30→10-09T20:00');
  });

  it('skips a ticker with a corporate action in the window (weekly), keeps unaffected windows', () => {
    const r = decideOpen(
      input(utc(2026, 9, 29, 12, 0), {
        corporateActions: [{ ticker: 'NVDA', date: '2026-09-30', kind: 'split', source: 'https://example.com/nvda-split' }],
      }),
    );
    expect(summary(r)).toContain('NVDA daily 09-29T13:30→09-29T20:00');
    expect(summary(r).some((s) => s.startsWith('NVDA weekly'))).toBe(false);
    expect(r.skipped.find((s) => s.ticker === 'NVDA' && s.family === 'weekly')!.reason).toBe('corporate action (split 2026-09-30) in the window');
  });

  it('respects the factory allow-list', () => {
    const allowList = new Map(liveFeeds.map((f) => [f.feed.toLowerCase(), { allowed: f.ticker !== 'TSLA' }]));
    const r = decideOpen(input(utc(2026, 10, 5, 12, 0), { allowList }));
    expect(r.open.some((o) => o.ticker === 'TSLA')).toBe(false);
    expect(r.skipped.find((s) => s.ticker === 'TSLA')!.reason).toBe("TSLA's feed is not allow-listed on the factory");
  });

  it('is idempotent: a second run over its own listings opens nothing', () => {
    for (const now of [utc(2026, 10, 5, 12, 0), utc(2026, 9, 28, 15, 0), utc(2026, 11, 27, 13, 0)]) {
      const first = decideOpen(input(now));
      const listings: ExistingListing[] = first.open.map((o) => ({
        feed: o.feed,
        strikeTime: Number(o.params.strikeTime),
        finalTime: Number(o.params.finalTime),
        maxFinalAge: 93_600,
      }));
      expect(decideOpen(input(now, { listings })).open).toEqual([]);
      // …including a later run the next morning: this week's weekly (standard or catch-up) is
      // recognised; only a NEW week's weekly may appear (e.g. Saturday after an early-close Friday).
      const weekFinals = new Set(listings.filter((l) => l.finalTime - l.strikeTime > 86_400).map((l) => l.finalTime));
      const later = decideOpen(input(now + 86_400, { listings })).open.filter((o) => o.family === 'weekly');
      expect(later.filter((o) => weekFinals.has(Number(o.params.finalTime)))).toEqual([]);
    }
  });

  it('refuses years the calendar does not cover', () => {
    const r = decideOpen(input(utc(2027, 12, 28, 12, 0)));
    expect(r.open).toEqual([]);
    expect(r.skipped[0]!.reason).toMatch(/does not cover/);
  });
});

describe('T9 · refund drill plan', () => {
  it("Friday's open → Saturday 06:00 UTC with a 1 h final bound, verbatim question", () => {
    const r = planRefundDrill({ nowSec: utc(2026, 10, 1, 12, 0), feed: liveFeeds[0]!, params });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.params.strikeTime).toBe(BigInt(openingBell('2026-10-02')));
    expect(r.plan.params.finalTime).toBe(BigInt(utc(2026, 10, 3, 6, 0)));
    expect(r.plan.params.maxFinalAge).toBe(3600);
    expect(r.plan.params.maxStrikeAge).toBe(0);
    expect(r.plan.question).toBe("Refund drill: NVDA UP from Friday's open to 2:00 am ET Saturday?");
    expect(Number(r.plan.params.finalTime - r.plan.params.strikeTime)).toBeLessThanOrEqual(8 * 86_400);
    expect(Number(r.plan.params.finalTime)).toBeGreaterThan(closingBell('2026-10-02'));
  });

  it('skips a Friday holiday (Good Friday 2027) and refuses a duplicate', () => {
    const r = planRefundDrill({ nowSec: utc(2027, 3, 25, 12, 0), feed: liveFeeds[0]!, params });
    expect(r.ok && r.plan.params.strikeTime).toBe(BigInt(openingBell('2027-04-02')));
    const first = planRefundDrill({ nowSec: utc(2026, 10, 1, 12, 0), feed: liveFeeds[0]!, params });
    if (!first.ok) throw new Error('expected a plan');
    const again = planRefundDrill({
      nowSec: utc(2026, 10, 1, 12, 0),
      feed: liveFeeds[0]!,
      params,
      listings: [{ feed: first.plan.feed, strikeTime: Number(first.plan.params.strikeTime), finalTime: Number(first.plan.params.finalTime), maxFinalAge: 3600 }],
    });
    expect(again.ok).toBe(false);
  });

  it('after EST starts, Saturday 06:00 UTC is 1:00 am ET', () => {
    const r = planRefundDrill({ nowSec: utc(2026, 11, 5, 12, 0), feed: liveFeeds[0]!, params });
    expect(r.ok && r.plan.question).toBe("Refund drill: NVDA UP from Friday's open to 1:00 am ET Saturday?");
  });
});
