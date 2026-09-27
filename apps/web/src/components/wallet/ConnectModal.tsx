'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { trackEvent } from '@/lib/wallet/analytics';
import { loadWallet } from '@/lib/wallet/bridge';
import type { ConnectorChoice, WalletCore } from '@/lib/wallet/core';
import { describeWalletError } from '@/lib/wallet/errors';
import { useWalletSnapshot } from '@/lib/wallet/port';

function WalletIcon({ choice }: { choice: ConnectorChoice }) {
  if (choice.icon !== null) {
    // eslint-disable-next-line @next/next/no-img-element -- a data: URI announced by the wallet itself
    return <img src={choice.icon} alt="" className="h-7 w-7 shrink-0 rounded-tag" />;
  }
  return (
    <span aria-hidden className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-tag border border-edge-strong bg-raised-2 text-[12px] font-semibold text-paper">
      {choice.name.slice(0, 1)}
    </span>
  );
}

/**
 * The wallet list. Every wallet that announced itself in this browser (EIP-6963) by name, then
 * WalletConnect (phone wallets) and Coinbase Wallet. Connecting is free and sends nothing.
 */
export default function ConnectModal({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [core, setCore] = useState<WalletCore | null>(null);
  const [choices, setChoices] = useState<ConnectorChoice[]>([]);
  const [pending, setPending] = useState<ConnectorChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wallet = useWalletSnapshot();

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    loadWallet()
      .then((loaded) => {
        if (cancelled) return;
        setCore(loaded);
        setChoices(loaded.connectors());
        off = loaded.watchConnectors(setChoices);
      })
      .catch(() => setError('The wallet list could not load. Check your connection and try again.'));
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [onClose]);

  useEffect(() => {
    if (wallet.status === 'connected' && pending !== null) {
      trackEvent('connect_wallet', { wallet: pending.name, kind: pending.type });
      onClose();
    }
  }, [wallet.status, pending, onClose]);

  const pick = async (choice: ConnectorChoice): Promise<void> => {
    if (core === null) return;
    setError(null);
    setPending(choice);
    try {
      await core.connect(choice.uid);
    } catch (reason) {
      setPending(null);
      setError(describeWalletError(reason).message);
    }
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
      <button type="button" aria-label="Close" tabIndex={-1} onClick={onClose} className="absolute inset-0 cursor-default bg-ink/85" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="lift relative w-full max-w-[420px] rounded-t-card border border-edge-strong bg-[#111114] p-4 outline-none sm:rounded-card sm:p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="font-body text-lg font-semibold tracking-normal text-paper">
              Connect a wallet
            </h2>
            <p className="mt-1 text-sm text-muted">Free, and it sends nothing. You need USDG on Robinhood Chain to bet; no ETH.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the wallet list"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control border border-edge text-paper hover:bg-paper/5"
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <ul className="mt-4 grid gap-2">
          {core === null && error === null ? (
            <li className="rounded-control border border-dashed border-edge px-3 py-4 text-sm text-muted">Finding wallets in this browser…</li>
          ) : null}
          {choices.map((choice) => (
            <li key={choice.uid}>
              <button
                type="button"
                onClick={() => void pick(choice)}
                disabled={pending !== null}
                className="flex min-h-12 w-full items-center gap-3 rounded-control border border-edge bg-ghost px-3 text-left text-[15px] font-semibold text-paper transition-colors hover:border-paper/20 hover:bg-paper/5 disabled:cursor-wait disabled:opacity-60"
              >
                <WalletIcon choice={choice} />
                <span className="min-w-0 flex-1 truncate">{choice.name}</span>
                {pending?.uid === choice.uid ? <span className="text-xs font-normal text-muted">Check your wallet</span> : null}
              </button>
            </li>
          ))}
          {core !== null && !choices.some((choice) => choice.type === 'injected' || choice.type === 'mock') ? (
            <li className="rounded-control border border-dashed border-edge px-3 py-3 text-sm leading-relaxed text-muted">
              No browser wallet found here. Open this page in MetaMask&rsquo;s or Rabby&rsquo;s browser, or install one of them
              {choices.some((choice) => choice.type === 'walletConnect') ? ', or use WalletConnect with a phone wallet' : ''}.
            </li>
          ) : null}
        </ul>

        <p className="mt-3 min-h-5 text-sm text-coral" role="alert">
          {error}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-faint">
          New to Robinhood Chain?{' '}
          <Link href="/start" onClick={onClose} className="text-muted underline decoration-edge-strong underline-offset-2 hover:text-paper">
            Get set up in 2 minutes
          </Link>
          .
        </p>
      </div>
    </div>,
    document.body,
  );
}
