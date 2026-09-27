'use client';

import { useEffect, useRef } from 'react';

import { switchPromptKey, useWallet } from '@/lib/wallet/useWallet';

/**
 * One line, site-wide, when the connected wallet is on the wrong chain.
 *
 * The header's own control already offers to switch, but the header is one
 * small control and this is a state that silently invalidates every
 * transactional affordance on the page. Arc's chain id ships in no wallet, so
 * arriving connected-but-elsewhere is the *likely* path, not an edge case —
 * and someone who does not notice will read a disabled button as a broken site.
 *
 * Renders nothing in every other state, including disconnected: "connect a
 * wallet" belongs where the action is, not in a bar across the top of a page
 * somebody may only be reading.
 */
export function NetworkBanner() {
  const wallet = useWallet();

  /*
   * Open the wallet's own switch prompt as soon as a wrong chain is seen.
   *
   * This banner is mounted exactly once, in the root layout, which makes it the
   * one place this can live without two components racing to open two popups.
   * `switchPromptKey` limits it to once per (account, wallet chain, selected
   * chain), so a dismissed prompt stays dismissed until something changes — the
   * banner and every send button still offer the switch after that.
   */
  const prompted = useRef<string | null>(null);
  const key = switchPromptKey(wallet);
  const { switchToActive } = wallet;
  useEffect(() => {
    if (key === null || prompted.current === key) return;
    prompted.current = key;
    switchToActive();
  }, [key, switchToActive]);

  if (!wallet.wrongChain) return null;

  return (
    <div
      role="status"
      className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-coral/35 bg-coral/10 px-4 py-3 text-sm"
    >
      <span className="inline-flex items-center rounded-tag border border-coral/35 bg-coral/10 px-2.5 py-1 text-[11px] leading-none font-semibold tracking-[0.05em] text-coral uppercase">
        Wrong network
      </span>
      <span className="text-muted">
        Your wallet is on another chain. Everything here settles on {wallet.chainName}, and nothing
        can be sent until you switch.
        {wallet.canSwitch
          ? ''
          : ` ${wallet.chainName} has no public RPC yet, so your wallet cannot be asked to add it.`}
      </span>
      <button
        type="button"
        onClick={wallet.switchToActive}
        disabled={wallet.switching || !wallet.canSwitch}
        className="ml-auto shrink-0 rounded-pill bg-coral px-3.5 py-1.5 text-[13px] font-semibold text-ink transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {wallet.switching ? 'Check your wallet…' : `Switch to ${wallet.chainName}`}
      </button>
    </div>
  );
}
