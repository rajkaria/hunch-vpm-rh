/**
 * A small, faithful replay of the settler's bookkeeping, used to build the
 * fixture data.
 *
 * It exists so the fixtures cannot be internally inconsistent. Book state is
 * not a set of numbers anyone chose: capacity really is kappa times principal,
 * V_w really is the sum of what vested in, the accumulator really is the sum
 * of `inflow * S / P` increments taken against the principal as it stood at
 * each vintage's start, and a stake that arrives with no room behind it really
 * is rationed by `floor(c * H / D)`. Numbers typed in by hand would drift from
 * that the first time anyone edited one, and every headroom bar and payout on
 * the site would then be quoting a state the contract could never reach.
 *
 * It is not a second implementation of the settler and nothing at runtime
 * depends on it: it builds the fixture dataset and then gets out of the way.
 * Each vintage here is one batch — the on-chain lazy roll (a vintage is
 * finalized by the first transaction of a later block) is the same arithmetic
 * with the finalization moved, and modelling the laziness would add nothing a
 * screen can see.
 */

import { ACC_SCALE, maxBigInt } from '../units';

export interface SimBook {
  outcome: number;
  /** P_w */
  principal: bigint;
  /** A_w, fixed point at ACC_SCALE */
  acc: bigint;
  /** C_w. `null` when kappa is unbounded. */
  capacity: bigint | null;
  /** V_w */
  vested: bigint;
  /** Positions with accepted > 0 that have not claimed. */
  live: number;
}

export interface SimPosition {
  positionId: bigint;
  owner: string;
  outcome: number;
  offered: bigint;
  accepted: bigint;
  entryAcc: bigint;
  vintage: bigint;
  enteredAt: bigint;
}

export interface SimEntry {
  owner: string;
  outcome: number;
  amount: bigint;
}

export interface SimSnapshot {
  t: bigint;
  points: { outcome: number; principal: bigint; acc: bigint; vested: bigint }[];
}

/** Which settler's bookkeeping to replay. */
export type SettlementRule = 'vested' | 'classic';

/**
 * One market's books, advanced one vintage at a time.
 *
 * `kappa` of `null` is the unbounded sentinel: capacity never binds, which is
 * what the paper prescribes for n-way markets.
 *
 * Under the `classic` rule the books are only principal: there is no capacity
 * to ration against, nothing ever vests, every offer is accepted in full, and
 * the accumulator stays at zero because there is no accumulator. Modelling it
 * through the same class keeps the comparison honest — both settlers really do
 * present the same interface, and the difference is entirely in what happens
 * to a stake after it lands.
 */
export class MarketSim {
  readonly books: SimBook[] = [];
  readonly positions: SimPosition[] = [];
  readonly history: SimSnapshot[] = [];
  acceptedPool = 0n;

  private nextPosition = 0n;
  private nextVintage = 1n;

  constructor(
    readonly kappa: bigint | null,
    seed: bigint[],
    readonly creator: string,
    openedAt: bigint,
    readonly rule: SettlementRule = 'vested',
  ) {
    if (rule === 'classic') {
      this.initClassic(seed, creator, openedAt);
      return;
    }
    const accepted = seedClamp(seed, kappa);
    const total = accepted.reduce((sum, value) => sum + value, 0n);
    accepted.forEach((amount, outcome) => {
      if (amount <= 0n) throw new Error(`seed leg ${outcome} clamps to zero, which voids the market at creation`);
      this.books.push({
        outcome,
        principal: amount,
        // The seed legs are each other's counterparties: every leg vests its
        // accepted principal into every other leg's book.
        acc: ((total - amount) * ACC_SCALE) / amount,
        capacity: kappa === null ? null : kappa * amount,
        vested: total - amount,
        live: 1,
      });
      this.positions.push({
        positionId: this.nextPosition++,
        owner: creator,
        outcome,
        offered: seed[outcome] ?? amount,
        accepted: amount,
        // Seed positions record A = 0, i.e. before the seed's own increments,
        // so the seed legs collect the vesting the other legs paid them.
        entryAcc: 0n,
        vintage: 0n,
        enteredAt: openedAt,
      });
    });
    this.acceptedPool = total;
    this.snapshot(openedAt);
  }

  /**
   * The classic pool's creation: every seed leg is accepted whole, there is no
   * capacity, and nothing vests. A zero leg still voids the market, because a
   * pool with an empty side has no counterparty.
   */
  private initClassic(seed: readonly bigint[], creator: string, openedAt: bigint): void {
    let total = 0n;
    seed.forEach((amount, outcome) => {
      if (amount <= 0n) throw new Error(`seed leg ${outcome} is empty, which voids the market at creation`);
      this.books.push({ outcome, principal: amount, acc: 0n, capacity: null, vested: 0n, live: 1 });
      this.positions.push({
        positionId: this.nextPosition++,
        owner: creator,
        outcome,
        offered: amount,
        accepted: amount,
        entryAcc: 0n,
        vintage: 0n,
        enteredAt: openedAt,
      });
      total += amount;
    });
    this.acceptedPool = total;
    this.snapshot(openedAt);
  }

  /** H_w = C_w - V_w, floored at 0. `null` when unbounded. */
  headroom(outcome: number): bigint | null {
    const book = this.books[outcome];
    if (book === undefined) throw new RangeError(`no outcome ${outcome}`);
    if (book.capacity === null) return null;
    return maxBigInt(0n, book.capacity - book.vested);
  }

  /**
   * Enter one vintage's worth of stake and finalize it, in the order the
   * settler does: ration against the headroom as it stood at vintage start,
   * vest the summed inflow into each book against its vintage-start principal,
   * then book principal and capacity so they are usable from the next vintage.
   */
  vintage(at: bigint, entries: SimEntry[]): SimPosition[] {
    if (this.rule === 'classic') return this.classicVintage(at, entries);
    const n = this.books.length;
    const head = this.books.map((_, outcome) => this.headroom(outcome));
    const demand = new Array<bigint>(n).fill(0n);
    for (const entry of entries) {
      for (let w = 0; w < n; w++) {
        if (w !== entry.outcome) demand[w] = (demand[w] ?? 0n) + entry.amount;
      }
    }

    const inflow = new Array<bigint>(n).fill(0n);
    const accepted: bigint[] = [];
    for (const entry of entries) {
      let take = entry.amount;
      for (let w = 0; w < n; w++) {
        if (w === entry.outcome) continue;
        const room = head[w] ?? null;
        const queued = demand[w] ?? 0n;
        if (room !== null && queued > room) {
          const cap = (entry.amount * room) / queued;
          if (cap < take) take = cap;
        }
      }
      accepted.push(take);
      for (let w = 0; w < n; w++) {
        if (w !== entry.outcome) inflow[w] = (inflow[w] ?? 0n) + take;
      }
    }

    for (let w = 0; w < n; w++) {
      const book = this.books[w];
      const into = inflow[w] ?? 0n;
      if (book === undefined || into === 0n) continue;
      book.acc += (into * ACC_SCALE) / book.principal;
      book.vested += into;
    }

    const vintage = this.nextVintage++;
    const created: SimPosition[] = [];
    entries.forEach((entry, i) => {
      const book = this.books[entry.outcome];
      if (book === undefined) throw new RangeError(`no outcome ${entry.outcome}`);
      const take = accepted[i] ?? 0n;
      const position: SimPosition = {
        positionId: this.nextPosition++,
        owner: entry.owner,
        outcome: entry.outcome,
        offered: entry.amount,
        accepted: take,
        entryAcc: book.acc,
        vintage,
        enteredAt: at,
      };
      this.positions.push(position);
      created.push(position);
      if (take > 0n) {
        book.principal += take;
        if (book.capacity !== null && this.kappa !== null) book.capacity += this.kappa * take;
        book.live += 1;
        this.acceptedPool += take;
      }
    });

    this.snapshot(at);
    return created;
  }

  /** The classic pool's entry: accepted in full, booked immediately, nothing vests. */
  private classicVintage(at: bigint, entries: SimEntry[]): SimPosition[] {
    const vintage = this.nextVintage++;
    const created: SimPosition[] = [];
    for (const entry of entries) {
      const book = this.books[entry.outcome];
      if (book === undefined) throw new RangeError(`no outcome ${entry.outcome}`);
      const position: SimPosition = {
        positionId: this.nextPosition++,
        owner: entry.owner,
        outcome: entry.outcome,
        offered: entry.amount,
        accepted: entry.amount,
        entryAcc: 0n,
        vintage,
        enteredAt: at,
      };
      this.positions.push(position);
      created.push(position);
      book.principal += entry.amount;
      book.live += 1;
      this.acceptedPool += entry.amount;
    }
    this.snapshot(at);
    return created;
  }

  /** Record the curve's next sample. */
  snapshot(t: bigint): void {
    this.history.push({
      t,
      points: this.books.map((book) => ({
        outcome: book.outcome,
        principal: book.principal,
        acc: book.acc,
        vested: book.vested,
      })),
    });
  }
}

/**
 * The creation clamp: a_o <- min(offered_o, kappa * min_{w != o} a_w), iterated
 * to a fixed point. Monotone non-increasing from the offer, so it terminates.
 */
export function seedClamp(offered: readonly bigint[], kappa: bigint | null): bigint[] {
  const accepted = [...offered];
  if (kappa === null) return accepted;
  for (let pass = 0; pass < 64; pass++) {
    let converged = true;
    for (let o = 0; o < accepted.length; o++) {
      let cap: bigint | null = null;
      for (let w = 0; w < accepted.length; w++) {
        if (w === o) continue;
        const limit = kappa * (accepted[w] ?? 0n);
        if (cap === null || limit < cap) cap = limit;
      }
      const offer = offered[o] ?? 0n;
      const next = cap === null || offer < cap ? offer : cap;
      if (next !== accepted[o]) {
        accepted[o] = next;
        converged = false;
      }
    }
    if (converged) return accepted;
  }
  throw new Error('seed clamp did not converge');
}
