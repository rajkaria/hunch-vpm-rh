/**
 * The one place that knows how `@hunch-vpm/client` spells things. Tool handlers depend
 * on `VenueReader` and the normalized domain types; swapping the client for a direct
 * subgraph query or an RPC read is a change to this file alone.
 *
 * Two spellings of "unbounded" arrive here and both are handled explicitly, because the
 * alternative is a number that is wrong by 2^256:
 *   - the client writes `null` on `kappa`, `capacity` and `headroom`;
 *   - the indexer writes -1 (its UNBOUNDED_SENTINEL) and publishes a boolean beside it.
 * Any other negative amount is upstream corruption — the settler floors headroom at zero
 * — and is refused rather than carried into a staking decision.
 */

import {
  asArray,
  asBigInt,
  asFlag,
  asIdString,
  asNumber,
  asObject,
  asString,
  asUnixSeconds,
  hasKey,
  optional,
  pick,
  require_,
  requirePresent,
} from "./decode.js";
import type {
  BookState,
  ClaimKind,
  ClaimableItem,
  ClaimableSummary,
  Counterparty,
  HeadroomPick,
  MarketState,
  MarketStatus,
  OddsRow,
  TrustSummary,
  VestingEarned,
} from "./domain.js";
import { badUpstreamData, ToolError } from "./errors.js";
import { isUnbounded, normalizeAddress, UNBOUNDED } from "./format.js";
import type { VpmReadClient } from "./client-surface.js";

export interface VenueReader {
  marketState(marketId: string): Promise<MarketState>;
  odds(marketId: string): Promise<OddsRow[]>;
  bestHeadroom(marketId: string): Promise<HeadroomPick | undefined>;
  counterpartyTrust(marketId: string): Promise<TrustSummary>;
  vestingEarned(positionId: string): Promise<VestingEarned>;
  claimable(wallet: string): Promise<ClaimableSummary>;
}

export function createClientVenueReader(client: VpmReadClient): VenueReader {
  return {
    async marketState(marketId) {
      const raw = await call(() => client.marketBook(marketId), "marketBook", { marketId });
      if (raw === null || raw === undefined) throw notFound("market", marketId);
      return normalizeMarketState(raw, marketId);
    },
    async odds(marketId) {
      const raw = await call(() => client.impliedOdds(marketId), "impliedOdds", { marketId });
      return normalizeOdds(raw);
    },
    async bestHeadroom(marketId) {
      const raw = await call(() => client.bestHeadroom(marketId), "bestHeadroom", { marketId });
      return normalizeHeadroomPick(raw);
    },
    async counterpartyTrust(marketId) {
      const raw = await call(() => client.counterpartyTrust(marketId), "counterpartyTrust", { marketId });
      return normalizeTrust(raw);
    },
    async vestingEarned(positionId) {
      const raw = await call(() => client.vestingEarned(positionId), "vestingEarned", { positionId });
      if (raw === null || raw === undefined) throw notFound("position", positionId);
      return normalizeVesting(raw, positionId);
    },
    async claimable(wallet) {
      const raw = await call(() => client.claimable(wallet), "claimable", { wallet });
      return normalizeClaimable(raw, wallet);
    },
  };
}

function notFound(what: string, id: string): ToolError {
  return new ToolError("not_found", `No ${what} with id "${id}" on this venue.`, {
    hint: `Check the id and the chain the server is pointed at (HUNCH_VPM_CHAIN_ID).`,
    detail: { [`${what}Id`]: id },
  });
}

/**
 * The client fails for reasons an agent can act on differently — a missing id is not a
 * dead endpoint — so its thrown errors are classified rather than flattened.
 */
async function call<T>(fn: () => Promise<T>, method: string, detail: Record<string, unknown>): Promise<T> {
  try {
    return await fn();
  } catch (thrown) {
    if (thrown instanceof ToolError) throw thrown;
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    if (/\bnot found\b|\b404\b|no such/i.test(message)) {
      throw new ToolError("not_found", message, { detail: { ...detail, method }, cause: thrown });
    }
    throw new ToolError("upstream_unavailable", `@hunch-vpm/client ${method}() failed: ${message}`, {
      hint: "The subgraph or RPC endpoint behind the client is unreachable or rate limited. Retry, or check HUNCH_VPM_SUBGRAPH_URL and HUNCH_VPM_GRAPH_API_KEY.",
      detail: { ...detail, method },
      cause: thrown,
    });
  }
}

// ------------------------------------------------------------------ amounts

/** The indexer's "unbounded" marker. A real amount is never negative. */
const UNBOUNDED_SENTINEL = -1n;

/** An amount that cannot be negative: principal, vested, a claimable sum. */
function asAmount(value: unknown, path: string): bigint {
  const amount = asBigInt(value, path);
  if (amount < 0n) throw badUpstreamData(path, "a non-negative amount", value);
  return amount;
}

/**
 * A quantity that is allowed to be unbounded: capacity, headroom, kappa.
 *
 * `null` is the client's spelling. -1 is the indexer's, and is only honoured when the
 * sibling boolean it publishes beside the number says so — otherwise a negative here is
 * corruption, and letting it through would report a saturated book as having room.
 */
function asUnboundedOr(value: unknown, path: string, flaggedUnbounded: boolean): bigint {
  if (value === null || value === undefined) return UNBOUNDED;
  const amount = asBigInt(value, path);
  if (amount < 0n) {
    if (flaggedUnbounded && amount === UNBOUNDED_SENTINEL) return UNBOUNDED;
    throw badUpstreamData(path, "a non-negative amount, or null for unbounded", value);
  }
  return amount;
}

function flag(source: Record<string, unknown>, keys: readonly string[]): boolean {
  const value = pick(source, keys);
  return value === undefined ? false : asFlag(value, keys[0] ?? "flag");
}

// ------------------------------------------------------------------ normalizers

const STATUS_BY_INDEX: readonly MarketStatus[] = ["open", "resolved", "voided"];

export function normalizeStatus(value: unknown, path: string): MarketStatus {
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) {
    // The settler's enum: 0 Open, 1 Resolved, 2 Voided.
    const status = STATUS_BY_INDEX[Number(value)];
    if (status !== undefined) return status;
  }
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "open" || lower === "resolved" || lower === "voided") return lower;
    if (lower === "void") return "voided";
  }
  throw badUpstreamData(path, "a market status (open | resolved | voided)", value);
}

export function normalizeMarketState(raw: unknown, fallbackId: string): MarketState {
  const source = asObject(raw, "marketBook");
  const market = isWrapped(source) ? asObject(source["market"], "marketBook.market") : source;
  const booksRaw = asArray(require_(market, ["books", "outcomes", "legs"], "marketBook"), "marketBook.books");
  const books = booksRaw.map((book, index) => normalizeBook(book, index, `marketBook.books[${index}]`));

  const acceptedPool =
    optional(pick(market, ["acceptedPool", "pool", "totalPrincipal"]), asAmount, "marketBook.acceptedPool") ??
    books.reduce((sum, book) => sum + book.principal, 0n);

  return {
    id: String(pick(market, ["id", "marketId"]) ?? fallbackId),
    settler: optional(pick(market, ["settler", "settlerAddress", "address"]), asString, "marketBook.settler"),
    question: optional(pick(market, ["question", "title", "description"]), asString, "marketBook.question"),
    status: normalizeStatus(require_(market, ["status", "state"], "marketBook"), "marketBook.status"),
    kappa: asUnboundedOr(
      requirePresent(market, ["kappa", "capacityCoefficient"], "marketBook"),
      "marketBook.kappa",
      flag(market, ["kappaIsUnbounded"]),
    ),
    resolutionTime: asUnixSeconds(
      require_(market, ["resolutionTime", "freezeAt", "resolvesAt"], "marketBook"),
      "marketBook.resolutionTime",
    ),
    acceptedPool,
    winner: optional(pick(market, ["winner", "winningOutcome"]), asNumber, "marketBook.winner"),
    books,
  };
}

/** A payload that wraps the market under a `market` key, as a GraphQL response would. */
function isWrapped(source: Record<string, unknown>): boolean {
  return typeof source["market"] === "object" && source["market"] !== null && source["books"] === undefined;
}

function normalizeBook(raw: unknown, position: number, path: string): BookState {
  const book = asObject(raw, path);
  const principal = asAmount(require_(book, ["principal", "accepted", "acceptedPrincipal"], path), `${path}.principal`);
  const vested = asAmount(require_(book, ["vested", "vestedIn", "vestedInto"], path), `${path}.vested`);
  const unbounded = flag(book, ["capacityIsUnbounded", "kappaIsUnbounded"]);
  const capacity = asUnboundedOr(requirePresent(book, ["capacity"], path), `${path}.capacity`, unbounded);
  const headroom = hasKey(book, ["headroom"])
    ? asUnboundedOr(book["headroom"], `${path}.headroom`, unbounded || isUnbounded(capacity))
    : deriveHeadroom(capacity, vested);
  return {
    index: optional(pick(book, ["outcome", "index", "outcomeIndex"]), asNumber, `${path}.index`) ?? position,
    label: optional(pick(book, ["label", "name", "outcomeLabel"]), asString, `${path}.label`),
    principal,
    vested,
    capacity,
    headroom,
  };
}

/** The settler clamps at zero rather than underflowing, so the derivation does too. */
function deriveHeadroom(capacity: bigint, vested: bigint): bigint {
  if (isUnbounded(capacity)) return UNBOUNDED;
  return capacity > vested ? capacity - vested : 0n;
}

const PPM = 1_000_000;

export function normalizeOdds(raw: unknown): OddsRow[] {
  if (raw === null || raw === undefined) return [];
  const rows = Array.isArray(raw)
    ? raw
    : asArray(require_(asObject(raw, "impliedOdds"), ["outcomes", "odds", "rows"], "impliedOdds"), "impliedOdds.outcomes");
  return rows.map((row, position) => {
    const path = `impliedOdds[${position}]`;
    const entry = asObject(row, path);
    return {
      index: optional(pick(entry, ["outcome", "index", "outcomeIndex"]), asNumber, `${path}.index`) ?? position,
      label: optional(pick(entry, ["label", "name"]), asString, `${path}.label`),
      impliedProbability: readProbability(entry, path),
    };
  });
}

/**
 * The client reports probability in parts per million, as an integer, because that is
 * what the settler's arithmetic produces. Other sources report a percent or a fraction;
 * each is read by its own name rather than guessed at from its magnitude, since 0.5 is a
 * plausible fraction AND a plausible percentage.
 */
function readProbability(entry: Record<string, unknown>, path: string): number {
  const ppm = pick(entry, ["probabilityPpm", "impliedProbabilityPpm"]);
  if (ppm !== undefined) return Number(asAmount(ppm, `${path}.probabilityPpm`)) / PPM;

  const percent = pick(entry, ["probabilityPercent", "impliedProbabilityPercent"]);
  if (percent !== undefined) return asNumber(percent, `${path}.probabilityPercent`) / 100;

  const fraction = asNumber(
    require_(entry, ["impliedProbability", "probability", "implied", "p"], path),
    `${path}.impliedProbability`,
  );
  // A bare "probability" above 1 can only have been a percentage.
  return fraction > 1 ? fraction / 100 : fraction;
}

export function normalizeHeadroomPick(raw: unknown): HeadroomPick | undefined {
  if (raw === null || raw === undefined) return undefined;
  const source = asObject(raw, "bestHeadroom");
  // The client answers with { best, outcomes, frozen }, and `best: null` is a real
  // answer: the market takes no stake at all right now.
  if (hasKey(source, ["best"])) {
    const best = source["best"];
    if (best === null || best === undefined) return undefined;
    return readHeadroomPick(asObject(best, "bestHeadroom.best"), "bestHeadroom.best");
  }
  return readHeadroomPick(source, "bestHeadroom");
}

function readHeadroomPick(source: Record<string, unknown>, path: string): HeadroomPick {
  return {
    index: asNumber(require_(source, ["outcome", "index", "outcomeIndex"], path), `${path}.outcome`),
    label: optional(pick(source, ["label", "name"]), asString, `${path}.label`),
    // `bindingHeadroom` first: it is the room the OPPOSING books have, which is what
    // rations a stake. An outcome's own headroom would be the wrong number.
    acceptsUpTo: asUnboundedOr(
      requirePresent(source, ["bindingHeadroom", "acceptsUpTo", "headroom", "amount", "capacityLeft"], path),
      `${path}.bindingHeadroom`,
      false,
    ),
  };
}

/**
 * Where a list of wallets hides. `wallets` comes first because on the client's own
 * `sides[]` the key `counterparties` is a COUNT, not a list — which is why every
 * candidate is checked for being an array rather than merely present.
 */
const TRUST_LIST_KEYS = ["wallets", "counterparties", "agents", "entries"] as const;

function pickArray(source: Record<string, unknown>, keys: readonly string[]): unknown[] | undefined {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

export function normalizeTrust(raw: unknown): TrustSummary {
  if (raw === null || raw === undefined) {
    return { counterparties: [], registeredShare: undefined, humanBackedShare: undefined, notes: [] };
  }

  const notes: string[] = [];
  const source = Array.isArray(raw) ? { counterparties: raw } : asObject(raw, "counterpartyTrust");

  // "No reputation source configured" makes every wallet look unrated. Saying so beats
  // reporting 0% registered, which is a different and false claim.
  const reputationUnavailable = flag(source, ["reputationUnavailable"]);
  if (reputationUnavailable) {
    notes.push("The client has no reputation source configured, so every counterparty reads as unrated.");
  }

  const counterparties = hasKey(source, ["sides"])
    ? readSides(asArray(source["sides"], "counterpartyTrust.sides"))
    : readFlatCounterparties(source);

  const shares = shareOf(counterparties);
  return {
    counterparties,
    registeredShare: reputationUnavailable
      ? undefined
      : optional(pick(source, ["registeredShare", "identifiedShare"]), asNumber, "counterpartyTrust.registeredShare") ??
        shares.registered,
    humanBackedShare: optional(pick(source, ["humanBackedShare", "verifiedShare"]), asNumber, "counterpartyTrust.humanBackedShare"),
    notes,
  };
}

/**
 * `sides[o]` is "who is against you if you take outcome o", so every wallet in the market
 * appears once per side it is not on, with its principal summed over the other outcomes.
 * Folding them into one list of wallets means keeping each wallet's largest entry.
 *
 * In a binary market a side's wallets are exactly the holders of the other outcome, so
 * the outcome is recoverable and worth reporting. Beyond two outcomes it is not: a side's
 * entry aggregates several books, and inventing an outcome for it would be a guess.
 */
function readSides(sides: readonly unknown[]): Counterparty[] {
  const binary = sides.length === 2;
  const byWallet = new Map<string, Counterparty>();

  sides.forEach((rawSide, position) => {
    const sidePath = `counterpartyTrust.sides[${position}]`;
    const side = asObject(rawSide, sidePath);
    const outcome = optional(pick(side, ["outcome", "index"]), asNumber, `${sidePath}.outcome`);
    const held = binary && outcome !== undefined ? 1 - outcome : undefined;
    const wallets = pickArray(side, TRUST_LIST_KEYS) ?? [];

    wallets.forEach((entry, walletPosition) => {
      const party = readCounterparty(entry, `${sidePath}.wallets[${walletPosition}]`, held);
      const existing = byWallet.get(party.wallet);
      if (existing === undefined || (party.stake ?? 0n) > (existing.stake ?? 0n)) byWallet.set(party.wallet, party);
    });
  });

  return [...byWallet.values()].sort((a, b) => {
    const left = a.stake ?? 0n;
    const right = b.stake ?? 0n;
    if (left === right) return a.wallet.localeCompare(b.wallet);
    return left > right ? -1 : 1;
  });
}

function readFlatCounterparties(source: Record<string, unknown>): Counterparty[] {
  const list = pickArray(source, TRUST_LIST_KEYS);
  if (list === undefined) {
    // Neither shape matched. Better a named failure than "0 counterparties", which is a
    // statement about the other side of a trade and would be false.
    throw badUpstreamData("counterpartyTrust.sides", `one of [sides, ${TRUST_LIST_KEYS.join(", ")}]`, source);
  }
  return list.map((entry, position) =>
    readCounterparty(entry, `counterpartyTrust.counterparties[${position}]`, undefined),
  );
}

function readCounterparty(raw: unknown, path: string, outcome: number | undefined): Counterparty {
  const record = asObject(raw, path);
  const sharePpm = pick(record, ["sharePpm"]);
  return {
    wallet: normalizeAddress(asString(require_(record, ["wallet", "address", "owner", "id"], path), `${path}.wallet`)),
    outcome: optional(pick(record, ["outcome", "outcomeIndex"]), asNumber, `${path}.outcome`) ?? outcome,
    stake: optional(pick(record, ["principal", "stake", "accepted"]), asAmount, `${path}.stake`),
    share:
      sharePpm === undefined
        ? optional(pick(record, ["share"]), asNumber, `${path}.share`)
        : Number(asAmount(sharePpm, `${path}.sharePpm`)) / PPM,
    agentId: optional(pick(record, ["agentId", "erc8004Id", "identityId"]), asIdString, `${path}.agentId`),
    humanBacked: optional(pick(record, ["humanBacked", "agentBookVerified", "verifiedHuman"]), asFlag, `${path}.humanBacked`),
    feedbackCount: optional(pick(record, ["feedbackCount", "feedback", "reviews"]), asNumber, `${path}.feedbackCount`),
    score: optional(pick(record, ["meanScore", "score", "averageScore", "reputation"]), asNumber, `${path}.score`),
  };
}

/** Principal-weighted share of the wallets the registry knows. */
function shareOf(counterparties: readonly Counterparty[]): { registered: number | undefined } {
  let total = 0n;
  let registered = 0n;
  for (const party of counterparties) {
    const stake = party.stake ?? 0n;
    total += stake;
    if (party.agentId !== undefined) registered += stake;
  }
  return { registered: total === 0n ? undefined : Number(registered) / Number(total) };
}

export function normalizeVesting(raw: unknown, positionId: string): VestingEarned {
  const source = asObject(raw, "vestingEarned");
  // `earned` is null until the vintage finalizes, because `accepted` is not fixed before
  // then. That is "not known yet", which is not zero.
  const earned = requirePresent(source, ["earned", "vested", "vestingEarned"], "vestingEarned");
  return {
    positionId: String(pick(source, ["positionId", "id"]) ?? positionId),
    accepted: optional(pick(source, ["accepted", "principal"]), asAmount, "vestingEarned.accepted") ?? 0n,
    vested: earned === null ? undefined : asAmount(earned, "vestingEarned.earned"),
    previewPayout: optional(
      pick(source, ["payoutIfOutcomeWins", "previewPayout", "payoutIfResolvedNow"]),
      asAmount,
      "vestingEarned.previewPayout",
    ),
  };
}

const CLAIM_KINDS: readonly ClaimKind[] = ["payout", "refund", "void_refund", "residue"];

/** The settler functions that pay, as the client names them. */
const CALL_NAMES = ["claim", "withdrawRefund", "claimResidue"] as const;

function normalizeClaimKind(value: unknown, path: string): ClaimKind {
  if (value === undefined || value === null) return "unknown";
  const lower = asString(value, path).trim().toLowerCase().replace(/[\s-]/g, "_");
  if ((CLAIM_KINDS as readonly string[]).includes(lower)) return lower as ClaimKind;
  if (lower === "voidrefund" || lower === "void") return "void_refund";
  if (lower === "refused" || lower === "remainder" || lower === "refused_remainder") return "refund";
  if (lower === "winnings" || lower === "settlement") return "payout";
  return "unknown";
}

/** Only a call this server can spell a signature for is echoed back. */
function normalizeCallName(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const name = asString(value, path).trim();
  return CALL_NAMES.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

/**
 * Which reason the money is owed for, from the per-reason breakdown the client attaches
 * to each call. `claim` pays a settlement and any outstanding refused remainder in one
 * transaction, so the settlement is checked first: that is what the item is for.
 */
function kindFromBreakdown(raw: unknown, path: string): ClaimKind | undefined {
  if (raw === null || raw === undefined) return undefined;
  const breakdown = asObject(raw, path);
  const nonZero = (key: string): boolean => {
    const value = breakdown[key];
    return value !== undefined && value !== null && asAmount(value, `${path}.${key}`) > 0n;
  };
  if (nonZero("settlement")) return "payout";
  if (nonZero("voidRefund")) return "void_refund";
  if (nonZero("residue")) return "residue";
  if (nonZero("refusedRemainder")) return "refund";
  return undefined;
}

function kindFromCall(call: string | undefined): ClaimKind | undefined {
  if (call === "withdrawRefund") return "refund";
  if (call === "claimResidue") return "residue";
  // `claim` pays a settlement or a void refund and the two are indistinguishable from
  // the call alone, so the breakdown decides; "payout" is the honest default.
  if (call === "claim") return "payout";
  return undefined;
}

export function normalizeClaimable(raw: unknown, wallet: string): ClaimableSummary {
  const normalizedWallet = normalizeAddress(wallet);
  if (raw === null || raw === undefined) {
    return { wallet: normalizedWallet, total: 0n, items: [] };
  }
  const source = Array.isArray(raw) ? { items: raw } : asObject(raw, "claimable");
  const listRaw = pick(source, ["items", "claims", "claimable", "positions", "entries"]);
  const list = listRaw === undefined ? [] : asArray(listRaw, "claimable.items");
  const items: ClaimableItem[] = list.map((entry, position) => {
    const path = `claimable.items[${position}]`;
    const record = asObject(entry, path);
    const callName = normalizeCallName(pick(record, ["call", "method", "function"]), `${path}.call`);
    // A source that names the kind is believed; the client does not, and its breakdown
    // says which reason the money is owed for far more precisely than a label would.
    const declaredKind = normalizeClaimKind(pick(record, ["kind", "type", "reason"]), `${path}.kind`);
    const kind =
      declaredKind !== "unknown"
        ? declaredKind
        : kindFromBreakdown(pick(record, ["breakdown"]), `${path}.breakdown`) ?? kindFromCall(callName) ?? "unknown";
    // Residue is keyed by the market, so its `id` is a market id and must not be read as
    // a position id. Reads take the composite id; writes take `argument`.
    const idAliases = callName === "claimResidue" ? ["positionId", "position"] : ["positionId", "position", "id"];
    return {
      kind,
      amount: asAmount(require_(record, ["amount", "claimable", "value", "payout"], path), `${path}.amount`),
      marketId: optional(pick(record, ["marketId", "market"]), asIdString, `${path}.marketId`),
      positionId: optional(pick(record, idAliases), asIdString, `${path}.positionId`),
      outcome: optional(pick(record, ["outcome", "outcomeIndex"]), asNumber, `${path}.outcome`),
      settler: optional(pick(record, ["settler", "settlerAddress", "contract"]), asString, `${path}.settler`),
      call: callName,
      argument: optional(pick(record, ["argument", "onChainPositionId", "positionIndex"]), asIdString, `${path}.argument`),
    };
  });
  return {
    wallet: normalizedWallet,
    total: declaredTotal(source) ?? items.reduce((sum, item) => sum + item.amount, 0n),
    items,
  };
}

/** `totals.total` is the client's spelling; a flat `total` is everyone else's. */
function declaredTotal(source: Record<string, unknown>): bigint | undefined {
  const flat = optional(pick(source, ["total", "totalClaimable", "sum"]), asAmount, "claimable.total");
  if (flat !== undefined) return flat;
  const totals = pick(source, ["totals"]);
  if (totals === undefined) return undefined;
  return optional(pick(asObject(totals, "claimable.totals"), ["total"]), asAmount, "claimable.totals.total");
}
