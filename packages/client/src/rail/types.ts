import type { Address } from 'viem';
import type { IndexStatus, MarketStatus, PositionState } from '../types.js';
import type { UnsignedCall } from '../writes/calldata.js';

/**
 * The settlement rail contract.
 *
 * An agent-facing product has four verbs — research, quote, positions, trade —
 * and they do not change when the money moves somewhere else. This file is the
 * shape those four verbs answer in, written so that a custodial book (a
 * Postgres ledger with the operator as resolver, payer and counterparty) and
 * this venue (an on-chain parimutuel where the agent's own wallet signs) are
 * the same interface.
 *
 * Where the two rails genuinely differ, the difference is in the TYPE rather
 * than in a comment:
 *
 *   - `RailQuote.refused` exists because a stake here can be accepted in part.
 *     A rail that always fills in full reports 0 and says so in its
 *     capabilities; a caller that ignores the field is wrong on one rail and
 *     merely redundant on the other.
 *   - `RailTrade` is a union. A custodial rail returns a fill; this one returns
 *     unsigned calldata. `kind` is the discriminant and there is no way to read
 *     a transaction out of the result without looking at it.
 *
 * Fields only some rails can answer are `null`-able here and narrowed to
 * non-null on the Arc implementations (`ArcResearch`, `ArcQuote`,
 * `ArcPosition`), so the adapter's own return types state what it always
 * provides.
 */

/** Identifier for a rail implementation: `'arc'` here, whatever the app calls its own book. */
export type RailId = string;

/**
 * How the caller names an outcome.
 *
 * A number is the outcome index the settler itself uses. A string is a label
 * the app configured (`sides: { yes: 0, no: 1 }`), which is how an existing
 * agent that has always sent `side: "yes"` keeps working unchanged.
 */
export type RailSide = number | string;

/** Read options every verb accepts. A rail with no notion of time may ignore them. */
export interface RailReadOptions {
  /** Evaluate as of this instant (unix seconds) instead of now. */
  now?: bigint;
}

// ---------------------------------------------------------------- capability descriptor

/**
 * What a rail can and cannot do, so the app can branch on a fact rather than on
 * the rail's name.
 *
 * Every field here is something the private app's existing code implicitly
 * assumes about the Postgres book: that it holds the money, that it fills
 * orders whole, that it decides the outcome, that it pays winners without being
 * asked. On this rail three of those are false, and that is the whole reason
 * this descriptor exists.
 */
export interface RailCapabilities {
  readonly rail: RailId;
  /** Who holds the stake between the trade and the payout. */
  readonly custody: 'venue' | 'self';
  /** Who is on the other side of a filled position. */
  readonly counterparty: 'venue' | 'other-stakers';
  /** Whether a stake can be accepted in part, with the rest handed back. */
  readonly refusal: boolean;
  /** What a quote answers: a price per unit, or how much would be accepted. */
  readonly quote: 'price' | 'acceptance';
  /** Who decides the outcome. */
  readonly resolution: 'operator' | 'feed';
  /** Whether a winner is paid automatically, or has to come and get it. */
  readonly payout: 'push' | 'pull';
  /** Who signs the transaction that takes the position. */
  readonly signing: 'venue' | 'agent-wallet';
  /** Whether a placed stake can be cancelled before settlement. */
  readonly cancellable: boolean;
  /** `null` when the rail is not on a chain. */
  readonly chainId: number | null;
  /** The settlement asset. `address` is `null` off-chain. */
  readonly asset: {
    readonly symbol: string;
    readonly decimals: number;
    readonly address: Address | null;
  };
}

// ---------------------------------------------------------------- research

export interface RailOutcome {
  readonly outcome: number;
  /** The label the app configured for this index, or `null` when it configured none. */
  readonly label: string | null;
  /** Stake backing this outcome that has actually been accepted, in smallest units. */
  readonly backing: bigint;
  /** `backing / total` in parts per million, floored. */
  readonly probabilityPpm: bigint;
  readonly probabilityPercent: string;
  /**
   * Gross return per unit if this outcome wins and nothing further enters, in
   * ppm. `null` when nothing backs the outcome.
   */
  readonly decimalOddsPpm: bigint | null;
}

/**
 * The room one outcome has for new stake.
 *
 * Only a rail that rations by capacity fills this in. The number that decides
 * whether a stake is refused is `bindingHeadroom`, which belongs to an OPPOSING
 * book: stake on outcome o vests into every other outcome's book the moment it
 * lands, so it is accepted only up to the room those books have to cover it.
 */
export interface RailHeadroom {
  readonly outcome: number;
  /** This outcome's own room. Informational: it is not what limits a stake here. */
  readonly ownBookHeadroom: bigint | null;
  /** The opposing book with the least room left once queued stake is counted. */
  readonly bindingHeadroom: bigint | null;
  readonly bindingOutcome: number | null;
  /** The largest stake accepted in full right now. `null` when capacity is unbounded. */
  readonly maxFullyAccepted: bigint | null;
  /** Stake already offered against the binding book in the current block. */
  readonly competingDemand: bigint;
  readonly opposing: readonly RailOpposingBook[];
}

export interface RailOpposingBook {
  readonly outcome: number;
  /** `capacity - vested`, floored at 0. `null` when unbounded. */
  readonly headroom: bigint | null;
  readonly competingDemand: bigint;
  /** `headroom - competingDemand`, floored at 0: what this book alone takes in full. */
  readonly allowance: bigint | null;
}

/**
 * How a market resolves.
 *
 * `by: 'operator'` means a person or a service decides. `by: 'feed'` means a
 * registered price spec decides and anyone may call it in — nobody, including
 * the venue, can resolve it any other way. `by: 'unknown'` means the market was
 * opened without a spec registered against it, so this rail cannot say who
 * decides: that is a reason not to stake, not a detail.
 */
export interface RailResolution {
  readonly by: 'operator' | 'feed' | 'unknown';
  /** The contract that resolves the market, when one does. */
  readonly resolver: Address | null;
  /** False when a market was opened without a spec registered against it. */
  readonly registered: boolean;
  /** The oracle adapter the spec reads. */
  readonly oracle: Address | null;
  /** Adapter-defined feed identifier. */
  readonly feedKey: string | null;
  /** Threshold at 8 decimals, signed. */
  readonly strike: bigint | null;
  /** The same threshold as a decimal string. */
  readonly strikeDecimal: string | null;
  /** `above`: outcome 0 wins at or above the strike. `below`: the other way. */
  readonly direction: 'above' | 'below' | null;
  /** Seconds beyond which a reading is too old and the market voids instead. */
  readonly maxStaleness: bigint | null;
  /** Unix seconds from which anyone may void a market that has not resolved. */
  readonly voidableFrom: bigint | null;
  /** The reading the market settled on, at 8 decimals. `null` until it does. */
  readonly resolvedPrice: bigint | null;
  readonly resolvedPriceDecimal: string | null;
  readonly priceUpdatedAt: bigint | null;
  /** Age of the reading that voided the market, in seconds. */
  readonly voidedStaleAge: bigint | null;
}

/** What an agent needs to decide. */
export interface RailResearch {
  readonly rail: RailId;
  /** The id every other verb takes for this market. */
  readonly marketId: string;
  readonly status: MarketStatus;
  /** Unix seconds at which the market stops taking stake. */
  readonly closesAt: bigint;
  /** True once it has: no further stake can be taken, whatever the books say. */
  readonly closed: boolean;
  readonly outcomes: readonly RailOutcome[];
  /** Stake accepted across every outcome. */
  readonly totalAccepted: bigint;
  /** The realized outcome, once there is one. */
  readonly winner: number | null;
  /** Unix seconds this answer was evaluated at. */
  readonly asOf: bigint;

  // Fields only some rails have. Narrowed to non-null on `ArcResearch`.

  /** Seconds until the market stops taking stake. `null` on a rail with no hard close. */
  readonly secondsToClose: bigint | null;
  /** Per-outcome capacity. `null` on a rail that does not ration. */
  readonly headroom: readonly RailHeadroom[] | null;
  /** How the market resolves. `null` on a rail that does not publish it. */
  readonly resolution: RailResolution | null;
  /** Who holds the other side, and what the reputation registry says. `null` when not read. */
  readonly counterparty: RailCounterparty | null;
}

/** Reputation of the wallets opposing each outcome, as far as a registry knows. */
export interface RailCounterparty {
  readonly sides: readonly RailCounterpartySide[];
  /** True when no reputation source is configured, so every wallet counts as unrated. */
  readonly unavailable: boolean;
}

export interface RailCounterpartySide {
  /** The outcome you would be taking. */
  readonly outcome: number;
  /** Accepted principal on every other outcome. */
  readonly opposingPrincipal: bigint;
  readonly counterparties: number;
  readonly ratedCounterparties: number;
  readonly meanScore: number | null;
  readonly principalWeightedMeanScore: number | null;
  /** Share of the opposing money held by wallets no registry has heard of, in ppm. */
  readonly unratedSharePpm: bigint;
}

// ---------------------------------------------------------------- quote

export type QuoteAcceptance = 'full' | 'partial' | 'none';

export type RailRefusalKind =
  /** The opposing books do not have the room to cover the whole stake. */
  | 'headroom'
  /** Past the freeze. The settler reverts rather than taking the entry. */
  | 'market-frozen'
  /** Already resolved or voided. The settler reverts. */
  | 'market-not-open'
  /** No opposing book exists, so there is nothing for the stake to vest into. */
  | 'no-counterparty';

export interface RailRefusal {
  readonly kind: RailRefusalKind;
  readonly refused: bigint;
  readonly detail: string;
  /** The settler error the transaction reverts with, or `null` when it would not revert. */
  readonly revertsWith: string | null;
}

/** What a position would be paid if the market settled at the moment of the quote. */
export interface RailPayoutPreview {
  /** Paid if this outcome is the one that happens. */
  readonly wins: bigint;
  /** Paid if it is not. */
  readonly loses: bigint;
  /** Paid if the market voids instead of resolving. `null` on a rail that cannot void. */
  readonly voided: bigint | null;
}

/**
 * What this stake would get.
 *
 * On a custodial rail this is a price. Here it is an ACCEPTANCE: how much of
 * the requested amount the opposing books can cover right now, what is refused,
 * and what the accepted part would pay. A quote that reports only a price is
 * not wrong on this rail so much as silent about the only thing that can
 * surprise the caller.
 */
export interface RailQuote {
  readonly rail: RailId;
  readonly marketId: string;
  readonly outcome: number;
  /** What was asked for. */
  readonly requested: bigint;
  /** What would actually be taken, right now. */
  readonly accepted: bigint;
  /** `requested - accepted`. Never silently dropped. */
  readonly refused: bigint;
  readonly acceptance: QuoteAcceptance;
  /** Why something was refused, or `null` when nothing was. */
  readonly refusal: RailRefusal | null;
  readonly payoutIfResolvedNow: RailPayoutPreview;
  readonly asOf: bigint;
}

// ---------------------------------------------------------------- positions

export interface RailPosition {
  readonly id: string;
  readonly marketId: string;
  readonly outcome: number;
  readonly label: string | null;
  readonly state: PositionState;
  /** What was staked. */
  readonly staked: bigint;
  /** What was accepted. */
  readonly accepted: bigint;
  /** What was refused and is refundable. */
  readonly refused: bigint;
  /** What this position pays if its outcome is the one that happens. */
  readonly payoutIfOutcomeWins: bigint | null;
  /** What could be collected right now. */
  readonly claimableNow: bigint;
}

export interface RailPositions {
  readonly rail: RailId;
  readonly wallet: Address;
  readonly positions: readonly RailPosition[];
  readonly totals: {
    readonly staked: bigint;
    readonly accepted: bigint;
    readonly refused: bigint;
    readonly claimableNow: bigint;
  };
  readonly asOf: bigint;
}

// ---------------------------------------------------------------- trade

export interface RailTradeOptions extends RailReadOptions {
  /** The agent's own wallet: the address that will sign. */
  wallet?: Address;
}

/**
 * A trade a custodial rail already made on the caller's behalf.
 *
 * This repo does not implement it — it is here so the app can type its existing
 * Postgres rail against the same union, and so the `kind` discriminant exists
 * on both sides. A venue rail with more to report extends this.
 */
export interface ExecutedTrade {
  readonly kind: 'executed';
  readonly custody: 'venue';
  readonly rail: RailId;
  /** The venue's own identifier for the fill. */
  readonly reference: string;
  readonly accepted: bigint;
  readonly refused: bigint;
}

/**
 * Calldata for the caller's OWN wallet. Nothing here is signed.
 *
 * This is the single most important difference between this rail and a
 * custodial one, so it is stated three times over: in the type's name, in
 * `kind`, and in `signed`, which is the literal `false` and cannot be anything
 * else. There is no field on this object that a wallet could broadcast, no
 * method that could produce one, and no key anywhere in this package. The agent
 * signs, or nothing happens.
 */
export interface UnsignedTrade {
  readonly kind: 'unsigned-calldata';
  /** Always `false`. This package holds no key and signs nothing. */
  readonly signed: false;
  /** The stake goes from the agent's wallet into the settler's escrow, never to an operator. */
  readonly custody: 'self';
  readonly rail: RailId;
  readonly chainId: number;
  /** The wallet that must sign and send, when the caller named one. */
  readonly from: Address | null;
  readonly marketId: string;
  readonly outcome: number;
  /** Send these in order, from `from`. */
  readonly steps: readonly TradeStep[];
  /** The acceptance this calldata was built against. */
  readonly quote: RailQuote;
  /** Things the caller should see before signing — a partial fill, a stale index. */
  readonly warnings: readonly string[];
}

export interface TradeStep {
  readonly id: 'approve' | 'enter';
  /** One line on what this call does. */
  readonly what: string;
  /** Whether the step is always needed, or only under a condition the caller must check. */
  readonly when: 'always' | 'if-allowance-below-amount';
  readonly chainId: number;
  /** `{ to, data, value }`. Unsigned. */
  readonly call: UnsignedCall;
}

/** What `trade` returns. Discriminate on `kind` before you do anything with it. */
export type RailTrade = UnsignedTrade | ExecutedTrade;

/** True when the rail handed back calldata for the caller to sign. */
export function isUnsignedTrade(trade: RailTrade): trade is UnsignedTrade {
  return trade.kind === 'unsigned-calldata';
}

// ---------------------------------------------------------------- the rail

/**
 * The four verbs, on any rail.
 *
 * The private app types its Postgres implementation against this and registers
 * either one behind its `settlementRail` switch. Nothing in the agent-facing
 * HTTP surface changes: the verbs, their arguments and their order are the ones
 * that surface already exposes.
 */
export interface SettlementRail {
  /** What this rail is and is not. Branch on these, never on the rail's name. */
  readonly capabilities: RailCapabilities;
  /** Everything an agent needs to decide on one market. */
  research(marketId: string, options?: RailReadOptions): Promise<RailResearch>;
  /** What this stake would get — including what would be refused. */
  quote(marketId: string, side: RailSide, amount: bigint, options?: RailReadOptions): Promise<RailQuote>;
  /** What a wallet holds. */
  positions(wallet: Address, options?: RailReadOptions): Promise<RailPositions>;
  /** Place it. On this rail that means handing back calldata for the agent to sign. */
  trade(marketId: string, side: RailSide, amount: bigint, options?: RailTradeOptions): Promise<RailTrade>;
}

/** Index freshness, carried on every Arc answer. */
export type { IndexStatus };
