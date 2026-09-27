/**
 * Static facts about the site and the chain it runs on.
 *
 * Everything here is either a public URL or a chain fact checked against chain
 * 4663 (docs/spec/08-deployment.md). Nothing here is a contract of ours: those
 * come from the deployment file, which says "not deployed" until the operator
 * deploys (see `lib/deployment.ts`).
 */

/** The canonical origin. Used for metadata, the sitemap and absolute links. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://rh.playhunch.xyz').replace(/\/+$/, '');

export const SITE_NAME = 'Hunch on Robinhood Chain';

/** The first-screen line, used by the hero, the metadata and the share card. */
export const HERO_TITLE = 'Call it early. Get paid more.';

export const HERO_SUB =
  'Prediction markets on Robinhood Stock Tokens, in USDG on Robinhood Chain. Open until the closing bell. Settled by Chainlink.';

/** Card-length description (160 chars or fewer), from docs/spec/01-product.md. */
export const SITE_DESCRIPTION =
  'Bet UP or DOWN on NVDA, TSLA, AAPL and COIN in USDG on Robinhood Chain. Call it early, earn more. Open until the bell. Settled by Chainlink.';

export const LINKS = {
  hunch: 'https://www.playhunch.xyz',
  vpm: 'https://vpm.playhunch.xyz',
  paper: 'https://www.playhunch.xyz/vpm-whitepaper',
  github: 'https://github.com/rajkaria/hunch-vpm-rh',
  across: 'https://app.across.to',
  relay: 'https://relay.link/bridge',
  stargate: 'https://stargate.finance',
  arbitrumBridge: 'https://portal.arbitrum.io/bridge',
  uniswap: 'https://app.uniswap.org',
  safeApp: 'https://app.safe.global',
  robinhoodChainDocs: 'https://docs.robinhood.com/chain',
  chainlinkFeeds: 'https://data.chain.link',
} as const;

/** Robinhood Chain mainnet, as a wallet needs it. */
export const ROBINHOOD_CHAIN = {
  id: 4663,
  idHex: '0x1237',
  name: 'Robinhood Chain',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorerUrl: 'https://robinhoodchain.blockscout.com',
  explorerName: 'Blockscout',
  currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
} as const;

/** USDG on chain 4663 (Paxos Global Dollar). 6 decimals. */
export const USDG = {
  address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  symbol: 'USDG',
  name: 'Global Dollar',
  decimals: 6,
} as const;

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** The countries the stock-price markets are not offered in (the Stock Token list). */
export const BLOCKED_COUNTRIES = ['the United States', 'Canada', 'the United Kingdom', 'Switzerland'] as const;

export const COUNTRY_NOTICE =
  'Stock-price markets are not offered to persons in the United States, Canada, the United Kingdom or Switzerland.';

export const BETA_NOTICE =
  'Beta. Unaudited. Contracts are permissionless; the country block is a front-end control.';

/** The late-bettor rule, said before the bet (docs/spec/05-web-app.md). */
export const LATE_RULE =
  'Bet late and you get your stake back plus whatever the other side adds after you. Bet early and you collect more.';

export function addressUrl(address: string): string {
  return `${ROBINHOOD_CHAIN.explorerUrl}/address/${address}`;
}

export function txUrl(hash: string): string {
  return `${ROBINHOOD_CHAIN.explorerUrl}/tx/${hash}`;
}

export function blockUrl(block: number | bigint): string {
  return `${ROBINHOOD_CHAIN.explorerUrl}/block/${block.toString()}`;
}

const ZERO = /^0x0{40}$/i;

/** A real address, not an empty slot or the zero placeholder. */
export function isAddress(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !ZERO.test(value);
}
