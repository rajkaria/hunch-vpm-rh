/**
 * The wallet module, loaded on demand (see `bridge.ts`): a wagmi config for Robinhood Chain
 * (chain 4663, the browser RPC), its connectors, and the actions the bet panel, the positions
 * panel and the resolution panel take. Reads (balances, allowances, receipts) go through a
 * public client for chain 4663 whatever chain the wallet is on.
 */

import { CHAIN_ID, makePublicClient, usdgAbi, USDG_ADDRESS, type EnterAuthorization } from '@hunch-rh/client';
import type { Abi, Address, Hex, PublicClient } from 'viem';
import { createConfig, createStorage, http, type Config, type Connector } from 'wagmi';
import { connect, disconnect, getAccount, reconnect, signTypedData, simulateContract, switchChain, watchAccount, watchConnectors, writeContract } from 'wagmi/actions';

import { rememberWallet, walletBridge } from './bridge';
import { buildConnectors } from './connectors';
import { BROWSER_RPC_URL, E2E_ENABLED, browserChain } from './env';
import { addThenSwitch, type Eip1193 } from './switch';

export interface WriteCall {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args: readonly unknown[];
}

export interface ConnectorChoice {
  uid: string;
  id: string;
  name: string;
  icon: string | null;
  type: string;
}

export interface WalletCore {
  config: Config;
  connectors(): ConnectorChoice[];
  watchConnectors(listener: (choices: ConnectorChoice[]) => void): () => void;
  connect(uid: string): Promise<void>;
  disconnect(): Promise<void>;
  switchToRobinhood(): Promise<void>;
  signTypedData(typedData: EnterAuthorization): Promise<Hex>;
  write(call: WriteCall): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<'success' | 'reverted'>;
  usdgBalance(owner: Address): Promise<bigint>;
  usdgAllowance(owner: Address, spender: Address): Promise<bigint>;
  authorizationUsed(owner: Address, nonce: Hex): Promise<boolean>;
}

let started: WalletCore | null = null;

function hasWindowEthereum(): boolean {
  return typeof window !== 'undefined' && typeof (window as { ethereum?: unknown }).ethereum === 'object';
}

/**
 * The connect list: every wallet that announced itself (EIP-6963), plus WalletConnect and
 * Coinbase Wallet; the generic browser wallet only when nothing announced itself but
 * `window.ethereum` exists.
 */
function choices(config: Config): ConnectorChoice[] {
  const all = config.connectors;
  const announced = all.filter((c) => c.type === 'injected' && c.id !== 'injected');
  return all
    .filter((c) => {
      if (c.id === 'injected') return announced.length === 0 && hasWindowEthereum();
      return true;
    })
    .map((c: Connector) => ({ uid: c.uid, id: c.id, name: c.id === 'injected' ? 'Browser wallet' : c.name, icon: c.icon ?? null, type: c.type }));
}

export function startWallet(): WalletCore {
  if (started !== null) return started;
  const config = createConfig({
    chains: [browserChain],
    connectors: buildConnectors(),
    transports: { [CHAIN_ID]: http(BROWSER_RPC_URL) },
    storage: createStorage({ storage: typeof window === 'undefined' ? undefined : window.localStorage, key: 'hunch-rh.wagmi' }),
    multiInjectedProviderDiscovery: true,
    ssr: false,
  });
  const reader = makePublicClient({ rpcUrl: BROWSER_RPC_URL, excludePublicRpc: E2E_ENABLED }) as unknown as PublicClient;

  const publish = (): void => {
    const account = getAccount(config);
    walletBridge.set({
      status: account.status,
      address: account.address ?? null,
      chainId: account.chainId ?? null,
      connectorName: account.connector?.name ?? null,
    });
  };
  watchAccount(config, {
    onChange(account, previous) {
      publish();
      if (account.status === 'connected' && previous.status !== 'connected') rememberWallet(true);
      if (account.status === 'disconnected' && previous.status === 'connected') rememberWallet(false);
    },
  });
  publish();
  void reconnect(config).finally(publish);

  const requireAccount = (): Address => {
    const account = getAccount(config);
    if (account.address === undefined) throw new Error('Connect a wallet first.');
    return account.address;
  };

  started = {
    config,
    connectors: () => choices(config),
    watchConnectors: (listener) => watchConnectors(config, { onChange: () => listener(choices(config)) }),
    async connect(uid) {
      const connector = config.connectors.find((c) => c.uid === uid);
      if (connector === undefined) throw new Error('That wallet is no longer available. Pick another.');
      await connect(config, { connector });
      publish();
    },
    async disconnect() {
      await disconnect(config);
      rememberWallet(false);
      publish();
    },
    async switchToRobinhood() {
      const account = getAccount(config);
      if (account.connector === undefined) throw new Error('Connect a wallet first.');
      if (account.chainId === CHAIN_ID) return;
      const provider = (await account.connector.getProvider()) as Eip1193 | undefined;
      if (provider !== undefined && typeof provider.request === 'function' && account.connector.type !== 'walletConnect') {
        await addThenSwitch(provider);
      } else {
        await switchChain(config, { chainId: CHAIN_ID });
      }
      publish();
    },
    async signTypedData(typedData) {
      const account = requireAccount();
      return signTypedData(config, { account, ...typedData } as never);
    },
    async write(call) {
      const account = requireAccount();
      const { request } = await simulateContract(config, { ...call, account, chainId: CHAIN_ID } as never);
      return writeContract(config, request as never);
    },
    async waitForReceipt(hash) {
      const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
      return receipt.status === 'success' ? 'success' : 'reverted';
    },
    async usdgBalance(owner) {
      return reader.readContract({ address: USDG_ADDRESS, abi: usdgAbi, functionName: 'balanceOf', args: [owner] });
    },
    async usdgAllowance(owner, spender) {
      return reader.readContract({ address: USDG_ADDRESS, abi: usdgAbi, functionName: 'allowance', args: [owner, spender] });
    },
    async authorizationUsed(owner, nonce) {
      return reader.readContract({ address: USDG_ADDRESS, abi: usdgAbi, functionName: 'authorizationState', args: [owner, nonce] });
    },
  };
  return started;
}
