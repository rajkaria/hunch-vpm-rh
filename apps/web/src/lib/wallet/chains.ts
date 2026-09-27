import { defineChain } from 'viem';

import { ARC_MAINNET, ARC_TESTNET, type ChainFacts, type NetworkId } from '@/lib/chain';

/*
 * Arc as viem chains.
 *
 * Two facts about this chain drive everything below and are easy to get wrong:
 *
 * 1. **USDC is the native gas token, and it has two views of ONE balance.**
 *    Natively — `eth_getBalance`, `msg.value`, gas — it is **18 decimals**.
 *    Through the ERC-20 interface at `0x3600…0000` — `balanceOf`, `approve`,
 *    `transferFrom`, which is how every stake in this protocol moves — it is
 *    **6 decimals**. Same money, raw values off by exactly 10^12. Verified on
 *    Arc testnet: one holder reads 3,141,473,534,331 through `balanceOf` and
 *    3,141,473,534,331,000,000,000,000 through `eth_getBalance`.
 *    `nativeCurrency` describes the NATIVE view, so it is 18 here; amounts
 *    the app stakes use `USDC_DECIMALS` (6) in `lib/units.ts`. Declaring 6 here
 *    — which this file used to — makes a wallet show gas off by 10^12.
 * 2. **Neither chain id ships in any wallet.** 5042002 and 5042 are unknown to
 *    MetaMask and to every other injected provider, so connecting is never
 *    enough on its own — the app has to be able to *add* the chain, which is
 *    why `rpcUrls` and `blockExplorers` are populated rather than left to the
 *    wallet to already know.
 *
 * The RPC URL is overridable from the environment because a public endpoint
 * may be rate limited and an operator will want their own. It is a URL and not
 * a secret — unless a provider embeds a key in it, which is why it is read from
 * a `NEXT_PUBLIC_` variable only as a last resort and defaults to the public one.
 */

// Circle's published primary testnet endpoint (docs.arc.io). The older
// rpc.testnet.arc.network still answers chain 5042002, but .io is the one the
// docs name now.
const ARC_TESTNET_RPC =
  process.env['NEXT_PUBLIC_ARC_TESTNET_RPC_URL'] ?? 'https://rpc.testnet.arc.io';

/*
 * No default for mainnet, on purpose. Arc's public mainnet opens 16 September
 * 2026 and Circle publishes the official RPC then; the value that used to sit
 * here was a guess nobody had checked. Until NEXT_PUBLIC_ARC_RPC_URL is set,
 * mainnet can be selected and read about but a wallet cannot be asked to add
 * it, and the UI says so.
 */
export const ARC_MAINNET_RPC = process.env['NEXT_PUBLIC_ARC_RPC_URL'] ?? '';

function nativeUsdc() {
  // Named "USD Coin" rather than "Ether" so a wallet's send screen does not lie
  // about what the user is spending.
  // 18: this is the NATIVE view of USDC. See the note at the top of the file.
  return { name: 'USD Coin', symbol: 'USDC', decimals: 18 } as const;
}

export const arcTestnetChain = defineChain({
  id: ARC_TESTNET.id,
  name: ARC_TESTNET.name,
  nativeCurrency: nativeUsdc(),
  rpcUrls: { default: { http: [ARC_TESTNET_RPC] } },
  blockExplorers: {
    default: { name: 'Arcscan', url: ARC_TESTNET.explorerUrl },
  },
  testnet: true,
});

export const arcMainnetChain = defineChain({
  id: ARC_MAINNET.id,
  name: ARC_MAINNET.name,
  nativeCurrency: nativeUsdc(),
  rpcUrls: { default: { http: ARC_MAINNET_RPC === '' ? [] : [ARC_MAINNET_RPC] } },
  // No mainnet explorer has been verified for this repo, so none is declared
  // rather than guessed — `addressExplorerUrl` suppresses those links already.
  testnet: false,
});

/**
 * Both chains, addressable by network id.
 *
 * The surface used to pick one at build time. It now carries both and the
 * viewer chooses — but *chooses explicitly*, and the choice is stored. A venue
 * that silently follows whatever chain the wallet happens to be on is a venue
 * that will eventually send an approval to the wrong USDC, so `wrongChain`
 * still means "your wallet disagrees with what you selected here".
 */
export const CHAINS: Record<NetworkId, typeof arcTestnetChain | typeof arcMainnetChain> = {
  testnet: arcTestnetChain,
  mainnet: arcMainnetChain,
};

/**
 * Which network a fresh visitor lands on.
 *
 * Testnet unless the deployment says otherwise, so a misconfigured build cannot
 * put someone on mainnet without anyone having decided to.
 */
export const DEFAULT_NETWORK: NetworkId =
  process.env['NEXT_PUBLIC_ARC_NETWORK'] === 'mainnet' ? 'mainnet' : 'testnet';

/** Kept for callers that only need the default; prefer `useNetwork()`. */
export const ACTIVE_CHAIN = DEFAULT_NETWORK === 'mainnet' ? arcMainnetChain : arcTestnetChain;
export const ACTIVE_CHAIN_FACTS: ChainFacts =
  DEFAULT_NETWORK === 'mainnet' ? ARC_MAINNET : ARC_TESTNET;

/**
 * Where an empty wallet is sent for testnet USDC.
 *
 * USDC is the gas token on Arc, which makes an empty wallet a hard stop rather
 * than an inconvenience: there is no transaction it can send to get started,
 * including the one that would fund it. So the empty-balance state has to hand
 * the visitor somewhere to go.
 *
 * No default. A faucet link that 404s teaches someone the site is broken, and
 * the right URL is deployment-specific — when it is unset the UI states the
 * problem without inventing a destination.
 */
export const FAUCET_URL = process.env['NEXT_PUBLIC_ARC_FAUCET_URL'] ?? '';
