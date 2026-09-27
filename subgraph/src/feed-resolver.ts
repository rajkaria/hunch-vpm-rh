import {
  Resolved as FeedResolved,
  SpecRegistered,
  VoidedStale,
} from "../generated/FeedResolver/FeedResolver";
import { Market, SpecLink } from "../generated/schema";
import { DIRECTION_ABOVE, DIRECTION_BELOW } from "./constants";
import { marketEntityId } from "./shared";

/// Registration is permissionless, so a spec can name a settler this subgraph does not
/// index, or a market that does not exist. Only specs that land on a market already in the
/// index are attached; under MarketFactory.open that is always the case, because the
/// settler's create() runs before resolver.register() in the same transaction.
export function handleSpecRegistered(event: SpecRegistered): void {
  let market = Market.load(marketEntityId(event.params.settler, event.params.marketId));
  if (market == null) return;

  market.specId = event.params.specId;
  market.oracle = event.params.oracle;
  market.feedKey = event.params.feedKey;
  market.strike = event.params.strike;
  market.direction = event.params.direction == 0 ? DIRECTION_ABOVE : DIRECTION_BELOW;
  market.maxStaleness = event.params.maxStaleness;
  market.save();

  // The Resolved and VoidedStale logs carry only the specId, so the link back to the
  // market is stored once here rather than paid for with a contract read every time.
  let link = new SpecLink(event.params.specId.toHexString());
  link.market = market.id;
  link.save();
}

export function handleFeedResolved(event: FeedResolved): void {
  let link = SpecLink.load(event.params.specId.toHexString());
  if (link == null) return;
  let market = Market.load(link.market);
  if (market == null) return;

  // The settler's own Resolved log, handled in the settler mapping, sets status and winner.
  // What only the resolver knows is the reading it settled on and how fresh it was.
  market.resolvedPrice = event.params.price;
  market.priceUpdatedAt = event.params.updatedAt;
  market.save();
}

export function handleVoidedStale(event: VoidedStale): void {
  let link = SpecLink.load(event.params.specId.toHexString());
  if (link == null) return;
  let market = Market.load(link.market);
  if (market == null) return;

  // Evidence that the void was the stale-feed path rather than a resolver call or a
  // timeout: the age of the last reading, against the market's own maxStaleness.
  market.voidedStaleAge = event.params.age;
  market.save();
}
