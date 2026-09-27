import type { ResolvedConfig } from '../config.js';
import { outcomeHeadroom } from '../mechanics.js';
import type { BestHeadroom, OutcomeHeadroom } from '../types.js';
import { fetchMarket, headBlock, nowSeconds } from './shared.js';

export interface BestHeadroomOptions {
  /** Evaluate as of this instant (unix seconds) instead of now. */
  now?: bigint;
}

/**
 * `null` is unbounded, which beats every finite number. Ties go to the lower
 * outcome index so the answer is stable between calls.
 */
function isBetter(candidate: OutcomeHeadroom, incumbent: OutcomeHeadroom | null): boolean {
  if (incumbent === null) return true;
  if (candidate.maxFullyAccepted === null) return incumbent.maxFullyAccepted !== null;
  if (incumbent.maxFullyAccepted === null) return false;
  return candidate.maxFullyAccepted > incumbent.maxFullyAccepted;
}

/**
 * Where can a stake go without being refused, and how large can it be?
 *
 * This is the question an agent actually has: not "what are the books", but
 * "if I put money down right now, will it be taken". The answer is driven by
 * the OPPOSING books — stake on outcome o vests into every other outcome's
 * book and is accepted only up to the room those books have left.
 */
export async function bestHeadroom(
  config: ResolvedConfig,
  marketId: string,
  options: BestHeadroomOptions = {},
): Promise<BestHeadroom> {
  const { market, index } = await fetchMarket(config, marketId);
  const at = nowSeconds(options.now);
  const frozen = market.status !== 'Open' || at >= market.resolutionTime;

  const outcomes = market.books.map((book) => outcomeHeadroom(market, book.outcome, headBlock(index)));

  let best: OutcomeHeadroom | null = null;
  if (!frozen) {
    for (const candidate of outcomes) {
      // An outcome that would accept nothing is not an answer to "where can I
      // put money", so it never wins even if it is the only one left.
      if (candidate.maxFullyAccepted !== null && candidate.maxFullyAccepted === 0n) continue;
      if (isBetter(candidate, best)) best = candidate;
    }
  }

  return {
    marketId: market.id,
    status: market.status,
    frozen,
    best,
    outcomes,
    // Without the open vintage the client cannot see stake queued in this
    // block, so `maxFullyAccepted` is an upper bound, not a guarantee.
    demandUnknown: market.vintageOpen === null || market.books.some((book) => book.demand === null),
    index,
  };
}
