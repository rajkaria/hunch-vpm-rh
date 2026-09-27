import { DRILL_MAX_FINAL_AGE } from './constants.js';
import { etDateOf } from './calendar.js';
import { formatAgeBound, formatEtDate, formatEtDateLong, formatEtTime, formatEtWeekday } from './format.js';
import { formatBps } from './units.js';

/**
 * Market copy, rendered from the on-chain spec, never from free text
 * (docs/spec/04-markets-and-resolution.md §Question templates and §What a bettor is told).
 */

export type MarketFamily = 'daily' | 'weekly' | 'drill';

export interface ListingTimes {
  strikeTime: number | bigint;
  finalTime: number | bigint;
  maxFinalAge: number | bigint;
}

const n = (x: number | bigint) => Number(x);

/** drill: final reading may be at most an hour old; daily: strike and final on the same ET date; else weekly. */
export function family(listing: ListingTimes): MarketFamily {
  if (n(listing.maxFinalAge) <= DRILL_MAX_FINAL_AGE) return 'drill';
  return etDateOf(n(listing.strikeTime)) === etDateOf(n(listing.finalTime)) ? 'daily' : 'weekly';
}

/** The refund drill's explanation, verbatim. */
export const REFUND_DRILL_NOTE =
  "The price feed does not update on Saturdays, so this market exists to show that everyone gets their money back when the price can't be trusted.";

export interface QuestionInput extends ListingTimes {
  ticker: string;
}

/**
 * - daily: `Will NVDA close UP today? · Mon Sep 28`
 * - weekly: `Will NVDA finish the week UP? · Tue Sep 29 → Fri Oct 2`
 * - drill: `Refund drill: NVDA UP from Friday's open to 2:00 am ET Saturday?`
 */
export function questionFor(input: QuestionInput): string {
  const strike = n(input.strikeTime);
  const final = n(input.finalTime);
  switch (family(input)) {
    case 'daily':
      return `Will ${input.ticker} close UP today? · ${formatEtDate(strike)}`;
    case 'weekly':
      return `Will ${input.ticker} finish the week UP? · ${formatEtDate(strike)} → ${formatEtDate(final)}`;
    case 'drill':
      return `Refund drill: ${input.ticker} UP from ${formatEtWeekday(strike)}'s open to ${formatEtTime(final)} ${formatEtWeekday(final)}?`;
  }
}

export interface RulesInput extends QuestionInput {
  maxStrikeAge: number | bigint;
  feeBps: number | bigint;
}

export interface RulesSegment {
  text: string;
  bold: boolean;
}

export interface RulesBox {
  heading: string;
  /** The paragraph after the heading as segments, bold where the template is bold. */
  segments: RulesSegment[];
  /** Plain text, heading included. */
  text: string;
  /** Markdown (`**bold**`), heading included. */
  markdown: string;
}

/** The rules box, from the verbatim template, with this market's ticker, times, age bounds and fee. */
export function rulesBox(input: RulesInput): RulesBox {
  const strike = n(input.strikeTime);
  const final = n(input.finalTime);
  const sameDay = etDateOf(strike) === etDateOf(final);
  const strikeAge = n(input.maxStrikeAge);
  const finalAge = n(input.maxFinalAge);
  const ageClause =
    strikeAge === finalAge
      ? `if either price is more than ${formatAgeBound(strikeAge)} old at that moment`
      : `if the opening price is more than ${formatAgeBound(strikeAge)} old or the closing price more than ${formatAgeBound(finalAge)} old at that moment`;
  const until = sameDay ? formatEtTime(final) : `${formatEtTime(final)} on ${formatEtDateLong(final)}`;

  const heading = 'How this market settles.';
  const segments: RulesSegment[] = [
    {
      text:
        ` The opening price is Chainlink's ${input.ticker} Stock Token price in effect at ${formatEtTime(strike)} on ${formatEtDateLong(strike)};` +
        ` the closing price is Chainlink's price in effect at ${formatEtTime(final)} on ${formatEtDateLong(final)}.` +
        " Chainlink updates this price whenever it moves 0.5% (or once a day), so either number can differ from the exchange's official print by up to about 0.5%. ",
      bold: false,
    },
    { text: 'UP', bold: true },
    { text: ' wins if the closing price is higher, ', bold: false },
    { text: 'DOWN', bold: true },
    {
      text:
        ` if it is lower. If they are the same, or ${ageClause}, or if Robinhood pauses the token's price for a corporate action for more than a day, every bet is refunded in full.` +
        ` Bets are accepted until ${until}.` +
        " The earlier you bet, the more of the other side's later money is yours; a bet placed at the last moment gets its stake back plus whatever the other side adds after it." +
        ` Hunch keeps ${formatBps(input.feeBps)} of winnings. Nobody at Hunch can set or change a price.` +
        ' If Chainlink moves this feed to a new aggregator around a bell, the price is read from the newest aggregator that had reported by then.',
      bold: false,
    },
  ];
  const body = segments.map((s) => s.text).join('');
  return {
    heading,
    segments,
    text: `${heading}${body}`,
    markdown: `**${heading}**${segments.map((s) => (s.bold ? `**${s.text}**` : s.text)).join('')}`,
  };
}

/** The one line said before every bet (docs/spec 05 §Copy rules). */
export const LATE_BETTOR_RULE =
  'Bet late and you get your stake back plus whatever the other side adds after you. Bet early and you collect more.';

/** Eligibility checkbox text (docs/spec 05 §Geo and eligibility). */
export const ELIGIBILITY_STATEMENT =
  'I am not a resident of the United States, Canada, the United Kingdom or Switzerland, and prediction markets are legal where I am.';
