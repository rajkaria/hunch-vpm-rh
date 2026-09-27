/** "Why Robinhood Chain", stated as a dependency list (docs/spec/01-product.md). */
export const WHY_ROBINHOOD_CHAIN: readonly { need: string; detail: string }[] = [
  {
    need: 'Robinhood Stock Tokens',
    detail: 'The ticker universe and the audience: NVDA, TSLA, AAPL and COIN as tokens on the chain.',
  },
  {
    need: 'Chainlink stock prices on the chain',
    detail: "A price that no operator types in. It is the settlement's only input.",
  },
  {
    need: 'USDG',
    detail: "The chain's native dollar: one asset for every stake and every payout.",
  },
  {
    need: 'Robinhood Wallet',
    detail: 'Supports the chain natively. Connecting it to this site is being verified before launch.',
  },
  {
    need: 'Signed USDG transfers',
    detail: 'USDG accepts a signed transfer (EIP-3009), so a bet is one signature and you need no ETH.',
  },
  {
    need: 'Cheap gas',
    detail: 'A bet costs well under a cent in gas, so Hunch can pay it for every bettor.',
  },
];
