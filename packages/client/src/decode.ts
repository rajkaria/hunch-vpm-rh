import type { Address, Hex } from 'viem';
import { getAddress } from 'viem';
import type {
  AgentReputation,
  Book,
  FeedDirection,
  IndexStatus,
  Market,
  MarketStatus,
  Position,
  ResolutionSpec,
  SettlerKind,
} from './types.js';
import type { AgentIdentityField } from './queries.js';

/**
 * Raw GraphQL response shapes, and the conversion into the entity types.
 *
 * Everything arrives as a string, and every numeric field is decoded with an
 * explicit width in mind: token amounts and accumulators become `bigint`, small
 * counts become `number`, and a `BigDecimal` becomes a `number` only where a
 * float is the honest type for it (a mean score), never for money.
 *
 * The schema's enums are SCREAMING_CASE and this package's are not, because a
 * `MarketStatus` of `'Open'` reads better in application code than `'OPEN'`.
 * The mapping is spelled out below rather than case-folded, so a value the
 * schema grows later fails loudly here instead of being waved through.
 */

export class DecodeError extends Error {
  constructor(field: string, value: unknown) {
    super(`cannot decode ${field} from ${JSON.stringify(value) ?? String(value)}`);
    this.name = 'DecodeError';
  }
}

export function bigIntFrom(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new DecodeError(field, value);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new DecodeError(field, value);
}

export function intFrom(value: unknown, field: string): number {
  const asBigInt = bigIntFrom(value, field);
  if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER) || asBigInt < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new DecodeError(field, value);
  }
  return Number(asBigInt);
}

export function boolFrom(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  throw new DecodeError(field, value);
}

export function stringFrom(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new DecodeError(field, value);
}

const DECIMAL = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

/**
 * A `BigDecimal` kept as its exact decimal string. Nothing is parsed, so
 * nothing is lost; a caller that wants arithmetic can choose its own precision.
 */
export function decimalStringFrom(value: unknown, field: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const raw = stringFrom(value, field);
  if (!DECIMAL.test(raw)) throw new DecodeError(field, value);
  return raw;
}

/**
 * A `BigDecimal` as a JS number. Only for values that are inherently
 * approximate — a mean feedback score on a 0..100 scale — never for an amount.
 */
export function decimalFrom(value: unknown, field: string): number {
  const parsed = Number(decimalStringFrom(value, field));
  if (!Number.isFinite(parsed)) throw new DecodeError(field, value);
  return parsed;
}

/** Checksums on the way in, so two reads of the same wallet are `===`. */
export function addressFrom(value: unknown, field: string): Address {
  const raw = stringFrom(value, field);
  try {
    return getAddress(raw);
  } catch {
    throw new DecodeError(field, value);
  }
}

function optionalAddressFrom(value: unknown, field: string): Address | null {
  return value === null || value === undefined ? null : addressFrom(value, field);
}

export function hexFrom(value: unknown, field: string): Hex {
  const raw = stringFrom(value, field);
  if (!/^0x[0-9a-fA-F]*$/.test(raw)) throw new DecodeError(field, value);
  return raw as Hex;
}

/** Address comparison. Subgraph filters are lowercase; our entities are checksummed. */
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Subgraph `where:` clauses match Bytes and entity ids literally, lowercase. */
export function addressFilter(address: string): string {
  return address.toLowerCase();
}

function statusFrom(value: unknown): MarketStatus {
  if (value === 'OPEN') return 'Open';
  if (value === 'RESOLVED') return 'Resolved';
  if (value === 'VOIDED') return 'Voided';
  throw new DecodeError('market.status', value);
}

function settlerKindFrom(value: unknown): SettlerKind {
  if (value === 'VESTED') return 'vested';
  if (value === 'CLASSIC') return 'classic';
  throw new DecodeError('market.settlerKind', value);
}

function directionFrom(value: unknown): FeedDirection {
  if (value === 'ABOVE') return 'above';
  if (value === 'BELOW') return 'below';
  throw new DecodeError('market.direction', value);
}

/**
 * `null` is this package's representation of an unbounded capacity.
 *
 * The index spells unbounded as `-1` and flags it with a companion boolean,
 * rather than passing `2^256-1` through to a consumer that might render it as
 * 1.16e77. The boolean is the thing to branch on: a negative amount without it
 * is a contradiction — capacity is never negative — so it is rejected instead
 * of being carried into a subtraction that would quietly report zero headroom.
 */
function unboundedOrValue(value: unknown, unbounded: unknown, field: string): bigint | null {
  if (boolFrom(unbounded, `${field}IsUnbounded`)) return null;
  const amount = bigIntFrom(value, field);
  if (amount < 0n) throw new DecodeError(field, value);
  return amount;
}

export interface RawMeta {
  block?: { number?: unknown } | null;
  hasIndexingErrors?: unknown;
}

export function decodeMeta(raw: RawMeta | null | undefined): IndexStatus {
  return {
    block: raw?.block?.number === undefined ? 0n : bigIntFrom(raw.block.number, '_meta.block.number'),
    hasIndexingErrors: raw?.hasIndexingErrors === true,
  };
}

export type RawRecord = Record<string, unknown>;

function field(raw: RawRecord, name: string): unknown {
  return raw[name];
}

function optionalBigIntFrom(value: unknown, name: string): bigint | null {
  return value === null || value === undefined ? null : bigIntFrom(value, name);
}

/**
 * The resolution spec, which the schema flattens onto `Market` rather than
 * nesting. Every field is registered in the same transaction as the market, so
 * `specId` is enough to tell "registered" from "opened directly on a settler
 * with no spec at all"; if it is there, the rest has to be there too.
 */
export function decodeSpec(market: RawRecord): ResolutionSpec | null {
  const specId = field(market, 'specId');
  if (specId === null || specId === undefined) return null;
  return {
    specId: hexFrom(specId, 'market.specId'),
    oracle: addressFrom(field(market, 'oracle'), 'market.oracle'),
    feedKey: hexFrom(field(market, 'feedKey'), 'market.feedKey'),
    strike: bigIntFrom(field(market, 'strike'), 'market.strike'),
    direction: directionFrom(field(market, 'direction')),
    maxStaleness: bigIntFrom(field(market, 'maxStaleness'), 'market.maxStaleness'),
  };
}

/**
 * The market's open vintage, reduced to what a staking decision needs.
 *
 * `offers` is `null` when the vintage could not be read whole — more entries
 * than one page holds, or a total that does not add up. An understated demand
 * overstates the room, which is the one direction this client must not be
 * wrong in, so it reports nothing rather than a lower bound.
 */
interface OpenVintage {
  open: boolean;
  block: bigint | null;
  offers: { offered: bigint; byOutcome: Map<number, bigint> } | null;
}

function decodeOpenVintage(market: RawRecord): { read: boolean; vintage: OpenVintage } {
  if (!('openVintage' in market)) {
    return { read: false, vintage: { open: false, block: null, offers: null } };
  }
  const raw = field(market, 'openVintage');
  if (raw === null || raw === undefined) {
    return { read: true, vintage: { open: false, block: null, offers: { offered: 0n, byOutcome: new Map() } } };
  }

  const vintage = raw as RawRecord;
  const block = bigIntFrom(field(vintage, 'block'), 'openVintage.block');
  const offered = bigIntFrom(field(vintage, 'offered'), 'openVintage.offered');
  const entryCount = bigIntFrom(field(vintage, 'entryCount'), 'openVintage.entryCount');
  const entries = field(vintage, 'entries');
  if (!Array.isArray(entries)) throw new DecodeError('openVintage.entries', entries);

  const byOutcome = new Map<number, bigint>();
  let seen = 0n;
  for (const rawEntry of entries) {
    const entry = rawEntry as RawRecord;
    const outcome = intFrom(field(entry, 'outcome'), 'openVintage.entries.outcome');
    const amount = bigIntFrom(field(entry, 'offered'), 'openVintage.entries.offered');
    byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0n) + amount);
    seen += amount;
  }

  const whole = BigInt(entries.length) === entryCount && seen === offered;
  return { read: true, vintage: { open: true, block, offers: whole ? { offered, byOutcome } : null } };
}

/**
 * D_w: an entry offering `c` on outcome `o` is demand `c` against every book
 * except `o`, so the demand on book `w` is the vintage total less what was
 * offered on `w` itself.
 */
function demandFor(vintage: OpenVintage, outcome: number): bigint | null {
  if (vintage.offers === null) return null;
  return vintage.offers.offered - (vintage.offers.byOutcome.get(outcome) ?? 0n);
}

function decodeBook(raw: unknown, kappaUnbounded: boolean, vintage: OpenVintage): Book {
  const book = raw as RawRecord;
  const outcome = intFrom(field(book, 'outcome'), 'book.outcome');
  return {
    outcome,
    principal: bigIntFrom(field(book, 'principal'), 'book.principal'),
    vested: bigIntFrom(field(book, 'vested'), 'book.vested'),
    // A market with unbounded kappa has unbounded capacity on every book, and
    // the index flags both. Either signal is enough.
    capacity: kappaUnbounded
      ? null
      : unboundedOrValue(field(book, 'capacity'), field(book, 'capacityIsUnbounded'), 'book.capacity'),
    acc: bigIntFrom(field(book, 'acc'), 'book.acc'),
    demand: demandFor(vintage, outcome),
  };
}

export function decodeMarket(raw: unknown): Market {
  if (raw === null || raw === undefined) throw new DecodeError('market', raw);
  const market = raw as RawRecord;
  const kappa = unboundedOrValue(field(market, 'kappa'), field(market, 'kappaIsUnbounded'), 'market.kappa');
  const status = statusFrom(field(market, 'status'));
  const books = field(market, 'books');
  if (!Array.isArray(books)) throw new DecodeError('market.books', books);
  const { read, vintage } = decodeOpenVintage(market);

  return {
    id: stringFrom(field(market, 'id'), 'market.id'),
    settler: addressFrom(field(market, 'settler'), 'market.settler'),
    settlerKind: settlerKindFrom(field(market, 'settlerKind')),
    marketId: bigIntFrom(field(market, 'marketId'), 'market.marketId'),
    token: addressFrom(field(market, 'token'), 'market.token'),
    creator: addressFrom(field(market, 'creator'), 'market.creator'),
    // Null for a market created directly on a settler rather than through the
    // factory, which is the one case where `creator` is already a wallet.
    opener: optionalAddressFrom(field(market, 'opener'), 'market.opener'),
    resolver: addressFrom(field(market, 'resolver'), 'market.resolver'),
    residueOwner: addressFrom(field(market, 'residueOwner'), 'market.residueOwner'),
    outcomeCount: intFrom(field(market, 'n'), 'market.n'),
    kappa,
    createdAt: bigIntFrom(field(market, 'createdAt'), 'market.createdAt'),
    resolutionTime: bigIntFrom(field(market, 'resolutionTime'), 'market.resolutionTime'),
    voidTimeout: bigIntFrom(field(market, 'voidTimeout'), 'market.voidTimeout'),
    status,
    // The winner slot is null until a market resolves, and 0 is a valid
    // outcome, so only a resolved market has a winner to report.
    winner: status === 'Resolved' ? intFrom(field(market, 'winner'), 'market.winner') : null,
    acceptedPool: bigIntFrom(field(market, 'acceptedPool'), 'market.acceptedPool'),
    paidOut: bigIntFrom(field(market, 'paidOut'), 'market.paidOut'),
    residue: bigIntFrom(field(market, 'residue'), 'market.residue'),
    residueClaimed: boolFrom(field(market, 'residueClaimed'), 'market.residueClaimed'),
    resolvedPrice: optionalBigIntFrom(field(market, 'resolvedPrice'), 'market.resolvedPrice'),
    priceUpdatedAt: optionalBigIntFrom(field(market, 'priceUpdatedAt'), 'market.priceUpdatedAt'),
    voidedStaleAge: optionalBigIntFrom(field(market, 'voidedStaleAge'), 'market.voidedStaleAge'),
    vintageOpen: read ? vintage.open : null,
    vintageBlock: vintage.block,
    books: books.map((book) => decodeBook(book, kappa === null, vintage)).sort((a, b) => a.outcome - b.outcome),
    spec: decodeSpec(market),
  };
}

/** `owner` is an `Agent` relation whose id is the wallet address. */
function ownerFrom(raw: RawRecord, path: string): Address {
  const owner = field(raw, 'owner');
  if (owner === null || owner === undefined) throw new DecodeError(path, owner);
  return addressFrom(field(owner as RawRecord, 'id'), `${path}.id`);
}

export function decodePosition(raw: unknown): Position {
  if (raw === null || raw === undefined) throw new DecodeError('position', raw);
  const position = raw as RawRecord;
  const vintage = field(position, 'vintage');
  return {
    id: stringFrom(field(position, 'id'), 'position.id'),
    positionId: bigIntFrom(field(position, 'positionId'), 'position.positionId'),
    owner: ownerFrom(position, 'position.owner'),
    outcome: intFrom(field(position, 'outcome'), 'position.outcome'),
    offered: bigIntFrom(field(position, 'offered'), 'position.offered'),
    accepted: bigIntFrom(field(position, 'accepted'), 'position.accepted'),
    refused: bigIntFrom(field(position, 'refused'), 'position.refused'),
    entryAcc: bigIntFrom(field(position, 'entryAcc'), 'position.entryAcc'),
    // Null on a CLASSIC position: nothing there is batched by block.
    vintage:
      vintage === null || vintage === undefined
        ? null
        : bigIntFrom(field(vintage as RawRecord, 'block'), 'position.vintage.block'),
    finalized: boolFrom(field(position, 'finalized'), 'position.finalized'),
    refundWithdrawn: boolFrom(field(position, 'refundWithdrawn'), 'position.refundWithdrawn'),
    claimed: boolFrom(field(position, 'claimed'), 'position.claimed'),
    previewPayout: bigIntFrom(field(position, 'previewPayout'), 'position.previewPayout'),
    market: decodeMarket(field(position, 'market')),
  };
}

/** A holder of principal on a market, as returned by the positions query. */
export interface PositionHolding {
  id: string;
  positionId: bigint;
  owner: Address;
  outcome: number;
  accepted: bigint;
}

export function decodeHolding(raw: unknown): PositionHolding {
  const position = raw as RawRecord;
  return {
    id: stringFrom(field(position, 'id'), 'position.id'),
    positionId: bigIntFrom(field(position, 'positionId'), 'position.positionId'),
    owner: ownerFrom(position, 'position.owner'),
    outcome: intFrom(field(position, 'outcome'), 'position.outcome'),
    accepted: bigIntFrom(field(position, 'accepted'), 'position.accepted'),
  };
}

/** A winning position a resolved market is still waiting on. */
export interface UnclaimedWinner {
  id: string;
  positionId: bigint;
  /** What `claim` will pay it out of the pool. */
  previewPayout: bigint;
}

export function decodeUnclaimedWinner(raw: unknown): UnclaimedWinner {
  const position = raw as RawRecord;
  return {
    id: stringFrom(field(position, 'id'), 'position.id'),
    positionId: bigIntFrom(field(position, 'positionId'), 'position.positionId'),
    previewPayout: bigIntFrom(field(position, 'previewPayout'), 'position.previewPayout'),
  };
}

/**
 * One ERC-8004 identity.
 *
 * `identity` says which of the agent's two addresses the lookup matched, and
 * becomes the `address` this reputation is filed under, because that is the
 * address the venue saw staking.
 */
export function decodeAgent(raw: unknown, identity: AgentIdentityField = 'agentWallet'): AgentReputation {
  const agent = raw as RawRecord;
  const agentId = field(agent, 'agentId');
  // The registry's aggregates are over non-revoked feedback only, so the count
  // that belongs next to the mean is the active one.
  const feedbackCount = intFrom(field(agent, 'activeFeedbackCount'), 'agent.activeFeedbackCount');
  return {
    address: addressFrom(field(agent, identity), `agent.${identity}`),
    owner: addressFrom(field(agent, 'owner'), 'agent.owner'),
    agentWallet: optionalAddressFrom(field(agent, 'agentWallet'), 'agent.agentWallet'),
    agentId: agentId === undefined || agentId === null ? null : bigIntFrom(agentId, 'agent.agentId'),
    feedbackCount,
    scoreSum: decimalStringFrom(field(agent, 'scoreSum'), 'agent.scoreSum'),
    // An identity with no live feedback is registered but unrated, which is a
    // different statement from "scores badly" and is reported as such. The
    // registry's own averageScore is 0 in that case, not null.
    meanScore: feedbackCount === 0 ? null : decimalFrom(field(agent, 'averageScore'), 'agent.averageScore'),
  };
}
