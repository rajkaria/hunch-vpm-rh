import type { Ticker } from '@/content/tickers';

/**
 * The Stock Token mark: the ticker's initial on a hairline tile. We draw our own mark rather
 * than a company logo: the market is on the Robinhood Stock Token's price, and a borrowed logo
 * would suggest an endorsement nobody gave.
 */
export function TickerMark({ ticker, size = 'md' }: { ticker: Ticker | string; size?: 'sm' | 'md' | 'lg' }) {
  const box = size === 'sm' ? 'h-6 w-6 text-[11px]' : size === 'lg' ? 'h-10 w-10 text-base' : 'h-8 w-8 text-[13px]';
  return (
    <span
      aria-hidden
      className={`lift inline-flex shrink-0 items-center justify-center rounded-tag border border-edge-strong bg-raised-2 font-mono font-medium text-paper ${box}`}
    >
      {ticker.slice(0, 1)}
    </span>
  );
}
