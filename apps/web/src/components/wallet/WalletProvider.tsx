'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { WagmiProvider } from 'wagmi';

import type { NetworkId } from '@/lib/chain';
import { walletConfig } from '@/lib/wallet/config';
import { NetworkProvider } from '@/lib/wallet/network';

/**
 * The wallet context, mounted once at the root.
 *
 * Everything under it is still server-rendered; this provider only gives the
 * client components that need an account somewhere to read it from. The pages
 * render on the server for the network in the viewer's cookie, and the wallet is
 * a client island on top of them.
 */
export function WalletProvider({
  children,
  initialNetwork,
}: {
  children: React.ReactNode;
  initialNetwork?: NetworkId | undefined;
}) {
  // One QueryClient per browser session. Created in state rather than at module
  // scope so a server render never shares a cache between two users.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Chain reads are cheap to repeat and expensive to show stale: a
            // balance or an allowance that is one minute old is a failed
            // transaction the user does not understand.
            staleTime: 10_000,
            retry: 1,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={walletConfig()}>
      <QueryClientProvider client={queryClient}>
        {/* Network selection sits inside wagmi so `useWallet` can compare the
            viewer's choice against the wallet's actual chain. */}
        <NetworkProvider initialNetwork={initialNetwork}>{children}</NetworkProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
