import { Address, BigDecimal, BigInt, ethereum, store } from "@graphprotocol/graph-ts";
import {
  Agent,
  AgentMarket,
  Book,
  DayAgent,
  Market,
  MarketDayStat,
  Position,
  Protocol,
  Vintage,
} from "../generated/schema";
import {
  ONE,
  PROTOCOL_ID,
  SCALE,
  SECONDS_PER_DAY,
  SETTLER_VESTED,
  STATUS_OPEN,
  STATUS_RESOLVED,
  STATUS_VOIDED,
  UINT256_MAX,
  UNBOUNDED_SENTINEL,
  ZERO,
  ZERO_BD,
} from "./constants";

// ---------------------------------------------------------------- ids
//
// Market and position ids are per settler contract, not global: the vested settler and the
// classic settler both start counting at 0. Every id here is therefore namespaced by the
// contract address the event came from.

export function marketEntityId(settler: Address, marketId: BigInt): string {
  return settler.toHexString() + "-" + marketId.toString();
}

export function positionEntityId(settler: Address, positionId: BigInt): string {
  return settler.toHexString() + "-" + positionId.toString();
}

export function bookEntityId(marketEntity: string, outcome: i32): string {
  return marketEntity + "-" + outcome.toString();
}

export function vintageEntityId(marketEntity: string, block: BigInt): string {
  return marketEntity + "-" + block.toString();
}

// ---------------------------------------------------------------- protocol

export function getOrCreateProtocol(): Protocol {
  let p = Protocol.load(PROTOCOL_ID);
  if (p != null) return p;
  p = new Protocol(PROTOCOL_ID);
  p.marketCount = ZERO;
  p.positionCount = ZERO;
  p.totalAccepted = ZERO;
  p.totalClaimed = ZERO;
  p.agentCount = ZERO;
  p.save();
  return p;
}

// ---------------------------------------------------------------- agents

export function getOrCreateAgent(addr: Address, timestamp: BigInt): Agent {
  let id = addr.toHexString();
  let a = Agent.load(id);
  if (a != null) return a;
  a = new Agent(id);
  a.agentBookVerified = false;
  a.marketsEntered = ZERO;
  a.totalOffered = ZERO;
  a.totalAccepted = ZERO;
  a.totalClaimed = ZERO;
  a.realizedPnl = ZERO;
  a.firstSeenAt = timestamp;
  a.save();

  let protocol = getOrCreateProtocol();
  protocol.agentCount = protocol.agentCount.plus(ONE);
  protocol.save();
  return a;
}

/// Count a wallet against a market once, however many positions it holds there. The link
/// carries the count so the wallet can be taken off the market again when its last
/// position there moves to someone else.
export function attachAgentToMarket(agent: Agent, market: Market): void {
  let id = agent.id + "-" + market.id;
  let link = AgentMarket.load(id);
  if (link == null) {
    link = new AgentMarket(id);
    link.positions = ZERO;
    agent.marketsEntered = agent.marketsEntered.plus(ONE);
    agent.save();
  }
  link.positions = link.positions.plus(ONE);
  link.save();
}

export function detachAgentFromMarket(agent: Agent, market: Market): void {
  let id = agent.id + "-" + market.id;
  let link = AgentMarket.load(id);
  if (link == null) return;
  link.positions = saturatingSub(link.positions, ONE);
  if (link.positions.gt(ZERO)) {
    link.save();
    return;
  }
  store.remove("AgentMarket", id);
  agent.marketsEntered = saturatingSub(agent.marketsEntered, ONE);
  agent.save();
}

// ---------------------------------------------------------------- markets

export function getOrCreateMarket(
  settler: Address,
  kind: string,
  marketId: BigInt,
  event: ethereum.Event
): Market {
  let id = marketEntityId(settler, marketId);
  let m = Market.load(id);
  if (m != null) return m;

  m = new Market(id);
  m.settler = settler;
  m.settlerKind = kind;
  m.marketId = marketId;
  m.kappa = ZERO;
  m.kappaIsUnbounded = false;
  m.n = 0;
  m.resolutionTime = ZERO;
  m.voidTimeout = ZERO;
  m.status = STATUS_OPEN;
  m.acceptedPool = ZERO;
  m.paidOut = ZERO;
  m.residue = ZERO;
  m.residueClaimed = false;
  m.createdAt = event.block.timestamp;
  m.createdBlock = event.block.number;
  m.save();

  let protocol = getOrCreateProtocol();
  protocol.marketCount = protocol.marketCount.plus(ONE);
  protocol.save();
  return m;
}

/// Copy the settler's own view of a market onto the entity. Every scalar here is read back
/// from the contract rather than accumulated from event payloads, so the entity can never
/// drift from the settler; the cost is that a contract read resolves against the state at
/// the END of the block, so within a block containing several entries the intermediate
/// snapshots run ahead. The value at the last event of each block is exact.
export function applyMarketState(
  m: Market,
  token: Address,
  creator: Address,
  resolver: Address,
  residueOwner: Address,
  resolutionTime: BigInt,
  voidTimeout: BigInt,
  n: i32,
  statusRaw: string,
  winner: i32,
  kappa: BigInt,
  acceptedPool: BigInt,
  paidOut: BigInt
): void {
  m.token = token;
  m.creator = creator;
  m.resolver = resolver;
  m.residueOwner = residueOwner;
  m.resolutionTime = resolutionTime;
  m.voidTimeout = voidTimeout;
  m.n = n;
  m.kappaIsUnbounded = kappa.equals(UINT256_MAX);
  m.kappa = m.kappaIsUnbounded ? UNBOUNDED_SENTINEL : kappa;
  m.acceptedPool = acceptedPool;
  m.paidOut = paidOut;
  // The settler's status is authoritative: ClassicParimutuel.resolve() voids instead of
  // resolving when only one address ever staked, so a Resolved log is not the last word.
  m.status = statusRaw;
  if (statusRaw == STATUS_RESOLVED) m.winner = winner;
  // Residue is the flooring remainder of a RESOLVED market and nothing else. Both settlers
  // add to paidOut only on the resolved branch of claim(), and claimResidue() reverts
  // NotSettled anywhere else, so an open or voided market owes its residue owner exactly
  // zero. Subtracting unconditionally would report the entire accepted pool as residue on
  // every live market and, on a void, forever.
  m.residue = statusRaw == STATUS_RESOLVED ? saturatingSub(acceptedPool, paidOut) : ZERO;
}

// ---------------------------------------------------------------- books

/// Write one book and the two numbers a client would otherwise have to derive: the headroom
/// left to accept stake, and the odds the accepted principal implies.
///
/// `capacity` and `vested` come from the settler. For the classic settler pass
/// UINT256_MAX and zero: a classic pool has no capacity to ration against, so it can never
/// refuse an offer, and nothing ever vests.
export function applyBook(
  market: Market,
  outcome: i32,
  principal: BigInt,
  acc: BigInt,
  capacity: BigInt,
  vested: BigInt
): Book {
  let id = bookEntityId(market.id, outcome);
  let b = Book.load(id);
  if (b == null) {
    b = new Book(id);
    b.market = market.id;
    b.outcome = outcome;
    b.positionCount = ZERO;
  }
  b.principal = principal;
  b.acc = acc;
  b.vested = vested;

  let unbounded = capacity.equals(UINT256_MAX);
  b.capacityIsUnbounded = unbounded;
  b.capacity = unbounded ? UNBOUNDED_SENTINEL : capacity;
  // H_w = C_w - V_w. Saturating: the settler clamps at zero and so must the index, or a
  // book that has taken exactly its capacity would report a negative amount of room.
  b.headroom = unbounded ? UNBOUNDED_SENTINEL : saturatingSub(capacity, vested);
  b.impliedOdds = odds(principal, market.acceptedPool);
  b.save();
  return b;
}

/// Odds implied by accepted principal, not by any quoted price: what share of the pool this
/// outcome has actually been paid to cover. Zero pool means no odds exist yet, not infinity.
export function odds(principal: BigInt, acceptedPool: BigInt): BigDecimal {
  if (acceptedPool.equals(ZERO)) return ZERO_BD;
  return principal.toBigDecimal().div(acceptedPool.toBigDecimal());
}

/// acceptedPool moves on every finalization and every classic entry, so every book's share
/// of it moves with it — including books that did not themselves change.
export function refreshImpliedOdds(market: Market): void {
  for (let w = 0; w < market.n; w++) {
    let b = Book.load(bookEntityId(market.id, w));
    if (b == null) continue;
    b.impliedOdds = odds(b.principal, market.acceptedPool);
    b.save();
  }
}

export function bumpBookPositionCount(market: Market, outcome: i32): void {
  let id = bookEntityId(market.id, outcome);
  let b = Book.load(id);
  if (b == null) {
    // The first Entered log of a market arrives before MarketCreated, because the settler
    // records the seed legs before it announces the market. Open the book now; the real
    // numbers land a log later.
    b = new Book(id);
    b.market = market.id;
    b.outcome = outcome;
    b.principal = ZERO;
    b.acc = ZERO;
    b.vested = ZERO;
    b.capacity = ZERO;
    b.capacityIsUnbounded = false;
    b.headroom = ZERO;
    b.impliedOdds = ZERO_BD;
    b.positionCount = ZERO;
  }
  b.positionCount = b.positionCount.plus(ONE);
  b.save();
}

// ---------------------------------------------------------------- vintages

export function getOrCreateVintage(market: Market, block: BigInt): Vintage {
  let id = vintageEntityId(market.id, block);
  let v = Vintage.load(id);
  if (v != null) return v;
  v = new Vintage(id);
  v.market = market.id;
  v.block = block;
  v.offered = ZERO;
  v.accepted = ZERO;
  v.rationed = ZERO;
  v.entryCount = ZERO;
  v.finalized = false;
  v.pending = [];
  v.save();
  return v;
}

/// AssemblyScript hands back a copy of an entity's array field, so the read-modify-write
/// has to be explicit; pushing onto `v.pending` directly silently does nothing.
export function addPending(v: Vintage, positionEntity: string): void {
  let ids = v.pending;
  ids.push(positionEntity);
  v.pending = ids;
}

// ---------------------------------------------------------------- day stats

export function dayIndex(timestamp: BigInt): i32 {
  return timestamp.toI32() / SECONDS_PER_DAY;
}

export function getOrCreateDayStat(market: Market, timestamp: BigInt): MarketDayStat {
  let day = dayIndex(timestamp);
  let id = market.id + "-" + day.toString();
  let s = MarketDayStat.load(id);
  if (s != null) return s;
  s = new MarketDayStat(id);
  s.market = market.id;
  s.date = day * SECONDS_PER_DAY;
  s.offered = ZERO;
  s.accepted = ZERO;
  s.rationed = ZERO;
  s.entries = ZERO;
  s.uniqueAgents = ZERO;
  s.save();
  return s;
}

export function countUniqueAgent(stat: MarketDayStat, agent: Agent): void {
  let id = stat.id + "-" + agent.id;
  let seen = DayAgent.load(id);
  if (seen == null) {
    seen = new DayAgent(id);
    seen.entries = ZERO;
    stat.uniqueAgents = stat.uniqueAgents.plus(ONE);
    stat.save();
  }
  seen.entries = seen.entries.plus(ONE);
  seen.save();
}

export function uncountUniqueAgent(stat: MarketDayStat, agent: Agent): void {
  let id = stat.id + "-" + agent.id;
  let seen = DayAgent.load(id);
  if (seen == null) return;
  seen.entries = saturatingSub(seen.entries, ONE);
  if (seen.entries.gt(ZERO)) {
    seen.save();
    return;
  }
  store.remove("DayAgent", id);
  stat.uniqueAgents = saturatingSub(stat.uniqueAgents, ONE);
  stat.save();
}

// ---------------------------------------------------------------- previews

/// What claim() would pay this position if the market settled right now to the position's
/// OWN outcome. On a resolved market that is the real payout for winners and zero for
/// losers; on a voided market it is the accepted principal, which is what a void refunds.
/// On an open market it is the honest "if my side wins" number, which is the one a holder
/// actually wants and the one a naive client gets wrong.
export function previewPayout(market: Market, position: Position, book: Book | null): BigInt {
  if (market.status == STATUS_VOIDED) return position.accepted;
  if (market.status == STATUS_RESOLVED && position.outcome != market.winner) return ZERO;
  if (book == null) return ZERO;
  if (position.accepted.equals(ZERO)) return ZERO;

  if (market.settlerKind == SETTLER_VESTED) {
    // s_i * (S + A_o - A_o(tau_i)) / S. The accumulator only grows, so the difference is
    // non-negative; the guard is for an entry the index has not finalized yet.
    if (book.acc.lt(position.entryAcc)) return position.accepted;
    let multiple = SCALE.plus(book.acc).minus(position.entryAcc);
    return position.accepted.times(multiple).div(SCALE);
  }

  // Classic: every unit of the pool, split by stake. floor(pool * s_i / P_o).
  if (book.principal.equals(ZERO)) return ZERO;
  return market.acceptedPool.times(position.accepted).div(book.principal);
}

/// Recompute every position's preview for one market. Called when the books move, which is
/// once per finalized vintage on the vested settler and once per entry on the classic one,
/// and again when the market settles. It is O(positions in this market) each time — paid
/// deliberately, because a stale preview is the field most likely to be believed.
export function refreshPreviews(market: Market): void {
  let positions = market.positions.load();
  for (let i = 0; i < positions.length; i++) {
    let p = positions[i];
    let b = Book.load(bookEntityId(market.id, p.outcome));
    let next = previewPayout(market, p, b);
    if (next.equals(p.previewPayout)) continue;
    p.previewPayout = next;
    p.save();
  }
}

// ---------------------------------------------------------------- arithmetic

export function saturatingSub(a: BigInt, b: BigInt): BigInt {
  return a.gt(b) ? a.minus(b) : ZERO;
}

// ---------------------------------------------------------------- entries

/// The bookkeeping every entry does regardless of settler: the position, the agent, the
/// books' head count, the day bucket and the protocol counters. What differs between the
/// two settlers is only whether the accepted amount is knowable yet, so that is left out.
export function recordEntry(
  market: Market,
  settler: Address,
  positionId: BigInt,
  owner: Address,
  outcome: i32,
  offered: BigInt,
  event: ethereum.Event
): Position {
  let agent = getOrCreateAgent(owner, event.block.timestamp);

  let p = new Position(positionEntityId(settler, positionId));
  p.positionId = positionId;
  p.market = market.id;
  p.owner = agent.id;
  p.outcome = outcome;
  p.offered = offered;
  p.accepted = ZERO;
  p.refused = ZERO;
  p.finalized = false;
  p.entryAcc = ZERO;
  p.refundWithdrawn = false;
  p.claimed = false;
  p.payout = ZERO;
  p.previewPayout = ZERO;
  p.createdAt = event.block.timestamp;
  p.createdBlock = event.block.number;
  // Kept so a later PositionTransferred can tell a hand-over inside the opening
  // transaction from a genuine sale. See recordTransfer.
  p.createdTx = event.transaction.hash;
  p.save();

  agent.totalOffered = agent.totalOffered.plus(offered);
  agent.save();
  attachAgentToMarket(agent, market);

  bumpBookPositionCount(market, outcome);

  let stat = getOrCreateDayStat(market, event.block.timestamp);
  stat.offered = stat.offered.plus(offered);
  stat.entries = stat.entries.plus(ONE);
  stat.save();
  countUniqueAgent(stat, agent);

  let protocol = getOrCreateProtocol();
  protocol.positionCount = protocol.positionCount.plus(ONE);
  protocol.save();

  return p;
}

/// Applied when a position's accepted amount becomes known: at finalization on the vested
/// settler, immediately on the classic one.
export function recordAcceptance(
  market: Market,
  position: Position,
  accepted: BigInt,
  entryAcc: BigInt
): void {
  position.accepted = accepted;
  position.entryAcc = entryAcc;
  position.refused = saturatingSub(position.offered, accepted);
  position.finalized = true;
  position.save();

  let agent = Agent.load(position.owner);
  if (agent != null) {
    agent.totalAccepted = agent.totalAccepted.plus(accepted);
    agent.save();
  }

  // Attributed to the day the stake was OFFERED, not the day the book got round to
  // accepting it, so offered and accepted in one bucket describe the same entries.
  let stat = getOrCreateDayStat(market, position.createdAt);
  stat.accepted = stat.accepted.plus(accepted);
  stat.rationed = stat.rationed.plus(position.refused);
  stat.save();

  let protocol = getOrCreateProtocol();
  protocol.totalAccepted = protocol.totalAccepted.plus(accepted);
  protocol.save();
}

// ---------------------------------------------------------------- transfers

/// A position handed over inside the transaction that created it never belonged to the
/// address the Entered log named.
///
/// MarketFactory.open() is the case that matters. The factory pulls the opener's USDC and
/// calls create() itself, so the settler's msg.sender — and therefore Market.creator and
/// the owner on every seed Entered log — is the factory contract. Later in the same
/// transaction it transfers each seed leg to the opener. Taken at face value, the index
/// would charge a contract with the whole seed, count it as an agent, and leave the wallet
/// that actually paid with a position and no stake against its name.
///
/// A transfer in any later transaction is a real change of hands and is NOT rewritten:
/// totalOffered and totalAccepted record what a wallet put at risk, not what it still
/// holds. Only the market link moves, because that one is about who holds the position now.
export function recordTransfer(
  market: Market,
  position: Position,
  to: Address,
  event: ethereum.Event
): void {
  let receiver = getOrCreateAgent(to, event.block.timestamp);
  if (receiver.id == position.owner) return;

  let sender = Agent.load(position.owner);
  let handOver = position.createdTx.equals(event.transaction.hash);

  position.owner = receiver.id;
  position.save();
  attachAgentToMarket(receiver, market);

  if (sender == null) return;
  detachAgentFromMarket(sender, market);
  if (!handOver) return;

  sender.totalOffered = saturatingSub(sender.totalOffered, position.offered);
  sender.totalAccepted = saturatingSub(sender.totalAccepted, position.accepted);
  sender.save();
  receiver.totalOffered = receiver.totalOffered.plus(position.offered);
  receiver.totalAccepted = receiver.totalAccepted.plus(position.accepted);
  receiver.save();

  // The entry counted towards the day the stake was offered, so its unique-agent credit
  // moves in that bucket, not in the bucket of the block the transfer landed in.
  let stat = getOrCreateDayStat(market, position.createdAt);
  uncountUniqueAgent(stat, sender);
  countUniqueAgent(stat, receiver);

  dropConduitAgent(sender);
}

/// An address left holding nothing, that never staked anything of its own and never
/// claimed anything, was a conduit rather than a participant — the factory is the only one
/// this index expects to see. Drop it, so it is not counted as an agent or rendered as a
/// leaderboard row of zeros. A wallet that actually staked keeps its history even after
/// selling its last position.
function dropConduitAgent(agent: Agent): void {
  if (agent.totalOffered.gt(ZERO) || agent.totalAccepted.gt(ZERO)) return;
  if (agent.totalClaimed.gt(ZERO) || !agent.realizedPnl.equals(ZERO)) return;
  if (agent.marketsEntered.gt(ZERO)) return;
  if (agent.positions.load().length > 0) return;

  store.remove("Agent", agent.id);
  let protocol = getOrCreateProtocol();
  protocol.agentCount = saturatingSub(protocol.agentCount, ONE);
  protocol.save();
}

/// Settlement side of a Claimed log.
///
/// `payout` is the settlement return and `refund` is refused stake coming back — which is
/// NOT always how the two settlers fill the fields of the log. ClassicParimutuel.claim()
/// reports a void through `refund`, so classic.ts translates before calling here. Passing
/// the raw pair through is what makes a fully refunded holder read as having lost
/// everything.
///
/// The vested settler emits the same event for a bare refund withdrawal and for the
/// settling claim, and the two are not always distinguishable from the log alone: a loser
/// claiming with an outstanding remainder looks exactly like `withdrawRefund`. So the two
/// halves are tracked independently. Payout accrual keys only on `payout > 0`, which
/// `withdrawRefund` can never produce, so the money is always counted exactly once; the
/// `claimed` flag is the caller's best reading of the settler's own flag and may flip one
/// log early when a refund and a claim land in the same block. Nothing numeric depends on
/// it except the one-time principal subtraction in realizedPnl, which is keyed to the
/// transition rather than to the log.
export function recordSettlement(
  position: Position,
  payout: BigInt,
  refund: BigInt,
  settled: boolean
): void {
  if (refund.gt(ZERO)) position.refundWithdrawn = true;

  let agent = Agent.load(position.owner);
  let protocol = getOrCreateProtocol();

  if (payout.gt(ZERO)) {
    position.payout = position.payout.plus(payout);
    protocol.totalClaimed = protocol.totalClaimed.plus(payout);
    protocol.save();
    if (agent != null) {
      agent.totalClaimed = agent.totalClaimed.plus(payout);
      agent.realizedPnl = agent.realizedPnl.plus(payout);
      agent.save();
    }
  }

  if (settled && !position.claimed) {
    position.claimed = true;
    // Realized, not marked: the principal the position tied up comes off once, when it
    // settles. A voided market pays back exactly the accepted principal, so it lands at 0.
    if (agent != null) {
      agent.realizedPnl = agent.realizedPnl.minus(position.accepted);
      agent.save();
    }
  }
  position.save();
}
