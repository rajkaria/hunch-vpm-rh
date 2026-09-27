import { Address, BigInt } from "@graphprotocol/graph-ts";
import {
  ClassicParimutuel,
  Claimed,
  Entered,
  MarketCreated,
  PositionTransferred,
  ResidueClaimed,
  Resolved,
  Voided,
} from "../generated/ClassicParimutuel/ClassicParimutuel";
import { Claim, Market, Position } from "../generated/schema";
import {
  SETTLER_CLASSIC,
  STATUS_RESOLVED,
  STATUS_VOIDED,
  UINT256_MAX,
  ZERO,
  statusFromUint8,
} from "./constants";
import {
  applyBook,
  applyMarketState,
  getOrCreateMarket,
  marketEntityId,
  positionEntityId,
  recordAcceptance,
  recordEntry,
  recordSettlement,
  recordTransfer,
  refreshImpliedOdds,
  refreshPreviews,
} from "./shared";

// ---------------------------------------------------------------- contract reads

function syncMarket(market: Market, settler: Address): void {
  let contract = ClassicParimutuel.bind(settler);

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
      m.value9, // kappa, recorded for interface parity and never read by the settler
      m.value10, // acceptedPool
      m.value11 // paidOut
    );
  }
  market.save();

  for (let w = 0; w < market.n; w++) {
    let book = contract.try_getBook(market.marketId, w);
    if (book.reverted) continue;
    // A classic pool has no capacity to ration against and nothing vests into it, so the
    // book is written with the unbounded capacity the settler itself reports from
    // headroom() and a vested total of zero. Both show up as the unbounded sentinel /
    // zero in the index, which is the whole difference between the two settlers made
    // legible side by side.
    applyBook(market, w, book.value.principal, ZERO, UINT256_MAX, ZERO);
  }
  refreshImpliedOdds(market);
}

function loadMarket(settler: Address, marketId: BigInt): Market | null {
  return Market.load(marketEntityId(settler, marketId));
}

// ---------------------------------------------------------------- handlers

export function handleMarketCreated(event: MarketCreated): void {
  let market = getOrCreateMarket(event.address, SETTLER_CLASSIC, event.params.marketId, event);
  syncMarket(market, event.address);
  refreshPreviews(market);
}

export function handleEntered(event: Entered): void {
  let market = getOrCreateMarket(event.address, SETTLER_CLASSIC, event.params.marketId, event);
  let position = recordEntry(
    market,
    event.address,
    event.params.positionId,
    event.params.owner,
    event.params.outcome,
    event.params.offered,
    event
  );
  // Nothing is ever refused here, so offered is accepted in the same transaction and there
  // is no vintage to wait for. Position.vintage stays null on purpose.
  recordAcceptance(market, position, event.params.offered, ZERO);

  syncMarket(market, event.address);
  // Every entry moves the pool, and in a classic pool every holder's share of the pool
  // moves with it — that is exactly the property the vested settler removes.
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

  // The two settlers do not fill this log the same way on a void. VestedParimutuel returns
  // the accepted principal through `payout`; this one returns it through `refund` and
  // leaves `payout` at zero. Nothing is ever refused on this settler, so a `refund` here is
  // never a refused remainder: it is the settlement. The schema's payout/refund mean
  // "settlement" and "refused stake coming back" rather than "whatever the log called it",
  // so the void shape is translated once, here. Read raw, a holder refunded in full comes
  // out of the index having lost their entire stake — the exact opposite of what happened.
  let returned =
    market.status == STATUS_VOIDED ? event.params.refund : event.params.payout;

  let claim = new Claim(
    event.transaction.hash.toHexString() + "-" + event.logIndex.toString()
  );
  claim.position = position.id;
  claim.market = market.id;
  claim.to = event.params.to;
  claim.payout = returned;
  claim.refund = ZERO;
  claim.timestamp = event.block.timestamp;
  claim.block = event.block.number;
  claim.txHash = event.transaction.hash;
  claim.save();

  // withdrawRefund() always reverts on this settler, so a Claimed log here is always the
  // settling claim. No ambiguity to resolve and no contract read to pay for.
  recordSettlement(position, returned, ZERO, true);

  syncMarket(market, event.address);
}

export function handleResidueClaimed(event: ResidueClaimed): void {
  let market = loadMarket(event.address, event.params.marketId);
  if (market == null) return;
  syncMarket(market, event.address);
  market.residue = event.params.amount;
  market.residueClaimed = true;
  market.save();
}

export function handlePositionTransferred(event: PositionTransferred): void {
  let position = Position.load(positionEntityId(event.address, event.params.positionId));
  if (position == null) return;
  let market = Market.load(position.market);
  if (market == null) return;
  recordTransfer(market, position, event.params.to, event);
}
