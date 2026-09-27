import type { Address } from 'viem';
import type { HunchClient } from '../client.js';
import type { BestHeadroom, IndexStatus, MarketBook, MarketStatus, SettlerKind } from '../types.js';
import { formatUsdc, shareToPpm } from '../units.js';
import type { Acceptance, BookAcceptance } from './acceptance.js';
import { acceptanceOf } from './acceptance.js';
import { ARC_RAIL } from './capabilities.js';
import type { SideMap } from './sides.js';
import type {
  QuoteAcceptance,
  RailPayoutPreview,
  RailQuote,
  RailRefusal,
  RailSide,
} from './types.js';

/** The settler packs a position's amounts into uint128 fields and reverts above that. */
const UINT128_MAX = 2n ** 128n - 1n;

/**
 * A quote on an Arc market.
 *
 * The answer to "what would this stake get" here is not a price. Every unit of
 * it is either accepted — in which case it vests into the opposing books
 * immediately and is someone else's counterparty — or refused for want of
 * headroom and handed back. `accepted`, `refused` and the book that decided
 * between them are the quote; the payout preview is what the accepted part is
 * worth if the market settles with no further entries.
 */
export interface ArcQuote extends RailQuote {
  readonly rail: 'arc';
  /** Echo of the side the caller named, before it was resolved to an index. */
  readonly side: RailSide;
  readonly label: string | null;
  readonly settler: Address;
  readonly settlerKind: SettlerKind;
  readonly onChainMarketId: bigint;
  readonly token: Address;
  readonly status: MarketStatus;
  /** True once the market takes no further stake. */
  readonly closed: boolean;
  readonly secondsToClose: bigint;

  /** The opposing book that cut the offer, or `null` when nothing did. */
  readonly binding: BookAcceptance | null;
  /** What every opposing book would let through of this offer, in outcome order. */
  readonly books: readonly BookAcceptance[];
  /** The largest offer taken whole right now. `null` when capacity is unbounded. */
  readonly maxFullyAccepted: bigint | null;
  /**
   * What the settler pulls from the wallet if this is sent: the WHOLE offer,
   * including the part that will be refused. The refused part comes back by
   * pull, not automatically.
   */
  readonly escrowed: bigint;
  readonly refund: {
    readonly amount: bigint;
    /** The settler call that pays it back, or `null` when there is nothing to pull. */
    readonly call: 'withdrawRefund' | null;
    readonly availableWhen: string;
  };
  /**
   * Where the accepted stake goes the moment it lands. On a vested market it is
   * assigned in full to every opposing book at once, which is exactly why those
   * books' headroom is what limits it.
   */
  readonly vestsInto: readonly { readonly outcome: number; readonly amount: bigint }[];
  /** Implied probability of this outcome before and after the accepted stake lands. */
  readonly probabilityPpm: { readonly before: bigint; readonly after: bigint };
  /** True when stake queued in the current block could not be read. */
  readonly demandUnknown: boolean;
  /** The index block this was computed against. A later block can change the answer. */
  readonly quotedAtBlock: bigint;
  readonly index: IndexStatus;
  /** Plain-language statements about this quote that a caller should not have to derive. */
  readonly notes: readonly string[];
}

function assertStake(amount: bigint): bigint {
  if (typeof amount !== 'bigint') throw new TypeError(`stake must be a bigint of smallest units, got ${typeof amount}`);
  if (amount <= 0n) throw new RangeError(`stake must be positive, got ${amount}`);
  if (amount > UINT128_MAX) throw new RangeError(`stake out of range: ${amount}`);
  return amount;
}

/**
 * What the accepted stake pays if the market settles right now, under whichever
 * rule this market runs.
 *
 * On a VESTED market a new position is paid its accepted principal plus what
 * has vested into its book SINCE it entered — and nothing has, because entries
 * record the accumulator after their own vintage is applied and same-vintage
 * entries never vest to each other. So the honest number at the moment of the
 * quote is the principal itself. The upside is entirely stake that arrives on
 * the other side afterwards, which is the mechanism, not a caveat.
 *
 * On a CLASSIC market the winner takes a pro-rata share of the whole pool,
 * `floor(pool * stake / winningPrincipal)`, so the stake changes both sides of
 * that fraction.
 */
function payoutPreview(book: MarketBook, outcome: number, accepted: bigint): RailPayoutPreview {
  // A void refunds accepted principal exactly, on either settler. No vesting is
  // paid and no pool is shared.
  const voided = accepted;
  if (book.settlerKind === 'classic') {
    const principal = book.books.find((entry) => entry.outcome === outcome)?.principal ?? 0n;
    const winning = principal + accepted;
    const pool = book.acceptedPool + accepted;
    return { wins: winning === 0n ? 0n : (pool * accepted) / winning, loses: 0n, voided };
  }
  return { wins: accepted, loses: 0n, voided };
}

function refusalFor(
  status: MarketStatus,
  closed: boolean,
  acceptance: Acceptance | null,
  requested: bigint,
): RailRefusal | null {
  if (status !== 'Open') {
    return {
      kind: 'market-not-open',
      refused: requested,
      detail:
        `this market is ${status.toLowerCase()}; the settler refuses every entry on it. Nothing is ` +
        `escrowed and nothing is refunded, because the transaction does not land.`,
      revertsWith: 'NotOpen',
    };
  }
  if (closed) {
    return {
      kind: 'market-frozen',
      refused: requested,
      detail:
        `this market is past its freeze; entries at or after the resolution time are refused outright. ` +
        `Nothing is escrowed, because the transaction reverts.`,
      revertsWith: 'Frozen',
    };
  }
  if (acceptance === null || acceptance.refused === 0n) return null;
  if (acceptance.books.length === 0) {
    return {
      kind: 'no-counterparty',
      refused: acceptance.refused,
      detail: 'this outcome has no opposing book, so there is nothing for the stake to vest into.',
      revertsWith: null,
    };
  }

  const binding = acceptance.binding;
  const where =
    binding === null
      ? 'the opposing books'
      : `outcome ${binding.outcome}, which has ${formatUsdc(binding.headroom ?? 0n)} of headroom left` +
        (binding.competingDemand > 0n
          ? ` and ${formatUsdc(binding.competingDemand)} already offered against it in this block`
          : '');
  return {
    kind: 'headroom',
    refused: acceptance.refused,
    detail:
      `${formatUsdc(acceptance.refused)} of ${formatUsdc(acceptance.requested)} cannot be covered by ${where}. ` +
      `The whole offer is still pulled from the wallet; the refused part has to be pulled back with ` +
      `withdrawRefund, which is available from the block after the entry lands.`,
    revertsWith: null,
  };
}

function acceptanceLabel(requested: bigint, accepted: bigint): QuoteAcceptance {
  if (accepted === 0n) return 'none';
  return accepted === requested ? 'full' : 'partial';
}

export interface QuoteInputs {
  readonly book: MarketBook;
  readonly headroom: BestHeadroom;
  readonly sides: SideMap;
  readonly side: RailSide;
  readonly outcome: number;
  readonly amount: bigint;
  readonly at: bigint;
}

/** Assemble the answer. Split out from the reads so it can be checked on its own. */
export function quoteFrom(inputs: QuoteInputs): ArcQuote {
  const { book, headroom, sides, side, outcome, amount, at } = inputs;
  const requested = assertStake(amount);
  const closed = headroom.frozen;

  const room = headroom.outcomes.find((entry) => entry.outcome === outcome);
  if (room === undefined) {
    // Otherwise the answer would be "no counterparty", which is a true
    // statement about a market that does not have this outcome at all and a
    // misleading one about why.
    throw new RangeError(
      `outcome ${outcome} does not exist on market ${book.marketId}: it has ${book.books.length} outcomes`,
    );
  }
  const rooms = room.opposing;

  // A market that cannot take an entry at all is not a rationing question: the
  // settler reverts, so nothing is escrowed and nothing comes back.
  const acceptance = closed ? null : acceptanceOf(rooms, requested);
  const refusal = refusalFor(book.status, closed, acceptance, requested);
  const accepted = acceptance?.accepted ?? 0n;
  const refused = requested - accepted;
  const wouldRevert = refusal !== null && refusal.revertsWith !== null;

  const principal = book.books.find((entry) => entry.outcome === outcome)?.principal ?? 0n;
  const opposing = book.books.filter((entry) => entry.outcome !== outcome);

  const vested = book.settlerKind === 'vested';
  const notes: string[] = [];
  if (vested) {
    notes.push(
      'A position is paid its accepted principal plus whatever vests into its book after it enters, so a ' +
        'stake that wins the instant it lands is paid exactly what was accepted. The return comes from ' +
        'stake that arrives on the other side later.',
    );
    if (accepted > 0n && opposing.length > 0) {
      notes.push(
        `The accepted ${formatUsdc(accepted)} vests into ${
          opposing.length === 1 ? 'the opposing book' : `all ${opposing.length} opposing books`
        } the moment it lands, and starts paying the wallets already there.`,
      );
    }
  } else {
    notes.push(
      'This is a classic pool: nothing vests, every unit pays the same multiple whenever it arrived, and ' +
        'the winner takes a pro-rata share of the whole pool. Capacity does not bind here, so nothing is ' +
        'refused for want of headroom.',
    );
  }
  if (headroom.demandUnknown) {
    notes.push(
      'Stake queued in the current block could not be read, so this acceptance is an upper bound rather ' +
        'than a guarantee.',
    );
  }
  if (!wouldRevert) {
    notes.push(
      `This answer is computed against index block ${headroom.index.block}. Another entry landing in the ` +
        'same block rations alongside this one and can lower what is accepted.',
    );
  }
  if (headroom.index.hasIndexingErrors) {
    notes.push('The index reports indexing errors, so the books behind this quote may be incomplete.');
  }

  return {
    rail: ARC_RAIL,
    marketId: book.marketId,
    outcome,
    side,
    label: sides.label(outcome),
    requested,
    accepted,
    refused,
    acceptance: acceptanceLabel(requested, accepted),
    refusal,
    payoutIfResolvedNow: payoutPreview(book, outcome, accepted),
    settler: book.settler,
    settlerKind: book.settlerKind,
    onChainMarketId: book.onChainMarketId,
    token: book.token,
    status: book.status,
    closed,
    secondsToClose: book.secondsToFreeze,
    binding: acceptance?.binding ?? null,
    books: acceptance?.books ?? [],
    // `null` is unbounded capacity, which is not the same statement as 0, so a
    // closed market has to be spelled out rather than folded in with `??`.
    maxFullyAccepted: acceptance === null ? 0n : acceptance.maxFullyAccepted,
    escrowed: wouldRevert ? 0n : requested,
    refund: {
      amount: wouldRevert ? 0n : refused,
      call: !wouldRevert && refused > 0n ? 'withdrawRefund' : null,
      availableWhen: wouldRevert
        ? 'nothing is escrowed: the transaction reverts'
        : refused > 0n
          ? 'from the block after the entry lands: withdrawRefund finalizes the entry\'s vintage itself, ' +
            'so nothing else has to be called first'
          : 'nothing is refused, so there is nothing to pull back',
    },
    vestsInto:
      book.settlerKind === 'vested' && accepted > 0n
        ? opposing.map((entry) => ({ outcome: entry.outcome, amount: accepted }))
        : [],
    probabilityPpm: {
      before: shareToPpm(principal, book.acceptedPool),
      after: shareToPpm(principal + accepted, book.acceptedPool + accepted),
    },
    demandUnknown: headroom.demandUnknown,
    quotedAtBlock: headroom.index.block,
    index: book.index,
    notes,
    asOf: at,
  };
}

/**
 * Quote it.
 *
 * Two index reads: the book, for what a position would be paid, and the
 * headroom, for what would be accepted. Both are evaluated at the same instant.
 */
export async function arcQuote(
  client: HunchClient,
  sides: SideMap,
  marketId: string,
  side: RailSide,
  amount: bigint,
  at: bigint,
): Promise<ArcQuote> {
  assertStake(amount);
  const [book, headroom] = await Promise.all([
    client.marketBook(marketId, { now: at }),
    client.bestHeadroom(marketId, { now: at }),
  ]);
  const outcome = sides.resolve(side, book.books.length);
  return quoteFrom({ book, headroom, sides, side, outcome, amount, at });
}
