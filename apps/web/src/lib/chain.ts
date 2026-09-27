/**
 * Chain facts and explorer links.
 *
 * These are duplicated from `@hunch-vpm/client` rather than imported, because
 * this app has to typecheck and build before that package has been compiled —
 * which is the state on a fresh clone, and the state in CI, where `typecheck`
 * runs before `build`. The live data adapter loads the client at runtime; see
 * `src/lib/data/live.ts` for that boundary and the reason for it.
 */

export interface ChainFacts {
  id: number;
  name: string;
  explorerUrl: string;
  /** CAIP-2, as The Graph lists it for Arc. */
  caip2: string;
  /** The Graph's network slug, which is what a subgraph manifest names. */
  graphSlug: string;
  testnet: boolean;
}

export const ARC_TESTNET: ChainFacts = {
  id: 5042002,
  name: 'Arc Testnet',
  explorerUrl: 'https://testnet.arcscan.app',
  caip2: 'eip155:5042002',
  graphSlug: 'arc-testnet',
  testnet: true,
};

export const ARC_MAINNET: ChainFacts = {
  id: 5042,
  name: 'Arc',
  /*
   * No mainnet explorer URL has been verified for this repo, so mainnet links
   * are SUPPRESSED rather than guessed — `addressExplorerUrl` returns null and
   * callers render plain text. Set NEXT_PUBLIC_ARC_EXPLORER_URL once the real
   * one is known and every mainnet address on the surface becomes a link.
   */
  explorerUrl: process.env['NEXT_PUBLIC_ARC_EXPLORER_URL'] ?? '',
  caip2: 'eip155:5042',
  graphSlug: 'arc',
  testnet: false,
};

/** USDC is the native gas token on Arc, at a fixed address, 6 decimals through ERC-20. */
export const ARC_USDC = '0x3600000000000000000000000000000000000000';

/**
 * PLACEHOLDER. Nothing of ours is deployed yet. Every address below that reads
 * as the zero address is a placeholder the UI labels as such rather than
 * linking into an explorer that has nothing to show.
 */
export const UNDEPLOYED = '0x0000000000000000000000000000000000000000';

export interface ContractAddresses {
  vestedParimutuel: string;
  classicParimutuel: string;
  marketFactory: string;
  feedResolver: string;
  /** The IPriceOracle adapter this deployment's resolver reads — StorkOracle on Arc testnet. */
  priceOracle: string;
  /**
   * ChainlinkCreOracle: Chainlink Data Feeds relayed onto a chain that has none, by a CRE
   * workflow through Chainlink's KeystoneForwarder. Arc testnet's markets resolve through it.
   */
  chainlinkCreOracle: string;
  usdc: string;
  identityRegistry: string;
  reputationRegistry: string;
  validationRegistry: string;
  storkOracle: string;
}

export const ARC_TESTNET_ADDRESSES: ContractAddresses = {
  // From deployments/arc-testnet.json, carried here by scripts/wire-deployment.mjs.
  vestedParimutuel: '0xC743940C75619f65F6178b7e49c0C3A0bE012Eec',
  classicParimutuel: '0x21603b2176aB8495A81fF3B3bE853C64f3860D57',
  marketFactory: '0x0380C6FC136AE64432558e407706a5C7E7652f07',
  feedResolver: '0xd9Fde9112a5dE78075fae334D8A9a67fDcAee3f3',
  priceOracle: '0x5938F12246642aE8E6A47Efbaa72a454EafD4287',
  chainlinkCreOracle: '0x68A79146C52dcA1cBea8a0Da9aCF506D5894c621',
  usdc: ARC_USDC,
  // ERC-8004 registries are live on Arc testnet and are not ours to deploy.
  identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  validationRegistry: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
  storkOracle: '0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62',
};

/**
 * Arc mainnet.
 *
 * **Every one of ours is a placeholder, and so are the ERC-8004 registries.**
 * The registries have published addresses on *testnet*; no mainnet address has
 * been verified for this repo, and guessing one would point the agents page at
 * whatever happens to sit there. Absence is the honest state — `isDeployed`
 * turns each of these into a "not deployed" badge rather than a dead link.
 */
export const ARC_MAINNET_ADDRESSES: ContractAddresses = {
  vestedParimutuel: UNDEPLOYED,
  classicParimutuel: UNDEPLOYED,
  marketFactory: UNDEPLOYED,
  feedResolver: UNDEPLOYED,
  priceOracle: UNDEPLOYED,
  // Arc mainnet has Chainlink Data Feeds of its own, so it reads them directly and needs no relay.
  chainlinkCreOracle: UNDEPLOYED,
  // USDC is at the same predeploy address on both Arc chains: it is the native
  // gas token exposed through an ERC-20 interface, not a deployed token.
  usdc: ARC_USDC,
  identityRegistry: UNDEPLOYED,
  reputationRegistry: UNDEPLOYED,
  validationRegistry: UNDEPLOYED,
  // Stork publishes an Arc *testnet* address. Nothing is published for mainnet
  // that this repo has verified, so it is not guessed.
  storkOracle: UNDEPLOYED,
};

/** The two networks this surface can transact on, as one lookup. */
export type NetworkId = 'testnet' | 'mainnet';

export const NETWORKS: Record<NetworkId, { facts: ChainFacts; addresses: ContractAddresses }> = {
  testnet: { facts: ARC_TESTNET, addresses: ARC_TESTNET_ADDRESSES },
  mainnet: { facts: ARC_MAINNET, addresses: ARC_MAINNET_ADDRESSES },
};

export function networkForChainId(chainId: number): NetworkId | null {
  if (chainId === ARC_TESTNET.id) return 'testnet';
  if (chainId === ARC_MAINNET.id) return 'mainnet';
  return null;
}

export function isDeployed(address: string): boolean {
  return address.toLowerCase() !== UNDEPLOYED;
}

/**
 * An explorer URL, or `null` when there is nothing worth linking to: a zero
 * placeholder, or a chain whose explorer we have not verified. Returning
 * `null` lets the caller render plain text instead of a link that 404s.
 */
export function addressExplorerUrl(address: string, chain: ChainFacts = ARC_TESTNET): string | null {
  if (chain.explorerUrl === '' || !isDeployed(address)) return null;
  return `${chain.explorerUrl}/address/${address}`;
}

export function txExplorerUrl(hash: string, chain: ChainFacts = ARC_TESTNET): string | null {
  if (chain.explorerUrl === '') return null;
  return `${chain.explorerUrl}/tx/${hash}`;
}
