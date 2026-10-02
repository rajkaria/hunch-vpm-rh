/**
 * One keeper run at a time. The cron jobs (open, resolve, deliver) all send from the keeper key,
 * and Vercel may run two of them at once (overlapping schedules, a duplicate delivery, a manual
 * `run-once` during a scheduled run). Two runs racing on one key waste gas on nonce errors and,
 * for `open`, could list the same market twice. A run first takes this lock and skips if another
 * run holds it.
 *
 * With `KV_REST_API_URL` + `KV_REST_API_TOKEN` (Vercel's Upstash Redis integration) or
 * `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, the lock is shared by every instance
 * (`SET key token NX EX ttl`, released only by its holder). Without them it is per instance,
 * and the keeper's own re-checks (listings just before each open, receipts) remain the guard.
 */

import type { EnvLike } from './wallet.js';

export interface LockHandle {
  release(): Promise<void>;
}

export interface JobLock {
  readonly shared: boolean;
  /** The lock, or null when another run holds it. */
  acquire(key: string, ttlSec: number): Promise<LockHandle | null>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

function token(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Upstash Redis over its REST API (one POST per command, JSON array body). */
export function upstashLock(url: string, restToken: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): JobLock {
  const base = url.replace(/\/+$/, '');
  const command = async (args: (string | number)[]): Promise<unknown> => {
    const res = await fetchImpl(base, {
      method: 'POST',
      headers: { authorization: `Bearer ${restToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`lock store answered HTTP ${res.status}`);
    return ((await res.json()) as { result?: unknown }).result ?? null;
  };
  return {
    shared: true,
    async acquire(key, ttlSec) {
      const mine = token();
      const result = await command(['SET', key, mine, 'NX', 'EX', Math.max(1, Math.floor(ttlSec))]);
      if (result !== 'OK') return null;
      return {
        release: async () => {
          await command(['EVAL', RELEASE_SCRIPT, 1, key, mine]).catch(() => undefined); // it expires anyway
        },
      };
    },
  };
}

/** Per process: enough for one serverless instance, a CLI or a test. */
export function memoryLock(now: () => number = Date.now): JobLock {
  const held = new Map<string, { token: string; until: number }>();
  return {
    shared: false,
    async acquire(key, ttlSec) {
      const t = now();
      const cur = held.get(key);
      if (cur !== undefined && cur.until > t) return null;
      const mine = token();
      held.set(key, { token: mine, until: t + ttlSec * 1000 });
      return {
        release: async () => {
          if (held.get(key)?.token === mine) held.delete(key);
        },
      };
    },
  };
}

let processLock: JobLock | null = null;

/** The shared store when configured, else one lock per process. */
export function lockFromEnv(env: EnvLike, fetchImpl?: FetchLike): JobLock {
  const url = env.KV_REST_API_URL?.trim() || env.UPSTASH_REDIS_REST_URL?.trim();
  const tok = env.KV_REST_API_TOKEN?.trim() || env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (url && tok) return upstashLock(url, tok, fetchImpl);
  processLock ??= memoryLock();
  return processLock;
}

/** The key every job that sends from the keeper key shares. */
export const KEEPER_LOCK_KEY = 'hunch:keeper-key';
/** Longer than any run (the cron route's maxDuration is 300 s). */
export const KEEPER_LOCK_TTL_SEC = 310;
