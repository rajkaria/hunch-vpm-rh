/**
 * The ticker universe, from docs/spec/04-markets-and-resolution.md §Tickers. Addresses were
 * checked with `cast` on chain 4663 (research facts, 2026-09-27) and are hardcoded from
 * docs.robinhood.com/chain/contracts, never looked up by symbol: look-alike tokens exist.
 *
 * S7: the allow-listed set comes from the deployment file / the factory's `feeds()`; this list
 * is the planned set and the source for the price tape until then.
 */

export type Ticker = 'NVDA' | 'TSLA' | 'AAPL' | 'COIN';

export interface TickerInfo {
  ticker: Ticker;
  /** The company the Stock Token tracks. */
  name: string;
  stockToken: `0x${string}`;
  /** Chainlink standard proxy (not the SVR proxy) on chain 4663. */
  feed: `0x${string}`;
  aggregator: `0x${string}`;
  /** Whether v1 lists markets on it, in the spec's words. */
  v1: 'yes' | 'if its feed passes the flat-rate check';
}

export const TICKERS: readonly TickerInfo[] = [
  {
    ticker: 'NVDA',
    name: 'NVIDIA',
    stockToken: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
    feed: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15',
    aggregator: '0xC9d16E4f2569b9E3ea0468fD85844953713DC2a2',
    v1: 'yes',
  },
  {
    ticker: 'TSLA',
    name: 'Tesla',
    stockToken: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d',
    feed: '0x4A1166a659A55625345e9515b32adECea5547C38',
    aggregator: '0x7A6b81ba7FbCB90104d8C496158Cf383cD7233b1',
    v1: 'yes',
  },
  {
    ticker: 'AAPL',
    name: 'Apple',
    stockToken: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
    feed: '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0',
    aggregator: '0xBb11A21267cFDb63d4935d99a499133DD1744ACb',
    v1: 'yes',
  },
  {
    ticker: 'COIN',
    name: 'Coinbase',
    stockToken: '0x6330D8C3178a418788dF01a47479c0ce7CCF450b',
    feed: '0xA3a468A452940B7D6b69991207B508c609a98Ef2',
    aggregator: '0x30398b0B0df82a009bB2D507BC7fE1dc6d3ca294',
    v1: 'if its feed passes the flat-rate check',
  },
];

export function tickerInfo(ticker: string): TickerInfo | undefined {
  return TICKERS.find((entry) => entry.ticker === ticker);
}
