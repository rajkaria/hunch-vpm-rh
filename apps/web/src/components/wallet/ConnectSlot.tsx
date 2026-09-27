'use client';

import { CHAIN_ID, formatUsdg } from '@hunch-rh/client';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';

import { buttonClass } from '@/components/ui/primitives';
import { shortAddress } from '@/lib/units';
import { trackEvent } from '@/lib/wallet/analytics';
import { describeWalletError } from '@/lib/wallet/errors';
import { useWalletPort } from '@/lib/wallet/port';

/**
 * The header's wallet control. Before anyone connects it is a plain Connect button and no wallet
 * code has loaded; pressing it loads the wallet list. Once connected it shows the address, says
 * so when the wallet is on another network, and opens a small menu: switch to Robinhood Chain,
 * the USDG balance on Robinhood Chain, your positions, disconnect.
 */
export function ConnectSlot() {
  const wallet = useWalletPort();
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const address = wallet.address;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || address === null) return;
    let cancelled = false;
    wallet
      .usdgBalance(address)
      .then((value) => !cancelled && setBalance(value))
      .catch(() => !cancelled && setBalance(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read when the menu opens or the account changes
  }, [open, address]);

  if (wallet.status !== 'connected' || address === null) {
    const busy = wallet.status === 'connecting' || wallet.status === 'reconnecting';
    return (
      <button type="button" onClick={() => wallet.openConnect()} className={buttonClass('secondary', 'sm', 'px-3.5')} aria-busy={busy || undefined}>
        {busy ? 'Connecting' : 'Connect'}
      </button>
    );
  }

  const wrongNetwork = wallet.chainId !== CHAIN_ID;
  const doSwitch = async (): Promise<void> => {
    setSwitching(true);
    setMessage(null);
    try {
      await wallet.switchToRobinhood();
      trackEvent('switch_chain', { from: 'header' });
    } catch (error) {
      setMessage(describeWalletError(error).message);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={buttonClass('secondary', 'sm', 'gap-2 px-3')}
      >
        <span aria-hidden className={`h-1.5 w-1.5 rounded-pill ${wrongNetwork ? 'bg-coral' : 'bg-lime'}`} />
        <span className="num">{shortAddress(address)}</span>
        {wrongNetwork ? <span className="sr-only"> (wrong network)</span> : null}
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Wallet"
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-[min(300px,calc(100vw-32px))] rounded-card border border-edge-strong bg-[#111114] p-4"
        >
          <p className="text-[11px] text-faint">{wallet.connectorName ?? 'Wallet'}</p>
          <p className="num mt-1 break-hash text-sm text-paper">{address}</p>
          {wrongNetwork ? (
            <div className="mt-3">
              <p className="text-sm text-muted">Your wallet is on another network. Bets are signed on Robinhood Chain; switching is free.</p>
              <button type="button" onClick={() => void doSwitch()} disabled={switching} className={buttonClass('primary', 'sm', 'mt-3 w-full disabled:opacity-60')}>
                {switching ? 'Check your wallet' : 'Switch to Robinhood Chain'}
              </button>
            </div>
          ) : null}
          <div className="mt-4 border-t border-edge pt-3">
            <p className="text-[11px] text-faint">USDG on Robinhood Chain</p>
            <p className="num mt-1 text-sm text-paper">{balance === null ? 'Reading…' : `${formatUsdg(balance)} USDG`}</p>
          </div>
          <p className="mt-2 min-h-5 text-xs text-coral" role="status">
            {message}
          </p>
          <div className="mt-2 grid gap-2">
            <Link href="/portfolio" onClick={() => setOpen(false)} className={buttonClass('secondary', 'sm', 'w-full')}>
              Your positions
            </Link>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void wallet.disconnect();
              }}
              className={buttonClass('ghost', 'sm', 'w-full')}
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
