'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import type { NetworkId } from '@/lib/chain';
import { useNetwork } from '@/lib/wallet/network';

/**
 * Re-renders the server half of the page when the network it was rendered for
 * is not the one the viewer has selected.
 *
 * That happens twice: when the toggle is flipped, and on a first visit where
 * the browser remembers a choice the server has not seen yet. The provider has
 * already written the cookie by the time `hydrated` or `network` changes, so a
 * refresh renders the right board. It does not loop: once the server renders
 * the selected network, `rendered` matches and nothing fires again.
 */
export function NetworkSync({ rendered }: { rendered: NetworkId }) {
  const { network, hydrated } = useNetwork();
  const router = useRouter();

  useEffect(() => {
    if (hydrated && network !== rendered) router.refresh();
  }, [hydrated, network, rendered, router]);

  return null;
}
