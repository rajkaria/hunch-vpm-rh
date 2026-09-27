import {
  bytesToHex,
  encodeAbiParameters,
  hashDomain,
  keccak256,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';
import { CHAIN_ID, ENTER_TYPEHASH, USDG_EIP712_DOMAIN } from './constants.js';

/**
 * Gasless entry (HunchVPM D5): the bettor signs USDG's EIP-3009
 * `ReceiveWithAuthorization` with `to = HunchVPM` and a nonce that binds the market,
 * side, amount and a random salt, so whoever relays the signature cannot change them;
 * USDG marks the nonce used, so it cannot be replayed.
 */

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export interface EnterNonceInput {
  hunchVpm: Address;
  marketId: bigint;
  outcome: number;
  amount: bigint;
  salt: Hex;
  /** Defaults to 4663. */
  chainId?: number | bigint;
}

/**
 * `HunchVPM.enterNonce(marketId, outcome, amount, salt)`, off-chain:
 * `keccak256(abi.encode(ENTER_TYPEHASH, block.chainid, address(this), marketId, outcome, amount, salt))`.
 */
export function enterNonce(input: EnterNonceInput): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint8' },
        { type: 'uint256' },
        { type: 'bytes32' },
      ],
      [ENTER_TYPEHASH, BigInt(input.chainId ?? CHAIN_ID), input.hunchVpm, input.marketId, input.outcome, input.amount, input.salt],
    ),
  );
}

export interface EnterAuthorizationInput extends EnterNonceInput {
  from: Address;
  /** Unix seconds; 0 = valid immediately. */
  validAfter: bigint;
  /** Unix seconds; the authorization expires at this time (exclusive). */
  validBefore: bigint;
}

export interface EnterAuthorization {
  domain: typeof USDG_EIP712_DOMAIN;
  types: typeof RECEIVE_WITH_AUTHORIZATION_TYPES;
  primaryType: 'ReceiveWithAuthorization';
  message: {
    from: Address;
    to: Address;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
  };
}

/**
 * The typed data a wallet signs for a gasless bet (`signTypedData(buildEnterAuthorization(...))`).
 * The domain is USDG's hardcoded one; the wallet must be on chain 4663 to sign it.
 */
export function buildEnterAuthorization(input: EnterAuthorizationInput): EnterAuthorization {
  if ((input.chainId ?? CHAIN_ID) !== CHAIN_ID && BigInt(input.chainId ?? CHAIN_ID) !== BigInt(CHAIN_ID)) {
    throw new RangeError(`USDG's domain is on chain ${CHAIN_ID}`);
  }
  return {
    domain: USDG_EIP712_DOMAIN,
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: 'ReceiveWithAuthorization',
    message: {
      from: input.from,
      to: input.hunchVpm,
      value: input.amount,
      validAfter: input.validAfter,
      validBefore: input.validBefore,
      nonce: enterNonce(input),
    },
  };
}

/** 32 random bytes (Web Crypto; available in Node ≥ 20 and every browser). */
export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  const crypto = (globalThis as { crypto?: { getRandomValues<T extends Uint8Array>(a: T): T } }).crypto;
  if (crypto === undefined) throw new Error('no Web Crypto available for randomSalt()');
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** `hashDomain` of USDG's hardcoded domain; equals `USDG_DOMAIN_SEPARATOR` (tested). */
export function usdgDomainSeparator(): Hex {
  return hashDomain({
    domain: { ...USDG_EIP712_DOMAIN, chainId: BigInt(USDG_EIP712_DOMAIN.chainId) },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
    },
  });
}

/** The EOA that signed `authorization` (ECDSA only; smart-wallet signatures need ERC-1271 on chain). */
export async function recoverEnterSigner(authorization: EnterAuthorization, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ ...authorization, signature });
}

/** A validity window of `seconds` starting now (validAfter = 0, validBefore = now + seconds). */
export function validityWindow(nowSec: number, seconds = 1800): { validAfter: bigint; validBefore: bigint } {
  return { validAfter: 0n, validBefore: BigInt(Math.floor(nowSec) + seconds) };
}
