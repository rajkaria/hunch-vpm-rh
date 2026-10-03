/**
 * The server's one public client for Robinhood Chain: `RH_RPC_URL` (a keyed provider) first,
 * the public RPC as the fallback transport (8 s timeout, 2 retries, Multicall3 batching).
 *
 * `eth_getLogs` never goes to `RH_RPC_URL`: keyed plans cap its block range (QuickNode's Discover
 * plan at 5 blocks, paid plans at 10,000, about 17 minutes of this chain), so every log scan
 * would fail there first. Logs go to `RH_LOGS_RPC_URL` when it is set (an RPC whose plan serves
 * long ranges; set it to `RH_RPC_URL` itself if that plan does), then the public RPC.
 *
 * The RPC URLs are read here, on the server, and nowhere else. They are never `NEXT_PUBLIC_`
 * variables, never in a response, and every error that leaves this layer goes through
 * `redactError` first.
 */

import { makePublicClient, makeRedactor, urlSecrets, type PublicClientOptions } from '@hunch-rh/client';
import type { PublicClient } from 'viem';

let client: PublicClient | null = null;

function assertServer(): void {
  if (typeof window !== 'undefined') throw new Error('lib/server is server-only');
}

export function serverClient(): PublicClient {
  assertServer();
  client ??= makePublicClient(serverClientOptions(process.env)) as unknown as PublicClient;
  return client;
}

/** The transports `serverClient` uses, from the environment (exported for tests). */
export function serverClientOptions(env: Record<string, string | undefined>): PublicClientOptions {
  const rpcUrl = env.RH_RPC_URL?.trim() || undefined;
  const logsUrl = env.RH_LOGS_RPC_URL?.trim() || undefined;
  return {
    rpcUrl,
    fallbackRpcUrls: [logsUrl],
    noLogsRpcUrls: rpcUrl !== undefined && rpcUrl !== logsUrl ? [rpcUrl] : [],
  };
}

/** For tests: replace (or reset with null) the shared client. */
export function setServerClient(next: PublicClient | null): void {
  client = next;
}

let redactor: ((text: string) => string) | null = null;

/** One line, with RPC credentials and URLs removed. Safe to put in a response or a log. */
export function redactError(error: unknown): string {
  redactor ??= makeRedactor([...urlSecrets(process.env.RH_RPC_URL), ...urlSecrets(process.env.RH_FALLBACK_RPC_URL), ...urlSecrets(process.env.RH_LOGS_RPC_URL)]);
  const raw = error instanceof Error ? ((error as { shortMessage?: string }).shortMessage ?? error.message) : String(error);
  const line = raw.split('\n')[0] ?? '';
  return redactor(line)
    .replace(/https?:\/\/\S+/g, '[rpc]')
    .slice(0, 240);
}
