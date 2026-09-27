/**
 * The keeper for route handlers (`/api/cron/[job]`, `/api/relay/enter`, `/api/health`), built
 * once per server instance from env: `KEEPER_PRIVATE_KEY` (only to send), `RH_RPC_URL`,
 * `RH_FALLBACK_RPC_URL`, `HUNCH_DEPLOYMENT_JSON`, `TELEGRAM_*`. The keeper redacts its key and
 * RPC credentials from everything it logs.
 */

import { createKeeper, type Keeper } from '@hunch-rh/keeper';

import { readDeployment } from '@/lib/deployment';

let keeper: Keeper | null = null;

export class KeeperUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'KeeperUnavailableError';
  }
}

export function getKeeper(): Keeper {
  if (typeof window !== 'undefined') throw new Error('lib/server is server-only');
  if (keeper !== null) return keeper;
  try {
    keeper = createKeeper(process.env as Record<string, string | undefined>, { deployment: readDeployment() });
    return keeper;
  } catch (error) {
    // KeeperKeyError says only that the key is malformed; it never echoes the value.
    throw new KeeperUnavailableError(error instanceof Error ? error.message.split('\n')[0]! : 'keeper could not start');
  }
}

/** For tests. */
export function setKeeper(next: Keeper | null): void {
  keeper = next;
}
