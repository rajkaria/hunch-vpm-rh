import {
  DRILL_MAX_FINAL_AGE,
  addDays,
  etDateOf,
  isCovered,
  isTradingDay,
  openingBell,
  questionFor,
  sessionOn,
  weekdayOf,
  weeklyWindow,
  currentOrNextSession,
  type FeedConfig,
  type UpDownParams,
} from '@hunch-rh/client';
import type { Address } from 'viem';
import { corporateActionIn, type CorporateAction } from '../calendar.js';

/**
 * Which markets the `open` job lists (docs/spec/06, 04 §Catalogue). Pure: given the time,
 * the feed table, the factory's allow-list and the existing listings, it returns the
 * `openUpDown` params to send. Idempotent: an existing listing with the same feed, strike
 * and final is never opened twice.
 */

export type OpenFamily = 'daily' | 'weekly';

export interface ExistingListing {
  feed: Address;
  strikeTime: number;
  finalTime: number;
  maxFinalAge: number;
}

export interface FeedAllowance {
  allowed: boolean;
}

export interface OpenInput {
  nowSec: number;
  /** The deployment's feed table. */
  feeds: readonly FeedConfig[];
  /** The factory's allow-list by lower-cased feed address (omit before reading it). */
  allowList?: ReadonlyMap<string, FeedAllowance>;
  listings: readonly ExistingListing[];
  corporateActions: readonly CorporateAction[];
  params: { seedPerLeg: bigint; minEntry: bigint; maxEntry: bigint };
}

export interface OpenPlan {
  ticker: string;
  family: OpenFamily | 'drill';
  feed: Address;
  params: UpDownParams;
  question: string;
  reason: string;
}

export interface OpenSkip {
  ticker: string;
  family: OpenFamily;
  reason: string;
}

export interface OpenDecision {
  open: OpenPlan[];
  skipped: OpenSkip[];
}

/** Sessions a launch-week catch-up weekly needs (including the next one). */
export const CATCH_UP_MIN_SESSIONS = 3;

function same(l: ExistingListing, feed: Address, strike: number, final: number): boolean {
  return l.feed.toLowerCase() === feed.toLowerCase() && l.strikeTime === strike && l.finalTime === final;
}

function isWeeklyListing(l: ExistingListing): boolean {
  return l.maxFinalAge > DRILL_MAX_FINAL_AGE && etDateOf(l.strikeTime) !== etDateOf(l.finalTime);
}

export function decideOpen(input: OpenInput): OpenDecision {
  const { nowSec } = input;
  const out: OpenDecision = { open: [], skipped: [] };
  const today = etDateOf(nowSec);
  const families: OpenFamily[] = ['daily', 'weekly'];
  if (!isCovered(today) || !isCovered(addDays(today, 7))) {
    for (const f of input.feeds) for (const fam of families) out.skipped.push({ ticker: f.ticker, family: fam, reason: `the NYSE calendar does not cover ${today.slice(0, 4)}` });
    return out;
  }

  const plan = (f: FeedConfig, family: OpenFamily, strike: number, final: number, reason: string) => {
    const skip = (why: string) => out.skipped.push({ ticker: f.ticker, family, reason: why });
    if (!f.families.includes(family)) return skip(`${family} markets are not enabled for ${f.ticker}`);
    if (f.pendingFlatRateCheck === true) return skip(`${f.ticker} is held back until its FLAT-rate check passes`);
    const allowance = input.allowList?.get(f.feed.toLowerCase());
    if (input.allowList !== undefined && allowance?.allowed !== true) return skip(`${f.ticker}'s feed is not allow-listed on the factory`);
    if (input.listings.some((l) => same(l, f.feed, strike, final))) return skip('already listed');
    const action = corporateActionIn(input.corporateActions, f.ticker, etDateOf(strike), etDateOf(final));
    if (action !== null) return skip(`corporate action (${action.kind} ${action.date}) in the window`);
    if (final <= nowSec) return skip('the window has already closed');
    const params: UpDownParams = {
      feed: f.feed,
      strikeTime: BigInt(strike),
      finalTime: BigInt(final),
      maxStrikeAge: 0,
      maxFinalAge: 0,
      seedPerLeg: input.params.seedPerLeg,
      minEntry: input.params.minEntry,
      maxEntry: input.params.maxEntry,
    };
    out.open.push({
      ticker: f.ticker,
      family,
      feed: f.feed,
      params,
      question: questionFor({ ticker: f.ticker, strikeTime: strike, finalTime: final, maxFinalAge: f.maxFinalAge }),
      reason,
    });
  };

  // Daily: today's session, only before its opening bell.
  const todaySession = isTradingDay(today) ? sessionOn(today) : null;
  for (const f of input.feeds) {
    if (todaySession === null) out.skipped.push({ ticker: f.ticker, family: 'daily', reason: `${today} is not an NYSE trading day` });
    else if (nowSec >= todaySession.open) out.skipped.push({ ticker: f.ticker, family: 'daily', reason: "past today's opening bell" });
    else plan(f, 'daily', todaySession.open, todaySession.close, `today's session ${today}`);
  }

  // Weekly: the week of the current (or next) session.
  const anchor = currentOrNextSession(nowSec);
  const week = weeklyWindow(anchor.date);
  for (const f of input.feeds) {
    if (week === null || week.sessions.length < 2) {
      out.skipped.push({ ticker: f.ticker, family: 'weekly', reason: 'this week has fewer than two sessions' });
      continue;
    }
    if (nowSec < week.strikeTime) {
      plan(f, 'weekly', week.strikeTime, week.finalTime, `week of ${week.weekOf}`);
      continue;
    }
    // Launch-week catch-up: the week started without a weekly for this feed.
    const exists = input.listings.some((l) => l.feed.toLowerCase() === f.feed.toLowerCase() && isWeeklyListing(l) && l.finalTime === week.finalTime);
    if (exists) {
      out.skipped.push({ ticker: f.ticker, family: 'weekly', reason: 'already listed' });
      continue;
    }
    const remaining = week.sessions.filter((s) => s.open > nowSec);
    const first = remaining[0];
    if (first === undefined || remaining.length < CATCH_UP_MIN_SESSIONS) {
      out.skipped.push({
        ticker: f.ticker,
        family: 'weekly',
        reason: `the week has started and ${remaining.length} session(s) remain (a catch-up weekly needs ${CATCH_UP_MIN_SESSIONS})`,
      });
      continue;
    }
    plan(f, 'weekly', first.open, week.finalTime, `catch-up weekly ${first.date} → ${week.finalDate}`);
  }
  return out;
}

// ------------------------------------------------------------------ refund drill (CLI only)

export interface DrillInput {
  nowSec: number;
  feed: FeedConfig;
  params: { seedPerLeg: bigint; minEntry: bigint; maxEntry: bigint };
  listings?: readonly ExistingListing[];
}

export type DrillPlan = { ok: true; plan: OpenPlan; saturdayUtc: string } | { ok: false; reason: string };

/**
 * The refund drill (docs/spec/04 §Catalogue): strike at a Friday's opening bell, final at
 * Saturday 06:00 UTC with `maxFinalAge = 1 h`. Feeds do not print on Saturdays, so the
 * final reading is provably older than an hour and `voidStale` refunds everyone.
 * Uses the next Friday session whose opening bell is still ahead.
 */
export function planRefundDrill(input: DrillInput): DrillPlan {
  let date = etDateOf(input.nowSec);
  for (let i = 0; i < 21; i++, date = addDays(date, 1)) {
    if (!isCovered(date)) return { ok: false, reason: `the NYSE calendar does not cover ${date.slice(0, 4)}` };
    if (weekdayOf(date) !== 5 || !isTradingDay(date)) continue;
    const strike = openingBell(date);
    if (strike <= input.nowSec) continue;
    const saturday = addDays(date, 1);
    const [y, m, d] = saturday.split('-').map(Number) as [number, number, number];
    const final = Date.UTC(y, m - 1, d, 6, 0, 0) / 1000;
    if (input.listings?.some((l) => same(l, input.feed.feed, strike, final))) return { ok: false, reason: 'the drill for that Friday is already listed' };
    const params: UpDownParams = {
      feed: input.feed.feed,
      strikeTime: BigInt(strike),
      finalTime: BigInt(final),
      maxStrikeAge: 0,
      maxFinalAge: DRILL_MAX_FINAL_AGE,
      seedPerLeg: input.params.seedPerLeg,
      minEntry: input.params.minEntry,
      maxEntry: input.params.maxEntry,
    };
    return {
      ok: true,
      saturdayUtc: new Date(final * 1000).toISOString(),
      plan: {
        ticker: input.feed.ticker,
        family: 'drill',
        feed: input.feed.feed,
        params,
        question: questionFor({ ticker: input.feed.ticker, strikeTime: strike, finalTime: final, maxFinalAge: DRILL_MAX_FINAL_AGE }),
        reason: `refund drill: Friday ${date} open → Saturday 06:00 UTC, final reading may be at most 1 hour old`,
      },
    };
  }
  return { ok: false, reason: 'no Friday session in the next three weeks' };
}

