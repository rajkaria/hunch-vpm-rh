'use client';

// S7: may move onto the wagmi connector (useSwitchChain with add-then-switch); keep the same
// behaviour: add first (wallets that never return 4902 still get the add call), then switch.

import { useState } from 'react';

import { buttonClass } from '@/components/ui/primitives';
import { ROBINHOOD_CHAIN } from '@/lib/site';

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

type State = { kind: 'idle' } | { kind: 'working' } | { kind: 'done' } | { kind: 'no-wallet' } | { kind: 'error'; message: string };

function provider(): Eip1193 | null {
  const candidate = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  return candidate !== undefined && typeof candidate.request === 'function' ? candidate : null;
}

function describe(error: unknown): string {
  const code = (error as { code?: number } | null)?.code;
  if (code === 4001) return 'You declined in your wallet. Nothing changed; try again when ready.';
  if (code === -32002) return 'Your wallet already has a request open. Check it, then try again.';
  return 'Your wallet did not add the network. Add it by hand with the details above.';
}

/**
 * Adds Robinhood Chain to a browser wallet and switches to it. Adding and switching a network
 * costs nothing and sends no transaction.
 */
export function AddNetworkButton() {
  const [state, setState] = useState<State>({ kind: 'idle' });

  const add = async (): Promise<void> => {
    const wallet = provider();
    if (wallet === null) {
      setState({ kind: 'no-wallet' });
      return;
    }
    setState({ kind: 'working' });
    try {
      await wallet.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: ROBINHOOD_CHAIN.idHex,
            chainName: ROBINHOOD_CHAIN.name,
            nativeCurrency: ROBINHOOD_CHAIN.currency,
            rpcUrls: [ROBINHOOD_CHAIN.rpcUrl],
            blockExplorerUrls: [ROBINHOOD_CHAIN.explorerUrl],
          },
        ],
      });
      await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ROBINHOOD_CHAIN.idHex }] });
      setState({ kind: 'done' });
    } catch (error) {
      setState({ kind: 'error', message: describe(error) });
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => void add()}
        disabled={state.kind === 'working'}
        className={buttonClass('secondary', 'md', 'disabled:cursor-wait disabled:opacity-60')}
      >
        {state.kind === 'working' ? 'Check your wallet' : state.kind === 'done' ? 'Added to your wallet' : 'Add Robinhood Chain to my wallet'}
      </button>
      <p className="mt-2 min-h-5 text-sm text-muted" role="status" aria-live="polite">
        {state.kind === 'done'
          ? 'Robinhood Chain is in your wallet and selected.'
          : state.kind === 'no-wallet'
            ? 'No browser wallet found here. Open this page in MetaMask or Rabby, or add the network by hand with the details above.'
            : state.kind === 'error'
              ? state.message
              : 'Free: adding and switching networks sends no transaction.'}
      </p>
    </div>
  );
}
