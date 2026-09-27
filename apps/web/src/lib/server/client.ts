/**
 * The server's one public client for Robinhood Chain: `RH_RPC_URL` (a keyed provider) first,
 * the public RPC as the fallback transport (8 s timeout, 2 retries, Multicall3 batching).
 *
 * `RH_RPC_URL` is read here, on the server, and nowhere else. It is never a `NEXT_PUBLIC_`
 * variable, never in a response, and every error that leaves this layer goes through
 * `redactError` first.
 */

import { makePublicClient, makeRedactor, urlSecrets } from '@hunch-rh/client';
import type { PublicClient } from 'viem';

let client: PublicClient | null = null;

function assertServer(): void {
  if (typeof window !== 'undefined') throw new Error('lib/server is server-only');
}

export function serverClient(): PublicClient {
  assertServer();
  client ??= makePublicClient({ rpcUrl: process.env.RH_RPC_URL?.trim() || undefined }) as unknown as PublicClient;
  return client;
}

/** For tests: replace (or reset with null) the shared client. */
export function setServerClient(next: PublicClient | null): void {
  client = next;
}

let redactor: ((text: string) => string) | null = null;

/** One line, with RPC credentials and URLs removed. Safe to put in a response or a log. */
export function redactError(error: unknown): string {
  redactor ??= makeRedactor([...urlSecrets(process.env.RH_RPC_URL), ...urlSecrets(process.env.RH_FALLBACK_RPC_URL)]);
  const raw = error instanceof Error ? ((error as { shortMessage?: string }).shortMessage ?? error.message) : String(error);
  const line = raw.split('\n')[0] ?? '';
  return redactor(line)
    .replace(/https?:\/\/\S+/g, '[rpc]')
    .slice(0, 240);
}
