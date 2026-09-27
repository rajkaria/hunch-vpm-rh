import type { Address } from 'viem';
import type { HunchClient } from '../client.js';
import type {
  BestHeadroom,
  CounterpartyTrust,
  IndexStatus,
  MarketBook,
  OutcomeHeadroom,
  SettlerKind,
} from '../types.js';
import { formatPrice } from '../units.js';
import { ARC_RAIL } from './capabilities.js';
import type { SideMap } from './sides.js';
import type {
  RailCounterparty,
  RailHeadroom,
  RailOutcome,
  RailResearch,
  RailResolution,
} from './types.js';

/**
 * Research on an Arc market: everything `RailResearch` promises, plus the three
 * things only this venue can answer — how much room each outcome has left, the
 * resolution spec the market is bound to, and how long until it stops taking
 * stake.
 */
export interface ArcResearch extends RailResearch {
  readonly rail: 'arc';
  readonly secondsToClose: bigint;
  readonly headroom: readonly RailHeadroom[];
  readonly resolution: RailResolution;

  /** The settler holding this market, and which settlement rule it runs. */
  readonly settler: Address;
  readonly settlerKind: SettlerKind;
  /** The settler's own market index, which is what a transaction takes. */
  readonly onChainMarketId: bigint;
  /** The settlement asset. */
  readonly token: Address;
  /** The capacity coefficient. `null` when capacity is unbounded. */
  readonly kappa: bigint | null;
  /**
   * True when the client could not read the stake queued in the current block,
   * which makes every `maxFullyAccepted` an upper bound rather than a promise.
   */
  readonly demandUnknown: boolean;
  /** How far behind the chain the index is. */
  readonly index: IndexStatus;
}

function outcomeView(book: MarketBook['books'][number], sides: SideMap): RailOutcome {
  return {
    outcome: book.outcome,
    label: sides.label(book.outcome),
    backing: book.principal,
    probabilityPpm: book.probabilityPpm,
    probabilityPercent: book.probabilityPercent,
    decimalOddsPpm: book.decimalOddsPpm,
  };
}

function headroomView(room: OutcomeHeadroom): RailHeadroom {
  return {
    outcome: room.outcome,
    ownBookHeadroom: room.bookHeadroom,
    bindingHeadroom: room.bindingHeadroom,
    bindingOutcome: room.bindingOutcome,
    maxFullyAccepted: room.maxFullyAccepted,
    competingDemand: room.competingDemand,
    opposing: room.opposing.map((opposing) => ({
      outcome: opposing.outcome,
      headroom: opposing.headroom,
      competingDemand: opposing.competingDemand,
      allowance: opposing.allowance,
    })),
  };
}

/**
 * The resolution terms.
 *
 * A market with a registered spec resolves from a price feed and nothing else:
 * the oracle, the threshold, the direction and the staleness bound are fixed at
 * creation and anyone may call the resolution in once the freeze has passed. A
 * market without one was opened straight onto a settler, and this rail will not
 * pretend to know who decides it.
 */
function resolutionView(book: MarketBook): RailResolution {
  const spec = book.spec;
  if (spec === null) {
    return {
      by: 'unknown',
      resolver: null,
      registered: false,
      oracle: null,
      feedKey: null,
      strike: null,
      strikeDecimal: null,
      direction: null,
      maxStaleness: null,
      voidableFrom: book.voidableFrom,
      resolvedPrice: book.resolvedPrice,
      resolvedPriceDecimal: book.resolvedPrice === null ? null : formatPrice(book.resolvedPrice),
      priceUpdatedAt: book.priceUpdatedAt,
      voidedStaleAge: book.voidedStaleAge,
    };
  }

  return {
    by: 'feed',
    // The index carries the market's resolver on the entity, but `marketBook`
    // does not surface it. What decides the terms is the registered spec below,
    // which is immutable once written.
    resolver: null,
    registered: true,
    oracle: spec.oracle,
    feedKey: spec.feedKey,
    strike: spec.strike,
    strikeDecimal: formatPrice(spec.strike),
    direction: spec.direction,
    maxStaleness: spec.maxStaleness,
    voidableFrom: book.voidableFrom,
    resolvedPrice: book.resolvedPrice,
    resolvedPriceDecimal: book.resolvedPrice === null ? null : formatPrice(book.resolvedPrice),
    priceUpdatedAt: book.priceUpdatedAt,
    voidedStaleAge: book.voidedStaleAge,
  };
}

function counterpartyView(trust: CounterpartyTrust): RailCounterparty {
  return {
    sides: trust.sides.map((side) => ({
      outcome: side.outcome,
      opposingPrincipal: side.opposingPrincipal,
      counterparties: side.counterparties,
      ratedCounterparties: side.ratedCounterparties,
      meanScore: side.meanScore,
      principalWeightedMeanScore: side.principalWeightedMeanScore,
      unratedSharePpm: side.unratedSharePpm,
    })),
    unavailable: trust.reputationUnavailable,
  };
}

export interface ResearchInputs {
  readonly book: MarketBook;
  readonly headroom: BestHeadroom;
  readonly trust: CounterpartyTrust | null;
  readonly sides: SideMap;
  readonly at: bigint;
}

/** Assemble the answer. Split out from the reads so it can be checked on its own. */
export function researchFrom(inputs: ResearchInputs): ArcResearch {
  const { book, headroom, trust, sides, at } = inputs;
  return {
    rail: ARC_RAIL,
    marketId: book.marketId,
    status: book.status,
    closesAt: book.resolutionTime,
    // A resolved or voided market is closed even before its freeze, so this is
    // the headroom read's answer rather than the clock alone.
    closed: headroom.frozen,
    secondsToClose: book.secondsToFreeze,
    outcomes: book.books.map((entry) => outcomeView(entry, sides)),
    // The settler's own Pi: the sum of accepted principal across the books.
    totalAccepted: book.acceptedPool,
    winner: book.winner,
    headroom: headroom.outcomes.map(headroomView),
    resolution: resolutionView(book),
    counterparty: trust === null ? null : counterpartyView(trust),
    settler: book.settler,
    settlerKind: book.settlerKind,
    onChainMarketId: book.onChainMarketId,
    token: book.token,
    kappa: book.kappa,
    demandUnknown: headroom.demandUnknown,
    index: book.index,
    asOf: at,
  };
}

/**
 * Read it.
 *
 * Two index reads by default — the book and the headroom — and two more when
 * `counterparty` is asked for, which walks the market's holders and looks their
 * reputation up. A caching transport collapses the first two into one request.
 */
export async function arcResearch(
  client: HunchClient,
  sides: SideMap,
  marketId: string,
  at: bigint,
  withCounterparty: boolean,
): Promise<ArcResearch> {
  const [book, headroom] = await Promise.all([
    client.marketBook(marketId, { now: at }),
    client.bestHeadroom(marketId, { now: at }),
  ]);
  const trust = withCounterparty ? await client.counterpartyTrust(marketId) : null;
  return researchFrom({ book, headroom, trust, sides, at });
}
