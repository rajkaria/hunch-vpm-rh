'use client';

import { useNetwork } from '@/lib/wallet/network';
import { useWallet } from '@/lib/wallet/useWallet';
import type { NetworkId } from '@/lib/chain';

const OPTIONS: { id: NetworkId; label: string; short: string }[] = [
  { id: 'testnet', label: 'Arc Testnet', short: 'Test' },
  { id: 'mainnet', label: 'Arc', short: 'Main' },
];

/**
 * Which Arc the surface is pointed at.
 *
 * A segmented control rather than a dropdown, because there are exactly two and
 * which one you are on is the single most consequential thing on this page —
 * one of them spends real money. Selecting mainnet is styled as a live state,
 * not a neutral one.
 *
 * Switching does NOT move the wallet on its own. It changes what this surface
 * targets, and if the wallet is then on the other chain that becomes a visible
 * wrong-chain state with a prompt. Silently switching someone's wallet is how
 * an approval lands on the wrong USDC.
 */
export function NetworkToggle() {
  const { network, setNetwork, hydrated } = useNetwork();
  const wallet = useWallet();

  if (!hydrated) {
    return <div aria-hidden className="h-[30px] w-[104px] shrink-0 rounded-pill bg-paper/5" />;
  }

  return (
    <div
      role="group"
      aria-label="Network"
      className="flex shrink-0 items-center gap-0.5 rounded-pill border border-edge bg-ghost p-0.5"
    >
      {OPTIONS.map((option) => {
        const active = option.id === network;
        const live = option.id === 'mainnet';
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            onClick={() => setNetwork(option.id)}
            title={
              live
                ? 'Arc mainnet — real USDC. The contracts are not audited.'
                : 'Arc testnet — test USDC, nothing at stake.'
            }
            className={`rounded-pill px-2.5 py-1 text-[11px] font-semibold transition-colors ${
              active
                ? live
                  ? 'bg-coral/20 text-coral'
                  : 'bg-paper/10 text-paper'
                : 'text-faint hover:text-muted'
            }`}
          >
            <span className="sm:hidden">{option.short}</span>
            <span className="hidden sm:inline">{option.label}</span>
          </button>
        );
      })}
      {wallet.wrongChain ? (
        <span
          aria-hidden
          title="Your wallet is on another chain"
          className="ml-1 mr-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-coral"
        />
      ) : null}
    </div>
  );
}
