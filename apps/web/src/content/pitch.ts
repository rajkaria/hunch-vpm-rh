/**
 * The investor deck's facts (/pitch), in one place, each with where it comes from and when it
 * was read. The deck renders from this file only, so a number changes here or nowhere.
 *
 * Three kinds of number, kept apart on purpose:
 *
 * - Robinhood Chain facts: read on chain 4663 (docs/FACTS.md, the deployment file, the research
 *   notes of 2026-09-27), or computed by the client's exact mirror of the contract.
 * - Hunch's track record before this venue: production figures for playhunch.xyz on Base, pulled
 *   on 2026-09-29. Shown as proof of concept, never as demand for this venue.
 * - Market context: third-party figures, each with its source named on the slide.
 *
 * The use-of-funds split, the milestones, the vision and the fee scenarios are the founders' plan
 * and arithmetic, not facts; the slides say so.
 */

import { publicDeployment } from '@/lib/deployment';
import { EXAMPLE, SCALE, WORKED, exampleBet, exampleRow, multiplePpm } from '@/content/worked-example';
import { formatAmount, formatMultiple } from '@/lib/units';

export const PITCH = {
  title: 'Hunch · Investor deck',
  description:
    'Hunch: an UP-or-DOWN market on every Robinhood Stock Token, every session, in USDG and settled by Chainlink, that pays more to whoever calls it first.',
  tagline: 'A prediction market on every stock, every day.',
  /** The link preview's sub-line (OG and Twitter cards). */
  share: 'Hunch: a prediction market on every stock, every day, starting with Robinhood Stock Tokens.',
  dateline: 'October 2026',
  round: 'Pre-seed',
  domain: 'vpm.playhunch.xyz',
  hunchDomain: 'playhunch.xyz',
  x: '@playhunchxyz',
  xUrl: 'https://x.com/playhunchxyz',
} as const;

// ------------------------------------------------------------------------------------------------
// The mechanism, in the worked example's numbers (replayed by the contract mirror, never typed in)

export interface CurveStep {
  /** Hours after Tuesday's opening bell. */
  from: number;
  to: number;
  /** Win payout per dollar for a small UP bet landing in this window, in ppm. */
  ppm: bigint;
}

/**
 * What a small UP bet is paid per dollar if UP wins, by when it lands, in the worked example's
 * week. A winning position is paid `stake x (1 + final - entry)` on its side's accumulator, so a
 * bet that lands after step k is paid `1 + final - acc_k` per dollar. UP bets do not move the UP
 * accumulator, so the curve only steps down when a DOWN bet arrives, and it ends at exactly 1x:
 * the last-second bettor gets their stake back.
 */
export function entryCurve(): CurveStep[] {
  const SCALE_PPM = 10n ** 12n; // 18-decimal accumulator to ppm
  const final = WORKED.steps[WORKED.steps.length - 1]!.accUp;
  const marks = WORKED.steps.map((step) => ({
    at: step.bet < 0 ? 0 : EXAMPLE.bets[step.bet]!.hoursIn,
    ppm: 1_000_000n + (final - step.accUp) / SCALE_PPM,
  }));
  const steps: CurveStep[] = [];
  marks.forEach((mark, index) => {
    const to = index + 1 < marks.length ? marks[index + 1]!.at : EXAMPLE.weekHours;
    const last = steps[steps.length - 1];
    if (last !== undefined && last.ppm === mark.ppm) last.to = to;
    else steps.push({ from: mark.at, to, ppm: mark.ppm });
  });
  return steps.filter((step) => step.to > step.from);
}

export interface Bettor {
  name: string;
  when: string;
  hoursIn: number;
  stake: string;
  payout: string;
  /** What winning added on top of the stake. */
  gain: string;
  multiple: string;
  multiplePpm: bigint;
  classic: string;
  classicMultiple: string;
  /** For bars: payout and classic as fractions of the largest of the four. */
  payoutShare: number;
  classicShare: number;
}

function bettors(): { mei: Bettor; ben: Bettor } {
  const rows = { mei: exampleRow('Mei'), ben: exampleRow('Ben') };
  const max = [rows.mei.payout, rows.ben.payout, rows.mei.classic, rows.ben.classic].reduce((a, b) => (b > a ? b : a), 1n);
  const share = (value: bigint): number => Number((value * 10_000n) / max) / 10_000;
  const of = (key: 'mei' | 'ben', name: string): Bettor => {
    const row = rows[key];
    const bet = exampleBet(name);
    return {
      name,
      when: bet.when,
      hoursIn: bet.hoursIn,
      stake: formatAmount(row.stake),
      payout: formatAmount(row.payout),
      gain: formatAmount(row.payout - row.stake),
      multiple: formatMultiple(multiplePpm(row.payout, row.stake)),
      multiplePpm: multiplePpm(row.payout, row.stake),
      classic: formatAmount(row.classic),
      classicMultiple: formatMultiple(multiplePpm(row.classic, row.stake)),
      payoutShare: share(row.payout),
      classicShare: share(row.classic),
    };
  };
  return { mei: of('mei', 'Mei'), ben: of('ben', 'Ben') };
}

const DAN = exampleBet('Dan');
const DAN_STEP = WORKED.steps.find((step) => step.bet === EXAMPLE.bets.findIndex((bet) => bet.name === 'Dan'))!;

export const EXAMPLE_FACTS = {
  question: EXAMPLE.question,
  weekHours: EXAMPLE.weekHours,
  seed: formatAmount(EXAMPLE.seedPerLeg, { fractionDigits: 0 }),
  classicMultiple: formatMultiple(WORKED.classicMultiplePpm),
  classicPpm: WORKED.classicMultiplePpm,
  curve: entryCurve(),
  bets: EXAMPLE.bets.map((bet) => ({ name: bet.name, side: bet.side, hoursIn: bet.hoursIn, stake: formatAmount(bet.stake, { fractionDigits: 0 }) })),
  ...bettors(),
  /** Dan's DOWN bet on Tuesday, paid straight to the UP side already standing. */
  dan: {
    when: DAN.when,
    stake: formatAmount(DAN.stake, { fractionDigits: 0 }),
    meiBefore: formatAmount(exampleBet('Mei').stake, { fractionDigits: 0 }),
    meiAfter: formatAmount(DAN_STEP.accruedMei, { fractionDigits: 0 }),
    /** The UP seed leg accrues like any position: stake x (1 + acc now - acc at entry). */
    seedAfter: formatAmount((EXAMPLE.seedPerLeg * (SCALE + DAN_STEP.accUp - WORKED.steps[0]!.accUp)) / SCALE, { fractionDigits: 0 }),
  },
};

// ------------------------------------------------------------------------------------------------
// The paper (playhunch.xyz/vpm-whitepaper, 2nd edition; results quoted from §13.4)

/**
 * The research Hunch settles on, published before the venue was built. The tape is Hunch's
 * four-week paper-money tournament, where most traders were agents deployed by participants; the
 * slide says so next to the numbers (docs/spec/01-product.md).
 */
export const PAPER = {
  title: 'The Vested Parimutuel',
  subtitle: 'Settling prediction markets by time priority of capital at risk',
  author: 'Raj Karia',
  publisher: 'Hunch Research',
  edition: '2nd edition, Sep 2026',
  firstEdition: 'Aug 2026',
  sections: 16,
  /** The seven proved properties, P1 to P7, in plain words. */
  properties: [
    'Every dollar in is paid out',
    'A win payout only goes up',
    'Later money can’t dilute you',
    'A last-second bet gets its stake back',
    'Same moment, same multiple',
    'The opening seed can’t lose',
    'Blends with a classic pool predictably',
  ],
  tape: { trades: '779,549', markets: '5,291', wallets: '458,957' },
  results: [
    {
      value: '70.1% → 0.08%',
      label: 'of the losing pool taken by winners who arrive in the last 10% of a market',
      detail: 'An ordinary pool, then ours. Median over 5,173 replayed markets.',
    },
    {
      value: '0 of 5,173',
      label: 'replayed markets where the opening seed lost money',
      detail: 'Median return +248%. Why we can open every ticker, every session.',
    },
  ],
  caveat: 'Replayed tape: Hunch’s four-week paper-money tournament, where most traders were agents deployed by participants (§13.4).',
} as const;

// ------------------------------------------------------------------------------------------------
// Live on Robinhood Chain (docs/FACTS.md "Live now"; the deployment file is the only address source)

/** The committed deployment (or its public override), so the deck renders the same everywhere. */
const DEPLOYMENT = publicDeployment();

export const LIVE = {
  deployedOn: 'Oct 2, 2026',
  chainId: DEPLOYMENT.chainId,
  explorer: DEPLOYMENT.explorer,
  contracts: (['HunchVPM', 'StockRoundResolver', 'HunchMarketFactory'] as const).map((name) => ({
    name,
    address: DEPLOYMENT.contracts[name].address,
    role:
      name === 'HunchVPM'
        ? 'The settler: holds stakes, pays winners'
        : name === 'StockRoundResolver'
          ? 'UP or DOWN from two Chainlink rounds; no owner'
          : 'Lists markets; owned by a 2-of-3 Safe',
  })),
  tickers: DEPLOYMENT.feeds.map((feed) => feed.ticker),
  feeBps: DEPLOYMENT.params.feeBps,
  conformanceVectors: 118,
};

// ------------------------------------------------------------------------------------------------
// Robinhood Chain, read on chain 4663 on 2026-09-27 (internal research notes; `cast` + Blockscout)

export const CHAIN_FACTS = [
  { value: '$686M', label: 'USDG on Robinhood Chain', note: 'totalSupply on chain 4663, Sep 27, 2026' },
  { value: '386,874', label: 'USDG holders on the chain', note: 'Blockscout, Sep 27, 2026' },
  { value: '58', label: 'Chainlink feeds live on mainnet', note: 'Chainlink data directory, Sep 27, 2026' },
  { value: '<$0.01', label: 'Gas for a bet, paid by Hunch', note: 'USDG transfer ≈ $0.004 at 0.02 gwei, 100 ms blocks' },
] as const;

/**
 * The Stock Tokens and ETFs with a Chainlink price on chain 4663 (36 of the directory's 58 feeds,
 * read 2026-09-27), the universe Hunch can list without new infrastructure. Ordered for the slide:
 * the four live markets first, then by how widely each name is traded.
 */
export const FEED_TICKERS = [
  'NVDA', 'TSLA', 'AAPL', 'COIN', 'MSFT', 'AMZN', 'GOOGL', 'META', 'AMD',
  'PLTR', 'SPY', 'QQQ', 'MSTR', 'TSM', 'MU', 'INTC', 'ORCL', 'GME',
  'CRCL', 'BABA', 'ASML', 'DELL', 'IONQ', 'RGTI', 'RKLB', 'NBIS', 'CRWV',
  'SNDK', 'SPCX', 'CLSK', 'USAR', 'GLD', 'SLV', 'USO', 'EWY', 'SGOV',
] as const;

/** Stock Tokens listed on chain 4663 (docs.robinhood.com/chain/contracts, read 2026-09-27). */
export const STOCK_TOKENS_ON_CHAIN = '~200';

// ------------------------------------------------------------------------------------------------
// Market context (third-party figures, each with its source named on the slide)

/**
 * Kalshi and Polymarket's combined monthly volume, in $B. Pew Research Center's analyses of data
 * from The Block: "less than $5 billion in September 2025 to about $24 billion in April 2026"
 * (May 27, 2026), then $25.7B, $47.7B and $53.0B for May to July and about $47B for August
 * (Sep 23, 2026). October to March are not published month by month, so the chart breaks there.
 */
export const WAVE = {
  months: [
    { label: 'Sep ’25', value: 5, display: '<$5B' },
    { label: 'Apr ’26', value: 24, display: '$24B' },
    { label: 'May', value: 25.7, display: '$25.7B' },
    { label: 'Jun', value: 47.7, display: '$47.7B' },
    { label: 'Jul', value: 53.0, display: '$53B' },
    { label: 'Aug', value: 47, display: '$47B' },
  ],
  /** From under $5B to $53B. */
  growth: '10×',
  span: 'ten months',
  source: 'Pew Research Center, data from The Block, May and Sep 2026',
} as const;

export const TAILWINDS = [
  {
    value: '$156M',
    label: 'Robinhood’s event-contract revenue in one quarter',
    detail: 'Q2 2026, more than 10× a year earlier, on a record 13.6 billion contracts.',
    source: 'Robinhood Q2 2026 results, Jul 30, 2026',
  },
  {
    value: '4×',
    label: 'Tokenized stocks, more than quadrupled in 2026',
    detail: 'About $0.7B in January to more than $3B by late September.',
    source: 'TokenPost, Sep 2026',
  },
  {
    value: CHAIN_FACTS[0].value,
    label: 'USDG on Robinhood Chain, the dollar Hunch settles in',
    detail: `Held by ${CHAIN_FACTS[1].value} addresses, one signature away from a Hunch market.`,
    source: 'Read on chain 4663 and Blockscout, Sep 27, 2026',
  },
] as const;

/** What a trader with a view on a stock today can actually do about it. */
export const PROBLEM = {
  question: 'Will NVDA close UP today?',
  answers: [
    {
      tool: 'An options chain',
      value: '65%',
      stat: 'of S&P 500 options volume is now same-day',
      body: 'The daily bet on stocks exists. Placing it takes a strike, an expiry, the greeks and a spread.',
      source: 'Cboe, May 2026',
    },
    {
      tool: 'A prediction market',
      value: '9 in 10',
      stat: 'dollars go to sports, crypto and politics',
      body: '91% of Kalshi’s volume and 90% of Polymarket’s. Stocks share what is left with everything else.',
      source: 'Pew Research Center, data from The Block, Jul 2024 to Apr 2026',
    },
    {
      tool: 'A long-tail market',
      value: '70%',
      stat: 'of Polymarket’s markets never reach $10K',
      body: 'Listed, then left empty: 45,000 closed without a single trade.',
      source: 'CNBC analysis of Polymarket, 2021 to May 2026',
    },
  ],
} as const;

// ------------------------------------------------------------------------------------------------
// Hunch's track record (playhunch.xyz, production, pulled 2026-09-29)

export const TRACK_RECORD = {
  asOf: 'Sep 29, 2026',
  since: 'May 2026',
  engine: [
    { value: '78,501', label: 'markets opened and settled by our own resolvers', detail: 'About 20 market types, automatic resolution and payout, no human in the loop.' },
    { value: '1,034,149', label: 'trades in the four-week Hunch Cup', detail: 'Across 58,341 markets, 99.5% settled automatically. Paper USDC: our load test.' },
  ],
  money: [
    { value: '119', label: 'real-USDC bets' },
    { value: '28', label: 'bettors' },
    { value: '69', label: 'markets' },
    { value: '$931', label: 'paid out to 21 wallets' },
  ],
  agents: {
    value: '28',
    label: 'bets placed by Bankr’s agents',
    detail: 'They found our public API and wired it in themselves, before our teams had ever spoken.',
  },
  rails: ['SDKs on npm and PyPI', '34-tool MCP server', 'Bankr skills in the BankrBot catalog', 'x402 payments for agents'],
} as const;

// ------------------------------------------------------------------------------------------------
// More from Hunch: two products on the production engine on Base (production, read 2026-10-03)

/**
 * Hunch's other two products. Both run on the playhunch.xyz engine on Base, not on the Robinhood
 * Chain settler, and the slide says so.
 *
 * - Hunch Cup: season 1's published stats (`hunch_cup_stats_published`, computed 2026-09-25);
 *   trades ran Jul 8 to Aug 5, 2026. 469,886 of the 470,983 trading wallets were agents, so the
 *   label says "nearly all agents". Its trade count is on the Traction slide, not repeated here.
 * - Bazaar: first market Sep 17, 2026; every market charges 200 bps at settlement with 100 bps to
 *   its creator (`hunch_bazaar_markets`). It has no open markets on Oct 3, so the slide states
 *   what it is and how it pays, never a count.
 */
export const MORE_FROM_HUNCH = {
  cup: {
    name: 'Hunch Cup',
    domain: 'cup.playhunch.xyz',
    status: 'Season 1 · Jul 8 to Aug 5',
    what: 'A free, four-week trading tournament',
    body: 'The same live markets as playhunch.xyz, traded with free paper USDC on a public leaderboard. Anyone could play, or deploy an agent to play for them.',
    flow: ['Claim paper USDC', 'Trade live markets', 'Climb the board'],
    stats: [
      { value: '470,983', label: 'wallets traded, nearly all of them agents' },
      { value: '58,341', label: 'markets traded in four weeks' },
      { value: '$0', label: 'to enter: no deposit, no gas' },
    ],
    matters: 'It proved our engine at a million trades, and its tape is the one our paper replays.',
  },
  bazaar: {
    name: 'Bazaar',
    domain: 'bazaar.playhunch.xyz',
    status: 'Live since Sep 17',
    what: 'Prediction markets anyone can open',
    body: 'Anyone, a person or an agent, opens a market on any question. The creator resolves it, and their record is public: what they resolved, what they missed and what they hold.',
    flow: ['Open a market', 'Bet USDC on Base', 'Creator resolves'],
    stats: [
      { value: '~1 min', label: 'to open one, from the web, an X post or an agent' },
      { value: '50%', label: 'of the 2% fee is paid to the market’s creator' },
      { value: '48 h', label: 'to resolve after the deadline, or every bet is refunded' },
    ],
    matters: 'It reaches the questions no data feed can settle, and pays creators to bring the bettors.',
  },
} as const;

// ------------------------------------------------------------------------------------------------
// Team (the founders' own bios)

export const TEAM = [
  {
    initials: 'RK',
    name: 'Raj Karia',
    role: 'Co-founder & CEO',
    linkedin: 'linkedin.com/in/raj-karia',
    lead: 'Author of The Vested Parimutuel. 8 years in crypto, three products taken from zero to real users.',
    points: [
      'Founded Truts, the first search and discovery engine for Web3: 120K users, 40K MAU, $200K revenue, a team of 11.',
      'Grew Questbook’s (YC W19) developer community from zero to 16,000 and ran Polygon’s $1M grant program on it.',
      'CBO at E Money Network: 20K to 100K+ users in four countries; a crypto card to 10,000 users, revenue positive.',
    ],
    stats: [
      { value: '120K', label: 'users at Truts' },
      { value: '16K', label: 'developers, Questbook' },
      { value: '100K+', label: 'users, E Money' },
    ],
  },
  {
    initials: 'PS',
    name: 'Prachi Sahani',
    role: 'Co-founder & CTO',
    linkedin: 'linkedin.com/in/prachi-sahani',
    lead: '7 years full stack, from consumer scale to safety-critical fleets.',
    points: [
      'Bosch: leads a team of five engineers and designers on fleet safety products for 2,000+ corporate fleets.',
      'Lenskart: frontend rebuild of a consumer platform serving 5M+ users a quarter; built its component library.',
      'Infosys: built the Springboard internship portal, used by 200K students.',
      'Built chipcount.xyz: 1,000+ weekly active users.',
    ],
    stats: [
      { value: '5M+', label: 'users a quarter, Lenskart' },
      { value: '2,000+', label: 'fleets, Bosch' },
      { value: '1,000+', label: 'weekly actives, chipcount' },
    ],
  },
] as const;

/** The close: how to reach Raj. Each channel is a link on the slide and in the printed PDF. */
export const CONTACT = {
  name: TEAM[0].name,
  role: TEAM[0].role,
  initials: TEAM[0].initials,
  channels: [
    { kind: 'Email', handle: 'raj@playhunch.xyz', href: 'mailto:raj@playhunch.xyz' },
    { kind: 'Telegram', handle: 't.me/rajkaria', href: 'https://t.me/rajkaria' },
    { kind: 'X', handle: 'x.com/rajkaria_', href: 'https://x.com/rajkaria_' },
  ],
} as const;

// ------------------------------------------------------------------------------------------------
// Business model: the fee, and what it is at scale (arithmetic, not a forecast)

/**
 * The fee is 2% of winners' gains. On a balanced book the winners' gains are about the losing
 * side, half the volume, so the fee is about 1% of volume. The scenarios apply that 1% to a
 * monthly volume and annualise it; the slide labels them an illustration.
 */
export const TAKE_RATE_BPS_OF_VOLUME = 100;

export const FEE_SCENARIOS = [10_000_000, 100_000_000, 1_000_000_000].map((monthly) => ({
  monthly: dollars(monthly),
  yearly: dollars((monthly * TAKE_RATE_BPS_OF_VOLUME * 12) / 10_000),
}));

/** $10,000,000 -> "$10M", $1,200,000 -> "$1.2M", $1,000,000,000 -> "$1B". */
function dollars(value: number): string {
  const [unit, size] = value >= 1e9 ? ['B', 1e9] : ['M', 1e6];
  return `$${Number((value / size).toFixed(1))}${unit}`;
}

// ------------------------------------------------------------------------------------------------
// Competition: where each way of pricing a question sits (the founders' read of the field)

/**
 * x: 0 needs a market maker on every market, 1 fills itself. y: 0 a few headline events, 1 every
 * stock, every session. Positions are qualitative and say so on the slide.
 */
export const LANDSCAPE = [
  { name: 'Kalshi, Polymarket', note: 'Order books', x: 0.2, y: 0.22 },
  { name: 'Same-day options', note: 'Every stock, for experts', x: 0.13, y: 0.8 },
  { name: 'Classic pools', note: 'Tote, sportsbook pools', x: 0.63, y: 0.16 },
  { name: 'Hunch', note: 'Vested Parimutuel', x: 0.72, y: 0.8 },
] as const;

export const WHY_WE_WIN = [
  {
    title: 'A published rule, not a subsidy',
    body: 'Our paper’s rule pays whoever goes first, and proves our opening seed can’t lose. The thousandth market costs what the first did.',
  },
  {
    title: 'Already running',
    body: 'Our engine has settled 78,501 markets since May, and the rule is live on Robinhood Chain mainnet.',
  },
  {
    title: 'Built for agents too',
    body: 'SDKs, a 34-tool MCP server and x402 payments. Bankr’s agents found our API and bet on their own.',
  },
] as const;

// ------------------------------------------------------------------------------------------------
// The vision, the plan, and the use of funds (the founders' split, no amount on the slide)

export const VISION = [
  {
    when: 'Today',
    count: String(LIVE.tickers.length),
    title: 'Stock Tokens, live',
    body: `Daily and weekly UP or DOWN on ${LIVE.tickers.join(', ').replace(/, (\w+)$/, ' and $1')}, on Robinhood Chain mainnet.`,
  },
  {
    when: 'In six months',
    count: String(FEED_TICKERS.length),
    title: 'Every priced Stock Token',
    body: 'Every Stock Token with a Chainlink price, every session and every weekend. Ranges and earnings weeks.',
  },
  {
    when: '2027',
    count: STOCK_TOKENS_ON_CHAIN,
    title: 'Every token, every agent',
    body: 'Every Stock Token on the chain, then crypto, commodities and indices. An API so agents trade it too.',
  },
  {
    when: 'The endgame',
    count: '∞',
    title: 'A live price on what happens next',
    body: 'The market’s answer to any question with a data feed, at any hour, even when the exchange is closed.',
  },
] as const;

export const MILESTONES = [
  {
    when: 'Month 1',
    title: 'Every Stock Token, every session',
    items: [
      'External review of the settler and resolver; entry caps raised step by step',
      'Every Stock Token with a healthy Chainlink feed, daily and weekly',
      'Weekend markets, Friday close to Monday open',
    ],
  },
  {
    when: 'Month 3',
    title: 'Deeper markets, more takers',
    items: [
      'Range markets: where does NVDA close Friday?',
      'A buy-back desk for early cash-out',
      'Agent API and MCP tools; playhunch.xyz markets settle on this rail',
    ],
  },
  {
    when: 'Month 6',
    title: 'A reference, not just a venue',
    items: [
      'Earnings-week and index markets',
      'A market-implied weekend reference for Stock Tokens',
      'A legal opinion per target market and a licensing path',
    ],
  },
] as const;

export const USE_OF_FUNDS = [
  { share: 40, label: 'Engineering and security', detail: 'Audit, a protocol engineer, the range-market and buy-back builds' },
  { share: 25, label: 'Growth', detail: 'Stock Token communities and Robinhood Wallet users in Asia and the EU' },
  { share: 20, label: 'Market float', detail: 'USDG seed to open every ticker, every session' },
  { share: 15, label: 'Legal and licensing', detail: 'An opinion per target market' },
] as const;
