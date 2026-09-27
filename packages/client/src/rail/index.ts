/**
 * The Arc settlement rail.
 *
 * An adapter that puts this venue behind the four verbs an agent-facing product
 * already exposes — research, quote, positions, trade — so an existing agent
 * reaches Arc markets through the API it already speaks. Nothing about the
 * agent's surface changes. What changes is underneath it: the venue stops being
 * the counterparty, a stake can be refused for want of headroom, payouts are
 * pulled rather than pushed, a price feed resolves the market instead of an
 * operator, and `trade` returns calldata for the agent's own wallet to sign
 * instead of taking the position on its behalf.
 */

export { createArcRail } from './createArcRail.js';
export type { ArcRail, ArcRailConfig } from './createArcRail.js';

export { ARC_RAIL, arcRailCapabilities, custodialRailCapabilities } from './capabilities.js';

export { acceptanceOf } from './acceptance.js';
export type { Acceptance, BookAcceptance } from './acceptance.js';

export { SideMap } from './sides.js';
export { RailError, TradeRefusedError, UnknownSideError } from './errors.js';

export { researchFrom } from './research.js';
export type { ArcResearch, ResearchInputs } from './research.js';
export { quoteFrom } from './quote.js';
export type { ArcQuote, QuoteInputs } from './quote.js';
export { arcPositions } from './positions.js';
export type { ArcPosition, ArcPositions, PositionClaim } from './positions.js';
export { tradeFrom } from './trade.js';
export type { ArcTrade, ArcTradeOptions, TradeInputs } from './trade.js';

export { isUnsignedTrade } from './types.js';
export type {
  ExecutedTrade,
  QuoteAcceptance,
  RailCapabilities,
  RailCounterparty,
  RailCounterpartySide,
  RailHeadroom,
  RailId,
  RailOpposingBook,
  RailOutcome,
  RailPayoutPreview,
  RailPosition,
  RailPositions,
  RailQuote,
  RailReadOptions,
  RailRefusal,
  RailRefusalKind,
  RailResearch,
  RailResolution,
  RailSide,
  RailTrade,
  RailTradeOptions,
  SettlementRail,
  TradeStep,
  UnsignedTrade,
} from './types.js';
