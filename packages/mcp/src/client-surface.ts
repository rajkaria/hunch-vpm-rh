/**
 * The read surface this server expects from a `@hunch-vpm/client` instance.
 *
 * ## The boundary, stated plainly
 *
 * `@hunch-vpm/client` is built in the same repository but as a separate package, and is
 * imported at run time by specifier (see `client-loader.ts`) rather than type-imported,
 * so this server typechecks and tests on its own. What that costs is a boundary nothing
 * checks at compile time, so it is checked at run time instead, in two places:
 *
 *   - the loader takes the client's factory (`createHunchClient`) and only accepts a
 *     module namespace of bare functions after an arity check, because the client also
 *     exports config-first `marketBook(config, marketId)` at module level and binding
 *     those would put a market id in the configuration slot;
 *   - `venue-reader.ts` normalizes every payload, accepting a short list of spellings
 *     per field and failing loudly — naming the field — when it finds none of them.
 *
 * That is deliberate: a wrong number silently reaching a staking decision is far worse
 * than a tool result that says the book could not be read.
 *
 * Bound to a configuration, the six reads take one argument each:
 *
 *   bestHeadroom(marketId)      impliedOdds(marketId)      counterpartyTrust(marketId)
 *   vestingEarned(positionId)   claimable(wallet)          marketBook(marketId)
 *
 * When the client's return types are pinned, the right change is to import them here and
 * delete the corresponding alias lists in `venue-reader.ts` — nothing else moves.
 */

/** Markets are addressed by the settler's numeric id, or by the subgraph's composite id. */
export type MarketRef = string;

/** Positions are addressed the same way. */
export type PositionRef = string;

export interface VpmReadClient {
  /** The book: per-outcome accepted principal, vested, capacity and headroom. */
  marketBook(marketId: MarketRef): Promise<unknown>;
  /** Where capacity still exists, so a stake will not be refused. */
  bestHeadroom(marketId: MarketRef): Promise<unknown>;
  /** Implied probabilities from accepted principal, not from a quoted price. */
  impliedOdds(marketId: MarketRef): Promise<unknown>;
  /** ERC-8004 reputation of the wallets on the other side of this market. */
  counterpartyTrust(marketId: MarketRef): Promise<unknown>;
  /** What has already vested to one position from stake that arrived after it. */
  vestingEarned(positionId: PositionRef): Promise<unknown>;
  /** Everything a wallet can pull right now. */
  claimable(wallet: string): Promise<unknown>;
}

export const CLIENT_METHODS = [
  "marketBook",
  "bestHeadroom",
  "impliedOdds",
  "counterpartyTrust",
  "vestingEarned",
  "claimable",
] as const satisfies ReadonlyArray<keyof VpmReadClient>;

/** Structural check used by the loader; also the error message's source of truth. */
export function isVpmReadClient(value: unknown): value is VpmReadClient {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return CLIENT_METHODS.every((method) => typeof candidate[method] === "function");
}

export function missingClientMethods(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [...CLIENT_METHODS];
  const candidate = value as Record<string, unknown>;
  return CLIENT_METHODS.filter((method) => typeof candidate[method] !== "function");
}
