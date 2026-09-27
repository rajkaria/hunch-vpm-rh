import {
  PUBLIC_RPC_URL,
  makePublicClient,
  makeRedactor,
  redactRpcUrl,
  robinhoodChain,
  urlSecrets,
  type Deployment,
  type HunchPublicClient,
} from '@hunch-rh/client';
import { createWalletClient, fallback, http, nonceManager, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * Keeper wallet and transports. The key comes ONLY from env `KEEPER_PRIVATE_KEY` (set by
 * the operator in Vercel as a sensitive variable). It is never logged: every log line and
 * error the keeper prints goes through `redact`, which scrubs the key (with and without
 * 0x) and any credential in the RPC URLs.
 */

export type EnvLike = Record<string, string | undefined>;

export class KeeperKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeeperKeyError';
  }
}

/** The keeper key from env, normalized to 0x-hex, or null when unset. Never echoes the value. */
export function readKeeperKey(env: EnvLike): Hex | null {
  const raw = env.KEEPER_PRIVATE_KEY?.trim();
  if (raw === undefined || raw === '') return null;
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new KeeperKeyError('KEEPER_PRIVATE_KEY is set but is not a 32-byte hex private key');
  return `0x${hex}` as Hex;
}

export interface KeeperClients {
  /** Primary reads: RH_RPC_URL (keyed) with the public RPC as fallback. */
  publicClient: PublicClient;
  /**
   * An independent reader for the STALE double-check: RH_FALLBACK_RPC_URL if set, else
   * the public RPC. It never uses RH_RPC_URL, so the two reads come from different
   * providers whenever RH_RPC_URL is set.
   */
  fallbackClient: PublicClient;
  /** null without KEEPER_PRIVATE_KEY (read-only / dry run). */
  walletClient: WalletClient | null;
  account: Address | null;
  /** Scrubs the key and RPC credentials from any text. */
  redact: (text: string) => string;
  /** Printable description of the transports (credentials hidden). */
  describe: string;
}

export interface MakeKeeperClientsOptions {
  deployment: Deployment;
  env: EnvLike;
  /** Load the wallet (default true). A dry run passes false and needs no key. */
  withWallet?: boolean;
}

export function makeKeeperClients(options: MakeKeeperClientsOptions): KeeperClients {
  const { env } = options;
  const primaryUrl = env.RH_RPC_URL?.trim() || undefined;
  const fallbackUrl = env.RH_FALLBACK_RPC_URL?.trim() || undefined;
  const key = options.withWallet === false ? null : readKeeperKey(env);
  const redact = makeRedactor([
    key,
    key?.slice(2),
    ...urlSecrets(primaryUrl),
    ...urlSecrets(fallbackUrl),
    env.TELEGRAM_BOT_TOKEN?.trim(),
  ]);

  const publicClient: HunchPublicClient = makePublicClient({ rpcUrl: primaryUrl });
  const fallbackClient: HunchPublicClient =
    fallbackUrl !== undefined ? makePublicClient({ rpcUrl: fallbackUrl, excludePublicRpc: true }) : makePublicClient({ rpcUrl: PUBLIC_RPC_URL });

  let walletClient: WalletClient | null = null;
  let account: Address | null = null;
  if (key !== null) {
    const acct = privateKeyToAccount(key, { nonceManager });
    account = acct.address;
    const urls = [primaryUrl, PUBLIC_RPC_URL].filter((u): u is string => u !== undefined);
    const transport = urls.length === 1 ? http(urls[0], { timeout: 15_000, retryCount: 1 }) : fallback(urls.map((u) => http(u, { timeout: 15_000, retryCount: 1 })));
    walletClient = createWalletClient({ account: acct, chain: robinhoodChain, transport });
  }
  const describe = [
    `primary ${primaryUrl === undefined ? PUBLIC_RPC_URL : redactRpcUrl(primaryUrl)}${primaryUrl === undefined ? '' : ` (+ ${PUBLIC_RPC_URL})`}`,
    `independent ${fallbackUrl === undefined ? PUBLIC_RPC_URL : redactRpcUrl(fallbackUrl)}`,
    account === null ? 'no keeper key (read-only)' : `keeper ${account}`,
  ].join(' · ');
  return { publicClient: publicClient as PublicClient, fallbackClient: fallbackClient as PublicClient, walletClient, account, redact, describe };
}
