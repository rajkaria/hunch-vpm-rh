/**
 * The decision procedure.
 *
 * Pure: same inputs, same output, no clock of its own and no I/O. Everything it needs is
 * in `DecisionInput`, and everything it considered comes back in `Decision.candidates`,
 * so a reader can check the agent's arithmetic without rerunning it.
 *
 * The numbered steps below are the same numbers used in the README's decision procedure,
 * and `test/decide.test.ts` names its describe blocks after them. Steps 1-6 are per
 * market and run in `decide`; steps 7-9 are per outcome and run in `evaluate` and `size`;
 * step 10 chooses between the survivors. Renumber all four places together or none.
 */

import { KAPPA_UNBOUNDED } from "../domain/types.js";
import type { BookSnapshot, MarketSnapshot, OutcomeEstimate } from "../domain/types.js";
import { clamp, minBigint, ratio, scaleByFraction } from "../domain/units.js";
import type { PolicyConfig } from "./config.js";

export type AbstainReason =
  | "market-not-open"
  | "frozen"
  | "inside-freeze-window"
  | "vesting-outlook-too-low"
  | "no-estimate"
  | "bankroll-exhausted"
  | "no-headroom"
  | "edge-below-threshold"
  | "below-min-ticket";

/** Why a single outcome was not the one entered. */
export type CandidateRejection = Extract<
  AbstainReason,
  "no-headroom" | "edge-below-threshold" | "below-min-ticket"
>;

export interface CandidateTrace {
  readonly outcome: number;
  readonly label: string;
  /** q_o — the book's price: this outcome's share of accepted principal. */
  readonly impliedProbability: number;
  /** p_o — the agent's own probability. */
  readonly ownProbability: number;
  /** p_o - q_o. */
  readonly rawEdge: number;
  /** Principal-weighted trust of the OPPOSING books, floored at `policy.trustFloor`. */
  readonly counterpartyTrust: number;
  /** rawEdge * counterpartyTrust. */
  readonly effectiveEdge: number;
  /** min over w != o of H_w — how much of an offer the books could accept. */
  readonly acceptanceHeadroom: bigint;
  readonly headroomUnbounded: boolean;
  /** What the policy would stake here, before choosing between outcomes. */
  readonly proposedStake: bigint;
  readonly rejection: CandidateRejection | undefined;
}

export interface Decision {
  readonly marketId: string;
  readonly action: "enter" | "abstain";
  /** Set only when `action` is "enter". */
  readonly outcome: number | undefined;
  /** Set only when `action` is "enter". */
  readonly stake: bigint | undefined;
  readonly reason: AbstainReason | "edge-found";
  readonly secondsToFreeze: number;
  /** Share of the market's arrival window still ahead, in [0, 1]. */
  readonly vestingOutlook: number;
  readonly candidates: readonly CandidateTrace[];
}

export interface DecisionInput {
  readonly market: MarketSnapshot;
  /** Undefined when the agent has no independent view — it then refuses to guess. */
  readonly estimate: OutcomeEstimate | undefined;
  /** Spendable USDC base units. */
  readonly bankroll: bigint;
  /** Unix seconds. Injected so the procedure stays pure and testable. */
  readonly now: number;
  readonly policy: PolicyConfig;
}

/** q_w = P_w / Pi, computed from the books so it always matches the headroom read beside it. */
export function impliedOddsFromBooks(books: readonly BookSnapshot[]): number[] {
  let pool = 0n;
  for (const b of books) pool += b.principal;
  return books.map((b) => ratio(b.principal, pool));
}

/**
 * Step 7's quantity: entering `outcome` vests the stake into every other book, and
 * `_finalizeVintage` rations the entry by the tightest of them. An unbounded kappa means
 * no book can run out of room, which is the n-way prescription.
 */
export function acceptanceHeadroom(
  books: readonly BookSnapshot[],
  outcome: number,
): { headroom: bigint; unbounded: boolean } {
  let tightest: bigint | undefined;
  for (const b of books) {
    if (b.outcome === outcome) continue;
    if (b.headroom === KAPPA_UNBOUNDED) continue;
    if (tightest === undefined || b.headroom < tightest) tightest = b.headroom;
  }
  if (tightest === undefined) return { headroom: KAPPA_UNBOUNDED, unbounded: true };
  return { headroom: tightest, unbounded: false };
}

/**
 * Step 8's quantity. The books the agent is NOT on are the ones that set the price it is
 * disagreeing with, so their holders' reputation is what discounts the disagreement.
 * Weighted by principal because a large anonymous position should move the number more
 * than a dust one.
 *
 * `supplied` is the opposing figure when the source already measured it that way — the
 * indexer answers "who is against you if you take o" directly. Deriving from per-book
 * trust in that case would flip an already-flipped number, so a supplied value is used as
 * given and only floored.
 */
export function counterpartyTrust(
  books: readonly BookSnapshot[],
  outcome: number,
  trustFloor: number,
  supplied?: number | undefined,
): number {
  if (supplied !== undefined) return Math.max(trustFloor, clamp(supplied, 0, 1));
  let weighted = 0;
  let total = 0n;
  for (const b of books) {
    if (b.outcome === outcome) continue;
    total += b.principal;
    weighted += clamp(b.trust, 0, 1) * Number(b.principal);
  }
  if (total === 0n) return trustFloor;
  return Math.max(trustFloor, clamp(weighted / Number(total), 0, 1));
}

export function decide(input: DecisionInput): Decision {
  const { market, estimate, bankroll, now, policy } = input;
  const secondsToFreeze = market.resolutionTime - now;
  const window = Math.max(market.resolutionTime - market.openedAt, 1);
  const vestingOutlook = clamp(secondsToFreeze / window, 0, 1);

  const abstain = (reason: AbstainReason, candidates: readonly CandidateTrace[] = []): Decision => ({
    marketId: market.marketId,
    action: "abstain",
    outcome: undefined,
    stake: undefined,
    reason,
    secondsToFreeze,
    vestingOutlook,
    candidates,
  });

  // 1. The market has to be open. A resolved or voided market takes no stake.
  if (market.status !== "open") return abstain("market-not-open");

  // 2. Past the freeze the settler reverts Frozen(). Nothing to think about.
  if (secondsToFreeze <= 0) return abstain("frozen");

  // 3. Inside the freeze buffer, refuse regardless of edge. Late stake vests into almost
  //    nothing: the accumulator on the agent's own book barely moves after it, so the
  //    position carries full outcome risk for a payoff near 1x principal.
  if (secondsToFreeze < policy.freezeBufferSeconds) return abstain("inside-freeze-window");

  // 4. The graded form of the same rule — a real share of the arrival window must remain.
  if (vestingOutlook < policy.minVestingOutlook) return abstain("vesting-outlook-too-low");

  // 5. No independent estimate means no disagreement worth acting on. The agent does not
  //    take the book's own price as evidence about the book.
  if (estimate === undefined) return abstain("no-estimate");

  // 6. Nothing to stake.
  if (bankroll < policy.minTicket) return abstain("bankroll-exhausted");

  const implied = impliedOddsFromBooks(market.books);
  const candidates: CandidateTrace[] = market.books.map((book) =>
    evaluate(book, market, estimate, implied, bankroll, vestingOutlook, policy),
  );

  // 10. Take the best surviving candidate: largest trust-weighted edge, then the book with
  //    the most room to accept, then the lower outcome index so the result is stable.
  const viable = candidates.filter((c) => c.rejection === undefined);
  if (viable.length === 0) return abstain(closestMiss(candidates), candidates);

  let best = viable[0] as CandidateTrace;
  for (const c of viable.slice(1)) {
    if (c.effectiveEdge > best.effectiveEdge) best = c;
    else if (c.effectiveEdge === best.effectiveEdge) {
      const roomier =
        (c.headroomUnbounded && !best.headroomUnbounded) ||
        (c.headroomUnbounded === best.headroomUnbounded && c.acceptanceHeadroom > best.acceptanceHeadroom);
      if (roomier) best = c;
    }
  }

  return {
    marketId: market.marketId,
    action: "enter",
    outcome: best.outcome,
    stake: best.proposedStake,
    reason: "edge-found",
    secondsToFreeze,
    vestingOutlook,
    candidates,
  };
}

function evaluate(
  book: BookSnapshot,
  market: MarketSnapshot,
  estimate: OutcomeEstimate,
  implied: readonly number[],
  bankroll: bigint,
  vestingOutlook: number,
  policy: PolicyConfig,
): CandidateTrace {
  const impliedProbability = implied[book.outcome] ?? 0;
  const ownProbability = estimate.probabilities[book.outcome] ?? 0;
  const rawEdge = ownProbability - impliedProbability;
  const trust = counterpartyTrust(
    market.books,
    book.outcome,
    policy.trustFloor,
    market.opposingTrust?.[book.outcome],
  );
  const effectiveEdge = rawEdge * trust;
  const { headroom, unbounded } = acceptanceHeadroom(market.books, book.outcome);

  const base = {
    outcome: book.outcome,
    label: book.label,
    impliedProbability,
    ownProbability,
    rawEdge,
    counterpartyTrust: trust,
    effectiveEdge,
    acceptanceHeadroom: headroom,
    headroomUnbounded: unbounded,
  } as const;

  // 7 (per outcome). No room means the settler would refuse the stake and hold it as a
  // refused remainder until the agent pulls it back. That is not a loss, but it is a
  // pointless round trip, so the agent does not make it.
  if (!unbounded && headroom <= 0n) {
    return { ...base, proposedStake: 0n, rejection: "no-headroom" };
  }

  // 8 (per outcome).
  if (effectiveEdge < policy.minEdge) {
    return { ...base, proposedStake: 0n, rejection: "edge-below-threshold" };
  }

  const stake = size(effectiveEdge, headroom, unbounded, bankroll, vestingOutlook, policy);
  if (stake < policy.minTicket) {
    return { ...base, proposedStake: stake, rejection: "below-min-ticket" };
  }
  return { ...base, proposedStake: stake, rejection: undefined };
}

/**
 * Step 9: size to the headroom that actually exists.
 *
 * Three multiplicative factors, each with a reason:
 *   - conviction: the trust-weighted edge as a share of the saturation edge;
 *   - outlook: how much of the arrival window is left, because that is what the position
 *     will earn its multiple from;
 *   - room: a share of the tightest opposing book's headroom, so the entry is accepted
 *     whole rather than rationed by `_finalizeVintage`.
 * Then the hard caps: the single-ticket limit and the bankroll itself.
 */
function size(
  effectiveEdge: number,
  headroom: bigint,
  unbounded: boolean,
  bankroll: bigint,
  vestingOutlook: number,
  policy: PolicyConfig,
): bigint {
  const conviction = policy.edgeSaturation > 0 ? clamp(effectiveEdge / policy.edgeSaturation, 0, 1) : 1;
  const fraction = policy.maxBankrollFraction * conviction * vestingOutlook;
  const target = scaleByFraction(bankroll, fraction);
  const roomCap = unbounded ? target : scaleByFraction(headroom, policy.headroomUtilisation);
  return minBigint(target, roomCap, policy.maxTicket, bankroll);
}

/** Report the closest miss, so the operator learns which knob was binding. */
function closestMiss(candidates: readonly CandidateTrace[]): AbstainReason {
  const order: readonly CandidateRejection[] = ["below-min-ticket", "edge-below-threshold", "no-headroom"];
  for (const reason of order) {
    if (candidates.some((c) => c.rejection === reason)) return reason;
  }
  return "no-headroom";
}
