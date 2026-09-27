import { http, createConfig, createStorage, cookieStorage } from 'wagmi';
import { injected, walletConnect } from 'wagmi/connectors';

import { CHAINS } from './chains';

/**
 * The WalletConnect project id.
 *
 * There is deliberately **no default**. A project id is a credential, and a
 * placeholder that half-works is worse than an honest absence: without one the
 * app offers injected wallets only and says so, which is a working product for
 * anyone with MetaMask and an accurate statement for everyone else.
 */
/*
 * Defaults to the project id the parent product already ships. A WalletConnect
 * project id is public by design — it is in playhunch.xyz's own browser bundle,
 * which is where this one came from — so committing it publishes nothing that
 * was private. Override per deployment if you would rather the two surfaces
 * report separately.
 */
const HUNCH_WALLETCONNECT_PROJECT_ID = '34357d3c125c2bcf2ce2bc3309d98715';

export const WALLETCONNECT_PROJECT_ID =
  process.env['NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID'] ?? HUNCH_WALLETCONNECT_PROJECT_ID;

export const hasWalletConnect = WALLETCONNECT_PROJECT_ID !== '';

/**
 * One wagmi config for the app.
 *
 * `injected` with `shimDisconnect` so "disconnect" is honoured across reloads —
 * an injected provider has no concept of disconnecting, and without the shim a
 * user who disconnects is silently reconnected by the next page load.
 *
 * Built lazily and memoised: `createConfig` touches browser storage, and Next
 * evaluates this module during prerender where there is none.
 */
let cached: ReturnType<typeof build> | undefined;

function build() {
  const connectors = [
    injected({ shimDisconnect: true }),
    ...(hasWalletConnect
      ? [
          walletConnect({
            projectId: WALLETCONNECT_PROJECT_ID,
            showQrModal: true,
            metadata: {
              name: 'Hunch VPM',
              description: 'The vested parimutuel, on Arc.',
              url: 'https://vpm.playhunch.xyz',
              icons: ['https://vpm.playhunch.xyz/icon-192.png'],
            },
          }),
        ]
      : []),
  ];

  return createConfig({
    chains: [CHAINS.testnet, CHAINS.mainnet],
    connectors,
    // Cookie storage so a connected account survives a server render without
    // the header flashing "Connect wallet" on every navigation.
    storage: createStorage({ storage: cookieStorage }),
    ssr: true,
    transports: { [CHAINS.testnet.id]: http(), [CHAINS.mainnet.id]: http() },
  });
}

export function walletConfig() {
  cached ??= build();
  return cached;
}
