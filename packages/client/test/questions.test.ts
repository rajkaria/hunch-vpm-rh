import { describe, expect, it } from 'vitest';
import {
  ELIGIBILITY_STATEMENT,
  LATE_BETTOR_RULE,
  REFUND_DRILL_NOTE,
  closingBell,
  family,
  openingBell,
  questionFor,
  rulesBox,
} from '../src/index.js';

const daily = { ticker: 'NVDA', strikeTime: openingBell('2026-09-28'), finalTime: closingBell('2026-09-28'), maxFinalAge: 93_600 };
const weekly = { ticker: 'TSLA', strikeTime: openingBell('2026-09-29'), finalTime: closingBell('2026-10-02'), maxFinalAge: 93_600 };
const drill = { ticker: 'NVDA', strikeTime: openingBell('2026-10-02'), finalTime: Date.UTC(2026, 9, 3, 6) / 1000, maxFinalAge: 3600 };

describe('question templates (docs/spec/04)', () => {
  it('families', () => {
    expect(family(daily)).toBe('daily');
    expect(family(weekly)).toBe('weekly');
    expect(family(drill)).toBe('drill');
  });

  it('daily', () => {
    expect(questionFor(daily)).toBe('Will NVDA close UP today? · Mon Sep 28');
  });

  it('weekly uses the actual strike and final dates', () => {
    expect(questionFor(weekly)).toBe('Will TSLA finish the week UP? · Tue Sep 29 → Fri Oct 2');
  });

  it('refund drill text is verbatim', () => {
    expect(`${questionFor(drill)} ${REFUND_DRILL_NOTE}`).toBe(
      "Refund drill: NVDA UP from Friday's open to 2:00 am ET Saturday? The price feed does not update on Saturdays, so this market exists to show that everyone gets their money back when the price can't be trusted.",
    );
  });
});

describe('rules box', () => {
  it('renders the verbatim template for a daily market', () => {
    const box = rulesBox({ ...daily, maxStrikeAge: 93_600, feeBps: 200 });
    expect(box.text).toBe(
      "How this market settles. The opening price is Chainlink's NVDA Stock Token price in effect at 9:30 am ET on Monday, September 28; " +
        "the closing price is Chainlink's price in effect at 4:00 pm ET on Monday, September 28. Chainlink updates this price whenever it moves 0.5% " +
        "(or once a day), so either number can differ from the exchange's official print by up to about 0.5%. UP wins if the closing price is higher, " +
        'DOWN if it is lower. If they are the same, or if either price is more than 26 hours old at that moment, or if either price is out of range ' +
        '(not a real price), or if Robinhood pauses the token\'s price ' +
        'for a corporate action for more than a day, every bet is refunded in full. Bets are accepted until 4:00 pm ET. The earlier you bet, the more of ' +
        "the other side's later money is yours; a bet placed at the last moment gets its stake back plus whatever the other side adds after it. " +
        'Hunch keeps 2% of winnings. Nobody at Hunch can set or change a price. ' +
        'If Chainlink moves this feed to a new aggregator around a bell, the price is read from the newest aggregator that had reported by then.',
    );
    expect(box.markdown.startsWith('**How this market settles.**')).toBe(true);
    expect(box.markdown).toContain('**UP** wins');
    expect(box.markdown).toContain('**DOWN** if it is lower');
    expect(box.segments.filter((s) => s.bold).map((s) => s.text)).toEqual(['UP', 'DOWN']);
  });

  it('names the final day for multi-day markets, the early close, and differing age bounds', () => {
    const w = rulesBox({ ...weekly, maxStrikeAge: 93_600, feeBps: 200 });
    expect(w.text).toContain('Bets are accepted until 4:00 pm ET on Friday, October 2.');
    const early = rulesBox({ ticker: 'AAPL', strikeTime: openingBell('2026-11-27'), finalTime: closingBell('2026-11-27'), maxFinalAge: 93_600, maxStrikeAge: 93_600, feeBps: 200 });
    expect(early.text).toContain('in effect at 1:00 pm ET on Friday, November 27');
    const d = rulesBox({ ...drill, maxStrikeAge: 93_600, feeBps: 200 });
    expect(d.text).toContain('if the opening price is more than 26 hours old or the closing price more than 1 hour old at that moment');
    expect(d.text).toContain('2:00 am ET on Saturday, October 3');
  });

  it('copy rules: no em dashes, UP/DOWN words', () => {
    for (const s of [
      rulesBox({ ...daily, maxStrikeAge: 93_600, feeBps: 200 }).text,
      questionFor(daily),
      questionFor(weekly),
      questionFor(drill),
      REFUND_DRILL_NOTE,
      LATE_BETTOR_RULE,
      ELIGIBILITY_STATEMENT,
    ]) {
      expect(s).not.toContain('—');
      expect(s).not.toMatch(/\b(YES|NO)\b/);
    }
  });
});
