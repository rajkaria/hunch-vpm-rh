import type { Address, Hex } from 'viem';
import { encodeFunctionData, getAddress } from 'viem';
import type { HunchAddresses } from '../addresses.js';
import { assertDeployed } from '../addresses.js';
import type { FeedDirection } from '../types.js';
import { KAPPA_UNBOUNDED } from '../units.js';
import { erc20Abi, marketFactoryAbi, settlerAbi } from './abi.js';

/**
 * Unsigned calldata, for the caller's OWN wallet.
 *
 * Nothing in this package signs anything, holds a key, or takes custody. Every
 * function here returns the three fields a wallet needs to build a transaction
 * and stops. The venue does not custody either: stake goes from the caller's
 * wallet to the settler's escrow and comes back by pull.
 */
export interface UnsignedCall {
  to: Address;
  data: Hex;
  /**
   * Always 0. Stake moves through the ERC-20 interface even though USDC is
   * Arc's native gas token, so no call here carries native value.
   */
  value: bigint;
}

const UINT128_MAX = 2n ** 128n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;
const UINT256_MAX = 2n ** 256n - 1n;

function assertUint(value: bigint, max: bigint, what: string): bigint {
  if (value < 0n || value > max) throw new RangeError(`${what} out of range: ${value}`);
  return value;
}

/**
 * The settler packs a position's amounts into uint128 fields and reverts
 * `AmountTooLarge` above that, so the check belongs here rather than in a
 * failed transaction.
 */
function assertStake(amount: bigint): bigint {
  if (amount <= 0n) throw new RangeError(`stake must be positive, got ${amount}`);
  return assertUint(amount, UINT128_MAX, 'stake');
}

function assertOutcome(outcome: number): number {
  if (!Number.isInteger(outcome) || outcome < 0 || outcome > 254) {
    throw new RangeError(`outcome must be an integer in [0, 254], got ${outcome}`);
  }
  return outcome;
}

export interface CalldataContext {
  addresses: HunchAddresses;
}

function settlerAddress(context: CalldataContext, override?: Address): Address {
  const address = override ?? context.addresses.vestedParimutuel;
  return assertDeployed(getAddress(address), 'the settler');
}

export interface EnterParams {
  /** The settler's own market index, not the subgraph id. */
  marketId: bigint;
  outcome: number;
  /** Stake offered, in the settlement asset's smallest unit. */
  amount: bigint;
  /** Defaults to the configured VestedParimutuel. */
  settler?: Address;
}

/**
 * Offer `amount` on `outcome`.
 *
 * The whole amount is escrowed when the transaction lands; how much of it the
 * books accept is fixed when the entry's vintage is finalized, and anything
 * refused becomes withdrawable then. Call `bestHeadroom` first if you need the
 * stake accepted in full — an amount above `maxFullyAccepted` is not an error,
 * it just comes back partly refunded.
 *
 * The settler pulls the stake with `transferFrom`, so an allowance has to
 * exist first: see `approveCalldata`.
 */
export function enterCalldata(context: CalldataContext, params: EnterParams): UnsignedCall {
  return {
    to: settlerAddress(context, params.settler),
    data: encodeFunctionData({
      abi: settlerAbi,
      functionName: 'enter',
      args: [
        assertUint(params.marketId, UINT256_MAX, 'marketId'),
        assertOutcome(params.outcome),
        assertStake(params.amount),
      ],
    }),
    value: 0n,
  };
}

export interface PositionParams {
  /** The settler's own position index, not the subgraph id. */
  positionId: bigint;
  settler?: Address;
}

/**
 * Settle a position after the market resolved or voided. Pays the settlement
 * and any refused remainder that has not been withdrawn, in one transaction.
 */
export function claimCalldata(context: CalldataContext, params: PositionParams): UnsignedCall {
  return {
    to: settlerAddress(context, params.settler),
    data: encodeFunctionData({
      abi: settlerAbi,
      functionName: 'claim',
      args: [assertUint(params.positionId, UINT256_MAX, 'positionId')],
    }),
    value: 0n,
  };
}

/**
 * Pull back the part of a stake the books refused, without waiting for the
 * market to settle. Available as soon as the entry's vintage is finalized.
 */
export function withdrawRefundCalldata(context: CalldataContext, params: PositionParams): UnsignedCall {
  return {
    to: settlerAddress(context, params.settler),
    data: encodeFunctionData({
      abi: settlerAbi,
      functionName: 'withdrawRefund',
      args: [assertUint(params.positionId, UINT256_MAX, 'positionId')],
    }),
    value: 0n,
  };
}

export interface ResidueParams {
  marketId: bigint;
  settler?: Address;
}

/** Sweep the flooring residue. Only the owner named at creation, only once every winner has claimed. */
export function claimResidueCalldata(context: CalldataContext, params: ResidueParams): UnsignedCall {
  return {
    to: settlerAddress(context, params.settler),
    data: encodeFunctionData({
      abi: settlerAbi,
      functionName: 'claimResidue',
      args: [assertUint(params.marketId, UINT256_MAX, 'marketId')],
    }),
    value: 0n,
  };
}

export interface OpenMarketParams {
  /** Which settlement rule. Defaults to the configured VestedParimutuel. */
  settler?: Address;
  /** Defaults to the configured settlement asset. */
  token?: Address;
  /** Offered seed per outcome, at least two entries, every one positive. */
  seed: bigint[];
  /** Capacity coefficient. `null` means unbounded, which is the prescription for n-way markets. */
  kappa: bigint | null;
  /** The freeze, unix seconds. Must be in the future when the transaction lands. */
  resolutionTime: bigint;
  /** Seconds after the freeze from which anyone may void. */
  voidTimeout: bigint;
  /** Who may sweep the residue. */
  residueOwner: Address;
  feed: {
    /** The IPriceOracle adapter. */
    oracle: Address;
    /** Adapter-defined feed identifier, 32 bytes. */
    feedKey: Hex;
    /** Threshold at 8 decimals, signed. */
    strike: bigint;
    direction: FeedDirection;
    /** Seconds beyond which a reading is too old and the market voids. */
    maxStaleness: bigint;
  };
  /** Defaults to the configured MarketFactory. */
  factory?: Address;
}

/**
 * Open a market and register how it resolves, in one transaction.
 *
 * Both halves happen or neither does. A market whose resolution spec is
 * registered later has a window in which stake can land against rules nobody
 * has committed to; the factory closes it. The factory pulls the whole offered
 * seed, keeps what the settler accepts, hands the seed positions back to the
 * caller and returns the rest — so an asymmetric seed costs only what the
 * capacity rule allows it to cost.
 */
export function openMarketCalldata(context: CalldataContext, params: OpenMarketParams): UnsignedCall {
  if (params.seed.length < 2) {
    throw new RangeError(`a market needs at least 2 outcomes, got ${params.seed.length}`);
  }
  if (params.seed.length > 255) {
    throw new RangeError(`a market takes at most 255 outcomes, got ${params.seed.length}`);
  }
  for (const [index, leg] of params.seed.entries()) {
    // The settler voids creation outright if any leg is accepted at zero, so a
    // zero offer is never what the caller meant.
    if (leg <= 0n) throw new RangeError(`seed leg ${index} must be positive, got ${leg}`);
    assertUint(leg, UINT128_MAX, `seed leg ${index}`);
  }
  const kappa = params.kappa === null ? KAPPA_UNBOUNDED : params.kappa;
  if (kappa < 1n) throw new RangeError(`kappa must be at least 1, got ${kappa}`);
  assertUint(kappa, UINT256_MAX, 'kappa');
  assertUint(params.resolutionTime, UINT64_MAX, 'resolutionTime');
  assertUint(params.voidTimeout, UINT64_MAX, 'voidTimeout');
  assertUint(params.feed.maxStaleness, UINT64_MAX, 'maxStaleness');
  if (!/^0x[0-9a-fA-F]{64}$/.test(params.feed.feedKey)) {
    throw new RangeError(`feedKey must be 32 bytes of hex, got ${params.feed.feedKey}`);
  }

  const factory = assertDeployed(getAddress(params.factory ?? context.addresses.marketFactory), 'the market factory');
  const settler = settlerAddress(context, params.settler);
  const token = getAddress(params.token ?? context.addresses.usdc);

  return {
    to: factory,
    data: encodeFunctionData({
      abi: marketFactoryAbi,
      functionName: 'open',
      args: [
        {
          settler,
          token,
          seed: params.seed,
          kappa,
          resolutionTime: params.resolutionTime,
          voidTimeout: params.voidTimeout,
          residueOwner: getAddress(params.residueOwner),
        },
        {
          oracle: getAddress(params.feed.oracle),
          feedKey: params.feed.feedKey,
          strike: params.feed.strike,
          direction: params.feed.direction === 'above' ? 0 : 1,
          maxStaleness: params.feed.maxStaleness,
        },
      ],
    }),
    value: 0n,
  };
}

export interface ApproveParams {
  /** Who may pull: the settler for `enter`, the factory for `open`. */
  spender: Address;
  amount: bigint;
  /** Defaults to the configured settlement asset. */
  token?: Address;
}

/**
 * Allowance for the settler or the factory to pull stake.
 *
 * Included because `enter` and `open` both use `transferFrom` and are
 * unusable without it — not because this package does anything with the
 * allowance itself.
 */
export function approveCalldata(context: CalldataContext, params: ApproveParams): UnsignedCall {
  return {
    to: getAddress(params.token ?? context.addresses.usdc),
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [getAddress(params.spender), assertUint(params.amount, UINT256_MAX, 'approval amount')],
    }),
    value: 0n,
  };
}
