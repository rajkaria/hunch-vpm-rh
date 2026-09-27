import { BigInt } from "@graphprotocol/graph-ts";
import { afterEach, assert, clearStore, describe, test } from "matchstick-as/assembly/index";
import {
  handleClaimed,
  handleEntered,
  handleMarketCreated,
  handleResolved,
  handleVoided,
} from "../src/classic";
import {
  ALICE,
  CLASSIC,
  CREATOR,
  bi,
  classicClaimed,
  classicEntered,
  classicMarketCreated,
  classicResolved,
  classicVoided,
  mockClassicBook,
  mockMarket,
  txHash,
} from "./utils";

const MARKET = CLASSIC.toHexString() + "-0";
const KAPPA = BigInt.fromI32(30);

// The same market as the vested test: seeded 1000 / 1000, then 29000 arrives late on
// outcome 0. The classic settler accepts every unit of it, because there is no capacity to
// ration against.
function seedMarket(): void {
  mockMarket(CLASSIC, 0, 2, 0, 0, KAPPA, bi(2000), BigInt.zero());
  mockClassicBook(CLASSIC, 0, 0, bi(1000));
  mockClassicBook(CLASSIC, 0, 1, bi(1000));

  handleEntered(classicEntered(0, 0, CREATOR, 0, bi(1000), 10));
  handleEntered(classicEntered(0, 1, CREATOR, 1, bi(1000), 10));
  handleMarketCreated(classicMarketCreated(0, 2, KAPPA, 10));
}

function lateEntry(): void {
  mockMarket(CLASSIC, 0, 2, 0, 0, KAPPA, bi(31000), BigInt.zero());
  mockClassicBook(CLASSIC, 0, 0, bi(30000));
  mockClassicBook(CLASSIC, 0, 1, bi(1000));
  handleEntered(classicEntered(0, 2, ALICE, 0, bi(29000), 100));
}

describe("classic settler", () => {
  afterEach(() => {
    clearStore();
  });

  test("every offer is accepted in full and no vintage is opened", () => {
    seedMarket();
    lateEntry();

    let position = CLASSIC.toHexString() + "-2";
    assert.fieldEquals("Position", position, "offered", "29000");
    assert.fieldEquals("Position", position, "accepted", "29000");
    assert.fieldEquals("Position", position, "refused", "0");
    assert.fieldEquals("Position", position, "finalized", "true");
    // Nothing to wait for, so no vintage is ever opened.
    assert.entityCount("Vintage", 0);
    assert.fieldEquals("Market", MARKET, "settlerKind", "CLASSIC");
    assert.fieldEquals("Market", MARKET, "acceptedPool", "31000");
    // Nothing is owed to the residue owner until the market resolves, so an open market's
    // residue is zero, not its whole accepted pool.
    assert.fieldEquals("Market", MARKET, "status", "OPEN");
    assert.fieldEquals("Market", MARKET, "residue", "0");
  });

  test("a classic book has no capacity and therefore no headroom", () => {
    seedMarket();

    assert.fieldEquals("Book", MARKET + "-0", "capacityIsUnbounded", "true");
    assert.fieldEquals("Book", MARKET + "-0", "capacity", "-1");
    assert.fieldEquals("Book", MARKET + "-0", "headroom", "-1");
    // Nothing vests, which is the whole difference from the vested settler.
    assert.fieldEquals("Book", MARKET + "-0", "vested", "0");
    assert.fieldEquals("Book", MARKET + "-0", "acc", "0");
    assert.fieldEquals("Book", MARKET + "-0", "impliedOdds", "0.5");
  });

  test("late money is paid the same multiple as early money", () => {
    seedMarket();
    lateEntry();

    // 31000 pool, 30000 of principal on outcome 0. Alice's 29000 previews at
    // floor(31000 * 29000 / 30000) = 29966; the seed leg that has been there since block
    // 10 previews at floor(31000 * 1000 / 30000) = 1033. The vested settler pays the same
    // two positions 29000 and 2000 for the same stake: that gap is the mechanism.
    assert.fieldEquals("Position", CLASSIC.toHexString() + "-2", "previewPayout", "29966");
    assert.fieldEquals("Position", CLASSIC.toHexString() + "-0", "previewPayout", "1033");
  });

  test("resolution pays the winning book and leaves the flooring residue", () => {
    seedMarket();
    lateEntry();

    mockMarket(CLASSIC, 0, 2, 1, 0, KAPPA, bi(31000), BigInt.zero());
    handleResolved(classicResolved(0, 0, 200));

    assert.fieldEquals("Market", MARKET, "status", "RESOLVED");
    assert.fieldEquals("Market", MARKET, "winner", "0");
    assert.fieldEquals("Position", CLASSIC.toHexString() + "-1", "previewPayout", "0");

    mockMarket(CLASSIC, 0, 2, 1, 0, KAPPA, bi(31000), bi(30999));
    handleClaimed(classicClaimed(2, ALICE, bi(29966), BigInt.zero(), 201, 0));
    handleClaimed(classicClaimed(0, CREATOR, bi(1033), BigInt.zero(), 201, 1));

    assert.fieldEquals("Position", CLASSIC.toHexString() + "-2", "claimed", "true");
    assert.fieldEquals("Position", CLASSIC.toHexString() + "-2", "payout", "29966");
    assert.fieldEquals("Agent", ALICE.toHexString(), "realizedPnl", "966");
    assert.fieldEquals("Agent", ALICE.toHexString(), "totalClaimed", "29966");
    // 29966 + 1033 = 30999 of a 31000 pool: the missing unit is the flooring residue.
    assert.fieldEquals("Market", MARKET, "residue", "1");
  });

  test("a void refunds the accepted principal and lands every holder at zero", () => {
    seedMarket();
    lateEntry();

    mockMarket(CLASSIC, 0, 2, 2, 0, KAPPA, bi(31000), BigInt.zero());
    handleVoided(classicVoided(0, 200));

    assert.fieldEquals("Market", MARKET, "status", "VOIDED");
    assert.fieldEquals("Position", CLASSIC.toHexString() + "-2", "previewPayout", "29000");
    assert.fieldEquals("Position", CLASSIC.toHexString() + "-0", "previewPayout", "1000");

    // ClassicParimutuel.claim() pays a void through the `refund` field and leaves `payout`
    // at zero — the opposite of VestedParimutuel, which reports the same money as payout.
    handleClaimed(classicClaimed(2, ALICE, BigInt.zero(), bi(29000), 201, 0));
    handleClaimed(classicClaimed(0, CREATOR, BigInt.zero(), bi(1000), 201, 1));
    handleClaimed(classicClaimed(1, CREATOR, BigInt.zero(), bi(1000), 201, 2));

    assert.fieldEquals("Position", CLASSIC.toHexString() + "-2", "claimed", "true");
    assert.fieldEquals("Position", CLASSIC.toHexString() + "-2", "payout", "29000");
    // Nothing is ever refused on this settler, so no holder has a remainder to withdraw.
    assert.fieldEquals("Position", CLASSIC.toHexString() + "-2", "refused", "0");
    assert.fieldEquals("Position", CLASSIC.toHexString() + "-2", "refundWithdrawn", "false");
    // The Claim entity reports it the way the schema defines the two fields, not the way
    // the settler filled the log: settlement in payout, refused stake in refund.
    let claimId = txHash(201).toHexString() + "-0";
    assert.fieldEquals("Claim", claimId, "payout", "29000");
    assert.fieldEquals("Claim", claimId, "refund", "0");

    // Everyone got exactly their accepted principal back, so nobody won or lost anything.
    assert.fieldEquals("Agent", ALICE.toHexString(), "totalClaimed", "29000");
    assert.fieldEquals("Agent", ALICE.toHexString(), "realizedPnl", "0");
    assert.fieldEquals("Agent", CREATOR.toHexString(), "totalClaimed", "2000");
    assert.fieldEquals("Agent", CREATOR.toHexString(), "realizedPnl", "0");
    assert.fieldEquals("Protocol", "1", "totalClaimed", "31000");

    // A voided market has no winning positions and claimResidue() reverts on it, so its
    // residue is zero and stays zero — not the whole pool, forever.
    assert.fieldEquals("Market", MARKET, "residue", "0");
    assert.fieldEquals("Market", MARKET, "residueClaimed", "false");
  });
});
