/**
 * The dataset every page renders from by default.
 *
 * It is sample data, and the surface says so out loud on every page rather
 * than letting a reader mistake it for the chain. Nothing here is a screenshot
 * of a number someone liked: the books are produced by replaying entries
 * through `MarketSim`, so capacity, vesting, the accumulator and every
 * rationed entry are exactly what the settler would have arrived at from the
 * same sequence of stakes.
 *
 * Times are relative to the moment the dataset is built, so the countdowns are
 * always sensible and the tests can pin them by passing their own `now`.
 */

import { fromDecimalString, shareToPpm, USDC_DECIMALS } from '../units';
import { ARC_TESTNET_ADDRESSES, UNDEPLOYED } from '../chain';
// The payout rules come from the same module the pages quote them from, so a
// fixture cannot state a settlement the screens would compute differently.
import { classicPayout, vpmPayout } from '../vpm';
import { MarketSim, type SimEntry, type SimPosition } from './simulate';
import type {
  AgentRow,
  ClaimBreakdown,
  ClaimableView,
  MarketDetail,
  OutcomeView,
  PositionView,
  ResolutionSpec,
  VestingSample,
} from './types';

const HOUR = 3_600n;
const DAY = 86_400n;

/** USDC, written the way a person writes it. `usdc('1,250.50')` is 1250500000n. */
function usdc(amount: string): bigint {
  return fromDecimalString(amount.replaceAll(',', ''), USDC_DECIMALS);
}

/** A price at the 8 decimals `FeedResolver` and `IPriceOracle` use. */
function price(amount: string): bigint {
  return fromDecimalString(amount.replaceAll(',', ''), 8);
}

/**
 * Wallets. These are sample addresses attached to sample behaviour; none of
 * them is anybody's. They are laid out so they are obviously a set.
 */
export const FIXTURE_WALLET = '0x9A41c7B2fE5d0a3c8B6E1f4D2a7C5b9E3f8A0d61';

const AGENT_ALPHA = '0x2F6b0C9dA1e84537B0cE9a2D5f13c7B48eA09d52';
const AGENT_BETA = '0x71D4e8Ba03C95f26aD8b1E7c04F92a6B5dC38e17';
const AGENT_GAMMA = '0xC03e5A97b214Df68e0a7C9B52d1fE846b03Ac975';
const AGENT_DELTA = '0x48Bc17e2F903aD56b8E4c0917dA52fB36e8C41a9';
const AGENT_EPSILON = '0xE5a2790BcD4136f8A07b9e254Cf813dA6B0e79F4';
const HUMAN_ONE = '0x3b7F9c14eA0d52867BfC3e908A41d75B2c60Ef83';
const HUMAN_TWO = '0xa71C4e05D839bF62074aC1e8B35d9027fE46C3B1';

const RESIDUE_OWNER = '0x6D2a80F31bC947e05A8f1D6b294Ce7031fA85b42';

// -------------------------------------------------------------------- labels

interface OutcomeMeta {
  label: string;
  tone: OutcomeView['tone'];
}

const BINARY_ABOVE = (strike: string): OutcomeMeta[] => [
  { label: `Above $${strike}`, tone: 'up' },
  { label: `Below $${strike}`, tone: 'down' },
];

// -------------------------------------------------------------------- shaping

interface MarketSeed {
  id: string;
  question: string;
  subject: string;
  settlerKind: MarketDetail['settlerKind'];
  kappa: bigint | null;
  outcomes: OutcomeMeta[];
  seed: bigint[];
  openedAt: bigint;
  resolutionTime: bigint;
  voidTimeout: bigint;
  /** Entries in vintage order; each inner array is one block. */
  vintages: { at: bigint; entries: SimEntry[] }[];
  status: MarketDetail['status'];
  winner: number | null;
  spec: ResolutionSpec | null;
  /** Which addresses' positions the detail page should show as "yours". */
  wallet: string;
}

function toOutcomeViews(sim: MarketSim, meta: OutcomeMeta[], pool: bigint): OutcomeView[] {
  return sim.books.map((book) => {
    const label = meta[book.outcome];
    return {
      outcome: book.outcome,
      label: label?.label ?? `Outcome ${book.outcome}`,
      tone: label?.tone ?? 'neutral',
      principal: book.principal,
      vested: book.vested,
      capacity: book.capacity,
      acc: book.acc,
      // No vintage is left open in the fixtures: every batch is finalized by
      // the next one, which is the state a reader sees between blocks.
      demand: 0n,
      live: book.live,
      probabilityPpm: shareToPpm(book.principal, pool),
    };
  });
}

function toPositionView(settler: string, position: SimPosition, refundWithdrawn: boolean): PositionView {
  return {
    id: `${settler}-${position.positionId}`,
    positionId: position.positionId,
    owner: position.owner,
    outcome: position.outcome,
    offered: position.offered,
    accepted: position.accepted,
    refused: position.offered - position.accepted,
    entryAcc: position.entryAcc,
    vintage: position.vintage,
    finalized: true,
    refundWithdrawn,
    claimed: false,
    enteredAt: position.enteredAt,
  };
}

function buildMarket(seed: MarketSeed, now: bigint): MarketDetail {
  const sim = new MarketSim(seed.kappa, seed.seed, HUMAN_ONE, seed.openedAt, seed.settlerKind);
  for (const vintage of seed.vintages) sim.vintage(vintage.at, vintage.entries);

  const pool = sim.acceptedPool;
  const settler = UNDEPLOYED;
  const secondsToFreeze = seed.resolutionTime > now ? seed.resolutionTime - now : 0n;
  const outcomes = toOutcomeViews(sim, seed.outcomes, pool);
  const settlement = settle(sim, seed);

  if (seed.winner !== null) {
    const winning = outcomes[seed.winner];
    // Everyone but the wallet has claimed, which is what leaves the residue
    // gated: the sum of the floors is not known until the last one does.
    if (winning !== undefined) winning.live = settlement.unclaimedWinners;
  }

  return {
    id: seed.id,
    onChainMarketId: BigInt(Math.abs(hashString(seed.id)) % 64),
    settler,
    settlerKind: seed.settlerKind,
    question: seed.question,
    subject: seed.subject,
    status: seed.status,
    winner: seed.winner,
    kappa: seed.kappa,
    acceptedPool: pool,
    resolutionTime: seed.resolutionTime,
    secondsToFreeze,
    frozen: secondsToFreeze === 0n,
    outcomes,
    token: ARC_TESTNET_ADDRESSES.usdc,
    creator: HUMAN_ONE,
    resolver: ARC_TESTNET_ADDRESSES.feedResolver,
    // The wallet opened the settled market, so the residue is its own to
    // sweep — which gives the claim screen its blocked-residue case.
    residueOwner: seed.status === 'Resolved' ? seed.wallet : RESIDUE_OWNER,
    residueClaimed: false,
    residue: settlement.residue,
    paidOut: settlement.paidOut,
    voidTimeout: seed.voidTimeout,
    voidableFrom: seed.resolutionTime + seed.voidTimeout,
    vintageOpen: false,
    vintageBlock: null,
    spec: seed.spec,
    history: toHistory(sim.history),
    positions: sim.positions
      .filter((position) => position.owner === seed.wallet)
      .map((position) => toPositionView(settler, position, position.offered === position.accepted)),
    index: { block: 4_182_669n, hasIndexingErrors: false, source: 'fixture' },
  };
}

function toHistory(samples: MarketSim['history']): VestingSample[] {
  return samples.map((sample) => ({ t: sample.t, points: sample.points }));
}

interface Settlement {
  /** Payouts already claimed. Everyone except the wallet has claimed. */
  paidOut: bigint;
  /** Pi minus the sum of every winner's floored payout: what flooring leaves. */
  residue: bigint;
  /** Winning positions that have not claimed, the residue gate. */
  unclaimedWinners: number;
}

/**
 * What a settled market has paid and what it has left over.
 *
 * The residue is what per-position flooring leaves behind, so it is computed
 * as the pool minus the sum of the floors rather than picked to look
 * plausible — a residue that did not come out of the same arithmetic the
 * payout column uses would be the first number a reader could catch us on.
 *
 * Which arithmetic that is depends on the settler. The classic pool pays
 * `floor(pool * s / P_winner)`; running its books through the vested rule would
 * pay every winner its principal back and call the entire losing side residue.
 */
function settle(sim: MarketSim, seed: MarketSeed): Settlement {
  if (seed.status !== 'Resolved' || seed.winner === null) {
    return { paidOut: 0n, residue: 0n, unclaimedWinners: 0 };
  }
  const book = sim.books[seed.winner];
  if (book === undefined) return { paidOut: 0n, residue: 0n, unclaimedWinners: 0 };

  let total = 0n;
  let unclaimed = 0n;
  let unclaimedWinners = 0;
  for (const position of sim.positions) {
    if (position.outcome !== seed.winner || position.accepted <= 0n) continue;
    const payout =
      seed.settlerKind === 'classic'
        ? classicPayout(position.accepted, book.principal, sim.acceptedPool)
        : vpmPayout(position.accepted, position.entryAcc, book.acc);
    total += payout;
    if (position.owner === seed.wallet) {
      unclaimed += payout;
      unclaimedWinners += 1;
    }
  }
  return { paidOut: total - unclaimed, residue: sim.acceptedPool - total, unclaimedWinners };
}

/** A stable small integer from a slug, so a fixture's on-chain id does not move between builds. */
function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return hash;
}

// -------------------------------------------------------------------- the markets

function marketSeeds(now: bigint): MarketSeed[] {
  const storkSpec = (
    specId: string,
    feedLabel: string,
    feedKey: string,
    strike: bigint,
    direction: ResolutionSpec['direction'],
    maxStaleness: bigint,
    lastPrice: bigint | null,
    lastUpdatedAt: bigint | null,
  ): ResolutionSpec => ({
    specId,
    oracle: ARC_TESTNET_ADDRESSES.storkOracle,
    oracleName: 'Stork, through the IPriceOracle adapter',
    feedKey,
    feedLabel,
    strike,
    direction,
    maxStaleness,
    lastPrice,
    lastUpdatedAt,
  });

  return [
    // ---------------------------------------------------------------- flagship
    {
      id: 'eth-3000-sep30',
      question: 'Will ETH be above $3,000 on 30 September 2026?',
      subject: 'ETH / USD',
      settlerKind: 'vested',
      kappa: 30n,
      outcomes: BINARY_ABOVE('3,000'),
      seed: [usdc('1000'), usdc('1000')],
      openedAt: now - 9n * DAY,
      resolutionTime: now + 2n * DAY + 6n * HOUR,
      voidTimeout: 2n * DAY,
      status: 'Open',
      winner: null,
      wallet: FIXTURE_WALLET,
      spec: storkSpec(
        '0x3c1d7f04a9b26e58d01fca3b7e9024d15c8b6a7f0e39d248bb51c76a9f03e2d1',
        'ETHUSD',
        '0x7404e3d104ea7841c3d9e6fd20adfe99b4ad586bc08d8f3bd3afef894cf184de',
        price('3000'),
        'above',
        60n,
        price('3958.42'),
        now - 14n,
      ),
      // A crowded favourite. The interesting thing about it is what the crowd
      // does to the book it is crowding: every unit staked on "above" vests
      // into "below", and "below" can only absorb kappa times its own
      // principal, so the market's own capacity is what stops the price
      // running past about 30:1.
      vintages: [
        // The wallet takes the unpopular side early, which is the position
        // the vested rule pays and the classic rule does not.
        { at: now - 9n * DAY + 6n * HOUR, entries: [{ owner: FIXTURE_WALLET, outcome: 1, amount: usdc('800') }] },
        { at: now - 9n * DAY + 18n * HOUR, entries: [{ owner: AGENT_ALPHA, outcome: 0, amount: usdc('5000') }] },
        { at: now - 8n * DAY, entries: [{ owner: AGENT_GAMMA, outcome: 0, amount: usdc('8000') }] },
        { at: now - 7n * DAY, entries: [{ owner: AGENT_ALPHA, outcome: 0, amount: usdc('10000') }] },
        { at: now - 6n * DAY, entries: [{ owner: AGENT_DELTA, outcome: 0, amount: usdc('12000') }] },
        { at: now - 5n * DAY, entries: [{ owner: HUMAN_TWO, outcome: 1, amount: usdc('400') }] },
        { at: now - 4n * DAY, entries: [{ owner: AGENT_GAMMA, outcome: 0, amount: usdc('15000') }] },
        // The wallet's second entry lands when the opposing book is nearly
        // full: 15,000 of the 20,000 offered is accepted, the rest refunds.
        { at: now - 3n * DAY, entries: [{ owner: FIXTURE_WALLET, outcome: 0, amount: usdc('20000') }] },
        { at: now - 2n * DAY - 12n * HOUR, entries: [{ owner: AGENT_BETA, outcome: 1, amount: usdc('500') }] },
        { at: now - 2n * DAY, entries: [{ owner: AGENT_EPSILON, outcome: 0, amount: usdc('12000') }] },
        { at: now - 30n * HOUR, entries: [{ owner: AGENT_DELTA, outcome: 0, amount: usdc('5000') }] },
        { at: now - 8n * HOUR, entries: [{ owner: AGENT_BETA, outcome: 1, amount: usdc('200') }] },
      ],
    },

    // ---------------------------------------------------------------- healthy binary
    {
      id: 'btc-120000-oct31',
      question: 'Will BTC be above $120,000 on 31 October 2026?',
      subject: 'BTC / USD',
      settlerKind: 'vested',
      kappa: 30n,
      outcomes: BINARY_ABOVE('120,000'),
      seed: [usdc('2500'), usdc('2500')],
      openedAt: now - 3n * DAY,
      resolutionTime: now + 12n * DAY + 9n * HOUR,
      voidTimeout: 2n * DAY,
      status: 'Open',
      winner: null,
      wallet: FIXTURE_WALLET,
      spec: storkSpec(
        '0x8b4e0a71c26df395e0b7a418d52c9f6034ae1782bd90cf35e2417a06db8c93f5',
        'BTCUSD',
        '0x7b1b3f1e1bb8a2f1b4a4c65c0b0f51a2ee2e3f3f0c1d1a7b9e1c0a5d3f2b6e84',
        price('120000'),
        'above',
        60n,
        price('118240.75'),
        now - 9n,
      ),
      vintages: [
        { at: now - 3n * DAY + 2n * HOUR, entries: [{ owner: AGENT_ALPHA, outcome: 1, amount: usdc('4200') }] },
        { at: now - 2n * DAY, entries: [{ owner: AGENT_GAMMA, outcome: 0, amount: usdc('3100') }] },
        {
          at: now - 30n * HOUR,
          entries: [
            { owner: FIXTURE_WALLET, outcome: 0, amount: usdc('1500') },
            { owner: AGENT_BETA, outcome: 1, amount: usdc('2400') },
          ],
        },
        { at: now - 11n * HOUR, entries: [{ owner: AGENT_EPSILON, outcome: 1, amount: usdc('5000') }] },
        { at: now - 90n * 60n, entries: [{ owner: HUMAN_TWO, outcome: 0, amount: usdc('900') }] },
      ],
    },

    // ---------------------------------------------------------------- n-way, unbounded kappa
    {
      id: 'eth-band-oct15',
      question: 'Which band will ETH be in on 15 October 2026?',
      subject: 'ETH / USD',
      settlerKind: 'vested',
      kappa: null,
      outcomes: [
        { label: 'Under $3,500', tone: 'down' },
        { label: '$3,500 to $4,000', tone: 'neutral' },
        { label: '$4,000 to $4,500', tone: 'neutral' },
        { label: 'Over $4,500', tone: 'up' },
      ],
      seed: [usdc('600'), usdc('600'), usdc('600'), usdc('600')],
      openedAt: now - 5n * DAY,
      resolutionTime: now + 20n * DAY,
      voidTimeout: 3n * DAY,
      status: 'Open',
      winner: null,
      wallet: FIXTURE_WALLET,
      spec: storkSpec(
        '0x51f8c2a03de947b16c805fa39e27d4b08c6139fe25ab7043d918e6c50f2ba374',
        'ETHUSD',
        '0x7404e3d104ea7841c3d9e6fd20adfe99b4ad586bc08d8f3bd3afef894cf184de',
        price('4000'),
        'above',
        120n,
        price('3958.42'),
        now - 14n,
      ),
      vintages: [
        { at: now - 4n * DAY, entries: [{ owner: AGENT_ALPHA, outcome: 1, amount: usdc('2200') }] },
        { at: now - 3n * DAY, entries: [{ owner: AGENT_BETA, outcome: 2, amount: usdc('1800') }] },
        { at: now - 2n * DAY, entries: [{ owner: AGENT_GAMMA, outcome: 0, amount: usdc('700') }] },
        { at: now - 20n * HOUR, entries: [{ owner: AGENT_DELTA, outcome: 3, amount: usdc('1400') }] },
        { at: now - 4n * HOUR, entries: [{ owner: AGENT_EPSILON, outcome: 2, amount: usdc('2600') }] },
      ],
    },

    // ---------------------------------------------------------------- the classic pool, for comparison
    {
      id: 'sol-250-oct07-classic',
      question: 'Will SOL be above $250 on 7 October 2026?',
      subject: 'SOL / USD',
      settlerKind: 'classic',
      kappa: 30n,
      outcomes: BINARY_ABOVE('250'),
      seed: [usdc('1500'), usdc('1500')],
      openedAt: now - 4n * DAY,
      resolutionTime: now + 7n * DAY + 3n * HOUR,
      voidTimeout: 2n * DAY,
      status: 'Open',
      winner: null,
      wallet: FIXTURE_WALLET,
      spec: storkSpec(
        '0xd07a3e51b9c284f60e17ad4c8b352f90e6714c38da095b2f7e410c63a8d59f27',
        'SOLUSD',
        '0x2f9a6c7d8e1b4a3c5f60d9e8b7a1c2d3e4f50617283940a1b2c3d4e5f60718293',
        price('250'),
        'above',
        60n,
        price('238.11'),
        now - 21n,
      ),
      vintages: [
        { at: now - 3n * DAY, entries: [{ owner: AGENT_BETA, outcome: 1, amount: usdc('3800') }] },
        { at: now - 2n * DAY, entries: [{ owner: AGENT_DELTA, outcome: 0, amount: usdc('2200') }] },
        // The wallet holds a side here so the position panel has the open
        // classic case to render: nothing vests, nothing is refused, and the
        // payout is a share of a pool that later stake keeps enlarging.
        { at: now - 20n * HOUR, entries: [{ owner: FIXTURE_WALLET, outcome: 0, amount: usdc('1200') }] },
        { at: now - 16n * HOUR, entries: [{ owner: AGENT_ALPHA, outcome: 1, amount: usdc('1900') }] },
      ],
    },

    // ---------------------------------------------------------------- the classic pool, settled
    // The wallet holds both sides of a settled classic market, which is the one
    // case where quoting the vested payout rule would be silently wrong: the
    // classic books carry A_w = 0, so `vpmPayout` would return the accepted
    // principal — 1,000 — where `claim` pays a share of the whole pool.
    {
      id: 'link-25-aug20-classic',
      question: 'Was LINK above $25 on 20 August 2026?',
      subject: 'LINK / USD',
      settlerKind: 'classic',
      kappa: 30n,
      outcomes: BINARY_ABOVE('25'),
      seed: [usdc('1000'), usdc('1000')],
      openedAt: now - 30n * DAY,
      resolutionTime: now - 16n * DAY,
      voidTimeout: 2n * DAY,
      status: 'Resolved',
      winner: 0,
      wallet: FIXTURE_WALLET,
      spec: storkSpec(
        '0x6f31a08c5b27de094a1c83f6b05d729e4318ca7f02be9d6135c084af7e21b953',
        'LINKUSD',
        '0x1c4d8e7f2a5b60934e8d1f7c0a3b6d9e2f5081a4b7c0d3e6f9021a4b7c0d3e6f',
        price('25'),
        'above',
        60n,
        price('27.94'),
        now - 16n * DAY + 5n,
      ),
      vintages: [
        { at: now - 29n * DAY, entries: [{ owner: FIXTURE_WALLET, outcome: 0, amount: usdc('1000') }] },
        { at: now - 27n * DAY, entries: [{ owner: AGENT_BETA, outcome: 1, amount: usdc('4000') }] },
        { at: now - 24n * DAY, entries: [{ owner: AGENT_ALPHA, outcome: 0, amount: usdc('1500') }] },
        { at: now - 22n * DAY, entries: [{ owner: FIXTURE_WALLET, outcome: 1, amount: usdc('500') }] },
        { at: now - 20n * DAY, entries: [{ owner: AGENT_EPSILON, outcome: 1, amount: usdc('2500') }] },
      ],
    },

    // ---------------------------------------------------------------- frozen, awaiting resolution
    {
      id: 'btc-130000-sep12',
      question: 'Was BTC above $130,000 at 12:00 UTC on 12 September 2026?',
      subject: 'BTC / USD',
      settlerKind: 'vested',
      kappa: 30n,
      outcomes: BINARY_ABOVE('130,000'),
      seed: [usdc('800'), usdc('800')],
      openedAt: now - 6n * DAY,
      resolutionTime: now - 22n * 60n,
      voidTimeout: 2n * DAY,
      status: 'Open',
      winner: null,
      wallet: FIXTURE_WALLET,
      spec: storkSpec(
        '0x2e95c7013b8ade46f1907c5b2da83e40f6c159b78a230de41c9506fb7a38e2c1',
        'BTCUSD',
        '0x7b1b3f1e1bb8a2f1b4a4c65c0b0f51a2ee2e3f3f0c1d1a7b9e1c0a5d3f2b6e84',
        price('130000'),
        'above',
        60n,
        price('118240.75'),
        now - 9n,
      ),
      vintages: [
        { at: now - 5n * DAY, entries: [{ owner: AGENT_GAMMA, outcome: 1, amount: usdc('2600') }] },
        { at: now - 3n * DAY, entries: [{ owner: AGENT_ALPHA, outcome: 1, amount: usdc('1700') }] },
        { at: now - 2n * DAY, entries: [{ owner: FIXTURE_WALLET, outcome: 1, amount: usdc('1200') }] },
        { at: now - 1n * DAY, entries: [{ owner: AGENT_DELTA, outcome: 0, amount: usdc('400') }] },
      ],
    },

    // ---------------------------------------------------------------- resolved
    {
      id: 'eth-3600-aug31',
      question: 'Was ETH above $3,600 on 31 August 2026?',
      subject: 'ETH / USD',
      settlerKind: 'vested',
      kappa: 30n,
      outcomes: BINARY_ABOVE('3,600'),
      seed: [usdc('1200'), usdc('1200')],
      openedAt: now - 26n * DAY,
      resolutionTime: now - 12n * DAY,
      voidTimeout: 2n * DAY,
      status: 'Resolved',
      winner: 0,
      wallet: FIXTURE_WALLET,
      spec: storkSpec(
        '0x9c07be34a1d582f70e6b4c19d83a25f0617cbe4903d51a7f2860b9d4c135ae82',
        'ETHUSD',
        '0x7404e3d104ea7841c3d9e6fd20adfe99b4ad586bc08d8f3bd3afef894cf184de',
        price('3600'),
        'above',
        60n,
        price('3712.08'),
        now - 12n * DAY + 3n,
      ),
      vintages: [
        { at: now - 25n * DAY, entries: [{ owner: FIXTURE_WALLET, outcome: 0, amount: usdc('2000') }] },
        { at: now - 22n * DAY, entries: [{ owner: AGENT_BETA, outcome: 1, amount: usdc('3400') }] },
        { at: now - 19n * DAY, entries: [{ owner: AGENT_ALPHA, outcome: 0, amount: usdc('2800') }] },
        { at: now - 15n * DAY, entries: [{ owner: AGENT_EPSILON, outcome: 1, amount: usdc('1600') }] },
        { at: now - 13n * DAY, entries: [{ owner: AGENT_GAMMA, outcome: 0, amount: usdc('3300') }] },
      ],
    },

    // ---------------------------------------------------------------- voided by a quiet feed
    {
      id: 'sol-260-sep05',
      question: 'Was SOL above $260 on 5 September 2026?',
      subject: 'SOL / USD',
      settlerKind: 'vested',
      kappa: 30n,
      outcomes: BINARY_ABOVE('260'),
      seed: [usdc('900'), usdc('900')],
      openedAt: now - 21n * DAY,
      resolutionTime: now - 7n * DAY,
      voidTimeout: 2n * DAY,
      status: 'Voided',
      winner: null,
      wallet: FIXTURE_WALLET,
      spec: storkSpec(
        '0x4a186f0c3b97e25d81a0f47cb6390de25871c4f3a09bd6270e1cf85a4b36d902',
        'SOLUSD',
        '0x2f9a6c7d8e1b4a3c5f60d9e8b7a1c2d3e4f50617283940a1b2c3d4e5f60718293',
        price('260'),
        'above',
        60n,
        // The last reading the resolver saw was hours before the freeze, which
        // is what `voidStale` is for.
        price('241.55'),
        now - 7n * DAY - 5n * HOUR,
      ),
      vintages: [
        { at: now - 20n * DAY, entries: [{ owner: AGENT_DELTA, outcome: 1, amount: usdc('2100') }] },
        { at: now - 17n * DAY, entries: [{ owner: FIXTURE_WALLET, outcome: 0, amount: usdc('1400') }] },
        { at: now - 12n * DAY, entries: [{ owner: AGENT_ALPHA, outcome: 1, amount: usdc('1100') }] },
      ],
    },
  ];
}

// -------------------------------------------------------------------- agents

function agentRows(): AgentRow[] {
  return [
    {
      address: AGENT_ALPHA,
      handle: 'vesper.eth',
      agentId: 1041n,
      humanBacked: true,
      backedBy: 'hunch.eth',
      feedbackCount: 218,
      meanScore: 87,
      marketsEntered: 34,
      acceptedPrincipal: usdc('182400'),
      refusedPrincipal: usdc('9800'),
      realizedPnl: usdc('12480.55'),
      winRatePpm: 612_000n,
    },
    {
      address: AGENT_GAMMA,
      handle: 'earlybird',
      agentId: 1188n,
      humanBacked: true,
      backedBy: 'kestrel.eth',
      feedbackCount: 96,
      meanScore: 81,
      marketsEntered: 21,
      acceptedPrincipal: usdc('104900'),
      refusedPrincipal: usdc('21600'),
      realizedPnl: usdc('7302.10'),
      winRatePpm: 571_000n,
    },
    {
      address: AGENT_DELTA,
      handle: 'flatline',
      agentId: 1204n,
      humanBacked: false,
      backedBy: null,
      feedbackCount: 42,
      meanScore: 74,
      marketsEntered: 18,
      acceptedPrincipal: usdc('66150'),
      refusedPrincipal: usdc('3100'),
      realizedPnl: usdc('1985.40'),
      winRatePpm: 500_000n,
    },
    {
      address: AGENT_BETA,
      handle: 'contrarian.eth',
      agentId: 1073n,
      humanBacked: true,
      backedBy: 'nine.eth',
      feedbackCount: 154,
      meanScore: 69,
      marketsEntered: 29,
      acceptedPrincipal: usdc('91300'),
      refusedPrincipal: usdc('0'),
      realizedPnl: usdc('-2410.75'),
      winRatePpm: 448_000n,
    },
    {
      address: AGENT_EPSILON,
      handle: 'latecomer',
      agentId: null,
      humanBacked: false,
      backedBy: null,
      feedbackCount: 0,
      meanScore: null,
      marketsEntered: 11,
      acceptedPrincipal: usdc('38900'),
      refusedPrincipal: usdc('47200'),
      realizedPnl: usdc('-6120.00'),
      winRatePpm: 272_000n,
    },
    {
      address: FIXTURE_WALLET,
      handle: 'you',
      agentId: 1310n,
      humanBacked: true,
      backedBy: 'you',
      feedbackCount: 7,
      meanScore: 78,
      marketsEntered: 6,
      acceptedPrincipal: usdc('9100'),
      refusedPrincipal: usdc('3000'),
      realizedPnl: usdc('812.36'),
      winRatePpm: 666_000n,
    },
    {
      address: HUMAN_TWO,
      handle: 'oak.eth',
      agentId: null,
      humanBacked: true,
      backedBy: 'oak.eth',
      feedbackCount: 3,
      meanScore: 90,
      marketsEntered: 4,
      acceptedPrincipal: usdc('2600'),
      refusedPrincipal: usdc('0'),
      realizedPnl: usdc('148.90'),
      winRatePpm: null,
    },
    {
      address: HUMAN_ONE,
      handle: 'mkt-maker',
      agentId: 1002n,
      humanBacked: true,
      backedBy: 'hunch.eth',
      feedbackCount: 311,
      meanScore: 84,
      marketsEntered: 61,
      acceptedPrincipal: usdc('240800'),
      refusedPrincipal: usdc('1200'),
      realizedPnl: usdc('9044.18'),
      winRatePpm: 519_000n,
    },
  ];
}

// -------------------------------------------------------------------- dataset

export interface FixtureData {
  markets: MarketDetail[];
  agents: AgentRow[];
  wallet: string;
  claimable: ClaimableView;
}

/**
 * Build the dataset as of `now`. Deterministic in `now`: the same timestamp
 * always produces the same books, which is what lets the tests assert on
 * concrete amounts.
 */
export function buildFixtures(now: bigint): FixtureData {
  const markets = marketSeeds(now).map((seed) => buildMarket(seed, now));
  return {
    markets,
    agents: agentRows(),
    wallet: FIXTURE_WALLET,
    claimable: buildClaimable(markets),
  };
}

const ZERO_BREAKDOWN: ClaimBreakdown = {
  settlement: 0n,
  voidRefund: 0n,
  refusedRemainder: 0n,
  residue: 0n,
};

/**
 * What the wallet can pull, derived from the same books the market pages show.
 *
 * One item per transaction the wallet should send, never two items sharing a
 * call: `claim` pays a settlement and any outstanding refused remainder in the
 * same transaction, and sending it twice reverts.
 */
function buildClaimable(markets: MarketDetail[]): ClaimableView {
  const items: ClaimableView['items'] = [];
  const blocked: ClaimableView['blockedResidue'] = [];
  const totals = { ...ZERO_BREAKDOWN, total: 0n };

  for (const market of markets) {
    for (const position of market.positions) {
      const breakdown = { ...ZERO_BREAKDOWN };

      if (market.status === 'Resolved' && position.outcome === market.winner) {
        const book = market.outcomes[position.outcome];
        // Same branch as `settle` and `PositionPanel`: the classic pool pays a
        // share of the whole pool, and quoting the vested rule on its books
        // would put the principal on the claim button instead of the payout.
        breakdown.settlement =
          market.settlerKind === 'classic'
            ? classicPayout(position.accepted, book?.principal ?? 0n, market.acceptedPool)
            : vpmPayout(position.accepted, position.entryAcc, book?.acc ?? 0n);
      } else if (market.status === 'Voided') {
        breakdown.voidRefund = position.accepted;
      }

      if (!position.refundWithdrawn && position.refused > 0n) {
        breakdown.refusedRemainder = position.refused;
      }

      const amount = breakdown.settlement + breakdown.voidRefund + breakdown.refusedRemainder;
      if (amount === 0n) continue;

      // A settled market pays through `claim`, which covers the remainder too.
      // An open one has only the remainder, and that is `withdrawRefund`.
      const call = market.status === 'Open' ? 'withdrawRefund' : 'claim';
      items.push({
        id: position.id,
        marketId: market.id,
        question: market.question,
        amount,
        breakdown,
        call,
        argument: position.positionId,
        settler: market.settler,
      });

      totals.settlement += breakdown.settlement;
      totals.voidRefund += breakdown.voidRefund;
      totals.refusedRemainder += breakdown.refusedRemainder;
      totals.total += amount;
    }

    // The residue is the wallet's only when it is the named owner, and it is
    // sweepable only once every winning position has claimed — including the
    // wallet's own, which is why this row sits under the claim button rather
    // than beside it.
    const outstanding = market.winner === null ? 0 : (market.outcomes[market.winner]?.live ?? 0);
    if (
      market.status === 'Resolved' &&
      market.residueOwner === FIXTURE_WALLET &&
      !market.residueClaimed &&
      market.residue > 0n
    ) {
      blocked.push({
        marketId: market.id,
        question: market.question,
        amount: market.residue,
        reason:
          outstanding === 1
            ? 'one winning position has not claimed yet'
            : `${outstanding} winning positions have not claimed yet`,
      });
    }
  }

  return {
    wallet: FIXTURE_WALLET,
    totals,
    items,
    blockedResidue: blocked,
    index: { block: 4_182_669n, hasIndexingErrors: false, source: 'fixture' },
  };
}
