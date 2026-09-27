import type { Address } from 'viem';
import { arcMainnet, arcTestnet } from './chains.js';

/**
 * Every address this package needs to build a transaction or to name a
 * registry. Addresses that are not yet deployed are the zero address; call
 * `assertDeployed` before you hand one to a wallet.
 */
export interface HunchAddresses {
  /** VestedParimutuel: the settler that vests stake into the opposing books. */
  vestedParimutuel: Address;
  /** ClassicParimutuel: the same interface under the classic pool rule. */
  classicParimutuel: Address;
  /** MarketFactory: opens a market and registers its resolution spec atomically. */
  marketFactory: Address;
  /** FeedResolver: permissionless resolution from a price feed. */
  feedResolver: Address;
  /** The settlement asset. On Arc this is the native gas token, ERC-20 at a fixed address. */
  usdc: Address;
  /** ERC-8004 IdentityRegistry. */
  identityRegistry: Address;
  /** ERC-8004 ReputationRegistry. */
  reputationRegistry: Address;
  /** ERC-8004 ValidationRegistry. */
  validationRegistry: Address;
  /** Stork's oracle contract, read through an IPriceOracle adapter. */
  storkOracle: Address;
}

/**
 * PLACEHOLDER. Nothing of ours is deployed yet, on either network. Anything
 * still reading `0x0000...0000` has not been filled in from
 * `deployments/<network>.json` and will revert if you send to it.
 */
export const UNDEPLOYED = '0x0000000000000000000000000000000000000000' as const satisfies Address;

/** USDC is the native gas token on Arc, at this fixed address on both networks. */
export const ARC_USDC = '0x3600000000000000000000000000000000000000' as const satisfies Address;

const arcTestnetAddresses: HunchAddresses = {
  // From deployments/arc-testnet.json, carried here by scripts/wire-deployment.mjs.
  vestedParimutuel: '0xC743940C75619f65F6178b7e49c0C3A0bE012Eec',
  classicParimutuel: '0x21603b2176aB8495A81fF3B3bE853C64f3860D57',
  marketFactory: '0x0380C6FC136AE64432558e407706a5C7E7652f07',
  feedResolver: '0xd9Fde9112a5dE78075fae334D8A9a67fDcAee3f3',
  usdc: ARC_USDC,
  // ERC-8004 registries are live on Arc testnet and are not ours to deploy.
  identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  validationRegistry: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
  storkOracle: '0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62',
};

const arcMainnetAddresses: HunchAddresses = {
  // PLACEHOLDER: nothing is deployed to Arc mainnet, including the registries,
  // whose mainnet addresses we have not verified. Do not assume they match testnet.
  vestedParimutuel: UNDEPLOYED,
  classicParimutuel: UNDEPLOYED,
  marketFactory: UNDEPLOYED,
  feedResolver: UNDEPLOYED,
  usdc: ARC_USDC,
  identityRegistry: UNDEPLOYED,
  reputationRegistry: UNDEPLOYED,
  validationRegistry: UNDEPLOYED,
  storkOracle: UNDEPLOYED,
};

export const DEFAULT_ADDRESSES: Record<number, HunchAddresses> = {
  [arcTestnet.id]: arcTestnetAddresses,
  [arcMainnet.id]: arcMainnetAddresses,
};

export function defaultAddressesFor(chainId: number): HunchAddresses {
  const addresses = DEFAULT_ADDRESSES[chainId];
  if (addresses === undefined) {
    throw new Error(
      `no default addresses for chain ${chainId}; pass \`addresses\` explicitly in the client config`,
    );
  }
  return { ...addresses };
}

/**
 * Guard for the placeholder. Calling a zero address does not revert on every
 * chain — it can succeed and do nothing — so this is checked before we hand
 * calldata to a caller, not after.
 */
export function assertDeployed(address: Address, what: string): Address {
  if (address.toLowerCase() === UNDEPLOYED) {
    throw new Error(
      `${what} is not deployed yet (address is the zero placeholder). ` +
        `Set it in the client config from deployments/<network>.json before building calldata.`,
    );
  }
  return address;
}
