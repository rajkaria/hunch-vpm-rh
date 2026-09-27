/**
 * Add Robinhood Chain to a wallet, then switch to it (docs/spec/05 §Wallets). Adding first means
 * wallets that never answer "unknown chain" (4902) still get the add call; a wallet that already
 * knows the chain treats the add as a no-op or a switch prompt. Both calls are free and send no
 * transaction.
 */

import { addChainParameters, CHAIN_ID } from '@hunch-rh/client';

import { isUnknownChain, isUserRejection } from './errors';

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}

export const CHAIN_ID_HEX = `0x${CHAIN_ID.toString(16)}`;

export async function addThenSwitch(provider: Eip1193, params = addChainParameters()): Promise<void> {
  try {
    await provider.request({ method: 'wallet_addEthereumChain', params: [params] });
  } catch (error) {
    if (isUserRejection(error)) throw error;
    // Some wallets refuse to re-add a chain they know, or do not implement the call; the switch decides.
  }
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
  } catch (error) {
    if (!isUnknownChain(error)) throw error;
    await provider.request({ method: 'wallet_addEthereumChain', params: [params] });
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
  }
}
