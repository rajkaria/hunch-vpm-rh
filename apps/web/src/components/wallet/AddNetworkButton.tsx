'use client';

import { CHAIN_ID } from '@hunch-rh/client';
import { useCallback, useEffect, useState } from 'react';

import { buttonClass } from '@/components/ui/primitives';
import { trackEvent } from '@/lib/wallet/analytics';
import { describeWalletError } from '@/lib/wallet/errors';
import { useWalletPort } from '@/lib/wallet/port';

type State = { kind: 'idle' } | { kind: 'waiting-for-wallet' } | { kind: 'working' } | { kind: 'done' } | { kind: 'error'; message: string };

/**
 * Adds Robinhood Chain to a wallet and switches to it, through the same wallet connection the
 * bet panel uses: connect first if needed, then add, then switch (a wallet that never answers
 * "unknown chain" still gets the add). Adding and switching a network costs nothing and sends no
 * transaction.
 */
export function AddNetworkButton() {
  const wallet = useWalletPort();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const onChain = wallet.status === 'connected' && wallet.chainId === CHAIN_ID;

  const run = useCallback(async (): Promise<void> => {
    setState({ kind: 'working' });
    try {
      await wallet.switchToRobinhood();
      trackEvent('switch_chain', { from: 'start' });
      setState({ kind: 'done' });
    } catch (error) {
      setState({ kind: 'error', message: describeWalletError(error).message });
    }
  }, [wallet]);

  // After the wallet list connects a wallet, carry on with the add and switch.
  useEffect(() => {
    if (state.kind === 'waiting-for-wallet' && wallet.status === 'connected') void run();
  }, [state.kind, wallet.status, run]);

  const onClick = (): void => {
    if (wallet.status !== 'connected') {
      setState({ kind: 'waiting-for-wallet' });
      wallet.openConnect();
      return;
    }
    void run();
  };

  const label = onChain
    ? 'Robinhood Chain is selected'
    : state.kind === 'working'
      ? 'Check your wallet'
      : state.kind === 'waiting-for-wallet'
        ? 'Pick your wallet'
        : 'Add Robinhood Chain to my wallet';

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={state.kind === 'working' || onChain}
        className={buttonClass('secondary', 'md', 'disabled:cursor-default disabled:opacity-70')}
      >
        {label}
      </button>
      <p className="mt-2 min-h-5 text-sm text-muted" role="status" aria-live="polite">
        {onChain || state.kind === 'done'
          ? 'Robinhood Chain is in your wallet and selected.'
          : state.kind === 'error'
            ? state.message
            : 'Free: adding and switching networks sends no transaction.'}
      </p>
    </div>
  );
}
