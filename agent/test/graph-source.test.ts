/**
 * The live seam: the client contract, and the decoders that sit behind it.
 *
 * The fixtures below are shaped like what `@hunch-vpm/client` actually returns —
 * `MarketBook`, `CounterpartyTrust`, `ImpliedOdds`, `BestHeadroom`, `VestingEarned` and
 * `Claimable` from `packages/client/src/types.ts`, and `UnsignedCall` from
 * `packages/client/src/writes/calldata.ts`. The agent binds that package at runtime rather
 * than importing it, so this file is where the two shapes are held against each other: a
 * disagreement should fail here and not in a live run.
 *
 * No network: the client surface is a plain object, which is exactly what
 * `assertClientSurface` promises is enough.
 */

import { describe, expect, it } from "vitest";
import { DryRunWallet } from "../src/circle/dry-run.js";
import { KAPPA_UNBOUNDED } from "../src/domain/types.js";
import { formatUsdc, parseUsdc } from "../src/domain/units.js";
import { MemoryLogger } from "../src/log.js";
import {
  ClientBindingError,
  assertClientSurface,
  bindHunchClient,
  clientConfig,
} from "../src/research/client-binding.js";
import type { HunchClientSurface } from "../src/research/client-binding.js";
import { DecodeError } from "../src/research/decode.js";
import {
  GraphResearchSource,
  GraphVenue,
  decodeBestHeadroom,
  decodeCalls,
  decodeClaimable,
  decodeMarket,
  decodeOdds,
  decodePosition,
  decodeTrust,
} from "../src/research/graph-source.js";
import { NOW, USDC, ZERO } from "./helpers.js";

const SETTLER = "0x1111111111111111111111111111111111111111" as const;
const MARKET_ID = `${SETTLER}-7`;
const FEED_KEY = `0x${"42".repeat(32)}`;

const INDEX = { block: 1_234n, hasIndexingErrors: false };

/** The client's `MarketBook`. Note `status` is capitalised and every amount is a bigint. */
const MARKET_BOOK = {
  marketId: MARKET_ID,
  settler: SETTLER,
  settlerKind: "vested",
  onChainMarketId: 7n,
  token: USDC,
  status: "Open",
  winner: null,
  kappa: 30n,
  acceptedPool: 10_000_000_000n,
  paidOut: 0n,
  residue: 0n,
  residueOwner: ZERO,
  residueClaimed: false,
  resolutionTime: BigInt(NOW + 86_400),
  secondsToFreeze: 86_400n,
  frozen: false,
  voidTimeout: 3_600n,
  voidableFrom: BigInt(NOW + 90_000),
  // The opening time, under the client's name for it. `client-integration.test.ts` is
  // what keeps this literal honest about the shape the client really returns.
  createdAt: BigInt(NOW - 3_600),
  books: [
    {
      outcome: 0,
      principal: 4_200_000_000n,
      vested: 6_100_000_000n,
      capacity: 126_000_000_000n,
      headroom: 119_900_000_000n,
      probabilityPpm: 420_000n,
      probabilityPercent: "42.0000",
      decimalOddsPpm: 2_380_952n,
      maxFullyAccepted: 169_100_000_000n,
      acc: 0n,
      live: 11,
    },
    {
      outcome: 1,
      principal: 5_800_000_000n,
      vested: 4_900_000_000n,
      capacity: 174_000_000_000n,
      headroom: 169_100_000_000n,
      probabilityPpm: 580_000n,
      probabilityPercent: "58.0000",
      decimalOddsPpm: 1_724_137n,
      maxFullyAccepted: 119_900_000_000n,
      acc: 0n,
      live: 14,
    },
  ],
  spec: {
    specId: `0x${"ab".repeat(32)}`,
    oracle: "0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62",
    feedKey: FEED_KEY,
    strike: 7_200_000_000_000n,
    direction: "above",
    maxStaleness: 3_600n,
  },
  index: INDEX,
};

/**
 * The client's `CounterpartyTrust`. `sides[o]` is who is against you if you take o, so
 * `sides[0]` describes the holders of outcome 1.
 */
const TRUST = {
  marketId: MARKET_ID,
  sides: [
    {
      outcome: 0,
      opposingPrincipal: 5_800_000_000n,
      counterparties: 14,
      ratedCounterparties: 14,
      meanScore: 70,
      principalWeightedMeanScore: 71,
      unratedPrincipal: 0n,
      unratedSharePpm: 0n,
      wallets: [],
    },
    {
      outcome: 1,
      opposingPrincipal: 4_200_000_000n,
      counterparties: 11,
      ratedCounterparties: 11,
      meanScore: 67,
      principalWeightedMeanScore: 68,
      unratedPrincipal: 0n,
      unratedSharePpm: 0n,
      wallets: [],
    },
  ],
  reputationUnavailable: false,
  index: INDEX,
};

const ODDS = {
  marketId: MARKET_ID,
  status: "Open",
  totalAccepted: 10_000_000_000n,
  defined: true,
  outcomes: [
    {
      outcome: 0,
      principal: 4_200_000_000n,
      probabilityPpm: 420_000n,
      probabilityPercent: "42.0000",
      decimalOddsPpm: 2_380_952n,
    },
    {
      outcome: 1,
      principal: 5_800_000_000n,
      probabilityPpm: 580_000n,
      probabilityPercent: "58.0000",
      decimalOddsPpm: 1_724_137n,
    },
  ],
  index: INDEX,
};

const BEST_HEADROOM = {
  marketId: MARKET_ID,
  status: "Open",
  frozen: false,
  best: {
    outcome: 0,
    bookHeadroom: 119_900_000_000n,
    bindingHeadroom: 169_100_000_000n,
    bindingOutcome: 1,
    maxFullyAccepted: 169_100_000_000n,
    competingDemand: 0n,
    opposing: [],
  },
  outcomes: [],
  demandUnknown: false,
  index: INDEX,
};

const VESTING_EARNED = {
  positionId: `${SETTLER}-3`,
  marketId: MARKET_ID,
  owner: ZERO,
  outcome: 0,
  state: "open",
  offered: 100_000_000n,
  accepted: 90_000_000n,
  refused: 10_000_000n,
  refundWithdrawn: false,
  entryAcc: 0n,
  currentAcc: 133_333_333_333_333_333n,
  earned: 12_000_000n,
  payoutIfOutcomeWins: 102_000_000n,
  claimableNow: 0n,
  index: INDEX,
};

const CLAIMABLE = {
  wallet: ZERO,
  totals: {
    settlement: 150_000_000n,
    voidRefund: 0n,
    refusedRemainder: 15_000_000n,
    residue: 0n,
    total: 165_000_000n,
  },
  items: [
    {
      id: `${SETTLER}-3`,
      marketId: MARKET_ID,
      amount: 160_000_000n,
      breakdown: {
        settlement: 150_000_000n,
        voidRefund: 0n,
        refusedRemainder: 10_000_000n,
        residue: 0n,
      },
      call: "claim",
      argument: 3n,
      settler: SETTLER,
    },
    {
      id: `${SETTLER}-9`,
      marketId: MARKET_ID,
      amount: 5_000_000n,
      breakdown: { settlement: 0n, voidRefund: 0n, refusedRemainder: 5_000_000n, residue: 0n },
      call: "withdrawRefund",
      argument: 9n,
      settler: SETTLER,
    },
    {
      id: MARKET_ID,
      marketId: MARKET_ID,
      amount: 1n,
      breakdown: { settlement: 0n, voidRefund: 0n, refusedRemainder: 0n, residue: 1n },
      call: "claimResidue",
      argument: 7n,
      settler: SETTLER,
    },
  ],
  blockedResidue: [],
  index: INDEX,
};

interface CallLog {
  readonly approve: unknown[];
  readonly enter: unknown[];
  readonly claim: unknown[];
  readonly withdraw: unknown[];
}

function client(overrides: Partial<HunchClientSurface> = {}): HunchClientSurface & { readonly calls: CallLog } {
  const calls: CallLog = { approve: [], enter: [], claim: [], withdraw: [] };
  return {
    calls,
    marketBook: () => Promise.resolve(MARKET_BOOK),
    impliedOdds: () => Promise.resolve(ODDS),
    counterpartyTrust: () => Promise.resolve(TRUST),
    bestHeadroom: () => Promise.resolve(BEST_HEADROOM),
    vestingEarned: () => Promise.resolve(VESTING_EARNED),
    claimable: () => Promise.resolve(CLAIMABLE),
    approveCalldata: (params) => {
      calls.approve.push(params);
      return { to: USDC, data: "0xa0", value: 0n };
    },
    enterCalldata: (params) => {
      calls.enter.push(params);
      return { to: SETTLER, data: "0xe0", value: 0n };
    },
    claimCalldata: (params) => {
      calls.claim.push(params);
      return { to: SETTLER, data: "0xc0", value: 0n };
    },
    withdrawRefundCalldata: (params) => {
      calls.withdraw.push(params);
      return { to: SETTLER, data: "0xw0", value: 0n };
    },
    ...overrides,
  };
}

/** The free-function namespace `@hunch-vpm/client` also exports, with its Module tag. */
function moduleNamespace(): Record<string, unknown> {
  const ns: Record<string, unknown> = {
    // Every required name is here, and every one of them is config-first:
    // marketBook(config, marketId, options). The surface check must still refuse it.
    bestHeadroom: (_config: unknown, _id: string) => Promise.resolve(null),
    impliedOdds: (_config: unknown, _id: string) => Promise.resolve(null),
    counterpartyTrust: (_config: unknown, _id: string) => Promise.resolve(null),
    vestingEarned: (_config: unknown, _id: string) => Promise.resolve(null),
    claimable: (_config: unknown, _w: string) => Promise.resolve(null),
    marketBook: (_config: unknown, _id: string) => Promise.resolve(null),
    approveCalldata: (_context: unknown, _p: unknown) => null,
    enterCalldata: (_context: unknown, _p: unknown) => null,
    claimCalldata: (_context: unknown, _p: unknown) => null,
    withdrawRefundCalldata: (_context: unknown, _p: unknown) => null,
    arcTestnet: { id: 5042002 },
    arcMainnet: { id: 5042 },
  };
  Object.defineProperty(ns, Symbol.toStringTag, { value: "Module" });
  return ns;
}

const BINDING = { subgraphUrl: "https://example.invalid/subgraph", settler: SETTLER, chainId: 5042002 };

describe("the client contract", () => {
  it("names every method the package is missing", () => {
    expect(() => assertClientSurface({ marketBook: () => null }, "@hunch-vpm/client")).toThrow(
      /bestHeadroom, impliedOdds, counterpartyTrust, vestingEarned, claimable, approveCalldata, enterCalldata, claimCalldata, withdrawRefundCalldata/,
    );
  });

  it("rejects a module that is not an object", () => {
    expect(() => assertClientSurface(undefined, "x")).toThrow(ClientBindingError);
  });

  it("accepts a complete surface", () => {
    expect(assertClientSurface(client(), "x")).toBeDefined();
  });

  /**
   * The regression this whole seam exists for. A module namespace carries every name the
   * agent needs, so a name check alone passes — and then `marketBook(marketId)` puts the
   * market id where the config belongs and the agent reads garbage rather than failing.
   */
  it("refuses a module namespace even though it has every required name", () => {
    const ns = moduleNamespace();
    expect(() => assertClientSurface(ns, "@hunch-vpm/client")).toThrow(/module namespace/);
    expect(() => bindHunchClient(ns, BINDING, "@hunch-vpm/client")).toThrow(
      /exports no client factory \(looked for createHunchClient, createClient\)/,
    );
  });

  it("binds through createHunchClient, which is the name the package exports", () => {
    const seen: unknown[] = [];
    const ns = { ...moduleNamespace(), createHunchClient: (config: unknown) => {
      seen.push(config);
      return client();
    } };
    expect(bindHunchClient(ns, BINDING, "@hunch-vpm/client")).toBeDefined();
    expect(seen).toHaveLength(1);
  });

  it("still accepts a package that names its factory createClient", () => {
    const ns = { ...moduleNamespace(), createClient: () => client() };
    expect(bindHunchClient(ns, BINDING, "@hunch-vpm/client")).toBeDefined();
  });

  it("puts the settler in the address overrides, where the write helpers read it", () => {
    const config = clientConfig(moduleNamespace(), BINDING, "@hunch-vpm/client");
    expect(config["addresses"]).toEqual({ vestedParimutuel: SETTLER });
    expect(config["subgraphUrl"]).toBe("https://example.invalid/subgraph");
    expect(config["chain"]).toEqual({ id: 5042002 });
  });

  it("names the chain it could not find rather than defaulting to the wrong one", () => {
    expect(() => clientConfig(moduleNamespace(), { ...BINDING, chainId: 1 }, "x")).toThrow(
      /exports no chain with id 1/,
    );
  });
});

describe("GraphResearchSource", () => {
  function source(overrides: Partial<HunchClientSurface> = {}) {
    const logger = new MemoryLogger();
    return {
      logger,
      source: new GraphResearchSource(client(overrides), { marketIds: [MARKET_ID], logger }),
    };
  }

  it("reads the client's own market shape, ids and units included", async () => {
    const { logger, source: s } = source();
    const market = await s.market(MARKET_ID);

    expect(market?.marketId).toBe(MARKET_ID);
    // The write path needs the settler's index, not the indexer's <settler>-<index> id.
    expect(market?.onChainMarketId).toBe(7n);
    expect(market?.status).toBe("open");
    expect(market?.kappa).toBe(30n);
    expect(market?.openedAt).toBe(NOW - 3_600);
    expect(market?.resolutionTime).toBe(NOW + 86_400);
    expect(market?.spec.direction).toBe(0);
    expect(market?.spec.maxStaleness).toBe(3_600);
    expect(market?.spec.strike8).toBe(7_200_000_000_000n);
    // Outcome 0 wins at or above the strike under direction "above".
    expect(market?.books.map((b) => b.label)).toEqual(["above", "below"]);
    expect(formatUsdc(market?.books[1]?.headroom ?? 0n)).toBe("169100.00");
    // Every number agrees with the client's, so nothing is worth warning about.
    expect(logger.lines).toEqual([]);
  });

  it("keeps counterparty trust pointed at the other side, and does not flip it twice", async () => {
    const { source: s } = source();
    const market = await s.market(MARKET_ID);
    // sides[0] describes the holders of outcome 1, scaled from the registry's 0..100.
    expect(market?.opposingTrust?.[0]).toBeCloseTo(0.71, 9);
    expect(market?.opposingTrust?.[1]).toBeCloseTo(0.68, 9);
    // Per-book holder trust is not something the client publishes, so it stays unknown.
    expect(market?.books.map((b) => b.trust)).toEqual([0, 0]);
  });

  it("discounts a side whose money is mostly anonymous", async () => {
    const mostlyUnrated = {
      ...TRUST,
      sides: [
        { ...TRUST.sides[0], principalWeightedMeanScore: 90, unratedSharePpm: 900_000n },
        TRUST.sides[1],
      ],
    };
    const { source: s } = source({ counterpartyTrust: () => Promise.resolve(mostlyUnrated) });
    const market = await s.market(MARKET_ID);
    // 0.90 over the tenth of the book that is rated at all.
    expect(market?.opposingTrust?.[0]).toBeCloseTo(0.09, 9);
  });

  it("falls back to the trust floor when reputation is unreadable, rather than losing the market", async () => {
    const { logger, source: s } = source({ counterpartyTrust: () => Promise.resolve("nonsense") });
    const market = await s.market(MARKET_ID);
    expect(market).toBeDefined();
    expect(market?.opposingTrust).toBeUndefined();
    expect(logger.lines.join("\n")).toContain("trust floor");
  });

  it("fails by name when the book carries no opening time", async () => {
    const { createdAt, ...withoutOpenedAt } = MARKET_BOOK;
    void createdAt;
    const { source: s } = source({ marketBook: () => Promise.resolve(withoutOpenedAt) });
    await expect(s.market(MARKET_ID)).rejects.toThrow(/openedAt: missing/);
  });

  it("warns when the indexer's implied odds disagree with its own books", async () => {
    const skewed = {
      ...ODDS,
      outcomes: [
        { ...ODDS.outcomes[0], probabilityPpm: 900_000n },
        { ...ODDS.outcomes[1], probabilityPpm: 100_000n },
      ],
    };
    const { logger, source: s } = source({ impliedOdds: () => Promise.resolve(skewed) });
    await s.market(MARKET_ID);
    expect(logger.lines.join("\n")).toContain("two views of one market");
  });

  it("warns when bestHeadroom disagrees with the book it names", async () => {
    const wrong = { ...BEST_HEADROOM, best: { ...BEST_HEADROOM.best, bookHeadroom: 1n } };
    const { logger, source: s } = source({ bestHeadroom: () => Promise.resolve(wrong) });
    await s.market(MARKET_ID);
    expect(logger.lines.join("\n")).toContain("bestHeadroom says 1");
  });

  it("warns when the indexer's binding headroom disagrees with the agent's own arithmetic", async () => {
    const wrong = { ...BEST_HEADROOM, best: { ...BEST_HEADROOM.best, bindingHeadroom: 5n } };
    const { logger, source: s } = source({ bestHeadroom: () => Promise.resolve(wrong) });
    await s.market(MARKET_ID);
    expect(logger.lines.join("\n")).toContain("binding headroom is 5");
  });

  it("carries on when a cross-check is unreadable, because it is only a cross-check", async () => {
    const { logger, source: s } = source({ impliedOdds: () => Promise.resolve("nonsense") });
    const market = await s.market(MARKET_ID);
    expect(market).toBeDefined();
    expect(logger.lines.join("\n")).toContain("unreadable");
  });

  it("says nothing when the market can take no stake at all", async () => {
    const none = { ...BEST_HEADROOM, best: null, frozen: true };
    const { logger, source: s } = source({ bestHeadroom: () => Promise.resolve(none) });
    await s.market(MARKET_ID);
    expect(logger.lines).toEqual([]);
  });

  it("lists exactly the markets it was told to watch", async () => {
    const { source: s } = source();
    expect(await s.listMarkets()).toHaveLength(1);
  });

  it("reads a position and what it has accrued", async () => {
    const { source: s } = source();
    const position = await s.position(`${SETTLER}-3`);
    expect(formatUsdc(position?.accepted ?? 0n)).toBe("90.00");
    expect(formatUsdc(position?.refused ?? 0n)).toBe("10.00");
    expect(formatUsdc(position?.vestingEarned ?? 0n)).toBe("12.00");
    expect(position?.finalized).toBe(true);
    expect(position?.claimed).toBe(false);
  });

  it("reads an unfinalized position as having accrued nothing, because it has", async () => {
    const pending = { ...VESTING_EARNED, state: "pending-vintage", accepted: 0n, earned: null };
    const { source: s } = source({ vestingEarned: () => Promise.resolve(pending) });
    const position = await s.position(`${SETTLER}-3`);
    expect(position?.finalized).toBe(false);
    expect(position?.vestingEarned).toBe(0n);
  });

  it("reads what the wallet can pull, and which call pulls it", async () => {
    const { logger, source: s } = source();
    const claims = await s.claimable(ZERO);

    expect(claims.map((c) => c.call)).toEqual(["claim", "withdrawRefund"]);
    expect(claims.map((c) => c.onChainPositionId)).toEqual([3n, 9n]);
    expect(formatUsdc(claims[0]?.payout ?? 0n)).toBe("150.00");
    expect(formatUsdc(claims[0]?.refund ?? 0n)).toBe("10.00");
    expect(claims[0]?.status).toBe("resolved");
    // A refused remainder is withdrawable while the market is still open.
    expect(claims[1]?.status).toBe("open");
    // The agent opens no markets, so it is never the residue owner.
    expect(logger.lines.join("\n")).toContain("claimResidue");
  });
});

describe("GraphVenue", () => {
  function venue(overrides: Partial<HunchClientSurface> = {}) {
    const wallet = new DryRunWallet({
      seed: "venue",
      startingBalance: parseUsdc("1000"),
      now: () => NOW,
    });
    const c = client(overrides);
    return { wallet, calls: c.calls, venue: new GraphVenue(c, wallet, SETTLER) };
  }

  async function market() {
    const logger = new MemoryLogger();
    const source = new GraphResearchSource(client(), { marketIds: [MARKET_ID], logger });
    const snapshot = await source.market(MARKET_ID);
    if (snapshot === undefined) throw new Error("fixture market did not decode");
    return snapshot;
  }

  it("approves before it enters, because the settler pulls the stake with transferFrom", async () => {
    const { wallet, venue: v } = venue();
    await v.enter(await market(), 0, parseUsdc("100"));
    expect(wallet.sent().map((r) => r.tx.label)).toEqual(["approve", "enter#0"]);
    expect(wallet.sent().map((r) => r.tx.data)).toEqual(["0xa0", "0xe0"]);
  });

  it("approves exactly the stake, on the market's own settlement token", async () => {
    const { calls, venue: v } = venue();
    await v.enter(await market(), 0, parseUsdc("100"));
    expect(calls.approve).toEqual([{ spender: SETTLER, amount: parseUsdc("100"), token: USDC }]);
  });

  it("enters with the settler's own market index and a bigint amount", async () => {
    const { calls, venue: v } = venue();
    await v.enter(await market(), 1, parseUsdc("100"));
    // Not the subgraph's "<settler>-7" id, and not a decimal string: `enter` takes uints.
    expect(calls.enter).toEqual([
      { settler: SETTLER, marketId: 7n, outcome: 1, amount: parseUsdc("100") },
    ]);
  });

  it("debits the stake on the entry, not on the allowance", async () => {
    const { wallet, venue: v } = venue();
    await v.enter(await market(), 0, parseUsdc("100"));
    expect(wallet.sent().map((r) => r.tx.settlementDebit)).toEqual([0n, parseUsdc("100")]);
    expect(formatUsdc(await wallet.balance())).toBe("900.00");
  });

  it("leaves acceptance undefined, because no entering transaction can know it", async () => {
    const { venue: v } = venue();
    const receipt = await v.enter(await market(), 0, parseUsdc("100"));
    expect(receipt.accepted).toBeUndefined();
  });

  it("stops sending once a step fails", async () => {
    const { wallet, venue: v } = venue();
    // A stake larger than the balance makes the entry fail in the dry-run wallet.
    await v.enter(await market(), 0, parseUsdc("5000"));
    expect(wallet.sent()).toHaveLength(2);
    expect(wallet.sent()[1]?.result.status).toBe("failed");
  });

  it("claims with the settler's own position index", async () => {
    const { calls, wallet, venue: v } = venue();
    await v.claim({
      positionId: `${SETTLER}-3`,
      onChainPositionId: 3n,
      marketId: MARKET_ID,
      payout: 1n,
      refund: 0n,
      call: "claim",
      status: "resolved",
    });
    expect(calls.claim).toEqual([{ settler: SETTLER, positionId: 3n }]);
    expect(wallet.sent()[0]?.tx.data).toBe("0xc0");
  });

  it("uses withdrawRefund for a refused remainder, because claim would revert", async () => {
    const { calls, wallet, venue: v } = venue();
    await v.claim({
      positionId: `${SETTLER}-9`,
      onChainPositionId: 9n,
      marketId: MARKET_ID,
      payout: 0n,
      refund: 5n,
      call: "withdrawRefund",
      status: "open",
    });
    expect(calls.claim).toEqual([]);
    expect(calls.withdraw).toEqual([{ settler: SETTLER, positionId: 9n }]);
    expect(wallet.sent()[0]?.tx.data).toBe("0xw0");
  });
});

describe("decoders", () => {
  it("names the field it could not read", () => {
    expect(() => decodeMarket({ ...MARKET_BOOK, acceptedPool: 1.5 }, "m1")).toThrow(
      /marketBook\(m1\)\.acceptedPool: expected an integer/,
    );
    expect(() => decodeMarket({ ...MARKET_BOOK, status: "half-open" }, "m1")).toThrow(
      /expected open\|resolved\|voided/,
    );
    expect(() =>
      decodeMarket({ ...MARKET_BOOK, spec: { ...MARKET_BOOK.spec, direction: 7 } }, "m1"),
    ).toThrow(/expected 0 or 1/);
  });

  it("says which id it needs when the book omits the settler's own index", () => {
    const { onChainMarketId, ...without } = MARKET_BOOK;
    void onChainMarketId;
    expect(() => decodeMarket(without, "m1")).toThrow(/onChainMarketId: missing/);
  });

  it("refuses an integer that arrived as a lossy float", () => {
    expect(() => decodePosition({ ...VESTING_EARNED, offered: 2 ** 60 }, "p1")).toThrow(DecodeError);
  });

  it("reads a null capacity, kappa and headroom as the unbounded sentinel", () => {
    const unbounded = {
      ...MARKET_BOOK,
      kappa: null,
      books: MARKET_BOOK.books.map((b) => ({ ...b, capacity: null, headroom: null })),
    };
    const market = decodeMarket(unbounded, "m1");
    expect(market.kappa).toBe(KAPPA_UNBOUNDED);
    expect(market.books.every((b) => b.headroom === KAPPA_UNBOUNDED)).toBe(true);
    // Three outcomes are not "above"/"below", and pretending otherwise would be a lie.
    expect(decodeMarket({ ...unbounded, books: [...unbounded.books, unbounded.books[0]] }, "m1").books[2]?.label).toBe(
      "outcome 0",
    );
  });

  it("derives headroom when the indexer does not supply it", () => {
    const withoutHeadroom = {
      ...MARKET_BOOK,
      books: MARKET_BOOK.books.map(({ headroom, ...rest }) => {
        void headroom;
        return rest;
      }),
    };
    const market = decodeMarket(withoutHeadroom, "m1");
    expect(formatUsdc(market.books[1]?.headroom ?? 0n)).toBe("169100.00");
  });

  it("reads odds from ppm, and positionally or by outcome for a simpler source", () => {
    expect(decodeOdds(ODDS, "m", 2)).toEqual([0.42, 0.58]);
    expect(decodeOdds([0.4, 0.6], "m", 2)).toEqual([0.4, 0.6]);
    expect(
      decodeOdds([{ outcome: 1, probability: 0.6 }, { outcome: 0, probability: 0.4 }], "m", 2),
    ).toEqual([0.4, 0.6]);
  });

  it("reads trust from the client's sides, or straight from a [0,1] array", () => {
    expect(decodeTrust(TRUST, "m", 100).get(0)).toBeCloseTo(0.71, 9);
    expect(decodeTrust([0.3, 0.7], "m", 100).get(1)).toBe(0.7);
    expect(decodeTrust([{ outcome: 0, trust: 0.5 }], "m", 100).get(0)).toBe(0.5);
    // An unrated side is unknown, which the policy's floor then handles.
    const unrated = { ...TRUST, sides: [{ outcome: 0, principalWeightedMeanScore: null }] };
    expect(decodeTrust(unrated, "m", 100).get(0)).toBe(0);
  });

  it("reads bestHeadroom's two different headrooms, and a market that takes nothing", () => {
    const best = decodeBestHeadroom(BEST_HEADROOM, "m");
    expect(best.outcome).toBe(0);
    expect(best.bookHeadroom).toBe(119_900_000_000n);
    expect(best.bindingHeadroom).toBe(169_100_000_000n);
    expect(decodeBestHeadroom({ ...BEST_HEADROOM, best: null }, "m").outcome).toBeUndefined();
    // The older flat shape still reads, as the outcome's own headroom.
    expect(decodeBestHeadroom({ outcome: 1, headroom: "42" }, "m").bookHeadroom).toBe(42n);
  });

  it("accepts a single call or a list, and puts the debit on the last one", () => {
    const one = decodeCalls({ to: ZERO, data: "0x" }, "enterCalldata", 5n, "enter");
    expect(one).toHaveLength(1);
    expect(one[0]?.settlementDebit).toBe(5n);
    expect(one[0]?.label).toBe("enter");

    const many = decodeCalls(
      { steps: [{ to: ZERO, data: "0x1" }, { to: ZERO, data: "0x2" }] },
      "enterCalldata",
      5n,
    );
    expect(many.map((s) => s.settlementDebit)).toEqual([0n, 5n]);
    expect(many.map((s) => s.label)).toEqual(["step0", "step1"]);
  });

  it("refuses an empty call list rather than reporting a silent success", () => {
    expect(() => decodeCalls({ steps: [] }, "enterCalldata", 0n)).toThrow(/no calls to send/);
  });

  it("reads a flat claimable list as well as the client's item shape", () => {
    const claims = decodeClaimable(
      [{ positionId: "p", onChainPositionId: "4", marketId: "m", payout: "1", status: "voided" }],
      "claimable[]",
    );
    expect(claims[0]?.refund).toBe(0n);
    expect(claims[0]?.onChainPositionId).toBe(4n);
    expect(claims[0]?.call).toBe("claim");
  });
});
