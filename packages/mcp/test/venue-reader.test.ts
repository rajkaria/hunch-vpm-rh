import { describe, expect, it } from "vitest";

import { ToolError } from "../src/errors.js";
import { UNBOUNDED } from "../src/format.js";
import {
  createClientVenueReader,
  normalizeClaimable,
  normalizeHeadroomPick,
  normalizeMarketState,
  normalizeOdds,
  normalizeStatus,
  normalizeTrust,
  normalizeVesting,
} from "../src/venue-reader.js";
import {
  CLIENT_PAYLOADS,
  JSON_PAYLOADS,
  OTHER_WALLET,
  SENTINEL_MARKET_PAYLOAD,
  SETTLER,
  stubClient,
  UNBOUNDED_MARKET_PAYLOAD,
  USDC,
  WALLET,
} from "./fixtures.js";

describe("normalizeMarketState", () => {
  it("reads the client's payload into the venue's vocabulary", () => {
    const market = normalizeMarketState(CLIENT_PAYLOADS.marketBook, "7");
    expect(market.id).toBe(`${SETTLER}-7`);
    expect(market.status).toBe("open");
    expect(market.kappa).toBe(30n);
    expect(market.acceptedPool).toBe(1_100n * USDC);
    expect(market.books).toHaveLength(2);
    expect(market.books[1]).toMatchObject({ index: 1, principal: 100n * USDC, headroom: 2_000n * USDC });
  });

  it("reads the same answer after a JSON round trip", () => {
    const market = normalizeMarketState(JSON_PAYLOADS.marketBook, "7");
    expect(market.books[1]).toMatchObject({ label: "NO", headroom: 2_000n * USDC });
  });

  it("treats the client's null kappa and null capacity as unbounded, not as missing", () => {
    const market = normalizeMarketState(UNBOUNDED_MARKET_PAYLOAD, "9");
    expect(market.kappa).toBe(UNBOUNDED);
    for (const book of market.books) {
      expect(book.capacity).toBe(UNBOUNDED);
      expect(book.headroom).toBe(UNBOUNDED);
    }
  });

  it("treats the indexer's -1 sentinel as unbounded only because the flag beside it says so", () => {
    const market = normalizeMarketState(SENTINEL_MARKET_PAYLOAD, "9");
    expect(market.kappa).toBe(UNBOUNDED);
    expect(market.books[0]?.capacity).toBe(UNBOUNDED);
    expect(market.books[0]?.headroom).toBe(UNBOUNDED);
  });

  it("refuses a negative headroom that nothing declares unbounded", () => {
    const payload = {
      ...SENTINEL_MARKET_PAYLOAD,
      kappa: "30",
      kappaIsUnbounded: false,
      books: [{ outcome: 0, principal: "100000000", vested: "10000000", capacity: "3000000000", headroom: "-1" }],
    };
    // A headroom below zero is impossible on-chain: the settler floors it. Reporting it
    // would say a saturated book has room.
    expect(() => normalizeMarketState(payload, "9")).toThrowError(
      expect.objectContaining({ code: "bad_upstream_data", message: expect.stringContaining("headroom") }),
    );
  });

  it("refuses a negative principal", () => {
    const payload = {
      ...JSON_PAYLOADS.marketBook,
      books: [{ outcome: 0, principal: "-1", vested: "0", capacity: "10" }],
    };
    expect(() => normalizeMarketState(payload, "7")).toThrowError(expect.objectContaining({ code: "bad_upstream_data" }));
  });

  it("derives headroom as capacity minus vested when the payload omits it", () => {
    const payload = {
      ...JSON_PAYLOADS.marketBook,
      books: JSON_PAYLOADS.marketBook.books.map(({ headroom: _headroom, ...rest }) => rest),
    };
    const market = normalizeMarketState(payload, "7");
    expect(market.books[1]?.headroom).toBe(2_000n * USDC);
  });

  it("clamps a derived headroom at zero rather than underflowing", () => {
    const payload = {
      ...JSON_PAYLOADS.marketBook,
      books: [
        { outcome: 0, principal: "1", vested: "9000", capacity: "10" },
        { outcome: 1, principal: "1", vested: "0", capacity: "10" },
      ],
    };
    expect(normalizeMarketState(payload, "7").books[0]?.headroom).toBe(0n);
  });

  it("unwraps a GraphQL-shaped { market } payload", () => {
    const market = normalizeMarketState({ market: JSON_PAYLOADS.marketBook }, "7");
    expect(market.books).toHaveLength(2);
  });

  it("names the field when the shape is wrong", () => {
    const payload = { ...JSON_PAYLOADS.marketBook, books: [{ outcome: 0, principal: "1" }] };
    expect(() => normalizeMarketState(payload, "7")).toThrowError(
      expect.objectContaining({ code: "bad_upstream_data", message: expect.stringContaining("marketBook.books[0]") }),
    );
  });

  it("accepts the settler's status enum as well as its name", () => {
    expect(normalizeStatus(0, "x")).toBe("open");
    expect(normalizeStatus("1", "x")).toBe("resolved");
    expect(normalizeStatus("Voided", "x")).toBe("voided");
    expect(() => normalizeStatus("settled", "x")).toThrow(ToolError);
  });
});

describe("normalizeOdds", () => {
  it("reads parts per million, which is what the client reports", () => {
    const rows = normalizeOdds(CLIENT_PAYLOADS.impliedOdds);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.impliedProbability).toBeCloseTo(0.909_09, 5);
    expect(rows[1]?.index).toBe(1);
  });

  it("reads a percent field as a percent, not as a fraction", () => {
    const rows = normalizeOdds([{ outcome: 0, probabilityPercent: "0.5000" }]);
    expect(rows[0]?.impliedProbability).toBeCloseTo(0.005, 6);
  });

  it("reads a bare array and rescales a percentage", () => {
    const rows = normalizeOdds([{ outcome: 0, impliedProbability: 90.9 }]);
    expect(rows[0]?.impliedProbability).toBeCloseTo(0.909, 3);
  });

  it("treats nothing as nothing", () => {
    expect(normalizeOdds(null)).toEqual([]);
  });
});

describe("normalizeHeadroomPick", () => {
  it("reads the outcome the client picked, and the headroom that binds it", () => {
    const pick = normalizeHeadroomPick(CLIENT_PAYLOADS.bestHeadroom);
    // Outcome 1, because a stake on it is rationed by outcome 0's 29,900 of headroom.
    expect(pick).toEqual({ index: 1, label: undefined, acceptsUpTo: 29_900n * USDC });
  });

  it("reads `best: null` as 'no stake can be accepted', not as a broken payload", () => {
    expect(normalizeHeadroomPick({ ...CLIENT_PAYLOADS.bestHeadroom, best: null })).toBeUndefined();
    expect(normalizeHeadroomPick(null)).toBeUndefined();
  });

  it("reads an unwrapped pick, and a null binding headroom as unbounded", () => {
    expect(normalizeHeadroomPick({ outcome: 2, bindingHeadroom: null })).toEqual({
      index: 2,
      label: undefined,
      acceptsUpTo: UNBOUNDED,
    });
  });
});

describe("normalizeTrust", () => {
  it("folds the client's per-side wallets into one list of counterparties", () => {
    const trust = normalizeTrust(CLIENT_PAYLOADS.counterpartyTrust);
    expect(trust.counterparties).toHaveLength(2);
    // Largest principal first, and in a binary market the side names the outcome held.
    expect(trust.counterparties[0]).toMatchObject({ wallet: OTHER_WALLET, outcome: 0, stake: 1_000n * USDC, agentId: undefined });
    expect(trust.counterparties[1]).toMatchObject({ wallet: WALLET, outcome: 1, stake: 100n * USDC, agentId: "42", score: 4.6 });
    expect(trust.notes).toEqual([]);
  });

  it("weights the registered share by principal", () => {
    const trust = normalizeTrust(CLIENT_PAYLOADS.counterpartyTrust);
    // 100 of 1,100 accepted principal belongs to a wallet the registry knows.
    expect(trust.registeredShare).toBeCloseTo(100 / 1_100, 6);
  });

  it("says so rather than reporting 0% registered when no reputation source is configured", () => {
    const trust = normalizeTrust({ ...CLIENT_PAYLOADS.counterpartyTrust, reputationUnavailable: true });
    expect(trust.registeredShare).toBeUndefined();
    expect(trust.notes).toEqual([expect.stringContaining("no reputation source")]);
  });

  it("still reads a flat list of counterparties", () => {
    const trust = normalizeTrust(JSON_PAYLOADS.counterpartyTrust);
    expect(trust.counterparties[0]).toMatchObject({ wallet: WALLET, agentId: "42", humanBacked: true });
    expect(trust.humanBackedShare).toBe(0.6);
  });

  it("fails loudly on a shape it does not recognise, rather than reporting nobody", () => {
    // "0 counterparties" is a statement about who is on the other side of a trade.
    expect(() => normalizeTrust({ marketId: "7", index: {} })).toThrowError(
      expect.objectContaining({ code: "bad_upstream_data", message: expect.stringContaining("counterpartyTrust.sides") }),
    );
  });

  it("survives an empty payload", () => {
    expect(normalizeTrust(undefined).counterparties).toEqual([]);
    expect(normalizeTrust({ sides: [] }).counterparties).toEqual([]);
  });
});

describe("normalizeVesting", () => {
  it("reads what has vested to a position", () => {
    const vesting = normalizeVesting(CLIENT_PAYLOADS.vestingEarned, "11");
    expect(vesting).toMatchObject({ accepted: 1_000n * USDC, vested: 400n * USDC, previewPayout: 1_400n * USDC });
  });

  it("reports 'not yet known' rather than zero while the vintage is unfinalized", () => {
    const vesting = normalizeVesting({ ...CLIENT_PAYLOADS.vestingEarned, earned: null, state: "pending-vintage" }, "11");
    expect(vesting.vested).toBeUndefined();
  });
});

describe("normalizeClaimable", () => {
  it("carries the exact call and its numeric argument from each item", () => {
    const summary = normalizeClaimable(CLIENT_PAYLOADS.claimable, WALLET.toUpperCase());
    expect(summary.wallet).toBe(WALLET);
    expect(summary.total).toBe(1_512n * USDC);
    expect(summary.items[0]).toMatchObject({
      kind: "payout",
      call: "claim",
      argument: "11",
      // The composite id is for display; `claim` takes the settler's own index.
      positionId: `${SETTLER}-11`,
    });
    expect(summary.items[1]).toMatchObject({ kind: "refund", call: "withdrawRefund", argument: "24" });
    expect(summary.items[2]).toMatchObject({ kind: "residue", call: "claimResidue", argument: "3", positionId: undefined });
  });

  it("derives the kind from the breakdown when the item does not name one", () => {
    const summary = normalizeClaimable(
      {
        items: [
          {
            id: `${SETTLER}-31`,
            marketId: `${SETTLER}-4`,
            amount: 5n * USDC,
            breakdown: { settlement: 0n, voidRefund: 5n * USDC, refusedRemainder: 0n, residue: 0n },
            call: "claim",
            argument: 31n,
          },
        ],
      },
      WALLET,
    );
    expect(summary.items[0]).toMatchObject({ kind: "void_refund", call: "claim", argument: "31" });
  });

  it("maps spellings of the refused remainder onto one kind and sums the items", () => {
    const summary = normalizeClaimable({ items: JSON_PAYLOADS.claimable.items }, WALLET);
    expect(summary.items.map((item) => item.kind)).toEqual(["payout", "refund"]);
    expect(summary.total).toBe(1_500n * USDC);
  });

  it("prefers a declared total over the sum", () => {
    expect(normalizeClaimable(JSON_PAYLOADS.claimable, WALLET).total).toBe(1_512n * USDC);
  });

  it("accepts a bare array and an empty answer", () => {
    expect(normalizeClaimable([], WALLET).items).toEqual([]);
    expect(normalizeClaimable(null, WALLET).total).toBe(0n);
  });

  it("keeps an unrecognised kind rather than guessing a contract call for it", () => {
    const summary = normalizeClaimable({ items: [{ kind: "bonus", amount: "1" }] }, WALLET);
    expect(summary.items[0]).toMatchObject({ kind: "unknown", call: undefined, argument: undefined });
  });

  it("refuses a negative amount", () => {
    expect(() => normalizeClaimable({ items: [{ kind: "payout", amount: "-1" }] }, WALLET)).toThrowError(
      expect.objectContaining({ code: "bad_upstream_data" }),
    );
  });
});

describe("error classification", () => {
  it("turns a missing market into not_found", async () => {
    const reader = createClientVenueReader(stubClient({ marketBook: async () => null }));
    await expect(reader.marketState("99")).rejects.toMatchObject({ code: "not_found" });
  });

  it("recognises a not-found thrown by the client", async () => {
    const reader = createClientVenueReader(
      stubClient({
        marketBook: async () => {
          throw new Error("market 99 not found");
        },
      }),
    );
    await expect(reader.marketState("99")).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports anything else as upstream_unavailable, naming the method", async () => {
    const reader = createClientVenueReader(
      stubClient({
        claimable: async () => {
          throw new Error("fetch failed");
        },
      }),
    );
    await expect(reader.claimable(WALLET)).rejects.toMatchObject({
      code: "upstream_unavailable",
      message: expect.stringContaining("claimable()"),
    });
  });

  it("passes the whole read through end to end", async () => {
    const reader = createClientVenueReader(stubClient());
    const market = await reader.marketState("7");
    expect(market.settler).toBe(SETTLER);
    expect((await reader.bestHeadroom("7"))?.acceptsUpTo).toBe(29_900n * USDC);
    expect((await reader.claimable(WALLET)).items).toHaveLength(3);
    expect((await reader.counterpartyTrust("7")).counterparties).toHaveLength(2);
    expect((await reader.odds("7"))[0]?.impliedProbability).toBeCloseTo(0.909_09, 5);
  });
});
