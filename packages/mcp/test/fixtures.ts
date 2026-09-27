/**
 * One market, sized so the mechanism is visible.
 *
 * YES holds 1,000 USDC of accepted principal against NO's 100. With κ = 30 the NO book
 * can carry 3,000 of vested stake and already carries 1,000, so it has 2,000 of
 * headroom left — and that number, not YES's own headroom, is the ceiling on what a new
 * stake on YES can have accepted. A 2,500 stake on YES is accepted at 2,000 and refused
 * at 500. Every acceptance test in this suite is a variation on that.
 *
 * `CLIENT_PAYLOADS` mirrors what `@hunch-vpm/client` actually returns for that market,
 * down to the bigints, the `null`-for-unbounded convention and the composite ids, so the
 * normalizers are exercised against the shape they will meet rather than a paraphrase of
 * it. `JSON_PAYLOADS` carries the same numbers as strings, which is what a source that
 * has been through JSON looks like.
 */

import type { AgentDirectory } from "../src/agent-directory.js";
import type { VpmReadClient } from "../src/client-surface.js";
import { loadConfig, type Env, type ServerConfig } from "../src/config.js";
import type {
  AgentRecord,
  ClaimableSummary,
  HeadroomPick,
  MarketState,
  OddsRow,
  TrustSummary,
  VestingEarned,
} from "../src/domain.js";
import type { ToolDeps } from "../src/tool.js";
import type { VenueReader } from "../src/venue-reader.js";

export const USDC = 1_000_000n;

export const SETTLER = "0x00000000000000000000000000000000000005e7";
export const CLASSIC_SETTLER = "0x00000000000000000000000000000000000c1a55";
export const WALLET = "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984";
export const OTHER_WALLET = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

/** 2026-09-30T18:00:00Z, and "now" 1h 46m before it. */
export const RESOLUTION_TIME = 1_790_791_200;
export const NOW = 1_790_784_840;

export const TEST_ENV: Env = {
  HUNCH_VPM_SETTLER_ADDRESS: SETTLER,
  HUNCH_VPM_CLASSIC_SETTLER_ADDRESS: CLASSIC_SETTLER,
  HUNCH_VPM_SUBGRAPH_URL: "https://example.test/subgraphs/hunch-vpm",
  HUNCH_VPM_ERC8004_SUBGRAPH_URL: "https://example.test/subgraphs/erc8004-arc",
};

export function testConfig(overrides: Env = {}): ServerConfig {
  return loadConfig({ ...TEST_ENV, ...overrides });
}

export const MARKET: MarketState = {
  id: "7",
  settler: SETTLER,
  question: "Will ETH close above $4,000 on 2026-09-30?",
  status: "open",
  kappa: 30n,
  resolutionTime: RESOLUTION_TIME,
  acceptedPool: 1_100n * USDC,
  winner: undefined,
  books: [
    {
      index: 0,
      label: "YES",
      principal: 1_000n * USDC,
      vested: 100n * USDC,
      capacity: 30_000n * USDC,
      headroom: 29_900n * USDC,
    },
    {
      index: 1,
      label: "NO",
      principal: 100n * USDC,
      vested: 1_000n * USDC,
      capacity: 3_000n * USDC,
      headroom: 2_000n * USDC,
    },
  ],
};

export const ODDS: OddsRow[] = [
  { index: 0, label: "YES", impliedProbability: 1_000 / 1_100 },
  { index: 1, label: "NO", impliedProbability: 100 / 1_100 },
];

/**
 * NO, not YES: the pick is the outcome a stake can put the most money on, and a stake on
 * NO is rationed by YES's 29,900 of headroom while a stake on YES is rationed by NO's
 * 2,000.
 */
export const BEST_HEADROOM: HeadroomPick = { index: 1, label: "NO", acceptsUpTo: 29_900n * USDC };

export const TRUST: TrustSummary = {
  counterparties: [
    {
      wallet: WALLET,
      outcome: 1,
      stake: 60n * USDC,
      share: 0.6,
      agentId: "42",
      humanBacked: true,
      feedbackCount: 17,
      score: 4.6,
    },
  ],
  registeredShare: 0.8,
  humanBackedShare: 0.6,
  notes: [],
};

export const CLAIMABLE: ClaimableSummary = {
  wallet: WALLET,
  total: 1_512n * USDC,
  items: [
    {
      kind: "payout",
      amount: 1_400n * USDC,
      marketId: `${SETTLER}-3`,
      positionId: `${SETTLER}-11`,
      outcome: 0,
      settler: SETTLER,
      call: "claim",
      argument: "11",
    },
    {
      kind: "refund",
      amount: 100n * USDC,
      marketId: `${SETTLER}-7`,
      positionId: `${SETTLER}-24`,
      outcome: 0,
      settler: SETTLER,
      call: "withdrawRefund",
      argument: "24",
    },
    {
      kind: "residue",
      amount: 12n * USDC,
      marketId: `${SETTLER}-3`,
      positionId: undefined,
      outcome: undefined,
      settler: SETTLER,
      call: "claimResidue",
      argument: "3",
    },
  ],
};

export const VESTING: VestingEarned = {
  positionId: `${SETTLER}-11`,
  accepted: 1_000n * USDC,
  vested: 400n * USDC,
  previewPayout: 1_400n * USDC,
};

export const AGENT: AgentRecord = {
  wallet: WALLET,
  identity: {
    registered: true,
    burned: false,
    agentId: "42",
    name: "forecaster",
    metadataUri: "ipfs://agent-card",
    registry: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
  },
  reputation: {
    feedbackCount: 17,
    activeFeedbackCount: 15,
    revokedFeedbackCount: 2,
    averageScore: 4.6,
    validationCount: 3,
    lastSeen: NOW - 3_600,
  },
  humanBacked: true,
  venue: {
    marketsEntered: 4,
    offered: 2_600n * USDC,
    acceptedStake: 2_400n * USDC,
    claimed: 900n * USDC,
    firstSeen: NOW - 86_400,
  },
  notes: [],
};

export function fakeVenue(overrides: Partial<VenueReader> = {}): VenueReader {
  return {
    marketState: async () => MARKET,
    odds: async () => ODDS,
    bestHeadroom: async () => BEST_HEADROOM,
    counterpartyTrust: async () => TRUST,
    vestingEarned: async () => VESTING,
    claimable: async () => CLAIMABLE,
    ...overrides,
  };
}

export function fakeAgents(record: AgentRecord | (() => Promise<AgentRecord>) = AGENT): AgentDirectory {
  return { lookup: typeof record === "function" ? record : async () => record };
}

export function makeDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    config: testConfig(),
    venue: fakeVenue(),
    agents: fakeAgents(),
    now: () => NOW,
    ...overrides,
  };
}

const INDEX = { block: 4_210_000n, hasIndexingErrors: false };

/** What `@hunch-vpm/client` resolves to for the market above. */
export const CLIENT_PAYLOADS = {
  marketBook: {
    marketId: `${SETTLER}-7`,
    settler: SETTLER,
    settlerKind: "vested",
    onChainMarketId: 7n,
    token: "0x3600000000000000000000000000000000000000",
    status: "Open",
    winner: null,
    kappa: 30n,
    acceptedPool: 1_100n * USDC,
    paidOut: 0n,
    residue: 0n,
    residueOwner: WALLET,
    residueClaimed: false,
    resolutionTime: BigInt(RESOLUTION_TIME),
    secondsToFreeze: BigInt(RESOLUTION_TIME - NOW),
    frozen: false,
    voidTimeout: 86_400n,
    voidableFrom: BigInt(RESOLUTION_TIME + 86_400),
    books: [
      {
        outcome: 0,
        principal: 1_000n * USDC,
        vested: 100n * USDC,
        capacity: 30_000n * USDC,
        headroom: 29_900n * USDC,
        probabilityPpm: 909_090n,
        probabilityPercent: "90.9090",
        decimalOddsPpm: 1_100_000n,
        maxFullyAccepted: 2_000n * USDC,
        acc: 0n,
        live: 1,
      },
      {
        outcome: 1,
        principal: 100n * USDC,
        vested: 1_000n * USDC,
        capacity: 3_000n * USDC,
        headroom: 2_000n * USDC,
        probabilityPpm: 90_909n,
        probabilityPercent: "9.0909",
        decimalOddsPpm: 11_000_000n,
        maxFullyAccepted: 29_900n * USDC,
        acc: 0n,
        live: 1,
      },
    ],
    spec: null,
    index: INDEX,
  },
  impliedOdds: {
    marketId: `${SETTLER}-7`,
    status: "Open",
    totalAccepted: 1_100n * USDC,
    defined: true,
    outcomes: [
      { outcome: 0, principal: 1_000n * USDC, probabilityPpm: 909_090n, probabilityPercent: "90.9090", decimalOddsPpm: 1_100_000n },
      { outcome: 1, principal: 100n * USDC, probabilityPpm: 90_909n, probabilityPercent: "9.0909", decimalOddsPpm: 11_000_000n },
    ],
    index: INDEX,
  },
  bestHeadroom: {
    marketId: `${SETTLER}-7`,
    status: "Open",
    frozen: false,
    best: {
      outcome: 1,
      bookHeadroom: 2_000n * USDC,
      bindingHeadroom: 29_900n * USDC,
      bindingOutcome: 0,
      maxFullyAccepted: 29_900n * USDC,
      competingDemand: 0n,
      opposing: [{ outcome: 0, headroom: 29_900n * USDC, competingDemand: 0n, allowance: 29_900n * USDC }],
    },
    outcomes: [],
    demandUnknown: false,
    index: INDEX,
  },
  claimable: {
    wallet: WALLET,
    totals: {
      settlement: 1_400n * USDC,
      voidRefund: 0n,
      refusedRemainder: 100n * USDC,
      residue: 12n * USDC,
      total: 1_512n * USDC,
    },
    items: [
      {
        id: `${SETTLER}-11`,
        marketId: `${SETTLER}-3`,
        amount: 1_400n * USDC,
        breakdown: { settlement: 1_400n * USDC, voidRefund: 0n, refusedRemainder: 0n, residue: 0n },
        call: "claim",
        argument: 11n,
        settler: SETTLER,
      },
      {
        id: `${SETTLER}-24`,
        marketId: `${SETTLER}-7`,
        amount: 100n * USDC,
        breakdown: { settlement: 0n, voidRefund: 0n, refusedRemainder: 100n * USDC, residue: 0n },
        call: "withdrawRefund",
        argument: 24n,
        settler: SETTLER,
      },
      {
        id: `${SETTLER}-3`,
        marketId: `${SETTLER}-3`,
        amount: 12n * USDC,
        breakdown: { settlement: 0n, voidRefund: 0n, refusedRemainder: 0n, residue: 12n * USDC },
        call: "claimResidue",
        argument: 3n,
        settler: SETTLER,
      },
    ],
    blockedResidue: [],
    index: INDEX,
  },
  vestingEarned: {
    positionId: `${SETTLER}-11`,
    marketId: `${SETTLER}-3`,
    owner: WALLET,
    outcome: 0,
    state: "won",
    offered: 1_000n * USDC,
    accepted: 1_000n * USDC,
    refused: 0n,
    refundWithdrawn: false,
    entryAcc: 0n,
    currentAcc: 400_000_000_000_000_000n,
    earned: 400n * USDC,
    payoutIfOutcomeWins: 1_400n * USDC,
    claimableNow: 1_400n * USDC,
    index: INDEX,
  },
  counterpartyTrust: {
    marketId: `${SETTLER}-7`,
    sides: [
      {
        // Take outcome 0 and NO's holders are against you.
        outcome: 0,
        opposingPrincipal: 100n * USDC,
        counterparties: 1,
        ratedCounterparties: 1,
        meanScore: 4.6,
        principalWeightedMeanScore: 4.6,
        unratedPrincipal: 0n,
        unratedSharePpm: 0n,
        wallets: [
          { address: WALLET, principal: 100n * USDC, sharePpm: 1_000_000n, meanScore: 4.6, feedbackCount: 17, agentId: 42n },
        ],
      },
      {
        outcome: 1,
        opposingPrincipal: 1_000n * USDC,
        counterparties: 1,
        ratedCounterparties: 0,
        meanScore: null,
        principalWeightedMeanScore: null,
        unratedPrincipal: 1_000n * USDC,
        unratedSharePpm: 1_000_000n,
        wallets: [
          { address: OTHER_WALLET, principal: 1_000n * USDC, sharePpm: 1_000_000n, meanScore: null, feedbackCount: 0, agentId: null },
        ],
      },
    ],
    reputationUnavailable: false,
    index: INDEX,
  },
} as const;

/** An n-way market: κ unbounded, so capacity and headroom are `null` on every book. */
export const UNBOUNDED_MARKET_PAYLOAD = {
  marketId: `${SETTLER}-9`,
  settler: SETTLER,
  status: "Open",
  winner: null,
  kappa: null,
  acceptedPool: 300n * USDC,
  resolutionTime: BigInt(RESOLUTION_TIME),
  frozen: false,
  books: [
    { outcome: 0, principal: 100n * USDC, vested: 10n * USDC, capacity: null, headroom: null, acc: 0n, live: 1 },
    { outcome: 1, principal: 100n * USDC, vested: 10n * USDC, capacity: null, headroom: null, acc: 0n, live: 1 },
    { outcome: 2, principal: 100n * USDC, vested: 10n * USDC, capacity: null, headroom: null, acc: 0n, live: 1 },
  ],
  index: INDEX,
} as const;

/**
 * The same market as it looks coming straight out of the index, where "unbounded" is the
 * -1 sentinel beside a boolean rather than a null.
 */
export const SENTINEL_MARKET_PAYLOAD = {
  id: `${SETTLER}-9`,
  settler: SETTLER,
  status: "OPEN",
  kappa: "-1",
  kappaIsUnbounded: true,
  acceptedPool: "300000000",
  resolutionTime: String(RESOLUTION_TIME),
  books: [
    { outcome: 0, principal: "100000000", vested: "10000000", capacity: "-1", capacityIsUnbounded: true, headroom: "-1" },
    { outcome: 1, principal: "100000000", vested: "10000000", capacity: "-1", capacityIsUnbounded: true, headroom: "-1" },
  ],
} as const;

/** The same answers after a JSON round trip, where every bigint has become a string. */
export const JSON_PAYLOADS = {
  marketBook: {
    id: "7",
    settler: SETTLER,
    question: "Will ETH close above $4,000 on 2026-09-30?",
    status: "open",
    kappa: "30",
    resolutionTime: String(RESOLUTION_TIME),
    acceptedPool: "1100000000",
    books: [
      { outcome: 0, label: "YES", principal: "1000000000", vested: "100000000", capacity: "30000000000", headroom: "29900000000" },
      { outcome: 1, label: "NO", principal: "100000000", vested: "1000000000", capacity: "3000000000", headroom: "2000000000" },
    ],
  },
  claimable: {
    total: "1512000000",
    items: [
      { kind: "payout", amount: "1400000000", marketId: "3", positionId: "11", outcome: 0, settler: SETTLER },
      { kind: "refused_remainder", amount: "100000000", marketId: "7", positionId: "24", outcome: 0 },
    ],
  },
  counterpartyTrust: {
    counterparties: [
      { address: WALLET, outcome: 1, stake: "60000000", agentId: 42, humanBacked: true, feedbackCount: 17, score: 4.6 },
    ],
    humanBackedShare: 0.6,
  },
} as const;

export function stubClient(overrides: Partial<VpmReadClient> = {}): VpmReadClient {
  return {
    marketBook: async () => CLIENT_PAYLOADS.marketBook,
    impliedOdds: async () => CLIENT_PAYLOADS.impliedOdds,
    bestHeadroom: async () => CLIENT_PAYLOADS.bestHeadroom,
    counterpartyTrust: async () => CLIENT_PAYLOADS.counterpartyTrust,
    vestingEarned: async () => CLIENT_PAYLOADS.vestingEarned,
    claimable: async () => CLIENT_PAYLOADS.claimable,
    ...overrides,
  };
}

/**
 * A stand-in for the real package: the factory it exports, alongside the config-first
 * module functions it ALSO exports. Binding the latter would put a market id in the
 * configuration slot, which is exactly what the loader has to refuse.
 */
export function realShapedClientModule(onConfig?: (config: unknown) => void): Record<string, unknown> {
  // Each one checks its first argument the way the real reads do, by using it: a module
  // function bound as if it were a method gets a market id where the config belongs, and
  // has to fail there rather than quietly answering.
  const withConfig = <T>(config: unknown, answer: T): T => {
    if (!isRecord(config) || typeof config["subgraphUrl"] !== "string") {
      throw new Error(`first argument must be a ResolvedConfig, got ${typeof config}`);
    }
    return answer;
  };
  const configFirst = {
    marketBook: async (config: unknown, _marketId: string, _options: unknown = {}) => withConfig(config, CLIENT_PAYLOADS.marketBook),
    bestHeadroom: async (config: unknown, _marketId: string, _options: unknown = {}) => withConfig(config, CLIENT_PAYLOADS.bestHeadroom),
    impliedOdds: async (config: unknown, _marketId: string) => withConfig(config, CLIENT_PAYLOADS.impliedOdds),
    counterpartyTrust: async (config: unknown, _marketId: string, _options: unknown = {}) =>
      withConfig(config, CLIENT_PAYLOADS.counterpartyTrust),
    vestingEarned: async (config: unknown, _positionId: string) => withConfig(config, CLIENT_PAYLOADS.vestingEarned),
    claimable: async (config: unknown, _wallet: string) => withConfig(config, CLIENT_PAYLOADS.claimable),
  };
  return {
    ...configFirst,
    createHunchClient: (config: unknown) => {
      onConfig?.(config);
      if (!isRecord(config) || typeof config["subgraphUrl"] !== "string") {
        throw new Error("no subgraph endpoint: pass `subgraphUrl`, or `subgraphId` together with `apiKey`");
      }
      return {
        config,
        marketBook: (marketId: string, options: unknown = {}) => configFirst.marketBook(config, marketId, options),
        bestHeadroom: (marketId: string, options: unknown = {}) => configFirst.bestHeadroom(config, marketId, options),
        impliedOdds: (marketId: string) => configFirst.impliedOdds(config, marketId),
        counterpartyTrust: (marketId: string, options: unknown = {}) => configFirst.counterpartyTrust(config, marketId, options),
        vestingEarned: (positionId: string) => configFirst.vestingEarned(config, positionId),
        claimable: (wallet: string) => configFirst.claimable(config, wallet),
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
