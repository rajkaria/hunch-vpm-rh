/**
 * The live research source and venue: the book through The Graph, execution through the
 * wallet.
 *
 * The shapes this file expects from `@hunch-vpm/client` are written out beside each
 * decoder, and they are the shapes that package actually returns today — `MarketBook`,
 * `CounterpartyTrust`, `ImpliedOdds`, `BestHeadroom`, `VestingEarned`, `Claimable`. If the
 * client's responses move, everything that needs changing is here, and a mismatch surfaces
 * as a `DecodeError` naming the field rather than as a wrong number.
 *
 * Where the client publishes a quantity under a different name or unit than the agent's
 * domain uses, the decoder converts and says why. Where it does not publish one at all,
 * the decoder fails by name rather than inventing a value.
 *
 * `impliedOdds` and `bestHeadroom` are read even though the policy recomputes both from
 * the books. They are a cross-check: a disagreement means the indexer is serving two
 * inconsistent views of the same market, which is worth a warning before the agent stakes
 * anything on either.
 */

import type { AgentTx, AgentWallet, TxResult } from "../circle/types.js";
import { KAPPA_UNBOUNDED } from "../domain/types.js";
import type {
  BookSnapshot,
  ClaimablePosition,
  FeedDirection,
  Hex,
  MarketSnapshot,
  MarketStatus,
  PositionSnapshot,
} from "../domain/types.js";
import { clamp } from "../domain/units.js";
import type { Logger } from "../log.js";
import { acceptanceHeadroom, impliedOddsFromBooks } from "../policy/decide.js";
import type { HunchClientSurface } from "./client-binding.js";
import {
  DecodeError,
  asArray,
  asBigint,
  asNumber,
  asObject,
  asString,
  field,
  optionalField,
} from "./decode.js";
import type { ClaimReceipt, EnterReceipt, ResearchSource, Venue } from "./source.js";

/** How far the client's own implied odds may differ from the book-derived ones before it is worth saying so. */
const ODDS_TOLERANCE = 0.005;

/**
 * Top of the ERC-8004 feedback score range. The client sanity-checks against the same
 * number (`DEFAULT_SCORE_MAX`, from Agent0's reference schema) and reports mean scores on
 * that scale; the policy wants [0, 1], so this is the divisor. Configurable because the
 * client's own `scoreMax` is.
 */
export const DEFAULT_REPUTATION_SCORE_MAX = 100;

const PPM = 1_000_000;

export interface GraphSourceOptions {
  readonly marketIds: readonly string[];
  readonly logger: Logger;
  /** Defaults to `DEFAULT_REPUTATION_SCORE_MAX`; match it to the client's `scoreMax`. */
  readonly reputationScoreMax?: number | undefined;
}

export class GraphResearchSource implements ResearchSource {
  readonly name = "the-graph";

  constructor(
    private readonly client: HunchClientSurface,
    private readonly options: GraphSourceOptions,
  ) {}

  async listMarkets(): Promise<readonly MarketSnapshot[]> {
    const out: MarketSnapshot[] = [];
    for (const id of this.options.marketIds) {
      const snapshot = await this.market(id);
      if (snapshot !== undefined) out.push(snapshot);
    }
    return out;
  }

  async market(marketId: string): Promise<MarketSnapshot | undefined> {
    const raw = await this.client.marketBook(marketId);
    if (raw === null || raw === undefined) return undefined;
    const snapshot = decodeMarket(raw, marketId);
    const withTrust: MarketSnapshot = { ...snapshot, opposingTrust: await this.#opposingTrust(snapshot) };

    this.#crossCheckOdds(withTrust, await this.client.impliedOdds(marketId));
    await this.#crossCheckHeadroom(withTrust);
    return withTrust;
  }

  async position(positionId: string): Promise<PositionSnapshot | undefined> {
    const raw = await this.client.vestingEarned(positionId);
    if (raw === null || raw === undefined) return undefined;
    return decodePosition(raw, positionId);
  }

  async claimable(wallet: Hex): Promise<readonly ClaimablePosition[]> {
    return decodeClaimable(await this.client.claimable(wallet), `claimable(${wallet})`, this.options.logger);
  }

  /**
   * Reputation discounts the edge; it is not a precondition for reading the book. An
   * unreadable trust response therefore degrades to "unknown counterparty", which is the
   * case `trustFloor` exists for, instead of aborting the market the way a malformed book
   * would. Same treatment as the two cross-checks below, and for the same reason.
   */
  async #opposingTrust(market: MarketSnapshot): Promise<readonly number[] | undefined> {
    const scoreMax = this.options.reputationScoreMax ?? DEFAULT_REPUTATION_SCORE_MAX;
    try {
      const trust = decodeTrust(await this.client.counterpartyTrust(market.marketId), market.marketId, scoreMax);
      return market.books.map((b) => trust.get(b.outcome) ?? 0);
    } catch (cause) {
      this.options.logger.warn(
        `counterpartyTrust(${market.marketId}) unreadable: ${String(cause)} — ` +
          `the policy falls back to its trust floor for this market`,
      );
      return undefined;
    }
  }

  #crossCheckOdds(market: MarketSnapshot, raw: unknown): void {
    let reported: readonly number[];
    try {
      reported = decodeOdds(raw, market.marketId, market.books.length);
    } catch (cause) {
      this.options.logger.warn(`impliedOdds(${market.marketId}) unreadable: ${String(cause)}`);
      return;
    }
    const derived = impliedOddsFromBooks(market.books);
    for (const [i, value] of derived.entries()) {
      const other = reported[i] ?? 0;
      if (Math.abs(value - other) > ODDS_TOLERANCE) {
        this.options.logger.warn(
          `${market.marketId} outcome ${String(i)}: impliedOdds says ${other.toFixed(4)}, ` +
            `the books say ${value.toFixed(4)} — the indexer is serving two views of one market`,
        );
      }
    }
  }

  /**
   * Two comparisons, because `bestHeadroom` reports two different quantities and mixing
   * them up is the easy mistake: `bookHeadroom` is the outcome's OWN room (C_w - V_w) and
   * `bindingHeadroom` is the tightest of the books it would vest into, which is the number
   * that actually rations an entry.
   */
  async #crossCheckHeadroom(market: MarketSnapshot): Promise<void> {
    let best: BestHeadroomReading;
    try {
      best = decodeBestHeadroom(await this.client.bestHeadroom(market.marketId), market.marketId);
    } catch (cause) {
      this.options.logger.warn(`bestHeadroom(${market.marketId}) unreadable: ${String(cause)}`);
      return;
    }
    if (best.outcome === undefined) return;

    const book = market.books.find((b) => b.outcome === best.outcome);
    if (book !== undefined && best.bookHeadroom !== undefined && book.headroom !== best.bookHeadroom) {
      this.options.logger.warn(
        `${market.marketId} outcome ${String(best.outcome)}: bestHeadroom says ${best.bookHeadroom.toString()}, ` +
          `the book says ${book.headroom.toString()}`,
      );
    }
    if (best.bindingHeadroom !== undefined) {
      const derived = acceptanceHeadroom(market.books, best.outcome).headroom;
      if (derived !== best.bindingHeadroom) {
        this.options.logger.warn(
          `${market.marketId} outcome ${String(best.outcome)}: bestHeadroom's binding headroom is ` +
            `${best.bindingHeadroom.toString()}, the books give ${derived.toString()}`,
        );
      }
    }
  }
}

/**
 * Live execution. The client builds the calldata, the Circle wallet signs and sends it,
 * and acceptance is deliberately left undefined: vintages finalize lazily, so no entering
 * transaction can know how much of its offer the books took. The monitor step reads it.
 */
export class GraphVenue implements Venue {
  readonly name = "the-graph";

  constructor(
    private readonly client: HunchClientSurface,
    private readonly wallet: AgentWallet,
    private readonly settler: Hex,
  ) {}

  /**
   * Two calls, not one. `VestedParimutuel.enter` pulls the stake with `transferFrom`, so
   * an allowance has to exist before it lands; the client builds the approval separately
   * because it is an ERC-20 call to the token, not a call to the settler.
   */
  async enter(market: MarketSnapshot, outcome: number, amount: bigint): Promise<EnterReceipt> {
    const approve = decodeCalls(
      await this.client.approveCalldata({ spender: this.settler, amount, token: market.token }),
      "approveCalldata",
      0n,
      "approve",
    );
    const entry = decodeCalls(
      await this.client.enterCalldata({
        settler: this.settler,
        marketId: market.onChainMarketId,
        outcome,
        amount,
      }),
      "enterCalldata",
      // The settler pulls the stake on this call, so the dry-run wallet debits it here.
      amount,
      `enter#${String(outcome)}`,
    );

    const txs = await this.#sendAll([...approve, ...entry]);
    return {
      marketId: market.marketId,
      outcome,
      offered: amount,
      accepted: undefined,
      positionId: undefined,
      txs,
    };
  }

  async claim(position: ClaimablePosition): Promise<ClaimReceipt> {
    const params = { settler: this.settler, positionId: position.onChainPositionId };
    const raw =
      position.call === "withdrawRefund"
        ? await this.client.withdrawRefundCalldata(params)
        : await this.client.claimCalldata(params);
    const txs = await this.#sendAll(decodeCalls(raw, `${position.call}Calldata`, 0n, position.call));
    return { positionId: position.positionId, payout: position.payout, refund: position.refund, txs };
  }

  async #sendAll(steps: readonly AgentTx[]): Promise<readonly TxResult[]> {
    const txs: TxResult[] = [];
    for (const step of steps) {
      const result = await this.wallet.send(step);
      txs.push(result);
      if (result.status === "failed") break;
    }
    return txs;
  }
}

// --------------------------------------------------------------------------- decoders

/**
 * Expected from `marketBook(marketId)` — the client's `MarketBook`:
 * ```
 * { marketId, onChainMarketId, settler, token, status: "Open"|"Resolved"|"Voided",
 *   kappa: bigint|null, createdAt, resolutionTime, acceptedPool, winner: number|null,
 *   spec: { feedKey, strike, direction: "above"|"below", maxStaleness } | null,
 *   books: [{ outcome, principal, vested, capacity: bigint|null, headroom: bigint|null }] }
 * ```
 * `null` capacity, headroom and kappa all mean unbounded. Timestamps arrive as bigints of
 * unix seconds and are narrowed to numbers here, because everything downstream compares
 * them to a clock.
 *
 * Two fields the client does not publish under the agent's own name are handled
 * explicitly: the opening time arrives as `createdAt` and is read as `openedAt` (see
 * below), and per-outcome labels fall back to the feed direction for a binary market and
 * to the outcome index otherwise.
 *
 * `test/client-integration.test.ts` runs this decoder over a `MarketBook` the client
 * itself builds, so a field that moves on one side of this comment fails on the other.
 */
export function decodeMarket(raw: unknown, marketId: string): MarketSnapshot {
  const path = `marketBook(${marketId})`;
  const m = asObject(raw, path);

  const specRaw = asObject(field(m, "spec", path), `${path}.spec`);
  const direction = decodeDirection(field(specRaw, "direction", `${path}.spec`), `${path}.spec.direction`);
  // The client reports an unbounded kappa as null, which `optionalField` folds to
  // undefined; the contracts spell the same thing as the uint256 max sentinel.
  const kappaRaw = optionalField(m, "kappa");
  const kappa = kappaRaw === undefined ? KAPPA_UNBOUNDED : asBigint(kappaRaw, `${path}.kappa`);
  const winnerRaw = optionalField(m, "winner");

  const booksRaw = asArray(field(m, "books", path), `${path}.books`);
  const books = booksRaw.map((b, i) =>
    decodeBook(b, `${path}.books[${String(i)}]`, i, direction, booksRaw.length),
  );

  return {
    marketId: asString(field(m, "marketId", path), `${path}.marketId`),
    onChainMarketId: decodeOnChainId(m, path, "onChainMarketId"),
    question: decodeQuestion(m, specRaw, path, direction),
    settler: asString(field(m, "settler", path), `${path}.settler`) as Hex,
    token: asString(field(m, "token", path), `${path}.token`) as Hex,
    status: decodeStatus(field(m, "status", path), `${path}.status`),
    kappa,
    openedAt: decodeOpenedAt(m, path),
    resolutionTime: Number(asBigint(field(m, "resolutionTime", path), `${path}.resolutionTime`)),
    acceptedPool: asBigint(field(m, "acceptedPool", path), `${path}.acceptedPool`),
    books,
    spec: {
      feedKey: asString(field(specRaw, "feedKey", `${path}.spec`), `${path}.spec.feedKey`),
      // The client calls the threshold `strike`; the contracts fix it at 8 decimals, which
      // is what `strike8` is named after, so the unit is the same and only the name moves.
      strike8: asBigint(
        optionalField(specRaw, "strike") ?? field(specRaw, "strike8", `${path}.spec`),
        `${path}.spec.strike`,
      ),
      direction,
      maxStaleness: Number(asBigint(field(specRaw, "maxStaleness", `${path}.spec`), `${path}.spec.maxStaleness`)),
    },
    winner: winnerRaw === undefined ? undefined : asNumber(winnerRaw, `${path}.winner`),
    // Filled in by the source from `counterpartyTrust`; the book read says nothing about it.
    opposingTrust: undefined,
  };
}

/**
 * The settler's own market or position index. The client publishes it beside the subgraph
 * id precisely so a caller can build a write; without it the agent would have to parse the
 * `<settler>-<index>` id, which is the indexer's format to change, not ours.
 */
function decodeOnChainId(source: Record<string, unknown>, path: string, ...keys: readonly string[]): bigint {
  for (const key of keys) {
    const raw = optionalField(source, key);
    if (raw !== undefined) return asBigint(raw, `${path}.${key}`);
  }
  throw new DecodeError(
    `${path}.${keys[0] ?? "id"}: missing. The settler addresses a market or position by its own ` +
      `index and the indexer addresses it as <settler>-<index>; a write needs the former.`,
  );
}

/**
 * Unix seconds the market opened — the start of its arrival window, and the denominator of
 * the vesting-outlook rule (README step 4).
 *
 * The subgraph records it as `Market.createdAt` and the client's `MarketBook` publishes it
 * under that name, which is the name read here first after the agent's own. A source that
 * publishes neither fails by name rather than assuming a window: the rule it feeds is the
 * one the agent's whole thesis rests on, and a guessed denominator would quietly resize
 * every stake.
 */
function decodeOpenedAt(source: Record<string, unknown>, path: string): number {
  const raw = optionalField(source, "openedAt") ?? optionalField(source, "createdAt");
  if (raw === undefined) {
    throw new DecodeError(
      `${path}.openedAt: missing. The agent needs the market's opening time to judge how much ` +
        `of the arrival window is left; the subgraph records it as Market.createdAt and the ` +
        `client publishes it under that name, so a response without either is not a market ` +
        `this agent can size a stake on.`,
    );
  }
  return Number(asBigint(raw, `${path}.openedAt`));
}

/**
 * A human label for the market. The client's `MarketBook` carries no question text — the
 * subgraph indexes the resolution spec, not prose — so one is composed from the spec,
 * which is what the market actually asks.
 */
function decodeQuestion(
  source: Record<string, unknown>,
  spec: Record<string, unknown>,
  path: string,
  direction: FeedDirection,
): string {
  const raw = optionalField(source, "question");
  if (raw !== undefined) return asString(raw, `${path}.question`);
  const feedKey = asString(field(spec, "feedKey", `${path}.spec`), `${path}.spec.feedKey`);
  const strike = asBigint(
    optionalField(spec, "strike") ?? field(spec, "strike8", `${path}.spec`),
    `${path}.spec.strike`,
  );
  const side = direction === 0 ? "at or above" : "below";
  return `${feedKey} ${side} ${strike.toString()} (8dp) at the freeze`;
}

/**
 * Expected per book — the client's `BookView`. `capacity` and `headroom` are `null` when
 * kappa is unbounded, and `headroom` is derived from capacity and vesting when it is
 * absent. Labels and holder counts are not published; see `decodeLabel`.
 */
function decodeBook(
  raw: unknown,
  path: string,
  index: number,
  direction: FeedDirection,
  outcomeCount: number,
): BookSnapshot {
  const b = asObject(raw, path);
  const principal = asBigint(field(b, "principal", path), `${path}.principal`);
  const capacityRaw = optionalField(b, "capacity");
  const capacity = capacityRaw === undefined ? KAPPA_UNBOUNDED : asBigint(capacityRaw, `${path}.capacity`);
  const vested = asBigint(field(b, "vested", path), `${path}.vested`);
  const headroomRaw = optionalField(b, "headroom");
  const headroom =
    headroomRaw !== undefined
      ? asBigint(headroomRaw, `${path}.headroom`)
      : capacity === KAPPA_UNBOUNDED
        ? KAPPA_UNBOUNDED
        : capacity > vested
          ? capacity - vested
          : 0n;
  const outcomeRaw = optionalField(b, "outcome");
  const outcome = outcomeRaw === undefined ? index : asNumber(outcomeRaw, `${path}.outcome`);
  const holdersRaw = optionalField(b, "holders") ?? optionalField(b, "live");

  return {
    outcome,
    label: decodeLabel(b, path, outcome, direction, outcomeCount),
    principal,
    capacity,
    vested,
    headroom,
    holders: holdersRaw === undefined ? 0 : asNumber(holdersRaw, `${path}.holders`),
    // Per-book holder reputation is not something the client publishes: it answers the
    // opposing question instead, which the source folds into `MarketSnapshot.opposingTrust`.
    // Zero here means "unknown", and nothing in the policy reads it once that is set.
    trust: 0,
  };
}

/**
 * A binary feed market's outcomes are "above" and "below" by construction —
 * `FeedResolver.winnerFor` gives outcome 0 to the at-or-above side under direction 0 and
 * to the below side under direction 1 — so the labels are derivable rather than guessed.
 * Anything else gets its index, which is at least honest.
 */
function decodeLabel(
  book: Record<string, unknown>,
  path: string,
  outcome: number,
  direction: FeedDirection,
  outcomeCount: number,
): string {
  const raw = optionalField(book, "label");
  if (raw !== undefined) return asString(raw, `${path}.label`);
  if (outcomeCount !== 2 || (outcome !== 0 && outcome !== 1)) return `outcome ${String(outcome)}`;
  const zeroIsAbove = direction === 0;
  return outcome === 0 ? (zeroIsAbove ? "above" : "below") : zeroIsAbove ? "below" : "above";
}

/** The client capitalises its statuses; the agent's domain does not. */
function decodeStatus(raw: unknown, path: string): MarketStatus {
  const text = asString(raw, path).toLowerCase();
  if (text === "open" || text === "resolved" || text === "voided") return text;
  throw new DecodeError(`${path}: expected open|resolved|voided, got ${text}`);
}

/** The client says "above"/"below"; the contracts say 0/1. Both are accepted. */
function decodeDirection(raw: unknown, path: string): FeedDirection {
  if (raw === "above") return 0;
  if (raw === "below") return 1;
  const value = asNumber(raw, path);
  if (value === 0 || value === 1) return value as FeedDirection;
  throw new DecodeError(`${path}: expected 0 or 1, got ${String(value)}`);
}

/**
 * Expected from `counterpartyTrust(marketId)` — the client's `CounterpartyTrust`:
 * ```
 * { marketId, sides: [{ outcome, principalWeightedMeanScore: number|null, unratedSharePpm }] }
 * ```
 * `sides[o]` is already the OPPOSING side: who is against you if you take outcome o. The
 * returned map keeps that orientation, and the policy uses it as given rather than
 * deriving an opposing figure from it a second time.
 *
 * Two conversions. The score is on the registry's own scale (0..`scoreMax`) and the policy
 * wants [0, 1]. And a mean over rated wallets says nothing about the principal held by
 * wallets with no record at all, so it is scaled by the rated share of the opposing book:
 * a 90%-anonymous side with two well-rated wallets is mostly unknown, and that is what the
 * agent should act on.
 *
 * A bare `[0.7, 0.6]` or `[{ outcome, trust }]` is accepted too, already in [0, 1], for a
 * source that measures trust directly.
 */
export function decodeTrust(raw: unknown, marketId: string, scoreMax: number): Map<number, number> {
  const path = `counterpartyTrust(${marketId})`;
  const out = new Map<number, number>();
  if (!Array.isArray(raw)) {
    const container = asObject(raw, path);
    const sides = asArray(field(container, "sides", path), `${path}.sides`);
    for (const [i, entry] of sides.entries()) {
      const sidePath = `${path}.sides[${String(i)}]`;
      const side = asObject(entry, sidePath);
      const outcomeRaw = optionalField(side, "outcome");
      const outcome = outcomeRaw === undefined ? i : asNumber(outcomeRaw, `${sidePath}.outcome`);
      out.set(outcome, opposingTrustFromSide(side, sidePath, scoreMax));
    }
    return out;
  }
  for (const [i, entry] of asArray(raw, path).entries()) {
    if (typeof entry === "number") {
      out.set(i, entry);
      continue;
    }
    const e = asObject(entry, `${path}[${String(i)}]`);
    const outcomeRaw = optionalField(e, "outcome");
    const outcome = outcomeRaw === undefined ? i : asNumber(outcomeRaw, `${path}[${String(i)}].outcome`);
    out.set(outcome, asNumber(field(e, "trust", `${path}[${String(i)}]`), `${path}[${String(i)}].trust`));
  }
  return out;
}

function opposingTrustFromSide(side: Record<string, unknown>, path: string, scoreMax: number): number {
  const scoreRaw = optionalField(side, "principalWeightedMeanScore") ?? optionalField(side, "meanScore");
  if (scoreRaw === undefined) return 0;
  const score = clamp(asNumber(scoreRaw, `${path}.principalWeightedMeanScore`) / scoreMax, 0, 1);
  const unratedRaw = optionalField(side, "unratedSharePpm");
  if (unratedRaw === undefined) return score;
  const ratedShare = clamp(1 - Number(asBigint(unratedRaw, `${path}.unratedSharePpm`)) / PPM, 0, 1);
  return score * ratedShare;
}

/**
 * Expected from `impliedOdds(marketId)` — the client's `ImpliedOdds`:
 * `{ outcomes: [{ outcome, probabilityPpm }] }`. A bare `[0.42, 0.58]` or
 * `[{ outcome, probability }]` is accepted too.
 */
export function decodeOdds(raw: unknown, marketId: string, outcomes: number): readonly number[] {
  const path = `impliedOdds(${marketId})`;
  const entries = Array.isArray(raw)
    ? asArray(raw, path)
    : asArray(field(asObject(raw, path), "outcomes", path), `${path}.outcomes`);

  const out = new Array<number>(outcomes).fill(0);
  for (const [i, entry] of entries.entries()) {
    if (typeof entry === "number") {
      if (i < outcomes) out[i] = entry;
      continue;
    }
    const e = asObject(entry, `${path}[${String(i)}]`);
    const outcomeRaw = optionalField(e, "outcome");
    const outcome = outcomeRaw === undefined ? i : asNumber(outcomeRaw, `${path}[${String(i)}].outcome`);
    const ppmRaw = optionalField(e, "probabilityPpm");
    const value =
      ppmRaw === undefined
        ? asNumber(field(e, "probability", `${path}[${String(i)}]`), `${path}[${String(i)}].probability`)
        : Number(asBigint(ppmRaw, `${path}[${String(i)}].probabilityPpm`)) / PPM;
    if (outcome >= 0 && outcome < outcomes) out[outcome] = value;
  }
  return out;
}

export interface BestHeadroomReading {
  /** Undefined when the market can take no stake at all right now. */
  readonly outcome: number | undefined;
  /** H_o of that outcome's own book. */
  readonly bookHeadroom: bigint | undefined;
  /** min over the opposing books of H_w — the number that actually rations an entry. */
  readonly bindingHeadroom: bigint | undefined;
}

/**
 * Expected from `bestHeadroom(marketId)` — the client's `BestHeadroom`:
 * `{ best: { outcome, bookHeadroom: bigint|null, bindingHeadroom: bigint|null } | null }`.
 * A bare `{ outcome, headroom }` is read as the own-book figure.
 */
export function decodeBestHeadroom(raw: unknown, marketId: string): BestHeadroomReading {
  const path = `bestHeadroom(${marketId})`;
  const o = asObject(raw, path);
  const bestRaw = optionalField(o, "best");
  if (bestRaw === undefined && optionalField(o, "outcome") === undefined) {
    // `best: null` is the indexer saying the market takes no stake, not a shape mismatch.
    return { outcome: undefined, bookHeadroom: undefined, bindingHeadroom: undefined };
  }
  const best = bestRaw === undefined ? o : asObject(bestRaw, `${path}.best`);
  const bestPath = bestRaw === undefined ? path : `${path}.best`;
  const book = optionalField(best, "bookHeadroom") ?? optionalField(best, "headroom");
  const binding = optionalField(best, "bindingHeadroom");

  return {
    outcome: asNumber(field(best, "outcome", bestPath), `${bestPath}.outcome`),
    // A null headroom is the unbounded sentinel, not a missing field.
    bookHeadroom: book === undefined ? KAPPA_UNBOUNDED : asBigint(book, `${bestPath}.bookHeadroom`),
    bindingHeadroom: binding === undefined ? undefined : asBigint(binding, `${bestPath}.bindingHeadroom`),
  };
}

/**
 * Expected from `vestingEarned(positionId)` — the client's `VestingEarned`:
 * ```
 * { positionId, marketId, owner, outcome, state, offered, accepted, refused,
 *   earned: bigint|null }
 * ```
 * `earned` is null until the entry's vintage is finalized, because `accepted` is not fixed
 * before then; that reads as zero here, which is what the position has actually accrued.
 */
export function decodePosition(raw: unknown, positionId: string): PositionSnapshot {
  const path = `vestingEarned(${positionId})`;
  const p = asObject(raw, path);
  const offered = asBigint(field(p, "offered", path), `${path}.offered`);
  const accepted = asBigint(field(p, "accepted", path), `${path}.accepted`);
  const refusedRaw = optionalField(p, "refused");
  const stateRaw = optionalField(p, "state");
  const state = stateRaw === undefined ? undefined : asString(stateRaw, `${path}.state`);
  const earnedRaw = optionalField(p, "earned");
  // The client reports the vintage's state rather than its block number, so a numeric
  // vintage is only present on sources that carry one. Nothing in the policy reads it.
  const vintageRaw = optionalField(p, "vintage");
  const finalizedRaw = optionalField(p, "finalized");
  const claimedRaw = optionalField(p, "claimed");

  return {
    positionId: asString(field(p, "positionId", path), `${path}.positionId`),
    marketId: asString(field(p, "marketId", path), `${path}.marketId`),
    owner: asString(field(p, "owner", path), `${path}.owner`) as Hex,
    outcome: asNumber(field(p, "outcome", path), `${path}.outcome`),
    offered,
    accepted,
    refused:
      refusedRaw === undefined
        ? offered > accepted
          ? offered - accepted
          : 0n
        : asBigint(refusedRaw, `${path}.refused`),
    vintage: vintageRaw === undefined ? 0 : asNumber(vintageRaw, `${path}.vintage`),
    finalized:
      finalizedRaw !== undefined
        ? finalizedRaw === true
        : state !== undefined
          ? state !== "pending-vintage"
          : accepted > 0n,
    vestingEarned: earnedRaw === undefined ? 0n : asBigint(earnedRaw, `${path}.earned`),
    claimed: claimedRaw === true || state === "claimed",
  };
}

/**
 * Expected from `claimable(wallet)` — the client's `Claimable`:
 * ```
 * { items: [{ id, marketId, amount, call, argument,
 *             breakdown: { settlement, voidRefund, refusedRemainder, residue } }] }
 * ```
 * There is exactly one item per transaction the wallet should send, which is why the call
 * and its argument travel with the amount: `claim` pays a settlement and any outstanding
 * refused remainder together, while `withdrawRefund` pays only the remainder and is
 * available before the market settles.
 *
 * `claimResidue` items are skipped with a warning. The agent never opens a market, so it
 * is never the residue owner; an item saying otherwise is a surprise worth naming rather
 * than a transaction worth sending.
 *
 * A bare `[{ positionId, marketId, payout, refund, status }]` is accepted as well.
 */
export function decodeClaimable(
  raw: unknown,
  path: string,
  logger?: Logger | undefined,
): readonly ClaimablePosition[] {
  const entries = Array.isArray(raw)
    ? asArray(raw, path)
    : asArray(field(asObject(raw, path), "items", path), `${path}.items`);

  const out: ClaimablePosition[] = [];
  for (const [i, entry] of entries.entries()) {
    const itemPath = `${path}[${String(i)}]`;
    const item = asObject(entry, itemPath);
    const call = decodeClaimCall(item, itemPath);
    if (call === undefined) {
      logger?.warn(`${itemPath}: a claimResidue item for a wallet that opens no markets — skipped`);
      continue;
    }
    out.push(decodeClaimableItem(item, itemPath, call));
  }
  return out;
}

function decodeClaimCall(
  item: Record<string, unknown>,
  path: string,
): "claim" | "withdrawRefund" | undefined {
  const raw = optionalField(item, "call");
  if (raw === undefined) return "claim";
  const text = asString(raw, `${path}.call`);
  if (text === "claim" || text === "withdrawRefund") return text;
  if (text === "claimResidue") return undefined;
  throw new DecodeError(`${path}.call: expected claim|withdrawRefund|claimResidue, got ${text}`);
}

function decodeClaimableItem(
  item: Record<string, unknown>,
  path: string,
  call: "claim" | "withdrawRefund",
): ClaimablePosition {
  const breakdownRaw = optionalField(item, "breakdown");
  const idRaw = optionalField(item, "id") ?? field(item, "positionId", path);

  if (breakdownRaw === undefined) {
    const refundRaw = optionalField(item, "refund");
    return {
      positionId: asString(idRaw, `${path}.positionId`),
      onChainPositionId: decodeOnChainId(item, path, "argument", "onChainPositionId"),
      marketId: asString(field(item, "marketId", path), `${path}.marketId`),
      payout: asBigint(field(item, "payout", path), `${path}.payout`),
      refund: refundRaw === undefined ? 0n : asBigint(refundRaw, `${path}.refund`),
      call,
      status: decodeStatus(field(item, "status", path), `${path}.status`),
    };
  }

  const breakdown = asObject(breakdownRaw, `${path}.breakdown`);
  const part = (key: string): bigint => {
    const value = optionalField(breakdown, key);
    return value === undefined ? 0n : asBigint(value, `${path}.breakdown.${key}`);
  };
  const settlement = part("settlement");
  const voidRefund = part("voidRefund");
  const refusedRemainder = part("refusedRemainder");

  return {
    positionId: asString(idRaw, `${path}.id`),
    onChainPositionId: decodeOnChainId(item, path, "argument", "onChainPositionId"),
    marketId: asString(field(item, "marketId", path), `${path}.marketId`),
    // Residue is not in this sum: it is paid by `claimResidue`, whose items never get
    // this far, and adding it to a settlement would overstate what the call pays.
    payout: settlement + voidRefund,
    refund: refusedRemainder,
    call,
    // The item carries no market status, but the breakdown implies one: a void refund
    // only exists on a voided market, a settlement only on a resolved one, and a bare
    // refused remainder is withdrawable while the market is still open.
    status: voidRefund > 0n ? "voided" : settlement > 0n ? "resolved" : "open",
  };
}

/**
 * Expected from the calldata helpers: a single `{ to, data, value? }`, which is what the
 * client returns, or `{ steps: [...] }` for a source that batches.
 *
 * `settlementDebit` is attached to the last step: it is the dry-run wallet's way of
 * keeping a believable balance, and the live wallet ignores it.
 */
export function decodeCalls(
  raw: unknown,
  path: string,
  debit: bigint,
  defaultLabel = "step",
): readonly AgentTx[] {
  const source = asObject(raw, path);
  const stepsRaw = optionalField(source, "steps");
  const entries = stepsRaw === undefined ? [source] : asArray(stepsRaw, `${path}.steps`);
  const steps = entries.map((entry, i) => {
    const e = asObject(entry, `${path}[${String(i)}]`);
    const valueRaw = optionalField(e, "value");
    const labelRaw = optionalField(e, "label");
    return {
      label:
        labelRaw === undefined
          ? entries.length === 1
            ? defaultLabel
            : `${defaultLabel}${String(i)}`
          : asString(labelRaw, `${path}[${String(i)}].label`),
      to: asString(field(e, "to", `${path}[${String(i)}]`), `${path}[${String(i)}].to`) as Hex,
      data: asString(field(e, "data", `${path}[${String(i)}]`), `${path}[${String(i)}].data`) as Hex,
      value: valueRaw === undefined ? 0n : asBigint(valueRaw, `${path}[${String(i)}].value`),
      settlementDebit: 0n,
    };
  });
  if (steps.length === 0) throw new DecodeError(`${path}: no calls to send`);
  const last = steps[steps.length - 1] as AgentTx;
  steps[steps.length - 1] = { ...last, settlementDebit: debit };
  return steps;
}
