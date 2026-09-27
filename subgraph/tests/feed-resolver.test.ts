import { BigInt } from "@graphprotocol/graph-ts";
import { afterEach, assert, clearStore, describe, test } from "matchstick-as/assembly/index";
import { handleEntered, handleMarketCreated } from "../src/vested";
import {
  handleFeedResolved,
  handleSpecRegistered,
  handleVoidedStale,
} from "../src/feed-resolver";
import {
  CLASSIC,
  CREATOR,
  FEED_KEY,
  ORACLE,
  SPEC_ID,
  VESTED,
  bi,
  feedResolved,
  mockMarket,
  mockVestedBook,
  mockVestedPosition,
  specRegistered,
  vestedEntered,
  vestedMarketCreated,
  voidedStale,
} from "./utils";

const MARKET = VESTED.toHexString() + "-0";
const KAPPA = BigInt.fromI32(30);
const SCALE = BigInt.fromString("1000000000000000000");
// 65000 at 8 decimals, the units IPriceOracle normalises to.
const STRIKE = BigInt.fromString("6500000000000");

function seedMarket(): void {
  mockVestedPosition(VESTED, 0, 0, CREATOR, 0, true, true, false, 0, bi(1000), bi(1000), BigInt.zero());
  mockVestedPosition(VESTED, 1, 0, CREATOR, 1, true, true, false, 0, bi(1000), bi(1000), BigInt.zero());
  mockMarket(VESTED, 0, 2, 0, 0, KAPPA, bi(2000), BigInt.zero());
  mockVestedBook(VESTED, 0, 0, bi(1000), SCALE, bi(30000), bi(1000));
  mockVestedBook(VESTED, 0, 1, bi(1000), SCALE, bi(30000), bi(1000));
  handleEntered(vestedEntered(0, 0, CREATOR, 0, bi(1000), 0, 10));
  handleEntered(vestedEntered(0, 1, CREATOR, 1, bi(1000), 0, 10));
  handleMarketCreated(vestedMarketCreated(0, 2, KAPPA, 10));
}

describe("feed resolver", () => {
  afterEach(() => {
    clearStore();
  });

  test("a registered spec is attached to the market it resolves", () => {
    seedMarket();
    handleSpecRegistered(specRegistered(SPEC_ID, VESTED, 0, STRIKE, 0, 120, 11));

    assert.fieldEquals("Market", MARKET, "specId", SPEC_ID.toHexString());
    assert.fieldEquals("Market", MARKET, "oracle", ORACLE.toHexString());
    assert.fieldEquals("Market", MARKET, "feedKey", FEED_KEY.toHexString());
    assert.fieldEquals("Market", MARKET, "strike", "6500000000000");
    assert.fieldEquals("Market", MARKET, "direction", "ABOVE");
    assert.fieldEquals("Market", MARKET, "maxStaleness", "120");
    assert.fieldEquals("SpecLink", SPEC_ID.toHexString(), "market", MARKET);
  });

  test("registration is permissionless, so a spec for an unknown market is ignored", () => {
    seedMarket();
    // Same specId, but pointed at a settler with no such market in the index.
    handleSpecRegistered(specRegistered(SPEC_ID, CLASSIC, 7, STRIKE, 1, 120, 11));

    assert.notInStore("SpecLink", SPEC_ID.toHexString());
    assert.notInStore("Market", CLASSIC.toHexString() + "-7");
  });

  test("resolution records the reading the market settled on", () => {
    seedMarket();
    handleSpecRegistered(specRegistered(SPEC_ID, VESTED, 0, STRIKE, 0, 120, 11));
    handleFeedResolved(feedResolved(SPEC_ID, 0, 0, BigInt.fromString("6612345000000"), 1_700_100_050, 12));

    assert.fieldEquals("Market", MARKET, "resolvedPrice", "6612345000000");
    assert.fieldEquals("Market", MARKET, "priceUpdatedAt", "1700100050");
  });

  test("a stale feed voids the market and the age is kept as the evidence", () => {
    seedMarket();
    handleSpecRegistered(specRegistered(SPEC_ID, VESTED, 0, STRIKE, 1, 120, 11));
    handleVoidedStale(voidedStale(SPEC_ID, 3600, 12));

    assert.fieldEquals("Market", MARKET, "direction", "BELOW");
    assert.fieldEquals("Market", MARKET, "voidedStaleAge", "3600");
  });
});
