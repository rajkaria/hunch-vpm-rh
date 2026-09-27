'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useWaitForTransactionReceipt, useWriteContract } from 'wagmi';

import { Button } from '@/components/ui/primitives';
import type { MarketDetail } from '@/lib/data/types';
import { settlerAbi } from '@/lib/wallet/abi';
import { friendlyError } from '@/lib/wallet/errors';
import { useNetwork } from '@/lib/wallet/network';
import { refreshPositions } from '@/lib/wallet/positions';
import { useWallet } from '@/lib/wallet/useWallet';

/**
 * Poking `finalizeVintage`, from wherever a buffered entry is on screen.
 *
 * It lives in two places — under a stake just sent, and under a position read
 * back from the index after a reload — so the call is written once. Once the
 * close confirms, the positions read is re-run so the entry's accepted and
 * refused figures replace "pending" as soon as the index has them.
 */
export function useCloseVintage(market: Pick<MarketDetail, 'settler' | 'onChainMarketId'>) {
  const wallet = useWallet();
  const { network } = useNetwork();
  const queryClient = useQueryClient();
  const finalize = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: finalize.data });
  const done = receipt.data !== undefined;

  useEffect(() => {
    if (done && wallet.address !== null) refreshPositions(queryClient, network, wallet.address);
  }, [done, wallet.address, network, queryClient]);

  return {
    done,
    sending: finalize.isPending,
    closing: receipt.isLoading,
    error: finalize.error,
    close: async () => {
      if (!(await wallet.ensureActiveChain())) return;
      finalize.writeContract({
        address: market.settler as `0x${string}`,
        abi: settlerAbi,
        functionName: 'finalizeVintage',
        args: [market.onChainMarketId],
        chainId: wallet.chainId,
      });
    },
  };
}

export function CloseVintageButton({ state }: { state: ReturnType<typeof useCloseVintage> }) {
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="w-full"
        disabled={state.sending || state.closing}
        onClick={state.close}
      >
        {state.sending ? 'Check your wallet…' : state.closing ? 'Closing the vintage…' : 'Close the vintage'}
      </Button>
      <p className="text-xs leading-snug text-faint">
        Only works from the next block onward, and anyone may call it — the next person to enter
        this market closes it for you. Doing it yourself just means not waiting.
      </p>
      {state.error === null || state.error === undefined ? null : (
        <p className="rounded-control border border-coral/35 bg-coral/10 px-3 py-2.5 text-sm leading-snug text-paper">
          {friendlyError(state.error)}
        </p>
      )}
    </>
  );
}
