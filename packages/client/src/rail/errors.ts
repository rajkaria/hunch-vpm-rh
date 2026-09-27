import type { RailQuote, RailSide } from './types.js';

/** Base for everything this adapter throws, so the app can catch one class. */
export class RailError extends Error {
  readonly rail: string;

  constructor(rail: string, message: string) {
    super(message);
    this.name = 'RailError';
    this.rail = rail;
  }
}

/**
 * The caller named a side the rail cannot resolve to an outcome.
 *
 * The message names the labels that ARE configured, because the fix is almost
 * always one line of rail config rather than anything in the agent.
 */
export class UnknownSideError extends RailError {
  readonly side: RailSide;
  readonly known: readonly string[];

  constructor(rail: string, side: RailSide, known: readonly string[]) {
    super(
      rail,
      known.length === 0
        ? `no side labels are configured on the ${rail} rail, so "${String(side)}" cannot be resolved to an ` +
            `outcome. Pass \`sides\` when you create the rail (for example { yes: 0, no: 1 }), or send the ` +
            `outcome index itself.`
        : `"${String(side)}" is not a side on the ${rail} rail. Configured labels: ${known.join(', ')}.`,
    );
    this.name = 'UnknownSideError';
    this.side = side;
    this.known = known;
  }
}

/**
 * `trade` refused to build calldata, and the quote says why.
 *
 * Thrown when the entry could not land at all — the market is frozen or settled
 * and the settler would revert, or the books have no room and the whole stake
 * would come straight back. It carries the quote so the caller can report the
 * refusal rather than a failure.
 */
export class TradeRefusedError extends RailError {
  readonly quote: RailQuote;

  constructor(rail: string, quote: RailQuote, message: string) {
    super(rail, message);
    this.name = 'TradeRefusedError';
    this.quote = quote;
  }
}
