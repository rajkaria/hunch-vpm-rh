import type { Address } from 'viem';
import type { HunchClientConfig, ResolvedConfig } from './config.js';
import { defineConfig } from './config.js';
import type { BestHeadroomOptions } from './reads/bestHeadroom.js';
import { bestHeadroom } from './reads/bestHeadroom.js';
import type { CounterpartyTrustOptions } from './reads/counterpartyTrust.js';
import { counterpartyTrust } from './reads/counterpartyTrust.js';
import { claimable } from './reads/claimable.js';
import { impliedOdds } from './reads/impliedOdds.js';
import type { MarketBookOptions } from './reads/marketBook.js';
import { marketBook } from './reads/marketBook.js';
import { ownerPositions } from './reads/positions.js';
import { vestingEarned } from './reads/vestingEarned.js';
import type {
  BestHeadroom,
  Claimable,
  CounterpartyTrust,
  ImpliedOdds,
  MarketBook,
  VestingEarned,
  WalletPositions,
} from './types.js';
import type {
  ApproveParams,
  EnterParams,
  OpenMarketParams,
  PositionParams,
  ResidueParams,
  UnsignedCall,
} from './writes/calldata.js';
import {
  approveCalldata,
  claimCalldata,
  claimResidueCalldata,
  enterCalldata,
  openMarketCalldata,
  withdrawRefundCalldata,
} from './writes/calldata.js';

/**
 * Reads that answer a question and writes that hand back unsigned calldata.
 *
 * Ids: every read takes a SUBGRAPH id (`<settler>-<index>`), because that is
 * what a read of the index is addressed by. Every write takes the settler's
 * own numeric index, because that is what the contract's function signature
 * takes. `marketBook` reports both.
 */
export interface HunchClient {
  readonly config: ResolvedConfig;

  /** Which outcome still has capacity, how much, and the largest stake accepted in full. */
  bestHeadroom(marketId: string, options?: BestHeadroomOptions): Promise<BestHeadroom>;
  /** Implied probability per outcome, from accepted principal. */
  impliedOdds(marketId: string): Promise<ImpliedOdds>;
  /** ERC-8004 reputation of the wallets on the other side of each outcome. */
  counterpartyTrust(marketId: string, options?: CounterpartyTrustOptions): Promise<CounterpartyTrust>;
  /** What has already vested to one position. */
  vestingEarned(positionId: string): Promise<VestingEarned>;
  /** Everything a wallet can pull right now, across markets, with totals. */
  claimable(wallet: Address): Promise<Claimable>;
  /**
   * Every position a wallet holds or has held, across markets, newest first —
   * open, unfinalized, settled and claimed alike. `claimable` is the narrower
   * question of what can be pulled right now.
   */
  positions(wallet: Address): Promise<WalletPositions>;
  /** The full book: principal, vested, capacity, headroom, odds, freeze, resolution spec. */
  marketBook(marketId: string, options?: MarketBookOptions): Promise<MarketBook>;

  /** Unsigned calldata for the caller's own wallet. This package never signs. */
  enterCalldata(params: EnterParams): UnsignedCall;
  claimCalldata(params: PositionParams): UnsignedCall;
  withdrawRefundCalldata(params: PositionParams): UnsignedCall;
  claimResidueCalldata(params: ResidueParams): UnsignedCall;
  openMarketCalldata(params: OpenMarketParams): UnsignedCall;
  approveCalldata(params: ApproveParams): UnsignedCall;
}

export function createHunchClient(config: HunchClientConfig = {}): HunchClient {
  const resolved = defineConfig(config);
  const context = { addresses: resolved.addresses };

  return {
    config: resolved,

    bestHeadroom: (marketId, options) => bestHeadroom(resolved, marketId, options),
    impliedOdds: (marketId) => impliedOdds(resolved, marketId),
    counterpartyTrust: (marketId, options) => counterpartyTrust(resolved, marketId, options),
    vestingEarned: (positionId) => vestingEarned(resolved, positionId),
    claimable: (wallet) => claimable(resolved, wallet),
    positions: (wallet) => ownerPositions(resolved, wallet),
    marketBook: (marketId, options) => marketBook(resolved, marketId, options),

    enterCalldata: (params) => enterCalldata(context, params),
    claimCalldata: (params) => claimCalldata(context, params),
    withdrawRefundCalldata: (params) => withdrawRefundCalldata(context, params),
    claimResidueCalldata: (params) => claimResidueCalldata(context, params),
    openMarketCalldata: (params) => openMarketCalldata(context, params),
    approveCalldata: (params) => approveCalldata(context, params),
  };
}
