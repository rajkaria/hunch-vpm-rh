import type { Address } from 'viem';
import type { HunchClient } from '../client.js';
import { createHunchClient } from '../client.js';
import type { HunchClientConfig } from '../config.js';
import { arcRailCapabilities } from './capabilities.js';
import type { ArcPositions } from './positions.js';
import { arcPositions } from './positions.js';
import type { ArcQuote } from './quote.js';
import { arcQuote } from './quote.js';
import type { ArcResearch } from './research.js';
import { arcResearch } from './research.js';
import { SideMap } from './sides.js';
import type { ArcTrade, ArcTradeOptions } from './trade.js';
import { arcTrade } from './trade.js';
import type { RailCapabilities, RailReadOptions, RailSide, SettlementRail } from './types.js';

export interface ArcRailConfig extends HunchClientConfig {
  /**
   * Reuse an existing client instead of building one from the fields above.
   * When this is given, the rest of the client configuration is ignored.
   */
  client?: HunchClient;
  /**
   * The side labels the agent-facing API already uses, mapped to outcome
   * indices — `{ yes: 0, no: 1 }`. Existing agents keep sending the labels they
   * always sent; the rail translates. Without this, only outcome indices are
   * accepted and a label raises `UnknownSideError` naming what to configure.
   */
  sides?: Readonly<Record<string, number>>;
  /**
   * Whether `research` also reads who is on the other side and what the
   * ERC-8004 registry says about them. It costs two further index reads — one
   * walk of the market's holders and one reputation lookup — so it is off by
   * default. Defaults to false.
   */
  includeCounterparty?: boolean;
  /** Unix seconds. Injectable so a caller can evaluate every verb at a fixed instant. */
  now?: () => bigint;
}

/**
 * The Arc rail: the four verbs, against the venue in this repository.
 *
 * It satisfies `SettlementRail`, so the private app can register it behind the
 * same switch as its Postgres book, and it narrows every return type to the
 * Arc-specific one, so a caller that knows which rail it holds keeps the extra
 * fields without a cast.
 */
export interface ArcRail extends SettlementRail {
  readonly capabilities: RailCapabilities;
  /** The underlying client, for reads this rail does not wrap. */
  readonly client: HunchClient;
  research(marketId: string, options?: RailReadOptions): Promise<ArcResearch>;
  quote(marketId: string, side: RailSide, amount: bigint, options?: RailReadOptions): Promise<ArcQuote>;
  positions(wallet: Address, options?: RailReadOptions): Promise<ArcPositions>;
  trade(marketId: string, side: RailSide, amount: bigint, options?: ArcTradeOptions): Promise<ArcTrade>;
}

/**
 * Build the rail.
 *
 * ```ts
 * const rail = createArcRail({
 *   subgraphUrl: process.env.HUNCH_SUBGRAPH_URL,
 *   sides: { yes: 0, no: 1 },
 * });
 * ```
 *
 * Nothing here takes a private key, an operator account, or a signer, and there
 * is no configuration field that would accept one.
 */
export function createArcRail(config: ArcRailConfig = {}): ArcRail {
  const client = config.client ?? createHunchClient(config);
  const sides = new SideMap('arc', config.sides ?? {});
  const clock = config.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  const withCounterparty = config.includeCounterparty === true;
  const chainId = client.config.chain.id;
  const capabilities = arcRailCapabilities(chainId, client.config.addresses.usdc);

  return {
    capabilities,
    client,

    research: (marketId, options = {}) =>
      arcResearch(client, sides, marketId, options.now ?? clock(), withCounterparty),

    quote: (marketId, side, amount, options = {}) =>
      arcQuote(client, sides, marketId, side, amount, options.now ?? clock()),

    positions: (wallet, options = {}) => arcPositions(client, sides, wallet, options.now ?? clock()),

    trade: (marketId, side, amount, options = {}) =>
      arcTrade(client, sides, chainId, marketId, side, amount, options.now ?? clock(), options),
  };
}
