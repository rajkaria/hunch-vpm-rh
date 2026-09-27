import type { ResolvedConfig } from '../config.js';
import { bookHeadroom, outcomeHeadroom } from '../mechanics.js';
import type { BookView, MarketBook } from '../types.js';
import { maxBigInt } from '../units.js';
import { fetchMarket, fetchUnclaimedWinners, headBlock, nowSeconds } from './shared.js';
import { impliedOddsFor } from './impliedOdds.js';

export interface MarketBookOptions {
  /** Evaluate as of this instant (unix seconds) instead of now. */
  now?: bigint;
}

/**
 * The whole market in one read: what is backing each outcome, how much room
 * each still has, what the money implies about the odds, when it freezes and
 * what it resolves against.
 *
 * This is the only read here that is a table rather than a decision. It exists
 * because a UI needs one, and because an agent that disagrees with the
 * client's reduction should be able to see the inputs.
 */
export async function marketBook(
  config: ResolvedConfig,
  marketId: string,
  options: MarketBookOptions = {},
): Promise<MarketBook> {
  const { market, index } = await fetchMarket(config, marketId);
  const at = nowSeconds(options.now);
  const odds = impliedOddsFor(market);

  // The residue gate only decides anything on the winning book of a resolved
  // market, so that is the only place it is worth a second round trip. A market
  // whose residue has already been swept needs none at all: the settler refuses
  // to release residue until the count reaches 0, and it never rises again once
  // the market has resolved.
  const winner = market.status === 'Resolved' ? market.winner : null;
  let live: number | null = null;
  if (winner !== null) {
    live = market.residueClaimed ? 0 : (await fetchUnclaimedWinners(config, market.id, winner)).count;
  }

  const books: BookView[] = market.books.map((book) => {
    const oddsForOutcome = odds.outcomes.find((entry) => entry.outcome === book.outcome);
    const room = outcomeHeadroom(market, book.outcome, headBlock(index));
    return {
      outcome: book.outcome,
      principal: book.principal,
      vested: book.vested,
      capacity: book.capacity,
      headroom: bookHeadroom(book),
      probabilityPpm: oddsForOutcome?.probabilityPpm ?? 0n,
      probabilityPercent: oddsForOutcome?.probabilityPercent ?? '0.0000',
      decimalOddsPpm: oddsForOutcome?.decimalOddsPpm ?? null,
      maxFullyAccepted: room.maxFullyAccepted,
      acc: book.acc,
      live: book.outcome === winner ? live : null,
    };
  });

  return {
    marketId: market.id,
    settler: market.settler,
    settlerKind: market.settlerKind,
    onChainMarketId: market.marketId,
    token: market.token,
    status: market.status,
    winner: market.winner,
    kappa: market.kappa,
    acceptedPool: market.acceptedPool,
    paidOut: market.paidOut,
    // The index's own figure: 0 until the market resolves, and still an upper
    // bound until the last winner claims. `claimable` is where it gets priced
    // exactly, because that needs a walk over the outstanding winners.
    residue: market.residue,
    residueOwner: market.residueOwner,
    residueClaimed: market.residueClaimed,
    // The other end of the arrival window. A reader that has to judge how much
    // of that window is left cannot derive this from anything else here.
    createdAt: market.createdAt,
    resolutionTime: market.resolutionTime,
    secondsToFreeze: maxBigInt(0n, market.resolutionTime - at),
    frozen: at >= market.resolutionTime,
    voidTimeout: market.voidTimeout,
    voidableFrom: market.resolutionTime + market.voidTimeout,
    books,
    spec: market.spec,
    resolvedPrice: market.resolvedPrice,
    priceUpdatedAt: market.priceUpdatedAt,
    voidedStaleAge: market.voidedStaleAge,
    index,
  };
}
