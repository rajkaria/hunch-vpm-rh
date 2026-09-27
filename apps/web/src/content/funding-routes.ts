import { LINKS } from '@/lib/site';

/** docs/spec/08-deployment.md §Funding routes, in a bettor's words. */
export interface FundingRoute {
  route: string;
  steps: string;
  landsAs: string;
  notes: string;
  href: string | null;
  linkLabel: string | null;
  recommended?: boolean;
}

export const FUNDING_ROUTES: readonly FundingRoute[] = [
  {
    route: 'USDC on Arbitrum One or Base, bridged with Across',
    steps: 'One transaction on across.to',
    landsAs: 'USDG',
    notes: 'Arrives in seconds. With gasless bets you need no ETH at all.',
    href: LINKS.across,
    linkLabel: 'Open Across',
    recommended: true,
  },
  {
    route: 'ETH on a major L2, bridged with Relay or Across, then swapped on Uniswap',
    steps: 'Two transactions',
    landsAs: 'ETH, then USDG',
    notes: 'Swap on the deepest USDG/WETH pool on Robinhood Chain.',
    href: LINKS.relay,
    linkLabel: 'Open Relay',
  },
  {
    route: 'USDG on Ethereum or Solana, sent with LayerZero (Stargate)',
    steps: 'One transaction',
    landsAs: 'USDG',
    notes: 'Only from Ethereum and Solana.',
    href: LINKS.stargate,
    linkLabel: 'Open Stargate',
  },
  {
    route: 'ETH on Ethereum, through the Arbitrum bridge',
    steps: 'About 10 minutes in',
    landsAs: 'ETH',
    notes: 'The slowest route, and withdrawing back takes 7 days.',
    href: LINKS.arbitrumBridge,
    linkLabel: 'Open the bridge',
  },
  {
    route: 'Robinhood Wallet',
    steps: 'Native chain support',
    landsAs: 'Depends',
    notes:
      'Moving USDG or ETH from the Robinhood app onto the chain, and which regions can, is not yet confirmed. We will say so here once it is.',
    href: null,
    linkLabel: null,
  },
];
