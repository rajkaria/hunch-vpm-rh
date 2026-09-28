import { keccak256, toBytes, type Address, type Hex } from 'viem';

/**
 * Chain-level constants for Hunch on Robinhood Chain. Every value here was checked
 * against chain 4663 (see docs/spec/08-deployment.md) and none of them depends on a
 * Hunch deployment; addresses of Hunch's own contracts live in
 * `deployments/robinhood-mainnet.json` and are read through `loadDeployment()`.
 */

export const CHAIN_ID = 4663 as const;

export const PUBLIC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
export const EXPLORER_URL = 'https://robinhoodchain.blockscout.com';

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/** Paxos Global Dollar on Robinhood Chain (UUPS proxy, 6 decimals, EIP-2612 + EIP-3009). */
export const USDG_ADDRESS: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const USDG_DECIMALS = 6;
/** One USDG in base units. */
export const ONE_USDG = 1_000_000n;

/**
 * USDG's EIP-712 domain. USDG has no `eip712Domain()` (EIP-5267), so wallets cannot
 * discover it: it is hardcoded here and `usdgDomainSeparator()` is tested to hash to
 * the on-chain `DOMAIN_SEPARATOR()`.
 */
export const USDG_EIP712_DOMAIN = {
  name: 'Global Dollar',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: USDG_ADDRESS,
} as const;

/** `USDG.DOMAIN_SEPARATOR()` on chain 4663, read and recomputed 2026-09-27. */
export const USDG_DOMAIN_SEPARATOR: Hex = '0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036';

export const MULTICALL3_ADDRESS: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** Chainlink equity feeds on chain 4663 report 8 decimals. */
export const PRICE_DECIMALS = 8;
/**
 * The resolver's sanity band for an answer: `0 < answer < 1e14` at 8 decimals. SPY's
 * first rounds hold 18-decimal garbage, so no historical round is trusted blindly.
 */
export const PRICE_SANITY_MAX = 10n ** 14n;

/** Outcome indices. Outcome 0 is UP, outcome 1 is DOWN, everywhere. */
export const UP = 0 as const;
export const DOWN = 1 as const;
export type Outcome = typeof UP | typeof DOWN;
export type Side = 'UP' | 'DOWN';
export const OUTCOMES: readonly Outcome[] = [UP, DOWN];

export function sideOf(outcome: number): Side {
  if (outcome === UP) return 'UP';
  if (outcome === DOWN) return 'DOWN';
  throw new RangeError(`not a binary outcome: ${outcome}`);
}

export function outcomeOf(side: Side): Outcome {
  return side === 'UP' ? UP : DOWN;
}

export function opposite(outcome: Outcome): Outcome {
  return outcome === UP ? DOWN : UP;
}

/** Fixed-point scale S of the settler's accumulator (`VestedParimutuel.SCALE`). */
export const SCALE = 10n ** 18n;
/** The settler's sentinel for an unbounded kappa / capacity (`type(uint256).max`). */
export const KAPPA_UNBOUNDED = 2n ** 256n - 1n;

/** `HunchVPM.Status` */
export const MARKET_STATUS = { Open: 0, Resolved: 1, Voided: 2 } as const;
export type MarketStatusCode = (typeof MARKET_STATUS)[keyof typeof MARKET_STATUS];

/** `StockRoundResolver.preview` status codes. */
export const PREVIEW_STATUS = {
  NOT_READY: 0,
  UP: 1,
  DOWN: 2,
  FLAT: 3,
  STALE: 4,
  BADPROOF: 5,
  PAUSED: 6,
  BADANSWER: 7,
} as const;
export type PreviewStatusCode = (typeof PREVIEW_STATUS)[keyof typeof PREVIEW_STATUS];
export const PREVIEW_STATUS_NAME: Record<number, keyof typeof PREVIEW_STATUS> = {
  0: 'NOT_READY',
  1: 'UP',
  2: 'DOWN',
  3: 'FLAT',
  4: 'STALE',
  5: 'BADPROOF',
  6: 'PAUSED',
  7: 'BADANSWER',
};

/** `StockRoundResolver.Resolved.outcome`: 0 UP, 1 DOWN, 2 FLAT. */
export const RESOLVED_OUTCOME = { UP: 0, DOWN: 1, FLAT: 2 } as const;

/** `keccak256("HunchEnter(uint256 marketId,uint8 outcome,uint256 amount,bytes32 salt)")` */
export const ENTER_TYPEHASH: Hex = keccak256(
  toBytes('HunchEnter(uint256 marketId,uint8 outcome,uint256 amount,bytes32 salt)'),
);

/**
 * Stock Tokens "may not be offered, sold, or delivered" in the United States or to US
 * persons, and restrictions also apply in Canada, the UK and Switzerland. ISO 3166-1
 * alpha-2 codes, as Vercel's `x-vercel-ip-country` reports them.
 */
export const RESTRICTED_COUNTRIES = ['US', 'CA', 'GB', 'CH'] as const;
export type RestrictedCountry = (typeof RESTRICTED_COUNTRIES)[number];

export function isRestrictedCountry(code: string | null | undefined): boolean {
  if (code === null || code === undefined) return false;
  return (RESTRICTED_COUNTRIES as readonly string[]).includes(code.trim().toUpperCase());
}

/** A drill market is one whose final reading may be at most an hour old (04 §Catalogue). */
export const DRILL_MAX_FINAL_AGE = 3600;
/** v1 age bound for weekday windows: the 24 h heartbeat plus 2 h. */
export const DEFAULT_MAX_AGE = 93_600;
