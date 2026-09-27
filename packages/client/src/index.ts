/**
 * @hunch-vpm/client — typed reads from The Graph and unsigned writes through viem.
 *
 * This package never holds a private key and never signs a transaction. The
 * write helpers return calldata for the caller's own wallet to sign and send.
 */

export { createHunchClient } from './client.js';
export type { HunchClient } from './client.js';

export { defineConfig, gatewayUrl, DEFAULT_PAGE_SIZE } from './config.js';
export type { HunchClientConfig, ResolvedConfig } from './config.js';

export { arcMainnet, arcTestnet, CAIP2, GRAPH_NETWORK_SLUG } from './chains.js';
export {
  ARC_USDC,
  DEFAULT_ADDRESSES,
  UNDEPLOYED,
  assertDeployed,
  defaultAddressesFor,
} from './addresses.js';
export type { HunchAddresses } from './addresses.js';

export { fetchTransport, GraphQLHttpError, GraphQLRequestError } from './transport.js';
export type { FetchLike, FetchTransportOptions, GraphQLRequest, GraphQLTransport } from './transport.js';

export { bestHeadroom } from './reads/bestHeadroom.js';
export type { BestHeadroomOptions } from './reads/bestHeadroom.js';
export { impliedOdds, impliedOddsFor } from './reads/impliedOdds.js';
export { counterpartyTrust, subgraphReputationLookup } from './reads/counterpartyTrust.js';
export type { CounterpartyTrustOptions, ReputationLookup } from './reads/counterpartyTrust.js';
export { vestingEarned } from './reads/vestingEarned.js';
export { claimable } from './reads/claimable.js';
export { decodeOwnedPosition, ownerPositions } from './reads/positions.js';
export { marketBook } from './reads/marketBook.js';
export type { MarketBookOptions } from './reads/marketBook.js';
export { NotFoundError } from './reads/shared.js';

export {
  approveCalldata,
  claimCalldata,
  claimResidueCalldata,
  enterCalldata,
  openMarketCalldata,
  withdrawRefundCalldata,
} from './writes/calldata.js';
export type {
  ApproveParams,
  CalldataContext,
  EnterParams,
  OpenMarketParams,
  PositionParams,
  ResidueParams,
  UnsignedCall,
} from './writes/calldata.js';
export { erc20Abi, feedResolverAbi, marketFactoryAbi, settlerAbi } from './writes/abi.js';

export {
  bookHeadroom,
  competingDemand,
  earnedVesting,
  opposingRoom,
  outcomeHeadroom,
  payoutIfWins,
  totalPrincipal,
} from './mechanics.js';

export {
  ACC_SCALE,
  KAPPA_UNBOUNDED,
  UNBOUNDED_SENTINEL,
  PPM,
  PRICE_DECIMALS,
  USDC_DECIMALS,
  formatPrice,
  formatUnitsExact,
  formatUsdc,
  maxBigInt,
  minBigInt,
  parseUnitsExact,
  parseUsdc,
  ppmToPercent,
  shareToPpm,
} from './units.js';
export type { FormatOptions } from './units.js';

// The Arc settlement rail: the four agent verbs (research, quote, positions,
// trade) over the reads and writes above, for a product that already has an
// agent API and wants Arc markets behind it unchanged.
export { createArcRail } from './rail/createArcRail.js';
export type { ArcRail, ArcRailConfig } from './rail/createArcRail.js';
export { ARC_RAIL, arcRailCapabilities, custodialRailCapabilities } from './rail/capabilities.js';
export { acceptanceOf } from './rail/acceptance.js';
export type { Acceptance, BookAcceptance } from './rail/acceptance.js';
export { SideMap } from './rail/sides.js';
export { RailError, TradeRefusedError, UnknownSideError } from './rail/errors.js';
export { isUnsignedTrade } from './rail/types.js';
export type { ArcResearch } from './rail/research.js';
export type { ArcQuote } from './rail/quote.js';
export type { ArcPosition, ArcPositions, PositionClaim } from './rail/positions.js';
export type { ArcTrade, ArcTradeOptions } from './rail/trade.js';
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
} from './rail/types.js';

export { DecodeError, sameAddress } from './decode.js';
export type { PositionHolding, UnclaimedWinner } from './decode.js';

export type {
  AgentReputation,
  BestHeadroom,
  BlockedResidue,
  Book,
  BookView,
  ClaimBreakdown,
  ClaimReason,
  Claimable,
  ClaimableItem,
  Counterparty,
  CounterpartyTrust,
  FeedDirection,
  ImpliedOdds,
  IndexStatus,
  Market,
  MarketBook,
  MarketStatus,
  OpposingBookRoom,
  OpposingSideTrust,
  OutcomeHeadroom,
  OutcomeOdds,
  OwnedPosition,
  Position,
  PositionState,
  ResolutionSpec,
  SettlerKind,
  VestingEarned,
  WalletPositions,
} from './types.js';
