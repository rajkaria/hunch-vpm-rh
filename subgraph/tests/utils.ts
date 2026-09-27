import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { createMockedFunction, newMockEvent } from "matchstick-as/assembly/index";
import {
  Claimed as VestedClaimed,
  Entered as VestedEntered,
  MarketCreated as VestedMarketCreated,
  Resolved as VestedResolved,
  VintageFinalized,
  Voided as VestedVoided,
} from "../generated/VestedParimutuel/VestedParimutuel";
import {
  Claimed as ClassicClaimed,
  Entered as ClassicEntered,
  MarketCreated as ClassicMarketCreated,
  PositionTransferred as ClassicPositionTransferred,
  Resolved as ClassicResolved,
  Voided as ClassicVoided,
} from "../generated/ClassicParimutuel/ClassicParimutuel";
import {
  Resolved as FeedResolved,
  SpecRegistered,
  VoidedStale,
} from "../generated/FeedResolver/FeedResolver";
import { PositionTransferred as VestedPositionTransferred } from "../generated/VestedParimutuel/VestedParimutuel";
import { MarketOpened } from "../generated/MarketFactory/MarketFactory";

export const VESTED = Address.fromString("0x1111111111111111111111111111111111111111");
export const CLASSIC = Address.fromString("0x2222222222222222222222222222222222222222");
export const RESOLVER = Address.fromString("0x3333333333333333333333333333333333333333");
export const CREATOR = Address.fromString("0x4444444444444444444444444444444444444444");
export const ALICE = Address.fromString("0x5555555555555555555555555555555555555555");
export const RESIDUE_OWNER = Address.fromString("0x6666666666666666666666666666666666666666");
export const FACTORY = Address.fromString("0x7777777777777777777777777777777777777777");
/// The wallet that calls MarketFactory.open() and pays for the seed.
export const OPENER = Address.fromString("0x8888888888888888888888888888888888888888");
export const BOB = Address.fromString("0x9999999999999999999999999999999999999999");

/// Stork on Arc testnet, read through the IPriceOracle adapter.
export const ORACLE = Address.fromString("0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62");
export const FEED_KEY = Bytes.fromHexString(
  "0x7404e3d104ea7841c3d9e6fd20adfe99b4ad586bc08d8f3bd3afef894cf184de"
) as Bytes;
export const SPEC_ID = Bytes.fromHexString(
  "0x00000000000000000000000000000000000000000000000000000000000000aa"
) as Bytes;

/// Arc's native USDC, which is what these markets actually settle in.
export const USDC = Address.fromString("0x3600000000000000000000000000000000000000");

export const MARKET_SIG =
  "getMarket(uint256):(address,address,address,address,uint64,uint64,uint8,uint8,uint8,uint256,uint256,uint256)";
export const VESTED_BOOK_SIG =
  "getBook(uint256,uint8):((uint256,uint256,uint256,uint256,uint256,uint256))";
export const CLASSIC_BOOK_SIG = "getBook(uint256,uint8):((uint256,uint256))";
export const POSITIONS_SIG =
  "positions(uint256):(uint64,address,uint8,bool,bool,bool,uint64,uint128,uint128,uint128)";

export function bi(n: i32): BigInt {
  return BigInt.fromI32(n);
}

export function big(s: string): BigInt {
  return BigInt.fromString(s);
}

/// One transaction per block in these fixtures. That is what lets a test say "the same
/// transaction" by reusing a block number, which is the shape MarketFactory.open() has:
/// the seed entries and the hand-over transfers are all one transaction.
export function txHash(block: i32): Bytes {
  let hex = block.toString(16);
  while (hex.length < 64) hex = "0" + hex;
  return Bytes.fromHexString("0x" + hex) as Bytes;
}

function stamp(event: ethereum.Event, block: i32, logIndex: i32): void {
  event.block.number = bi(block);
  // One block a second keeps the arithmetic in the day-bucket assertions trivial.
  event.block.timestamp = bi(1_700_000_000 + block);
  event.logIndex = bi(logIndex);
  event.transaction.hash = txHash(block);
  event.parameters = new Array<ethereum.EventParam>();
}

function param(name: string, value: ethereum.Value): ethereum.EventParam {
  return new ethereum.EventParam(name, value);
}

// ---------------------------------------------------------------- contract mocks

export function mockMarket(
  settler: Address,
  marketId: i32,
  n: i32,
  status: i32,
  winner: i32,
  kappa: BigInt,
  acceptedPool: BigInt,
  paidOut: BigInt
): void {
  mockMarketCreatedBy(settler, marketId, CREATOR, n, status, winner, kappa, acceptedPool, paidOut);
}

/// getMarket() reports whoever called create(). Under MarketFactory that is the factory
/// contract, which is the whole reason Market.opener exists.
export function mockMarketCreatedBy(
  settler: Address,
  marketId: i32,
  creator: Address,
  n: i32,
  status: i32,
  winner: i32,
  kappa: BigInt,
  acceptedPool: BigInt,
  paidOut: BigInt
): void {
  createMockedFunction(settler, "getMarket", MARKET_SIG)
    .withArgs([ethereum.Value.fromUnsignedBigInt(bi(marketId))])
    .returns([
      ethereum.Value.fromAddress(USDC),
      ethereum.Value.fromAddress(creator),
      ethereum.Value.fromAddress(RESOLVER),
      ethereum.Value.fromAddress(RESIDUE_OWNER),
      ethereum.Value.fromUnsignedBigInt(bi(1_700_100_000)),
      ethereum.Value.fromUnsignedBigInt(bi(3600)),
      ethereum.Value.fromI32(n),
      ethereum.Value.fromI32(status),
      ethereum.Value.fromI32(winner),
      ethereum.Value.fromUnsignedBigInt(kappa),
      ethereum.Value.fromUnsignedBigInt(acceptedPool),
      ethereum.Value.fromUnsignedBigInt(paidOut),
    ]);
}

export function mockVestedBook(
  settler: Address,
  marketId: i32,
  outcome: i32,
  principal: BigInt,
  acc: BigInt,
  capacity: BigInt,
  vested: BigInt
): void {
  let fields: Array<ethereum.Value> = [
    ethereum.Value.fromUnsignedBigInt(principal),
    ethereum.Value.fromUnsignedBigInt(acc),
    ethereum.Value.fromUnsignedBigInt(capacity),
    ethereum.Value.fromUnsignedBigInt(vested),
    ethereum.Value.fromUnsignedBigInt(BigInt.zero()), // demand
    ethereum.Value.fromUnsignedBigInt(BigInt.zero()), // live
  ];
  createMockedFunction(settler, "getBook", VESTED_BOOK_SIG)
    .withArgs([
      ethereum.Value.fromUnsignedBigInt(bi(marketId)),
      ethereum.Value.fromUnsignedBigInt(bi(outcome)),
    ])
    .returns([ethereum.Value.fromTuple(changetype<ethereum.Tuple>(fields))]);
}

export function mockClassicBook(
  settler: Address,
  marketId: i32,
  outcome: i32,
  principal: BigInt
): void {
  let fields: Array<ethereum.Value> = [
    ethereum.Value.fromUnsignedBigInt(principal),
    ethereum.Value.fromUnsignedBigInt(BigInt.zero()), // live
  ];
  createMockedFunction(settler, "getBook", CLASSIC_BOOK_SIG)
    .withArgs([
      ethereum.Value.fromUnsignedBigInt(bi(marketId)),
      ethereum.Value.fromUnsignedBigInt(bi(outcome)),
    ])
    .returns([ethereum.Value.fromTuple(changetype<ethereum.Tuple>(fields))]);
}

export function mockVestedPosition(
  settler: Address,
  positionId: i32,
  marketId: i32,
  owner: Address,
  outcome: i32,
  finalized: boolean,
  refunded: boolean,
  claimed: boolean,
  vintage: i32,
  offered: BigInt,
  accepted: BigInt,
  entryAcc: BigInt
): void {
  createMockedFunction(settler, "positions", POSITIONS_SIG)
    .withArgs([ethereum.Value.fromUnsignedBigInt(bi(positionId))])
    .returns([
      ethereum.Value.fromUnsignedBigInt(bi(marketId)),
      ethereum.Value.fromAddress(owner),
      ethereum.Value.fromI32(outcome),
      ethereum.Value.fromBoolean(finalized),
      ethereum.Value.fromBoolean(refunded),
      ethereum.Value.fromBoolean(claimed),
      ethereum.Value.fromUnsignedBigInt(bi(vintage)),
      ethereum.Value.fromUnsignedBigInt(offered),
      ethereum.Value.fromUnsignedBigInt(accepted),
      ethereum.Value.fromUnsignedBigInt(entryAcc),
    ]);
}

// ---------------------------------------------------------------- vested events

export function vestedMarketCreated(
  marketId: i32,
  n: i32,
  kappa: BigInt,
  block: i32
): VestedMarketCreated {
  let event = changetype<VestedMarketCreated>(newMockEvent());
  event.address = VESTED;
  stamp(event, block, 0);
  event.parameters.push(param("marketId", ethereum.Value.fromUnsignedBigInt(bi(marketId))));
  event.parameters.push(param("creator", ethereum.Value.fromAddress(CREATOR)));
  event.parameters.push(param("n", ethereum.Value.fromI32(n)));
  event.parameters.push(param("kappa", ethereum.Value.fromUnsignedBigInt(kappa)));
  event.parameters.push(
    param("resolutionTime", ethereum.Value.fromUnsignedBigInt(bi(1_700_100_000)))
  );
  return event;
}

export function vestedEntered(
  marketId: i32,
  positionId: i32,
  owner: Address,
  outcome: i32,
  offered: BigInt,
  vintage: i32,
  block: i32
): VestedEntered {
  let event = changetype<VestedEntered>(newMockEvent());
  event.address = VESTED;
  stamp(event, block, positionId);
  event.parameters.push(param("marketId", ethereum.Value.fromUnsignedBigInt(bi(marketId))));
  event.parameters.push(param("positionId", ethereum.Value.fromUnsignedBigInt(bi(positionId))));
  event.parameters.push(param("owner", ethereum.Value.fromAddress(owner)));
  event.parameters.push(param("outcome", ethereum.Value.fromI32(outcome)));
  event.parameters.push(param("offered", ethereum.Value.fromUnsignedBigInt(offered)));
  event.parameters.push(param("vintage", ethereum.Value.fromUnsignedBigInt(bi(vintage))));
  return event;
}

export function vintageFinalized(
  marketId: i32,
  vintage: i32,
  entries: i32,
  block: i32
): VintageFinalized {
  let event = changetype<VintageFinalized>(newMockEvent());
  event.address = VESTED;
  stamp(event, block, 0);
  event.parameters.push(param("marketId", ethereum.Value.fromUnsignedBigInt(bi(marketId))));
  event.parameters.push(param("vintage", ethereum.Value.fromUnsignedBigInt(bi(vintage))));
  event.parameters.push(param("entries", ethereum.Value.fromUnsignedBigInt(bi(entries))));
  return event;
}

export function vestedResolved(marketId: i32, winner: i32, block: i32): VestedResolved {
  let event = changetype<VestedResolved>(newMockEvent());
  event.address = VESTED;
  stamp(event, block, 0);
  event.parameters.push(param("marketId", ethereum.Value.fromUnsignedBigInt(bi(marketId))));
  event.parameters.push(param("winner", ethereum.Value.fromI32(winner)));
  return event;
}

export function vestedVoided(marketId: i32, block: i32): VestedVoided {
  let event = changetype<VestedVoided>(newMockEvent());
  event.address = VESTED;
  stamp(event, block, 0);
  event.parameters.push(param("marketId", ethereum.Value.fromUnsignedBigInt(bi(marketId))));
  return event;
}

export function vestedClaimed(
  positionId: i32,
  to: Address,
  payout: BigInt,
  refund: BigInt,
  block: i32,
  logIndex: i32
): VestedClaimed {
  let event = changetype<VestedClaimed>(newMockEvent());
  event.address = VESTED;
  stamp(event, block, logIndex);
  event.parameters.push(param("positionId", ethereum.Value.fromUnsignedBigInt(bi(positionId))));
  event.parameters.push(param("to", ethereum.Value.fromAddress(to)));
  event.parameters.push(param("payout", ethereum.Value.fromUnsignedBigInt(payout)));
  event.parameters.push(param("refund", ethereum.Value.fromUnsignedBigInt(refund)));
  return event;
}

export function vestedPositionTransferred(
  positionId: i32,
  from: Address,
  to: Address,
  block: i32,
  logIndex: i32
): VestedPositionTransferred {
  let event = changetype<VestedPositionTransferred>(newMockEvent());
  event.address = VESTED;
  stamp(event, block, logIndex);
  event.parameters.push(param("positionId", ethereum.Value.fromUnsignedBigInt(bi(positionId))));
  event.parameters.push(param("from", ethereum.Value.fromAddress(from)));
  event.parameters.push(param("to", ethereum.Value.fromAddress(to)));
  return event;
}

// ---------------------------------------------------------------- classic events

export function classicMarketCreated(
  marketId: i32,
  n: i32,
  kappa: BigInt,
  block: i32
): ClassicMarketCreated {
  let event = changetype<ClassicMarketCreated>(newMockEvent());
  event.address = CLASSIC;
  stamp(event, block, 0);
  event.parameters.push(param("marketId", ethereum.Value.fromUnsignedBigInt(bi(marketId))));
  event.parameters.push(param("creator", ethereum.Value.fromAddress(CREATOR)));
  event.parameters.push(param("n", ethereum.Value.fromI32(n)));
  event.parameters.push(param("kappa", ethereum.Value.fromUnsignedBigInt(kappa)));
  event.parameters.push(
    param("resolutionTime", ethereum.Value.fromUnsignedBigInt(bi(1_700_100_000)))
  );
  return event;
}

export function classicEntered(
  marketId: i32,
  positionId: i32,
  owner: Address,
  outcome: i32,
  offered: BigInt,
  block: i32
): ClassicEntered {
  let event = changetype<ClassicEntered>(newMockEvent());
  event.address = CLASSIC;
  stamp(event, block, positionId);
  event.parameters.push(param("marketId", ethereum.Value.fromUnsignedBigInt(bi(marketId))));
  event.parameters.push(param("positionId", ethereum.Value.fromUnsignedBigInt(bi(positionId))));
  event.parameters.push(param("owner", ethereum.Value.fromAddress(owner)));
  event.parameters.push(param("outcome", ethereum.Value.fromI32(outcome)));
  event.parameters.push(param("offered", ethereum.Value.fromUnsignedBigInt(offered)));
  return event;
}

export function classicResolved(marketId: i32, winner: i32, block: i32): ClassicResolved {
  let event = changetype<ClassicResolved>(newMockEvent());
  event.address = CLASSIC;
  stamp(event, block, 0);
  event.parameters.push(param("marketId", ethereum.Value.fromUnsignedBigInt(bi(marketId))));
  event.parameters.push(param("winner", ethereum.Value.fromI32(winner)));
  return event;
}

export function classicClaimed(
  positionId: i32,
  to: Address,
  payout: BigInt,
  refund: BigInt,
  block: i32,
  logIndex: i32
): ClassicClaimed {
  let event = changetype<ClassicClaimed>(newMockEvent());
  event.address = CLASSIC;
  stamp(event, block, logIndex);
  event.parameters.push(param("positionId", ethereum.Value.fromUnsignedBigInt(bi(positionId))));
  event.parameters.push(param("to", ethereum.Value.fromAddress(to)));
  event.parameters.push(param("payout", ethereum.Value.fromUnsignedBigInt(payout)));
  event.parameters.push(param("refund", ethereum.Value.fromUnsignedBigInt(refund)));
  return event;
}

export function classicVoided(marketId: i32, block: i32): ClassicVoided {
  let event = changetype<ClassicVoided>(newMockEvent());
  event.address = CLASSIC;
  stamp(event, block, 0);
  event.parameters.push(param("marketId", ethereum.Value.fromUnsignedBigInt(bi(marketId))));
  return event;
}

export function classicPositionTransferred(
  positionId: i32,
  from: Address,
  to: Address,
  block: i32,
  logIndex: i32
): ClassicPositionTransferred {
  let event = changetype<ClassicPositionTransferred>(newMockEvent());
  event.address = CLASSIC;
  stamp(event, block, logIndex);
  event.parameters.push(param("positionId", ethereum.Value.fromUnsignedBigInt(bi(positionId))));
  event.parameters.push(param("from", ethereum.Value.fromAddress(from)));
  event.parameters.push(param("to", ethereum.Value.fromAddress(to)));
  return event;
}

// ---------------------------------------------------------------- factory events

export function marketOpened(
  marketId: i32,
  settler: Address,
  specId: Bytes,
  opener: Address,
  seed: Array<BigInt>,
  kappa: BigInt,
  block: i32,
  logIndex: i32
): MarketOpened {
  let event = changetype<MarketOpened>(newMockEvent());
  event.address = FACTORY;
  stamp(event, block, logIndex);
  event.parameters.push(param("marketId", ethereum.Value.fromUnsignedBigInt(bi(marketId))));
  event.parameters.push(param("settler", ethereum.Value.fromAddress(settler)));
  event.parameters.push(param("specId", ethereum.Value.fromFixedBytes(specId)));
  event.parameters.push(param("opener", ethereum.Value.fromAddress(opener)));
  event.parameters.push(param("seed", ethereum.Value.fromUnsignedBigIntArray(seed)));
  event.parameters.push(param("kappa", ethereum.Value.fromUnsignedBigInt(kappa)));
  event.parameters.push(
    param("resolutionTime", ethereum.Value.fromUnsignedBigInt(bi(1_700_100_000)))
  );
  return event;
}

// ---------------------------------------------------------------- resolver events

export function specRegistered(
  specId: Bytes,
  settler: Address,
  marketId: i32,
  strike: BigInt,
  direction: i32,
  maxStaleness: i32,
  block: i32
): SpecRegistered {
  let event = changetype<SpecRegistered>(newMockEvent());
  event.address = RESOLVER;
  stamp(event, block, 0);
  event.parameters.push(param("specId", ethereum.Value.fromFixedBytes(specId)));
  event.parameters.push(param("settler", ethereum.Value.fromAddress(settler)));
  event.parameters.push(param("marketId", ethereum.Value.fromUnsignedBigInt(bi(marketId))));
  event.parameters.push(param("oracle", ethereum.Value.fromAddress(ORACLE)));
  event.parameters.push(param("feedKey", ethereum.Value.fromFixedBytes(FEED_KEY)));
  event.parameters.push(param("strike", ethereum.Value.fromSignedBigInt(strike)));
  event.parameters.push(param("direction", ethereum.Value.fromI32(direction)));
  event.parameters.push(
    param("resolutionTime", ethereum.Value.fromUnsignedBigInt(bi(1_700_100_000)))
  );
  event.parameters.push(param("maxStaleness", ethereum.Value.fromUnsignedBigInt(bi(maxStaleness))));
  return event;
}

export function feedResolved(
  specId: Bytes,
  marketId: i32,
  winner: i32,
  price: BigInt,
  updatedAt: i32,
  block: i32
): FeedResolved {
  let event = changetype<FeedResolved>(newMockEvent());
  event.address = RESOLVER;
  stamp(event, block, 0);
  event.parameters.push(param("specId", ethereum.Value.fromFixedBytes(specId)));
  event.parameters.push(param("marketId", ethereum.Value.fromUnsignedBigInt(bi(marketId))));
  event.parameters.push(param("winner", ethereum.Value.fromI32(winner)));
  event.parameters.push(param("price", ethereum.Value.fromSignedBigInt(price)));
  event.parameters.push(param("updatedAt", ethereum.Value.fromUnsignedBigInt(bi(updatedAt))));
  return event;
}

export function voidedStale(specId: Bytes, age: i32, block: i32): VoidedStale {
  let event = changetype<VoidedStale>(newMockEvent());
  event.address = RESOLVER;
  stamp(event, block, 0);
  event.parameters.push(param("specId", ethereum.Value.fromFixedBytes(specId)));
  event.parameters.push(param("age", ethereum.Value.fromUnsignedBigInt(bi(age))));
  return event;
}
