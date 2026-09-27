/**
 * The settlement arithmetic, restated on plain values.
 *
 * Every function here mirrors a specific piece of `contracts/src`, and the
 * tests pin the mirror. Where the contract floors, this floors, in the same
 * place, on the same operands — a UI that rounds where the settler floors will
 * quote a payout the settler does not pay, and that is the one bug this page
 * cannot have.
 *
 *   VestedParimutuel._finalizeVintage  -> simulateEntry
 *   VestedParimutuel.previewPayout     -> vpmPayout
 *   VestedParimutuel._headroom         -> bookHeadroom
 *   ClassicParimutuel._payout          -> classicPayout
 */

import { ACC_SCALE, PPM, maxBigInt, minBigInt, shareToPpm } from './units';

/** The per-outcome state the acceptance rule reads. */
export interface BookMath {
  outcome: number;
  /** P_w — accepted principal on this outcome. */
  principal: bigint;
  /** V_w — accepted stake vested INTO this book from the other outcomes. */
  vested: bigint;
  /** C_w = kappa * P_w. `null` when kappa is unbounded, which is never binding. */
  capacity: bigint | null;
  /** D_w — offered demand already queued against this book in the open vintage. */
  demand: bigint;
  /** A_w — reward-per-share accumulator, fixed point at ACC_SCALE. */
  acc: bigint;
}

// ---------------------------------------------------------------- headroom

/**
 * H_w = C_w - V_w, floored at 0. `null` when the book's capacity is unbounded.
 *
 * Floored rather than allowed negative: `_headroom` in the settler returns 0
 * for an over-vested book, and a negative bar width is not a thing.
 */
export function bookHeadroom(capacity: bigint | null, vested: bigint): bigint | null {
  if (capacity === null) return null;
  return maxBigInt(0n, capacity - vested);
}

export interface CapacityBar {
  /** True when the book has no capacity ceiling, so there is no bar to draw. */
  unbounded: boolean;
  /** V_w, what has vested in. */
  vested: bigint;
  /** C_w. `null` when unbounded. */
  capacity: bigint | null;
  /** H_w. `null` when unbounded. */
  headroom: bigint | null;
  /** V_w / C_w in ppm, clamped to [0, 1e6]. 0 when unbounded. */
  consumedPpm: bigint;
  /** The complement, so the two halves of the track always sum to 1e6. */
  freePpm: bigint;
  /** True once no further stake can vest into this book at all. */
  full: boolean;
}

/**
 * How much of a book's capacity has been consumed, as a bar.
 *
 * The two shares are computed once and made to sum to exactly 1e6 so the two
 * segments of the track cannot leave a sub-pixel seam between them, and the
 * consumed share is clamped because a book can finish a vintage with V_w
 * marginally over C_w without that being an error worth painting as overflow.
 */
export function capacityBar(capacity: bigint | null, vested: bigint): CapacityBar {
  if (capacity === null) {
    return {
      unbounded: true,
      vested,
      capacity: null,
      headroom: null,
      consumedPpm: 0n,
      freePpm: PPM,
      full: false,
    };
  }
  const headroom = bookHeadroom(capacity, vested);
  // A capacity of 0 means a book with no principal behind it; it can accept
  // nothing, which reads as full rather than as empty.
  const raw = capacity === 0n ? PPM : shareToPpm(vested, capacity);
  const consumedPpm = raw > PPM ? PPM : raw < 0n ? 0n : raw;
  return {
    unbounded: false,
    vested,
    capacity,
    headroom,
    consumedPpm,
    freePpm: PPM - consumedPpm,
    full: headroom === 0n,
  };
}

// ---------------------------------------------------------------- acceptance

export interface OpposingRoom {
  outcome: number;
  /** H_w. `null` when unbounded. */
  headroom: bigint | null;
  /** D_w already queued against this book in the open vintage. */
  demand: bigint;
  /** What this book alone would accept of the offer. */
  cap: bigint;
}

export interface Acceptance {
  /** c — what was offered. */
  offered: bigint;
  /** s — what the opposing books had room to take. */
  accepted: bigint;
  /** offered - accepted. Refunded, not lost. */
  refused: bigint;
  /** The opposing book that produced the binding cap, or `null` if none did. */
  bindingOutcome: number | null;
  /** The largest offer that would have been accepted in full. `null` when unbounded. */
  maxFullyAccepted: bigint | null;
  /** Every opposing book's contribution to the decision, in outcome order. */
  opposing: OpposingRoom[];
}

/**
 * What the settler would accept of an offer of `offered` on `outcome`, if the
 * entry landed now and its vintage finalized with no other new stake in it.
 *
 * This is `_finalizeVintage` rule (iii) for a single entry. Two details decide
 * the number and both are easy to get wrong:
 *
 *  - the entry's own offer is part of the demand it is rationed against. The
 *    settler adds `amount` to every opposing book's `demand` inside `enter`,
 *    before the vintage is finalized, so the denominator is D_w + c, not D_w.
 *  - the cap is taken per opposing book and then minimised in ONE pass.
 *    Headroom that an entry leaves unused on book A because book B cut it is
 *    not handed back round. The settler does not redistribute within a vintage
 *    and neither does this.
 *
 * Stake on an outcome vests into every OTHER outcome, so an outcome with no
 * opposing book has no counterparty and accepts nothing.
 */
export function simulateEntry(books: readonly BookMath[], outcome: number, offered: bigint): Acceptance {
  const opposing: OpposingRoom[] = [];
  let accepted = offered > 0n ? offered : 0n;
  let bindingOutcome: number | null = null;
  let maxFullyAccepted: bigint | null = null;

  for (const book of books) {
    if (book.outcome === outcome) continue;
    const headroom = bookHeadroom(book.capacity, book.vested);
    const demand = book.demand + (offered > 0n ? offered : 0n);

    let cap = offered > 0n ? offered : 0n;
    if (headroom !== null && demand > headroom && offered > 0n) {
      cap = (offered * headroom) / demand;
    }
    opposing.push({ outcome: book.outcome, headroom, demand: book.demand, cap });

    if (cap < accepted) {
      accepted = cap;
      bindingOutcome = book.outcome;
    }
    if (headroom !== null) {
      const allowance = maxBigInt(0n, headroom - book.demand);
      maxFullyAccepted = maxFullyAccepted === null ? allowance : minBigInt(maxFullyAccepted, allowance);
    }
  }

  if (opposing.length === 0) {
    return { offered, accepted: 0n, refused: offered, bindingOutcome: null, maxFullyAccepted: 0n, opposing };
  }

  return {
    offered,
    accepted,
    refused: offered - accepted,
    bindingOutcome,
    maxFullyAccepted,
    opposing,
  };
}

// ---------------------------------------------------------------- payouts

/**
 * `floor(s * (A_now - A_entry) / S)` — what has vested to a position since it
 * entered. The accumulator only rises, so a negative delta means the two
 * numbers came from different states; report 0 rather than a negative earning.
 */
export function earnedVesting(accepted: bigint, entryAcc: bigint, currentAcc: bigint): bigint {
  const delta = currentAcc - entryAcc;
  if (delta <= 0n || accepted <= 0n) return 0n;
  return (accepted * delta) / ACC_SCALE;
}

/**
 * `VestedParimutuel.previewPayout`: `floor(s * (S + A_w - A_entry) / S)`.
 *
 * Written as `accepted + earnedVesting(...)`, which is the same integer
 * because `floor(s*(S + d)/S) == s + floor(s*d/S)` for integer s — the split
 * form is the one the UI needs, since it shows principal and vesting apart.
 */
export function vpmPayout(accepted: bigint, entryAcc: bigint, currentAcc: bigint): bigint {
  if (accepted <= 0n) return 0n;
  return accepted + earnedVesting(accepted, entryAcc, currentAcc);
}

/**
 * `ClassicParimutuel._payout`: `floor(pool * stake / winningPrincipal)`.
 *
 * The pool is every stake, winning and losing, and each winner takes a share
 * of it in proportion to stake. When the market resolves to an outcome nobody
 * backed the principal is 0 and the payout is 0.
 */
export function classicPayout(accepted: bigint, winningPrincipal: bigint, acceptedPool: bigint): bigint {
  if (accepted <= 0n || winningPrincipal <= 0n) return 0n;
  return (acceptedPool * accepted) / winningPrincipal;
}

/** The multiple a position's accepted principal has grown to, in ppm. */
export function vestingMultiplePpm(entryAcc: bigint, currentAcc: bigint): bigint {
  const delta = currentAcc - entryAcc;
  const scaled = delta <= 0n ? ACC_SCALE : ACC_SCALE + delta;
  return (scaled * PPM) / ACC_SCALE;
}

/** The multiple the classic rule pays a unit on this outcome, in ppm. */
export function classicMultiplePpm(winningPrincipal: bigint, acceptedPool: bigint): bigint | null {
  if (winningPrincipal <= 0n) return null;
  return (acceptedPool * PPM) / winningPrincipal;
}

// ---------------------------------------------------------------- comparison

export interface RuleComparison {
  /** The principal the comparison is per: both rules are applied to this stake. */
  stake: bigint;
  /** What the vested rule pays if this outcome is the one that happens. */
  vpm: bigint;
  /** What the classic rule would pay the same stake on the same books. */
  classic: bigint;
  /** vpm - classic. Positive means the vested rule pays this position more. */
  delta: bigint;
  /** vpm / stake in ppm. `null` when the stake is 0 and the ratio is undefined. */
  vpmMultiplePpm: bigint | null;
  classicMultiplePpm: bigint | null;
  /** delta / stake in ppm — the difference stated against what was put in. */
  deltaOfStakePpm: bigint | null;
}

function compare(stake: bigint, vpm: bigint, classic: bigint): RuleComparison {
  const delta = vpm - classic;
  const defined = stake > 0n;
  return {
    stake,
    vpm,
    classic,
    delta,
    vpmMultiplePpm: defined ? (vpm * PPM) / stake : null,
    classicMultiplePpm: defined ? (classic * PPM) / stake : null,
    // Signed division in JS truncates toward zero, which is what a signed
    // ratio wants: the magnitude is the same whichever rule is ahead.
    deltaOfStakePpm: defined ? (delta * PPM) / stake : null,
  };
}

export interface PositionComparisonInput {
  /** s_i — the principal the settler accepted. */
  accepted: bigint;
  /** A_o at entry. */
  entryAcc: bigint;
  /** A_o now (frozen at the resolution timestamp once the market has settled). */
  currentAcc: bigint;
  /** P_o — accepted principal on this position's outcome. */
  outcomePrincipal: bigint;
  /** Pi — accepted principal across every book. */
  acceptedPool: bigint;
}

/**
 * The same position, the same books, settled under each rule.
 *
 * Both sides are applied to the SAME accepted principal, so the only thing
 * that differs between them is the settlement rule. Under the classic rule
 * nothing is ever refused, so a position that was rationed would have had more
 * principal at risk there; `newEntryComparison` is the function that models
 * that, and it is the one to use for a stake that has not been placed yet.
 */
export function positionComparison(input: PositionComparisonInput): RuleComparison {
  const vpm = vpmPayout(input.accepted, input.entryAcc, input.currentAcc);
  const classic = classicPayout(input.accepted, input.outcomePrincipal, input.acceptedPool);
  return compare(input.accepted, vpm, classic);
}

export interface NewEntryComparison {
  acceptance: Acceptance;
  /** Both rules applied to the offer, per the notes on each field below. */
  comparison: RuleComparison;
  /**
   * What the vested rule returns if the outcome wins and nothing enters after:
   * the accepted principal, plus the refused remainder refunded. Exactly the
   * offer — a stake that arrives with nothing behind it earns nothing from
   * money that is already down.
   */
  vpmReturnedIfWins: bigint;
  /** What the classic rule returns: a share of a pool this stake has just enlarged. */
  classicReturnedIfWins: bigint;
  /**
   * What this entry costs an incumbent under each rule, per unit of their
   * accepted principal, in ppm. Under the classic rule a new stake dilutes
   * every holder on its own side; under the vested rule it cannot.
   */
  incumbentMultipleBeforePpm: bigint | null;
  incumbentClassicMultipleAfterPpm: bigint | null;
}

/**
 * What a stake placed right now would earn under each rule, and what it would
 * do to the people already holding the same outcome.
 *
 * The two rules are handed the same offer, not the same accepted principal,
 * because that is the choice in front of someone about to stake: the classic
 * pool takes the whole offer (it never refuses), the vested settler takes what
 * the opposing books have room for and refunds the rest.
 */
export function newEntryComparison(
  books: readonly BookMath[],
  outcome: number,
  offered: bigint,
): NewEntryComparison {
  const acceptance = simulateEntry(books, outcome, offered);
  const own = books.find((book) => book.outcome === outcome);
  const principal = own?.principal ?? 0n;
  const pool = books.reduce((total, book) => total + book.principal, 0n);

  // The vested rule: the entry vests into the OPPOSING books, never its own,
  // so its own accumulator is unmoved by its own arrival and A_entry == A_now.
  // With nothing arriving after it, it is paid its accepted principal and no
  // more, and the refused remainder comes back — so the offer returns whole.
  const vpmReturnedIfWins = acceptance.accepted + acceptance.refused;

  // The classic rule: the offer joins the pool and the winning principal, and
  // is paid a share of the enlarged pool.
  const classicReturnedIfWins = classicPayout(offered, principal + offered, pool + offered);

  return {
    acceptance,
    comparison: compare(offered, vpmReturnedIfWins, classicReturnedIfWins),
    vpmReturnedIfWins,
    classicReturnedIfWins,
    incumbentMultipleBeforePpm: classicMultiplePpm(principal, pool),
    incumbentClassicMultipleAfterPpm: classicMultiplePpm(principal + offered, pool + offered),
  };
}

// ---------------------------------------------------------------- odds

/**
 * P_o / Pi in ppm. Flooring means the outcomes sum to slightly under 1e6; that
 * gap is the rounding, not a margin taken by anyone.
 */
export function impliedProbabilityPpm(principal: bigint, acceptedPool: bigint): bigint {
  return shareToPpm(principal, acceptedPool);
}

/** Pi across a set of books. */
export function totalPrincipal(books: readonly BookMath[]): bigint {
  return books.reduce((total, book) => total + book.principal, 0n);
}
