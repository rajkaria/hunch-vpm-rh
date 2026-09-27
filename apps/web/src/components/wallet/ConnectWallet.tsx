'use client';

import { useEffect, useRef, useState } from 'react';

import { truncateAddress, useWallet } from '@/lib/wallet/useWallet';
import { hasWalletConnect } from '@/lib/wallet/config';

/*
 * The header's wallet control.
 *
 * Three states, and each one is a different shape so the header never has to be
 * read twice: disconnected is the lime pill the product uses for its one call
 * to action, wrong-chain is a coral pill that says what to do, and connected is
 * the same quiet outlined pill the network chip already is.
 *
 * It renders nothing until mounted. wagmi resolves a stored connection on the
 * client, and a server render that guesses "disconnected" flashes the wrong
 * state into the most prominent control on the page.
 */
export function ConnectWallet() {
  const wallet = useWallet();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  if (!mounted) return <Placeholder />;

  if (wallet.wrongChain) {
    return (
      <button
        type="button"
        onClick={wallet.switchToActive}
        disabled={wallet.switching}
        className="shrink-0 rounded-pill border border-coral/40 bg-coral/10 px-3.5 py-1.5 text-[13px] font-semibold text-coral transition-colors hover:bg-coral/15 disabled:opacity-60"
      >
        <span className="sm:hidden">{wallet.switching ? 'Switching…' : 'Switch network'}</span>
        <span className="hidden sm:inline">
          {wallet.switching ? 'Check your wallet…' : `Switch to ${wallet.chainName}`}
        </span>
      </button>
    );
  }

  if (wallet.address !== null) {
    return (
      <div ref={box} className="relative shrink-0">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-haspopup="menu"
          className="num flex items-center gap-2 rounded-pill border border-edge bg-ghost px-3 py-1.5 text-[11px] text-paper transition-colors hover:border-edge-strong"
        >
          <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-lime" />
          {truncateAddress(wallet.address)}
        </button>
        {open ? (
          <div
            role="menu"
            className="lift absolute right-0 z-50 mt-2 w-44 rounded-control border border-edge bg-ink p-1"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                wallet.disconnect();
                setOpen(false);
              }}
              className="w-full rounded-tag px-3 py-2 text-left text-sm text-muted transition-colors hover:bg-paper/6 hover:text-paper"
            >
              Disconnect
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  /*
   * Disconnected. Exactly one usable connector goes straight through; zero or
   * several open the menu. Zero has to open something — a lime button that
   * does nothing when a visitor without a wallet clicks it is the worst
   * outcome available, and it is what this did before the menu learned to
   * explain itself.
   */
  const only = wallet.connectors.length === 1 ? wallet.connectors[0] : undefined;

  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        onClick={() => (only ? only.connect() : setOpen((value) => !value))}
        disabled={wallet.connecting}
        aria-expanded={only ? undefined : open}
        aria-haspopup={only ? undefined : 'menu'}
        className="rounded-pill bg-lime px-4 py-1.5 text-[13px] font-semibold text-ink transition-colors hover:bg-lime/90 disabled:opacity-60"
      >
        <span className="sm:hidden">{wallet.connecting ? 'Connecting…' : 'Connect'}</span>
        <span className="hidden sm:inline">{wallet.connecting ? 'Connecting…' : 'Connect wallet'}</span>
      </button>

      {open && !only ? (
        <div
          role="menu"
          className="lift absolute right-0 z-50 mt-2 w-64 rounded-control border border-edge bg-ink p-1"
        >
          {wallet.noWallet ? (
            <div className="px-3 py-2.5">
              <p className="text-sm font-semibold text-paper">No wallet found</p>
              <p className="mt-1.5 text-xs leading-snug text-muted">
                Install a browser wallet to connect. Arc is not in any wallet by default — the
                site will offer to add it once you are connected.
              </p>
              <a
                href="https://ethereum.org/en/wallets/find-wallet/"
                target="_blank"
                rel="noreferrer noopener"
                className="mt-2.5 inline-block text-xs font-semibold text-lime hover:underline"
              >
                Find a wallet →
              </a>
            </div>
          ) : (
            wallet.connectors.map((connector) => (
              <button
                key={connector.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  connector.connect();
                  setOpen(false);
                }}
                className="w-full rounded-tag px-3 py-2 text-left text-sm text-muted transition-colors hover:bg-paper/6 hover:text-paper"
              >
                {connector.name}
              </button>
            ))
          )}
          {hasWalletConnect || wallet.noWallet ? null : (
            <p className="border-t border-edge px-3 py-2 text-[11px] leading-snug text-faint">
              Browser wallets only on this deployment — no WalletConnect project id is set.
            </p>
          )}
          {wallet.error === null ? null : (
            <p className="border-t border-edge px-3 py-2 text-[11px] leading-snug text-coral">
              {wallet.error}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Holds the control's width through the first paint so the header does not jump. */
function Placeholder() {
  return <div aria-hidden className="h-[30px] w-[92px] shrink-0 rounded-pill bg-paper/5 sm:w-[130px]" />;
}
