'use client';

// S7: replace this placeholder with the real wallet control (wagmi connectors; connect, then
// add-then-switch to chain 4663; balance chip once connected). Keep the export name so the header
// does not change.

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';

import { buttonClass } from '@/components/ui/primitives';

/**
 * The header's wallet slot, before the venue is live.
 *
 * It looks like the Connect button it will become (secondary outline: the page's one solid
 * accent belongs to its primary action), and says honestly what connecting does today: nothing
 * yet, because betting opens with the venue launch. It points at the setup guide instead.
 */
export function ConnectSlot() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);

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

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={buttonClass('secondary', 'sm', 'px-3.5')}
      >
        Connect
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Wallet"
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-[min(300px,calc(100vw-32px))] rounded-card border border-edge-strong bg-[#111114] p-4"
        >
          <p className="text-sm font-semibold text-paper">Betting opens with the venue launch.</p>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Get ready now: USDG on Robinhood Chain and a wallet that can switch to it. No ETH needed to bet.
          </p>
          <Link
            href="/start"
            onClick={() => setOpen(false)}
            className={buttonClass('secondary', 'sm', 'mt-4 w-full')}
          >
            Get set up in 2 minutes
          </Link>
        </div>
      ) : null}
    </div>
  );
}
