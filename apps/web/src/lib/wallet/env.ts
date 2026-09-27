/**
 * Browser wallet settings, all public (`NEXT_PUBLIC_*`, written literally so Next inlines them).
 * Nothing secret is ever read here.
 */

import { PUBLIC_RPC_URL, robinhoodChain } from '@hunch-rh/client';
import type { Address, Chain } from 'viem';

/** Optional public RPC for the browser (a public or domain-restricted key). Defaults to the public RPC. */
export const BROWSER_RPC_URL = (process.env.NEXT_PUBLIC_RH_RPC_URL ?? '').trim() || PUBLIC_RPC_URL;

/** Reown (WalletConnect) project id; the WalletConnect option appears only when it is set. */
export const WALLETCONNECT_PROJECT_ID = (process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '').trim();

/**
 * The E2E hook: a mock wallet (wagmi's `mock` connector over a local anvil, whose default
 * accounts are unlocked) so a browser run can connect, sign, relay and confirm without an
 * extension. Only when the build sets `NEXT_PUBLIC_E2E=1`; production builds never do.
 */
export const E2E_ENABLED = process.env.NEXT_PUBLIC_E2E === '1';

/** Anvil's first two default accounts (public test addresses from its well-known mnemonic). */
const ANVIL_ACCOUNTS: readonly Address[] = ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'];

export function e2eAccounts(raw: string | undefined = process.env.NEXT_PUBLIC_E2E_ACCOUNTS): readonly [Address, ...Address[]] {
  const parsed = (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part): part is Address => /^0x[0-9a-fA-F]{40}$/.test(part));
  const list = parsed.length > 0 ? parsed : ANVIL_ACCOUNTS;
  return [list[0]!, ...list.slice(1)];
}

/** Robinhood Chain as the browser uses it: the configured RPC first. */
export const browserChain: Chain = {
  ...robinhoodChain,
  rpcUrls: { default: { http: [BROWSER_RPC_URL] } },
};
