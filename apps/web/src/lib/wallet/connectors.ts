/**
 * Which wallets the connect list offers. Browser wallets announce themselves over EIP-6963
 * (wagmi's `multiInjectedProviderDiscovery`, on by default), so MetaMask, Rabby and others each
 * appear by name; `injected()` covers an older wallet that only sets `window.ethereum`.
 * WalletConnect only when a Reown project id is configured. The mock wallet only in E2E builds.
 */

import type { CreateConnectorFn } from 'wagmi';
import { coinbaseWallet, injected, mock, walletConnect } from 'wagmi/connectors';

import { SITE_NAME, SITE_URL } from '@/lib/site';

import { E2E_ENABLED, WALLETCONNECT_PROJECT_ID, e2eAccounts } from './env';

export interface ConnectorOptions {
  e2e?: boolean;
  walletConnectProjectId?: string;
}

export function buildConnectors(options: ConnectorOptions = {}): CreateConnectorFn[] {
  const e2e = options.e2e ?? E2E_ENABLED;
  const projectId = options.walletConnectProjectId ?? WALLETCONNECT_PROJECT_ID;
  const connectors: CreateConnectorFn[] = [];
  if (e2e) connectors.push(mock({ accounts: e2eAccounts(), features: { reconnect: true } }));
  connectors.push(injected({ shimDisconnect: true }));
  if (projectId !== '') {
    connectors.push(
      walletConnect({
        projectId,
        showQrModal: true,
        metadata: {
          name: SITE_NAME,
          description: 'UP or DOWN on Robinhood Stock Tokens, in USDG on Robinhood Chain.',
          url: SITE_URL,
          icons: [`${SITE_URL}/icon-512.png`],
        },
      }),
    );
  }
  connectors.push(coinbaseWallet({ appName: SITE_NAME, appLogoUrl: `${SITE_URL}/icon-512.png`, preference: 'eoaOnly' }));
  return connectors;
}
