import type { Address } from 'viem';
import { getAddress } from 'viem';
import type { HunchClient } from '../client.js';
import { formatUsdc } from '../units.js';
import { ARC_RAIL } from './capabilities.js';
import { TradeRefusedError } from './errors.js';
import type { ArcQuote } from './quote.js';
import { arcQuote } from './quote.js';
import type { SideMap } from './sides.js';
import type { RailSide, RailTradeOptions, TradeStep, UnsignedTrade } from './types.js';

/**
 * `trade` on this rail does not trade. It hands back calldata.
 *
 * On a custodial rail the verb takes the position: the venue holds the key, the
 * venue signs, and the agent gets a fill. Here the venue has no key and no
 * account the stake could pass through. `trade` reads the books, prices the
 * acceptance, and returns the transactions the AGENT'S OWN WALLET must sign for
 * anything to happen. If the agent never signs, nothing happens — there is no
 * pending order, no reservation, and no way for this package to have done it
 * on the agent's behalf.
 *
 * The return type says so in three places at once (`kind`, `signed`, `custody`)
 * and carries nothing a wallet could broadcast on its own.
 */
export interface ArcTrade extends UnsignedTrade {
  readonly rail: 'arc';
  readonly quote: ArcQuote;
}

export interface ArcTradeOptions extends RailTradeOptions {
  /** Refuse unless every unit of the stake would be accepted right now. */
  requireFullAcceptance?: boolean;
  /**
   * Build the calldata even when the books would accept nothing. The entry
   * still lands and the whole stake comes back by `withdrawRefund`, so this is
   * off by default: it costs two transactions and a round trip to achieve
   * nothing.
   */
  acceptTotalRefusal?: boolean;
  /**
   * Include the ERC-20 approval step. The settler pulls the stake with
   * `transferFrom`, so an allowance has to exist first; this package cannot see
   * the current allowance, which is why the step is marked conditional rather
   * than mandatory. Defaults to true.
   */
  includeApproval?: boolean;
}

/**
 * Freeze what we hand back, so nothing downstream can quietly decorate it with
 * a signature, a hash, or a `send` and have it still look like this rail's
 * answer.
 */
function freezeTrade(trade: ArcTrade): ArcTrade {
  for (const step of trade.steps) {
    Object.freeze(step.call);
    Object.freeze(step);
  }
  Object.freeze(trade.steps);
  Object.freeze(trade.warnings);
  return Object.freeze(trade);
}

function warningsFor(quote: ArcQuote): string[] {
  const warnings: string[] = [];
  if (quote.acceptance === 'partial') {
    warnings.push(
      `Partial fill: ${formatUsdc(quote.accepted)} of ${formatUsdc(quote.requested)} would be accepted. The ` +
        `whole ${formatUsdc(quote.requested)} is pulled from the wallet, and the refused ` +
        `${formatUsdc(quote.refused)} has to be pulled back with withdrawRefund once the vintage is finalized.`,
    );
  }
  if (quote.acceptance === 'none') {
    warnings.push(
      `Nothing would be accepted: the whole ${formatUsdc(quote.requested)} would be escrowed and then have ` +
        `to be pulled back with withdrawRefund.`,
    );
  }
  if (quote.demandUnknown) {
    warnings.push(
      'Stake queued in the current block could not be read, so the acceptance above is an upper bound.',
    );
  }
  warnings.push(
    'Nothing here is signed. These calls do nothing until the wallet that owns the stake signs and sends ' +
      'them itself; this rail holds no key and takes no custody.',
  );
  return warnings;
}

export interface TradeInputs {
  readonly client: HunchClient;
  readonly quote: ArcQuote;
  readonly chainId: number;
  readonly from: Address | null;
  readonly includeApproval: boolean;
}

/** Assemble the calldata. Split out from the reads so it can be checked on its own. */
export function tradeFrom(inputs: TradeInputs): ArcTrade {
  const { client, quote, chainId, from, includeApproval } = inputs;
  const steps: TradeStep[] = [];

  if (includeApproval) {
    steps.push({
      id: 'approve',
      what:
        `Let the settler pull ${formatUsdc(quote.requested)} of the settlement asset. The settler takes the ` +
        `whole offer, including the part it will refuse.`,
      // There is no way to read an allowance from the index, so this is stated
      // as a condition rather than asserted as a fact.
      when: 'if-allowance-below-amount',
      chainId,
      call: client.approveCalldata({ spender: quote.settler, amount: quote.requested, token: quote.token }),
    });
  }

  steps.push({
    id: 'enter',
    what:
      `Offer ${formatUsdc(quote.requested)} on outcome ${quote.outcome}` +
      `${quote.label === null ? '' : ` (${quote.label})`}. The books accept what they have room for; the ` +
      `rest becomes refundable.`,
    when: 'always',
    chainId,
    call: client.enterCalldata({
      marketId: quote.onChainMarketId,
      outcome: quote.outcome,
      amount: quote.requested,
      settler: quote.settler,
    }),
  });

  return freezeTrade({
    kind: 'unsigned-calldata',
    signed: false,
    custody: 'self',
    rail: ARC_RAIL,
    chainId,
    from,
    marketId: quote.marketId,
    outcome: quote.outcome,
    steps,
    quote,
    warnings: warningsFor(quote),
  });
}

/**
 * Price the stake, then return the calldata for it.
 *
 * Refuses rather than returning calldata that cannot do what was asked: an
 * entry the settler would revert, an entry that would be refused in full, or a
 * partial fill when the caller asked for all-or-nothing. Every refusal carries
 * the quote, so the caller can tell the agent what the venue would have done
 * instead of reporting a failure.
 */
export async function arcTrade(
  client: HunchClient,
  sides: SideMap,
  chainId: number,
  marketId: string,
  side: RailSide,
  amount: bigint,
  at: bigint,
  options: ArcTradeOptions = {},
): Promise<ArcTrade> {
  const quote = await arcQuote(client, sides, marketId, side, amount, at);

  const revert = quote.refusal?.revertsWith ?? null;
  if (revert !== null) {
    throw new TradeRefusedError(
      ARC_RAIL,
      quote,
      `this market takes no stake right now: the settler would revert with ${revert}. ${quote.refusal?.detail ?? ''}`.trim(),
    );
  }
  if (quote.accepted === 0n && options.acceptTotalRefusal !== true) {
    throw new TradeRefusedError(
      ARC_RAIL,
      quote,
      `the opposing books have no room for this stake, so all ${formatUsdc(quote.requested)} would be ` +
        `escrowed and then refunded. Pass acceptTotalRefusal to build the calldata anyway.`,
    );
  }
  if (options.requireFullAcceptance === true && quote.refused > 0n) {
    throw new TradeRefusedError(
      ARC_RAIL,
      quote,
      `only ${formatUsdc(quote.accepted)} of ${formatUsdc(quote.requested)} would be accepted, and full ` +
        `acceptance was required. The largest stake taken whole right now is ` +
        `${quote.maxFullyAccepted === null ? 'unbounded' : formatUsdc(quote.maxFullyAccepted)}.`,
    );
  }

  return tradeFrom({
    client,
    quote,
    chainId,
    from: options.wallet === undefined ? null : getAddress(options.wallet),
    includeApproval: options.includeApproval !== false,
  });
}
