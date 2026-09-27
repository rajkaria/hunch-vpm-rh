import { BigInt } from "@graphprotocol/graph-ts";
import { afterEach, assert, clearStore, describe, test } from "matchstick-as/assembly/index";
import { handleMarketOpened } from "../src/factory";
import { handleSpecRegistered } from "../src/feed-resolver";
import {
  handleEntered,
  handleMarketCreated,
  handlePositionTransferred,
} from "../src/vested";
import {
  BOB,
  FACTORY,
  OPENER,
  SPEC_ID,
  VESTED,
  bi,
  marketOpened,
  mockMarketCreatedBy,
  mockVestedBook,
  mockVestedPosition,
  specRegistered,
  vestedEntered,
  vestedMarketCreated,
  vestedPositionTransferred,
} from "./utils";

const MARKET = VESTED.toHexString() + "-0";
const KAPPA = BigInt.fromI32(30);
const SCALE = BigInt.fromString("1000000000000000000");
const STRIKE = BigInt.fromString("6500000000000");
const DAY = MARKET + "-19675";

// MarketFactory.open() in one transaction, in the order the contract emits: the settler's
// create() runs with the factory as msg.sender, so both seed legs are logged with
// owner = the factory; then MarketCreated, then the resolver's SpecRegistered, then the
// hand-over of each seed leg to the opener, and MarketOpened last.
function openViaFactory(block: i32): void {
  mockVestedPosition(VESTED, 0, 0, FACTORY, 0, true, true, false, 0, bi(1000), bi(1000), BigInt.zero());
  mockVestedPosition(VESTED, 1, 0, FACTORY, 1, true, true, false, 0, bi(1000), bi(1000), BigInt.zero());
  mockMarketCreatedBy(VESTED, 0, FACTORY, 2, 0, 0, KAPPA, bi(2000), BigInt.zero());
  mockVestedBook(VESTED, 0, 0, bi(1000), SCALE, bi(30000), bi(1000));
  mockVestedBook(VESTED, 0, 1, bi(1000), SCALE, bi(30000), bi(1000));

  handleEntered(vestedEntered(0, 0, FACTORY, 0, bi(1000), 0, block));
  handleEntered(vestedEntered(0, 1, FACTORY, 1, bi(1000), 0, block));
  handleMarketCreated(vestedMarketCreated(0, 2, KAPPA, block));
  handleSpecRegistered(specRegistered(SPEC_ID, VESTED, 0, STRIKE, 0, 120, block));
  handlePositionTransferred(vestedPositionTransferred(0, FACTORY, OPENER, block, 3));
  handlePositionTransferred(vestedPositionTransferred(1, FACTORY, OPENER, block, 4));

  let seed: Array<BigInt> = [bi(1000), bi(1000)];
  handleMarketOpened(marketOpened(0, VESTED, SPEC_ID, OPENER, seed, KAPPA, block, 5));
}

describe("market factory", () => {
  afterEach(() => {
    clearStore();
  });

  test("the opener owns the seed stake, not the factory that carried it", () => {
    openViaFactory(10);

    // creator is what the settler saw; opener is the wallet that paid. Both are recorded,
    // because only together do they say what happened.
    assert.fieldEquals("Market", MARKET, "creator", FACTORY.toHexString());
    assert.fieldEquals("Market", MARKET, "opener", OPENER.toHexString());
    assert.fieldEquals("Market", MARKET, "specId", SPEC_ID.toHexString());

    assert.fieldEquals("Position", VESTED.toHexString() + "-0", "owner", OPENER.toHexString());
    assert.fieldEquals("Position", VESTED.toHexString() + "-1", "owner", OPENER.toHexString());

    assert.fieldEquals("Agent", OPENER.toHexString(), "totalOffered", "2000");
    assert.fieldEquals("Agent", OPENER.toHexString(), "totalAccepted", "2000");
    assert.fieldEquals("Agent", OPENER.toHexString(), "marketsEntered", "1");

    // The factory never put anything at risk and ends up holding nothing, so it is not an
    // agent at all — not a row of zeros on a leaderboard and not a body in the head count.
    assert.notInStore("Agent", FACTORY.toHexString());
    assert.fieldEquals("Protocol", "1", "agentCount", "1");
    assert.fieldEquals("Protocol", "1", "totalAccepted", "2000");

    // One wallet seeded this market on this day, and it is the opener.
    assert.fieldEquals("MarketDayStat", DAY, "uniqueAgents", "1");
    assert.fieldEquals("MarketDayStat", DAY, "offered", "2000");
    assert.fieldEquals("MarketDayStat", DAY, "accepted", "2000");
  });

  test("a sale in a later transaction leaves the stake with the wallet that staked it", () => {
    openViaFactory(10);
    handlePositionTransferred(vestedPositionTransferred(0, OPENER, BOB, 300, 0));

    assert.fieldEquals("Position", VESTED.toHexString() + "-0", "owner", BOB.toHexString());
    // Not a hand-over: totalOffered and totalAccepted record what a wallet put at risk.
    assert.fieldEquals("Agent", OPENER.toHexString(), "totalOffered", "2000");
    assert.fieldEquals("Agent", OPENER.toHexString(), "totalAccepted", "2000");
    assert.fieldEquals("Agent", BOB.toHexString(), "totalOffered", "0");
    assert.fieldEquals("Agent", BOB.toHexString(), "totalAccepted", "0");
    // The market link does follow the position: both wallets hold one leg each now.
    assert.fieldEquals("Agent", OPENER.toHexString(), "marketsEntered", "1");
    assert.fieldEquals("Agent", BOB.toHexString(), "marketsEntered", "1");
    // A sale is not an entry, so the seeding day's head count is untouched.
    assert.fieldEquals("MarketDayStat", DAY, "uniqueAgents", "1");

    handlePositionTransferred(vestedPositionTransferred(1, OPENER, BOB, 300, 1));

    assert.fieldEquals("Agent", OPENER.toHexString(), "marketsEntered", "0");
    // The opener staked real money, so it keeps its history even holding nothing.
    assert.fieldEquals("Agent", OPENER.toHexString(), "totalAccepted", "2000");
    assert.fieldEquals("Protocol", "1", "agentCount", "2");
  });
});
