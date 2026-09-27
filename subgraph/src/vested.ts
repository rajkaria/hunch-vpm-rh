import { Address, BigInt } from "@graphprotocol/graph-ts";
import {
  Claimed,
  Entered,
  MarketCreated,
  PositionTransferred,
  ResidueClaimed,
  Resolved,
  VestedParimutuel,
  VestedParimutuel__positionsResult,
  VintageFinalized,
  Voided,
} from "../generated/VestedParimutuel/VestedParimutuel";
import { Claim, Market, Position, Vintage } from "../generated/schema";
import {
  ONE,
  SETTLER_VESTED,
  STATUS_RESOLVED,
  STATUS_VOIDED,
  ZERO,
  statusFromUint8,
} from "./constants";
import {
  addPending,
  applyBook,
  applyMarketState,
  getOrCreateMarket,
  getOrCreateVintage,
  marketEntityId,
  positionEntityId,
  recordAcceptance,
  recordEntry,
  recordSettlement,
  recordTransfer,
  refreshImpliedOdds,
  refreshPreviews,
  saturatingSub,
  vintageEntityId,
} from "./shared";

// ---------------------------------------------------------------- contract reads

/// The settler never puts an accepted amount in a log: acceptance is decided when the
/// vintage finalizes, one block after the entry, and VintageFinalized carries only a count.
/// The public `positions` array is the only place the number exists, so the index reads it.
function readPosition(
  settler: Address,
  positionId: BigInt
): VestedParimutuel__positionsResult | null {
  let result = VestedParimutuel.bind(settler).try_positions(positionId);
  if (result.reverted) return null;
  return result.value;
}

function syncMarket(market: Market, settler: Address): void {
  let contract = VestedParimutuel.bind(settler);

  let read = contract.try_getMarket(market.marketId);
  if (!read.reverted) {
    let m = read.value;
    applyMarketState(
      market,
      m.value0, // token
      m.value1, // creator
      m.value2, // resolver
      m.value3, // residueOwner
      m.value4, // resolutionTime
      m.value5, // voidTimeout
      m.value6, // n
      statusFromUint8(m.value7),
      m.value8, // winner
      m.value9, // kappa
      m.value10, // acceptedPool
      m.value11 // paidOut
    );
  }
  market.save();

  for (let w = 0; w < market.n; w++) {
    let book = contract.try_getBook(market.marketId, w);
    if (book.reverted) continue;
    let b = book.value;
    applyBook(market, w, b.principal, b.acc, b.capacity, b.vested);
  }
  refreshImpliedOdds(market);
}

function loadMarket(settler: Address, marketId: BigInt): Market | null {
  return Market.load(marketEntityId(settler, marketId));
}

// ---------------------------------------------------------------- handlers

export function handleMarketCreated(event: MarketCreated): void {
  let market = getOrCreateMarket(event.address, SETTLER_VESTED, event.params.marketId, event);
  // The seed legs were logged as Entered before this event, so the market entity and its
  // books may already exist. Everything below is a refresh, not a first write.
  syncMarket(market, event.address);
  refreshPreviews(market);
}

export function handleEntered(event: Entered): void {
  let market = getOrCreateMarket(event.address, SETTLER_VESTED, event.params.marketId, event);
  let position = recordEntry(
    market,
    event.address,
    event.params.positionId,
    event.params.owner,
    event.params.outcome,
    event.params.offered,
    event
  );

  let vintage = getOrCreateVintage(market, event.params.vintage);
  vintage.offered = vintage.offered.plus(event.params.offered);
  vintage.entryCount = vintage.entryCount.plus(ONE);
  position.vintage = vintage.id;
  position.save();

  if (event.params.vintage.equals(ZERO)) {
    // Vintage 0 is the reserved seed vintage: the legs are clamped and booked inside
    // create(), so their accepted amounts are already final and there is nothing to poke.
    // A leg the Rule-2 clamp cut shows up here as rationing at creation.
    let onChain = readPosition(event.address, event.params.positionId);
    if (onChain != null) {
      recordAcceptance(market, position, onChain.value8, onChain.value9);
      position.refundWithdrawn = onChain.value4;
      position.save();
      vintage.accepted = vintage.accepted.plus(onChain.value8);
    }
    vintage.rationed = saturatingSub(vintage.offered, vintage.accepted);
    vintage.finalized = true;
    vintage.finalizedAt = event.block.timestamp;
  } else {
    addPending(vintage, position.id);
    market.openVintage = vintage.id;
    market.save();
  }
  vintage.save();
}

export function handleVintageFinalized(event: VintageFinalized): void {
  let market = loadMarket(event.address, event.params.marketId);
  if (market == null) return;

  let vintage = Vintage.load(vintageEntityId(market.id, event.params.vintage));
  if (vintage == null) return;

  let pending = vintage.pending;
  let accepted = ZERO;
  for (let i = 0; i < pending.length; i++) {
    let position = Position.load(pending[i]);
    if (position == null) continue;
    let onChain = readPosition(event.address, position.positionId);
    if (onChain == null) continue;
    recordAcceptance(market, position, onChain.value8, onChain.value9);
    accepted = accepted.plus(onChain.value8);
  }

  vintage.accepted = vintage.accepted.plus(accepted);
  // The number this whole mechanism exists to make visible: what the books refused for
  // want of headroom, per block of arrivals.
  vintage.rationed = saturatingSub(vintage.offered, vintage.accepted);
  vintage.finalized = true;
  vintage.finalizedAt = event.block.timestamp;
  vintage.pending = [];
  vintage.save();

  // Only one vintage is ever buffered, and a later entry in this same block opens the next
  // one after this log, so clearing here is not a race.
  market.openVintage = null;
  syncMarket(market, event.address);
  refreshPreviews(market);
}

export function handleResolved(event: Resolved): void {
  let market = loadMarket(event.address, event.params.marketId);
  if (market == null) return;
  market.status = STATUS_RESOLVED;
  market.winner = event.params.winner;
  market.resolvedAt = event.block.timestamp;
  syncMarket(market, event.address);
  refreshPreviews(market);
}

export function handleVoided(event: Voided): void {
  let market = loadMarket(event.address, event.params.marketId);
  if (market == null) return;
  market.status = STATUS_VOIDED;
  syncMarket(market, event.address);
  refreshPreviews(market);
}

export function handleClaimed(event: Claimed): void {
  let position = Position.load(positionEntityId(event.address, event.params.positionId));
  if (position == null) return;
  let market = Market.load(position.market);
  if (market == null) return;

  let claim = new Claim(
    event.transaction.hash.toHexString() + "-" + event.logIndex.toString()
  );
  claim.position = position.id;
  claim.market = market.id;
  claim.to = event.params.to;
  claim.payout = event.params.payout;
  claim.refund = event.params.refund;
  claim.timestamp = event.block.timestamp;
  claim.block = event.block.number;
  claim.txHash = event.transaction.hash;
  claim.save();

  // withdrawRefund() reverts unless there is a remainder, so it can never emit payout > 0
  // and never emits refund == 0. Either shape is therefore a settling claim on its own;
  // the remaining case is genuinely ambiguous and is decided by the settler's own flag.
  let settled = event.params.payout.gt(ZERO) || event.params.refund.equals(ZERO);
  if (!settled) {
    let onChain = readPosition(event.address, event.params.positionId);
    if (onChain != null) settled = onChain.value5;
  }
  recordSettlement(position, event.params.payout, event.params.refund, settled);

  syncMarket(market, event.address);
}

export function handleResidueClaimed(event: ResidueClaimed): void {
  let market = loadMarket(event.address, event.params.marketId);
  if (market == null) return;
  syncMarket(market, event.address);
  // The swept amount is authoritative; the running acceptedPool - paidOut estimate is not
  // exact until the last winner has claimed, which is precisely when this event can fire.
  market.residue = event.params.amount;
  market.residueClaimed = true;
  market.save();
}

export function handlePositionTransferred(event: PositionTransferred): void {
  let position = Position.load(positionEntityId(event.address, event.params.positionId));
  if (position == null) return;
  let market = Market.load(position.market);
  if (market == null) return;
  // totalOffered and totalAccepted stay with the wallet that staked: they record what that
  // wallet put at risk, not what it still holds. Settlement follows the position, so
  // totalClaimed and realizedPnl accrue to whoever owns it at claim time. The one exception
  // is the factory hand-over, which recordTransfer rewrites.
  recordTransfer(market, position, event.params.to, event);
}
