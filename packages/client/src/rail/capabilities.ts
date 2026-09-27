import type { Address } from 'viem';
import { USDC_DECIMALS } from '../units.js';
import type { RailCapabilities, RailId } from './types.js';

/** The rail id this adapter registers itself under. */
export const ARC_RAIL = 'arc';

/**
 * What the Arc rail is.
 *
 * Read it against `custodialRailCapabilities()` below and the four differences
 * that matter are all here: the venue does not hold the money, it is not the
 * counterparty, a stake can be refused in part, and nobody at the venue decides
 * the outcome or pushes the payout.
 */
export function arcRailCapabilities(chainId: number, asset: Address): RailCapabilities {
  return {
    rail: ARC_RAIL,
    // Stake goes from the agent's wallet into the settler's escrow. No operator
    // account is ever the owner of it.
    custody: 'self',
    // The other side is whoever staked the other outcomes. The venue takes no
    // position and cannot.
    counterparty: 'other-stakers',
    // The defining behaviour: capacity is finite, so an offer is accepted only
    // up to the room the opposing books have to cover it.
    refusal: true,
    quote: 'acceptance',
    // A registered price spec decides, and anyone may call it in.
    resolution: 'feed',
    // Winners are paid when they ask. Nothing is pushed to a wallet.
    payout: 'pull',
    signing: 'agent-wallet',
    // An entry cannot be cancelled: it is demand against the opposing books
    // from the moment it lands.
    cancellable: false,
    chainId,
    asset: { symbol: 'USDC', decimals: USDC_DECIMALS, address: asset },
  };
}

/**
 * The descriptor a custodial book declares.
 *
 * This repo does not implement that rail — the shape is here so the private
 * app can register its existing Postgres implementation with one call and have
 * both rails describe themselves the same way. Adjust any field that is not
 * true of your book; the point of the descriptor is that the app branches on
 * the fact rather than on the rail's name.
 */
export function custodialRailCapabilities(
  rail: RailId,
  asset: { symbol: string; decimals: number } = { symbol: 'USDC', decimals: USDC_DECIMALS },
): RailCapabilities {
  return {
    rail,
    custody: 'venue',
    counterparty: 'venue',
    refusal: false,
    quote: 'price',
    resolution: 'operator',
    payout: 'push',
    signing: 'venue',
    cancellable: true,
    chainId: null,
    asset: { symbol: asset.symbol, decimals: asset.decimals, address: null },
  };
}
