/**
 * A model of the settler, in memory.
 *
 * It exists so the demo and the tests can watch the mechanism work without a chain: an
 * entry vests into the opposing books immediately, is accepted only up to their headroom,
 * and earns its multiple from flow that arrives afterwards. The arithmetic below is the
 * arithmetic in `VestedParimutuel._finalizeVintage`, restricted to the case where each
 * entry is alone in its vintage — which is what happens in a simulation with no
 * concurrency, and which is the case with no same-vintage rationing to reproduce.
 *
 * It is not a substitute for the contract or for its Foundry tests. It is a fixture.
 */

import { KAPPA_UNBOUNDED } from "../domain/types.js";
import type {
  BookSnapshot,
  ClaimablePosition,
  Hex,
  MarketSnapshot,
  PositionSnapshot,
  ResolutionSpec,
} from "../domain/types.js";
import { ratio, scaleByFraction } from "../domain/units.js";

/** `VestedParimutuel.SCALE`. */
const SCALE = 10n ** 18n;

export interface WorldBook {
  outcome: number;
  label: string;
  principal: bigint;
  /** A_w, fixed point at SCALE. */
  acc: bigint;
  capacity: bigint;
  vested: bigint;
  holders: number;
  trust: number;
}

export interface WorldIntel {
  price8: bigint;
  volAnnualised: number;
  /** Fractional move applied to the price each tick, so a demo shows the feed breathing. */
  driftPerTick: number;
  source: string;
}

export interface WorldMarket {
  marketId: string;
  /** The settler's own market index. The fixture world numbers its markets in file order. */
  onChainMarketId: bigint;
  question: string;
  settler: Hex;
  token: Hex;
  kappa: bigint;
  openedAt: number;
  resolutionTime: number;
  spec: ResolutionSpec;
  books: WorldBook[];
  status: "open" | "resolved" | "voided";
  winner: number | undefined;
  intel: WorldIntel;
  /** Offered USDC per tick from everybody who is not this agent. */
  flowPerTick: bigint;
}

export interface WorldPosition {
  positionId: string;
  /** The settler's own position index, which is what `claim` takes. */
  onChainPositionId: bigint;
  marketId: string;
  owner: Hex;
  outcome: number;
  offered: bigint;
  accepted: bigint;
  entryAcc: bigint;
  vintage: number;
  claimed: boolean;
}

export interface EnterOutcome {
  readonly position: WorldPosition;
  /** offered - accepted. Non-zero means the books did not have room for all of it. */
  readonly refused: bigint;
}

export class FixtureWorld {
  #vintage = 1;
  #nextPositionId = 1;
  readonly #positions = new Map<string, WorldPosition>();

  constructor(private readonly markets: WorldMarket[]) {}

  list(): readonly WorldMarket[] {
    return this.markets;
  }

  find(marketId: string): WorldMarket | undefined {
    return this.markets.find((m) => m.marketId === marketId);
  }

  /** H_w = C_w - V_w. */
  static headroom(book: WorldBook): bigint {
    if (book.capacity === KAPPA_UNBOUNDED) return KAPPA_UNBOUNDED;
    return book.capacity > book.vested ? book.capacity - book.vested : 0n;
  }

  /** The tightest opposing book — how much of an offer on `outcome` can be accepted. */
  static acceptable(market: WorldMarket, outcome: number, offered: bigint): bigint {
    let cap: bigint | undefined;
    for (const b of market.books) {
      if (b.outcome === outcome) continue;
      const h = FixtureWorld.headroom(b);
      if (h === KAPPA_UNBOUNDED) continue;
      if (cap === undefined || h < cap) cap = h;
    }
    if (cap === undefined) return offered;
    return offered < cap ? offered : cap;
  }

  /**
   * Rule 1 then Rule 2: accept what the opposing books have room for, vest it into every
   * one of them, then book the principal and the capacity it brings.
   */
  enter(marketId: string, outcome: number, offered: bigint, owner: Hex): EnterOutcome {
    const market = this.#require(marketId);
    const accepted = FixtureWorld.acceptable(market, outcome, offered);

    for (const b of market.books) {
      if (b.outcome === outcome || accepted === 0n) continue;
      // A_w += inflow * SCALE / P_w, against the book as it stood before this entry.
      b.acc += (accepted * SCALE) / b.principal;
      b.vested += accepted;
    }

    const own = this.#book(market, outcome);
    const position: WorldPosition = {
      positionId: `p${String(this.#nextPositionId)}`,
      onChainPositionId: BigInt(this.#nextPositionId),
      marketId,
      owner,
      outcome,
      offered,
      accepted,
      // Recorded AFTER the increments above, which is what stops same-vintage entries
      // vesting to each other. This entry is alone in its vintage, so its own book did
      // not move; the field is still written the way the contract writes it.
      entryAcc: own.acc,
      vintage: this.#vintage,
      claimed: false,
    };
    this.#nextPositionId += 1;
    this.#vintage += 1;

    if (accepted > 0n) {
      own.principal += accepted;
      own.capacity = addCapacity(own.capacity, times(market.kappa, accepted));
      own.holders += 1;
    }
    this.#positions.set(position.positionId, position);
    return { position, refused: offered - accepted };
  }

  /**
   * One step of everybody else. Flow follows the price — it is split across outcomes in
   * proportion to accepted principal — which is exactly the behaviour that makes an early
   * contrarian entry pay: the crowd's money vests into the book it is not on.
   */
  tick(): void {
    for (const market of this.markets) {
      if (market.status !== "open") continue;
      market.intel.price8 = driftPrice(market.intel.price8, market.intel.driftPerTick);
      if (market.flowPerTick === 0n) continue;

      let pool = 0n;
      for (const b of market.books) pool += b.principal;
      if (pool === 0n) continue;

      // Shares are computed from the books as they stand at the start of the tick, before
      // any of this tick's arrivals have landed. Otherwise the first outcome in the list
      // would silently change the split for the rest.
      const split = market.books.map((b) => ({
        outcome: b.outcome,
        amount: scaleByFraction(market.flowPerTick, ratio(b.principal, pool)),
      }));
      for (const entry of split) {
        if (entry.amount > 0n) this.enter(market.marketId, entry.outcome, entry.amount, CROWD);
      }
    }
  }

  /**
   * Settle every market whose freeze has passed, the way `FeedResolver` would: the reading
   * at or above the strike wins outcome 0 under direction 0, the other way under 1.
   */
  settleDue(now: number): readonly string[] {
    const settled: string[] = [];
    for (const market of this.markets) {
      if (market.status !== "open" || now < market.resolutionTime) continue;
      const above = market.intel.price8 >= market.spec.strike8;
      market.winner = market.spec.direction === 0 ? (above ? 0 : 1) : above ? 1 : 0;
      market.status = "resolved";
      settled.push(market.marketId);
    }
    return settled;
  }

  vestingEarned(positionId: string): bigint {
    const p = this.#positions.get(positionId);
    if (p === undefined) return 0n;
    const market = this.#require(p.marketId);
    const book = this.#book(market, p.outcome);
    if (book.acc <= p.entryAcc) return 0n;
    return (p.accepted * (book.acc - p.entryAcc)) / SCALE;
  }

  /** What `claim` would pay: principal plus everything that vested in after entry. */
  payout(positionId: string): bigint {
    const p = this.#positions.get(positionId);
    if (p === undefined) return 0n;
    const market = this.#require(p.marketId);
    if (market.status === "voided") return p.accepted;
    if (market.status !== "resolved" || market.winner !== p.outcome) return 0n;
    const book = this.#book(market, p.outcome);
    return (p.accepted * (SCALE + book.acc - p.entryAcc)) / SCALE;
  }

  claimable(owner: Hex): readonly ClaimablePosition[] {
    const out: ClaimablePosition[] = [];
    for (const p of this.#positions.values()) {
      if (p.owner.toLowerCase() !== owner.toLowerCase() || p.claimed) continue;
      const market = this.#require(p.marketId);
      if (market.status === "open") continue;
      const payout = this.payout(p.positionId);
      const refund = p.offered - p.accepted;
      if (payout === 0n && refund === 0n) continue;
      out.push({
        positionId: p.positionId,
        onChainPositionId: p.onChainPositionId,
        marketId: p.marketId,
        payout,
        refund,
        // `claim` pays the settlement and any outstanding refused remainder together, and
        // the fixture world only reports a position once its market has settled, so the
        // refund-only call never comes up here.
        call: "claim",
        status: market.status,
      });
    }
    return out;
  }

  markClaimed(positionId: string): void {
    const p = this.#positions.get(positionId);
    if (p !== undefined) p.claimed = true;
  }

  positionsOf(marketId: string, owner: Hex): readonly WorldPosition[] {
    const out: WorldPosition[] = [];
    for (const p of this.#positions.values()) {
      if (p.marketId === marketId && p.owner.toLowerCase() === owner.toLowerCase()) out.push(p);
    }
    return out;
  }

  snapshot(market: WorldMarket): MarketSnapshot {
    let pool = 0n;
    for (const b of market.books) pool += b.principal;
    const books: BookSnapshot[] = market.books.map((b) => ({
      outcome: b.outcome,
      label: b.label,
      principal: b.principal,
      capacity: b.capacity,
      vested: b.vested,
      headroom: FixtureWorld.headroom(b),
      holders: b.holders,
      trust: b.trust,
    }));
    return {
      marketId: market.marketId,
      onChainMarketId: market.onChainMarketId,
      question: market.question,
      settler: market.settler,
      token: market.token,
      status: market.status,
      kappa: market.kappa,
      openedAt: market.openedAt,
      resolutionTime: market.resolutionTime,
      acceptedPool: pool,
      books,
      spec: market.spec,
      winner: market.winner,
      // The fixture world knows each book's own holders, so the policy derives the
      // opposing figure from `BookSnapshot.trust` rather than being handed one.
      opposingTrust: undefined,
    };
  }

  positionSnapshot(positionId: string): PositionSnapshot | undefined {
    const p = this.#positions.get(positionId);
    if (p === undefined) return undefined;
    return {
      positionId: p.positionId,
      marketId: p.marketId,
      owner: p.owner,
      outcome: p.outcome,
      offered: p.offered,
      accepted: p.accepted,
      refused: p.offered - p.accepted,
      vintage: p.vintage,
      finalized: true,
      vestingEarned: this.vestingEarned(p.positionId),
      claimed: p.claimed,
    };
  }

  #require(marketId: string): WorldMarket {
    const market = this.find(marketId);
    if (market === undefined) throw new Error(`unknown market ${marketId}`);
    return market;
  }

  #book(market: WorldMarket, outcome: number): WorldBook {
    const book = market.books.find((b) => b.outcome === outcome);
    if (book === undefined) throw new Error(`market ${market.marketId} has no outcome ${String(outcome)}`);
    return book;
  }
}

/** Everybody who is not the agent, as one synthetic address. */
export const CROWD: Hex = "0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";

function times(kappa: bigint, x: bigint): bigint {
  if (kappa === KAPPA_UNBOUNDED) return x === 0n ? 0n : KAPPA_UNBOUNDED;
  return kappa * x;
}

function addCapacity(c: bigint, d: bigint): bigint {
  if (c === KAPPA_UNBOUNDED || d === KAPPA_UNBOUNDED) return KAPPA_UNBOUNDED;
  return c + d;
}

function driftPrice(price8: bigint, driftPerTick: number): bigint {
  if (driftPerTick === 0) return price8;
  const moved = price8 + scaleByFraction(price8, Math.abs(driftPerTick));
  const backwards = price8 - scaleByFraction(price8, Math.abs(driftPerTick));
  return driftPerTick > 0 ? moved : backwards;
}
