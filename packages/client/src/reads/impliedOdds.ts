import type { ResolvedConfig } from '../config.js';
import { totalPrincipal } from '../mechanics.js';
import type { ImpliedOdds, Market, OutcomeOdds } from '../types.js';
import { PPM, ppmToPercent, shareToPpm } from '../units.js';
import { fetchMarket } from './shared.js';

/**
 * Implied probability per outcome from ACCEPTED principal.
 *
 * There is no order book here and nothing quotes a price. What an outcome's
 * odds mean is arithmetic on the money that is actually down: an outcome
 * backed by a fifth of the accepted pool is a 20% outcome, and the gross
 * return on a winning unit is the whole pool divided by that outcome's book.
 *
 * Offered-but-refused stake is deliberately excluded — it never became anyone's
 * counterparty and it is refundable, so counting it would read as conviction
 * that does not exist.
 */
export function impliedOddsFor(market: Market): Omit<ImpliedOdds, 'index'> {
  const total = totalPrincipal(market);
  const outcomes: OutcomeOdds[] = market.books.map((book) => {
    const probabilityPpm = shareToPpm(book.principal, total);
    return {
      outcome: book.outcome,
      principal: book.principal,
      probabilityPpm,
      probabilityPercent: ppmToPercent(probabilityPpm),
      // Division-by-zero guard: an outcome nobody backs has no defined return.
      decimalOddsPpm: book.principal === 0n ? null : (total * PPM) / book.principal,
    };
  });

  return {
    marketId: market.id,
    status: market.status,
    totalAccepted: total,
    defined: total > 0n,
    outcomes,
  };
}

export async function impliedOdds(config: ResolvedConfig, marketId: string): Promise<ImpliedOdds> {
  const { market, index } = await fetchMarket(config, marketId);
  return { ...impliedOddsFor(market), index };
}
