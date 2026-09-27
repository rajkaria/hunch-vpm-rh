import { MarketOpened } from "../generated/MarketFactory/MarketFactory";
import { Market } from "../generated/schema";
import { marketEntityId } from "./shared";

/// MarketOpened is the last log of the opening transaction: the settler's market and the
/// resolver's spec both already exist by the time it fires.
///
/// The fact only this log carries is the opener. MarketFactory.open() pulls the opener's
/// USDC and then calls create() itself, so the settler sees the factory contract as
/// msg.sender: Market.creator is the factory, and so is the owner on every seed Entered
/// log. The wallet that actually paid appears nowhere in the settler's own logs except as
/// the recipient of the seed legs. Recording it here is what lets a client tell the two
/// apart, and the settler mappings undo the factory's brief ownership of the stake when
/// the hand-over transfers arrive.
export function handleMarketOpened(event: MarketOpened): void {
  let market = Market.load(marketEntityId(event.params.settler, event.params.marketId));
  if (market == null) return;

  market.opener = event.params.opener;
  // handleSpecRegistered normally wrote the same specId earlier in this transaction. It is
  // written again because this log is the factory's own statement of the pair, and a
  // factory pointed at a FeedResolver this subgraph does not index would otherwise leave
  // the market with no spec at all.
  market.specId = event.params.specId;
  market.save();
}
