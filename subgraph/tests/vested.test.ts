import { BigInt } from "@graphprotocol/graph-ts";
import {
  afterEach,
  assert,
  clearStore,
  describe,
  test,
} from "matchstick-as/assembly/index";
import { Market } from "../generated/schema";
import {
  handleClaimed,
  handleEntered,
  handleMarketCreated,
  handleResolved,
  handleVintageFinalized,
  handleVoided,
} from "../src/vested";
import {
  ALICE,
  CREATOR,
  VESTED,
  big,
  bi,
  mockMarket,
  mockVestedBook,
  mockVestedPosition,
  vestedClaimed,
  vestedEntered,
  vestedMarketCreated,
  vestedResolved,
  vestedVoided,
  vintageFinalized,
} from "./utils";

const MARKET = VESTED.toHexString() + "-0";
const KAPPA = BigInt.fromI32(30);
const SCALE = BigInt.fromString("1000000000000000000");
const UINT256_MAX = BigInt.fromString(
  "115792089237316195423570985008687907853269984665640564039457584007913129639935"
);

// A binary market seeded 1000 / 1000 with kappa = 30.
//   total = 2000, so each book is vested with the other leg's 1000 and opens at
//   A_w = 1000 * 1e18 / 1000 = 1e18, capacity 30 * 1000 = 30000.
function seedMarket(): void {
  mockVestedPosition(VESTED, 0, 0, CREATOR, 0, true, true, false, 0, bi(1000), bi(1000), BigInt.zero());
  mockVestedPosition(VESTED, 1, 0, CREATOR, 1, true, true, false, 0, bi(1000), bi(1000), BigInt.zero());
  mockMarket(VESTED, 0, 2, 0, 0, KAPPA, bi(2000), BigInt.zero());
  mockVestedBook(VESTED, 0, 0, bi(1000), SCALE, bi(30000), bi(1000));
  mockVestedBook(VESTED, 0, 1, bi(1000), SCALE, bi(30000), bi(1000));

  // The settler logs the seed legs before it announces the market, so the index has to
  // survive Entered arriving first.
  handleEntered(vestedEntered(0, 0, CREATOR, 0, bi(1000), 0, 10));
  handleEntered(vestedEntered(0, 1, CREATOR, 1, bi(1000), 0, 10));
  handleMarketCreated(vestedMarketCreated(0, 2, KAPPA, 10));
}

// Alice offers 100000 on outcome 0 in block 100. Book 1 has H_1 = 30000 - 1000 = 29000 of
// headroom and is the only opposing book, so 29000 is accepted and 71000 is refused.
// Afterwards: P_0 = 30000, C_0 = 30000 + 30*29000 = 900000, V_1 = 30000 so H_1 = 0,
// A_1 = 1e18 + 29000*1e18/1000 = 30e18, A_0 unchanged at 1e18.
function enterAlice(): void {
  handleEntered(vestedEntered(0, 2, ALICE, 0, bi(100000), 100, 100));
}

function finalizeAlice(): void {
  mockVestedPosition(VESTED, 2, 0, ALICE, 0, true, false, false, 100, bi(100000), bi(29000), SCALE);
  mockMarket(VESTED, 0, 2, 0, 0, KAPPA, bi(31000), BigInt.zero());
  mockVestedBook(VESTED, 0, 0, bi(30000), SCALE, bi(900000), bi(1000));
  mockVestedBook(VESTED, 0, 1, bi(1000), SCALE.times(bi(30)), bi(30000), bi(30000));
  handleVintageFinalized(vintageFinalized(0, 100, 1, 101));
}

function rationedEntry(): void {
  enterAlice();
  finalizeAlice();
}

describe("vested settler", () => {
  afterEach(() => {
    clearStore();
  });

  test("seed vintage opens the books and the derived fields", () => {
    seedMarket();

    assert.fieldEquals("Market", MARKET, "settlerKind", "VESTED");
    assert.fieldEquals("Market", MARKET, "status", "OPEN");
    assert.fieldEquals("Market", MARKET, "n", "2");
    assert.fieldEquals("Market", MARKET, "kappa", "30");
    assert.fieldEquals("Market", MARKET, "kappaIsUnbounded", "false");
    assert.fieldEquals("Market", MARKET, "acceptedPool", "2000");
    // The residue owner is owed nothing until the market resolves.
    assert.fieldEquals("Market", MARKET, "residue", "0");
    // No factory involved, so the market has no opener: creator is a wallet here.
    // Read through get(), because `Bytes == null` hits an operator overload the
    // AssemblyScript compiler cannot resolve.
    let market = Market.load(MARKET)!;
    assert.assertTrue(market.get("opener") == null);

    // headroom = capacity - vested, computed here so a client never has to.
    assert.fieldEquals("Book", MARKET + "-0", "principal", "1000");
    assert.fieldEquals("Book", MARKET + "-0", "vested", "1000");
    assert.fieldEquals("Book", MARKET + "-0", "capacity", "30000");
    assert.fieldEquals("Book", MARKET + "-0", "headroom", "29000");
    assert.fieldEquals("Book", MARKET + "-0", "capacityIsUnbounded", "false");
    // Odds come from accepted principal, not from a quote: 1000 of a 2000 pool.
    assert.fieldEquals("Book", MARKET + "-0", "impliedOdds", "0.5");
    assert.fieldEquals("Book", MARKET + "-1", "impliedOdds", "0.5");
    assert.fieldEquals("Book", MARKET + "-0", "positionCount", "1");

    assert.fieldEquals("Vintage", MARKET + "-0", "offered", "2000");
    assert.fieldEquals("Vintage", MARKET + "-0", "accepted", "2000");
    assert.fieldEquals("Vintage", MARKET + "-0", "rationed", "0");
    assert.fieldEquals("Vintage", MARKET + "-0", "entryCount", "2");
    assert.fieldEquals("Vintage", MARKET + "-0", "finalized", "true");

    // If outcome 0 won right now the seed leg would take the whole pool.
    assert.fieldEquals("Position", VESTED.toHexString() + "-0", "accepted", "1000");
    assert.fieldEquals("Position", VESTED.toHexString() + "-0", "previewPayout", "2000");

    assert.fieldEquals("Protocol", "1", "marketCount", "1");
    assert.fieldEquals("Protocol", "1", "positionCount", "2");
    assert.fieldEquals("Protocol", "1", "totalAccepted", "2000");
    assert.fieldEquals("Protocol", "1", "agentCount", "1");
  });

  test("an entry is refused for want of headroom, and the refusal is visible", () => {
    seedMarket();
    enterAlice();
    let position = VESTED.toHexString() + "-2";

    // Before the vintage finalizes the accepted amount does not exist yet.
    assert.fieldEquals("Position", position, "finalized", "false");
    assert.fieldEquals("Position", position, "accepted", "0");
    assert.fieldEquals("Market", MARKET, "openVintage", MARKET + "-100");

    finalizeAlice();

    assert.fieldEquals("Position", position, "finalized", "true");
    assert.fieldEquals("Position", position, "offered", "100000");
    assert.fieldEquals("Position", position, "accepted", "29000");
    assert.fieldEquals("Position", position, "refused", "71000");

    assert.fieldEquals("Vintage", MARKET + "-100", "offered", "100000");
    assert.fieldEquals("Vintage", MARKET + "-100", "accepted", "29000");
    assert.fieldEquals("Vintage", MARKET + "-100", "rationed", "71000");
    assert.fieldEquals("Vintage", MARKET + "-100", "finalized", "true");

    // The opposing book is now full: it has vested exactly its capacity.
    assert.fieldEquals("Book", MARKET + "-1", "vested", "30000");
    assert.fieldEquals("Book", MARKET + "-1", "capacity", "30000");
    assert.fieldEquals("Book", MARKET + "-1", "headroom", "0");
    assert.fieldEquals("Book", MARKET + "-0", "headroom", "899000");

    assert.fieldEquals("Market", MARKET, "acceptedPool", "31000");
    assert.fieldEquals("MarketDayStat", MARKET + "-19675", "offered", "102000");
    assert.fieldEquals("MarketDayStat", MARKET + "-19675", "accepted", "31000");
    assert.fieldEquals("MarketDayStat", MARKET + "-19675", "rationed", "71000");
    assert.fieldEquals("MarketDayStat", MARKET + "-19675", "uniqueAgents", "2");
  });

  test("late stake previews only what has vested into its own book", () => {
    seedMarket();
    rationedEntry();

    // Nothing has vested into book 0 since Alice entered, so her 29000 previews at 29000:
    // she is paid her own principal back and nothing else. The seed leg, which has had
    // 1000 vested into it plus Alice's 29000, previews at 2000... and the two together
    // exhaust the pool exactly.
    assert.fieldEquals("Position", VESTED.toHexString() + "-2", "previewPayout", "29000");
    assert.fieldEquals("Position", VESTED.toHexString() + "-0", "previewPayout", "2000");
    // 29000 + 2000 = 31000 = acceptedPool. The vested rule pays late money less, and the
    // books still balance.
    assert.fieldEquals("Market", MARKET, "acceptedPool", "31000");

    // The other side has had everything vested into it: 1000 + 29000 of the 31000 pool.
    assert.fieldEquals("Position", VESTED.toHexString() + "-1", "previewPayout", "31000");
  });

  test("resolution, claims and realized pnl net to zero", () => {
    seedMarket();
    rationedEntry();

    mockMarket(VESTED, 0, 2, 1, 1, KAPPA, bi(31000), BigInt.zero());
    handleResolved(vestedResolved(0, 1, 200));

    assert.fieldEquals("Market", MARKET, "status", "RESOLVED");
    assert.fieldEquals("Market", MARKET, "winner", "1");
    assert.fieldEquals("Position", VESTED.toHexString() + "-2", "previewPayout", "0");
    assert.fieldEquals("Position", VESTED.toHexString() + "-1", "previewPayout", "31000");

    // The winning seed leg claims 31000 against 1000 of principal.
    mockMarket(VESTED, 0, 2, 1, 1, KAPPA, bi(31000), bi(31000));
    handleClaimed(vestedClaimed(1, CREATOR, bi(31000), BigInt.zero(), 201, 0));
    // The losing seed leg claims nothing and has no remainder: payout 0, refund 0.
    handleClaimed(vestedClaimed(0, CREATOR, BigInt.zero(), BigInt.zero(), 201, 1));
    // Alice lost, but still has 71000 refused stake to collect. payout 0 with refund > 0 is
    // the one ambiguous shape, so the handler falls back to the settler's own claimed flag.
    mockVestedPosition(VESTED, 2, 0, ALICE, 0, true, true, true, 100, bi(100000), bi(29000), SCALE);
    handleClaimed(vestedClaimed(2, ALICE, BigInt.zero(), bi(71000), 201, 2));

    assert.fieldEquals("Position", VESTED.toHexString() + "-1", "claimed", "true");
    assert.fieldEquals("Position", VESTED.toHexString() + "-1", "payout", "31000");
    assert.fieldEquals("Position", VESTED.toHexString() + "-2", "claimed", "true");
    assert.fieldEquals("Position", VESTED.toHexString() + "-2", "refundWithdrawn", "true");
    assert.fieldEquals("Position", VESTED.toHexString() + "-2", "payout", "0");

    // Creator: +31000 on the winner, -1000 on the loser. Alice: -29000.
    assert.fieldEquals("Agent", CREATOR.toHexString(), "realizedPnl", "29000");
    assert.fieldEquals("Agent", CREATOR.toHexString(), "totalClaimed", "31000");
    assert.fieldEquals("Agent", ALICE.toHexString(), "realizedPnl", "-29000");
    assert.fieldEquals("Protocol", "1", "totalClaimed", "31000");
    // Every accepted unit was paid out, so the settler keeps no residue.
    assert.fieldEquals("Market", MARKET, "residue", "0");
  });

  test("a void previews and refunds accepted principal", () => {
    seedMarket();
    rationedEntry();

    mockMarket(VESTED, 0, 2, 2, 0, KAPPA, bi(31000), BigInt.zero());
    handleVoided(vestedVoided(0, 200));

    assert.fieldEquals("Market", MARKET, "status", "VOIDED");
    assert.fieldEquals("Position", VESTED.toHexString() + "-2", "previewPayout", "29000");
    assert.fieldEquals("Position", VESTED.toHexString() + "-0", "previewPayout", "1000");
    assert.fieldEquals("Position", VESTED.toHexString() + "-1", "previewPayout", "1000");

    // This settler reports a void as payout, and pays any refused remainder alongside it.
    handleClaimed(vestedClaimed(2, ALICE, bi(29000), bi(71000), 201, 0));
    handleClaimed(vestedClaimed(0, CREATOR, bi(1000), BigInt.zero(), 201, 1));
    handleClaimed(vestedClaimed(1, CREATOR, bi(1000), BigInt.zero(), 201, 2));

    // Same economic event as the classic void test, and the same answer: everyone gets
    // their accepted principal back, so nobody won or lost anything.
    assert.fieldEquals("Agent", ALICE.toHexString(), "totalClaimed", "29000");
    assert.fieldEquals("Agent", ALICE.toHexString(), "realizedPnl", "0");
    assert.fieldEquals("Agent", CREATOR.toHexString(), "totalClaimed", "2000");
    assert.fieldEquals("Agent", CREATOR.toHexString(), "realizedPnl", "0");
    assert.fieldEquals("Protocol", "1", "totalClaimed", "31000");
    // claimResidue() reverts NotSettled on a voided market: there is no residue to sweep.
    assert.fieldEquals("Market", MARKET, "residue", "0");
  });

  test("unbounded kappa is reported as a sentinel, never as 2^256-1", () => {
    mockVestedPosition(VESTED, 0, 0, CREATOR, 0, true, true, false, 0, bi(1000), bi(1000), BigInt.zero());
    mockVestedPosition(VESTED, 1, 0, CREATOR, 1, true, true, false, 0, bi(1000), bi(1000), BigInt.zero());
    mockMarket(VESTED, 0, 2, 0, 0, UINT256_MAX, bi(2000), BigInt.zero());
    mockVestedBook(VESTED, 0, 0, bi(1000), SCALE, UINT256_MAX, bi(1000));
    mockVestedBook(VESTED, 0, 1, bi(1000), SCALE, UINT256_MAX, bi(1000));

    handleEntered(vestedEntered(0, 0, CREATOR, 0, bi(1000), 0, 10));
    handleEntered(vestedEntered(0, 1, CREATOR, 1, bi(1000), 0, 10));
    handleMarketCreated(vestedMarketCreated(0, 2, UINT256_MAX, 10));

    assert.fieldEquals("Market", MARKET, "kappaIsUnbounded", "true");
    assert.fieldEquals("Market", MARKET, "kappa", "-1");
    assert.fieldEquals("Book", MARKET + "-0", "capacityIsUnbounded", "true");
    assert.fieldEquals("Book", MARKET + "-0", "capacity", "-1");
    assert.fieldEquals("Book", MARKET + "-0", "headroom", "-1");
    // The odds are still real numbers; only the capacity is absent.
    assert.fieldEquals("Book", MARKET + "-0", "impliedOdds", "0.5");
  });
});
