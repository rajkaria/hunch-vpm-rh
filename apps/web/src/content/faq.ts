/**
 * Questions a first-time bettor asks, answered from the spec. Plain words only: the mechanism's
 * own vocabulary lives on /how-it-works under "For the curious".
 */

export interface FaqItem {
  id: string;
  q: string;
  a: string[];
  /** Shown in the landing page's short list. */
  teaser?: boolean;
}

export const FAQ: readonly FaqItem[] = [
  {
    id: 'what-am-i-betting-on',
    q: 'What exactly am I betting on?',
    a: [
      "Whether a Robinhood Stock Token's price is higher (UP) or lower (DOWN) at the closing bell than it was at the opening bell. A daily market runs from 9:30 am to 4:00 pm ET on one trading day; a weekly market runs from the week's first opening bell to Friday's closing bell.",
      "Both prices are Chainlink's price for the Stock Token in effect at that moment on Robinhood Chain: the last update at or before the bell.",
    ],
    teaser: true,
  },
  {
    id: 'why-early-pays-more',
    q: 'Why does betting early pay more?',
    a: [
      'The moment your bet lands, it is paid to the people already standing on the other side. So everyone who bets against you after you arrive is, in effect, paying you if you are right.',
      'If you win, you get your stake back plus every opposing dollar that arrived after you. The earlier you call it, the more of that money is yours, and nobody arriving later can shrink what you have already earned.',
    ],
    teaser: true,
  },
  {
    id: 'late-bet',
    q: 'What if I bet at the last minute?',
    a: [
      'Bet late and you get your stake back plus whatever the other side adds after you. Bet early and you collect more.',
      'A bet placed a moment before the bell, with nothing coming in after it, is paid exactly its stake back if it wins (1.00×). Sniping pays nothing, which is why markets can stay open until the bell instead of closing early.',
    ],
    teaser: true,
  },
  {
    id: 'no-eth',
    q: 'Do I need ETH for gas?',
    a: [
      'No. A bet is one signature over USDG: your wallet signs a transfer of exactly your stake into exactly the market and side you chose, and Hunch sends it and pays the gas.',
      'You can also send the transaction yourself and pay the gas (well under a cent) if you prefer.',
    ],
    teaser: true,
  },
  {
    id: 'who-decides',
    q: 'Who decides whether it went UP or DOWN?',
    a: [
      "Chainlink's price feed on Robinhood Chain, read by a contract that has no owner. Settlement takes two Chainlink price updates, the one in effect at the opening bell and the one in effect at the closing bell, and checks on-chain that each really was the last update at or before its bell.",
      'Anyone can submit that settlement. Nobody at Hunch can set or change a price.',
    ],
    teaser: true,
  },
  {
    id: 'refunds',
    q: "What if the price doesn't move, or the feed stops?",
    a: [
      "If the opening and closing prices are the same, every bet is refunded in full with no fee. The same happens if either price is more than 26 hours old at its bell (the feed missed its daily update), or if Robinhood pauses the token's price for a corporate action for more than a day.",
      'If nobody settles a market at all, anyone can refund it 72 hours after the bell.',
    ],
    teaser: true,
  },
  {
    id: 'fee',
    q: 'What does Hunch earn?',
    a: [
      "2% of a winner's gain (what you are paid minus what you staked), taken when the payout is sent. Nothing on your stake, on refunds, on refunded markets or on losing bets.",
    ],
  },
  {
    id: 'when-paid',
    q: 'When and how do I get paid?',
    a: [
      "After the bell, the market is settled from the two Chainlink prices and payouts are pushed to every winner's wallet automatically. You do not need to come back and claim.",
      "If the automatic delivery is ever slow, anyone (including you) can deliver a payout, and it always goes to the position's owner, never to whoever sent it.",
    ],
  },
  {
    id: 'partial-fill',
    q: 'Why was only part of my bet accepted?',
    a: [
      'A bet is accepted only up to what the other side can cover. If you bet more than that, the part that cannot be covered is returned to you automatically, usually within minutes, and anyone can send it back sooner. The bet screen tells you the accepted amount before you sign.',
      'With the beta limit of 100 USDG per bet this should be rare.',
    ],
  },
  {
    id: 'cash-out',
    q: 'Can I cash out before the bell?',
    a: [
      'Not in this version. There is no order book and no early exit. A position can be transferred to another address on-chain; a buy-back desk is on the roadmap.',
    ],
  },
  {
    id: 'official-close',
    q: "Why can the closing price differ from the exchange's official close?",
    a: [
      "Chainlink updates these prices whenever the price moves 0.5% from its last update, or once a day. The price in effect at 4:00 pm ET is the last update at or before 4:00 pm, so it can differ from the exchange's official print by up to about 0.5%.",
      "It is also the Stock Token's price (the share price times the token's multiplier), which stays continuous through dividends and splits.",
    ],
  },
  {
    id: 'safety',
    q: 'Can Hunch take my money or stop payouts?',
    a: [
      "No. Only two actions are privileged: listing markets (a Safe decides which price feeds and which listing wallet are allowed, and the listing wallet pays each market's opening seed itself) and pausing new bets (the Safe). Neither can move a stake, set a price, or stop claims, refunds or settlement.",
      'See the powers table on the Proof page for who can do what.',
    ],
  },
  {
    id: 'where',
    q: 'Where is it available?',
    a: [
      'Stock-price markets are not offered to persons in the United States, Canada, the United Kingdom or Switzerland, the same list Robinhood applies to Stock Tokens. Prediction markets are regulated in many places; make sure they are legal where you are.',
      'The contracts are permissionless; the country block is a front-end control.',
    ],
  },
  {
    id: 'audited',
    q: 'Is it audited?',
    a: [
      "No. This is a beta on mainnet with small limits: 1 to 100 USDG per bet. The main contract is the paper's reference contract plus a short, listed set of changes, and an external review is the first item on the roadmap.",
    ],
  },
  {
    id: 'usdg',
    q: 'How do I get USDG on Robinhood Chain?',
    a: [
      'The quickest route: bridge USDC from Arbitrum One or Base with Across. It arrives as USDG on Robinhood Chain in seconds. The Start page lists every route.',
    ],
  },
];
