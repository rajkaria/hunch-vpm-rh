/**
 * "How this market settles", the verbatim template from docs/spec/04-markets-and-resolution.md
 * §"What a bettor is told". S7 renders it on every market page with the market's own values;
 * /how-it-works renders it with generic ones. Never truncated, never behind a disclosure.
 */
export function RulesBox({
  ticker,
  strikeDate,
  finalDate,
  maxAge,
  closeTime = '4:00 pm',
  feePercent = '2%',
  label,
}: {
  ticker: string;
  /** The opening bell's date in words, e.g. "Tue Sep 29". */
  strikeDate: string;
  /** The closing bell's date in words, e.g. "Fri Oct 2". */
  finalDate: string;
  /** The staleness bound in words, e.g. "26 hours". */
  maxAge: string;
  /** "4:00 pm", or "1:00 pm" on an early-close day. */
  closeTime?: string;
  feePercent?: string;
  /** An eyebrow above the box, e.g. "Example". */
  label?: string;
}) {
  return (
    <section aria-label="How this market settles" className="rounded-card border border-edge bg-raised p-4 sm:p-5">
      {label === undefined ? null : <p className="eyebrow mb-3">{label}</p>}
      <p className="text-[15px] leading-[1.7] text-muted">
        <strong className="font-semibold text-paper">How this market settles.</strong> The opening price is
        Chainlink&rsquo;s {ticker} Stock Token price in effect at 9:30 am ET on {strikeDate}; the closing price is
        Chainlink&rsquo;s price in effect at {closeTime} ET on {finalDate}. Chainlink updates this price whenever it moves
        0.5% (or once a day), so either number can differ from the exchange&rsquo;s official print by up to about 0.5%.{' '}
        <strong className="font-semibold text-lime">UP</strong> wins if the closing price is higher,{' '}
        <strong className="font-semibold text-coral">DOWN</strong> if it is lower. If they are the same, or if either
        price is more than {maxAge} old at that moment, or if Robinhood pauses the token&rsquo;s price for a corporate
        action for more than a day, every bet is refunded in full. Bets are accepted until {closeTime} ET. The earlier
        you bet, the more of the other side&rsquo;s later money is yours; a bet placed at the last moment gets its stake
        back plus whatever the other side adds after it. Hunch keeps {feePercent} of winnings. Nobody at Hunch can set or
        change a price.
      </p>
    </section>
  );
}
