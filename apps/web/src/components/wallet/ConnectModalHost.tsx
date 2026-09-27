'use client';

import { lazy, Suspense, useEffect, useState } from 'react';

import { connectModal } from '@/lib/wallet/bridge';

const ConnectModal = lazy(() => import('./ConnectModal'));

/**
 * Mounted once in the root layout. It renders nothing, and loads nothing, until something asks
 * for the wallet list; then it loads the list (and the wallet code) on demand.
 */
export function ConnectModalHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => connectModal.subscribe(setOpen), []);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <ConnectModal onClose={() => connectModal.close()} />
    </Suspense>
  );
}
