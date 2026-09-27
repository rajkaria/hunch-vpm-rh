/**
 * The two pieces of state a tiering middleware has to keep: which nonces have been
 * spent, and how many requests a subject has made in the current window.
 *
 * No database dependency lives in this package. The interface is small enough that a
 * Redis, Postgres or Durable Object implementation is a short file, and the contract
 * below is written so that implementation can be checked against it.
 */

export type NonceOutcome = 'accepted' | 'replayed';

export interface TierStorage {
  /**
   * Record `key` as spent, and say whether it had already been spent.
   *
   * Contract:
   *  - Atomic. Two concurrent calls with the same key must produce exactly one
   *    `'accepted'`. A read-then-write implemented as two round trips is wrong; use
   *    `SET key value NX PX ttl` or an insert with a unique constraint.
   *  - `expiresAtMs` is an absolute wall-clock deadline in milliseconds. The entry may
   *    be dropped at or after it. It must not be dropped before it, or a spent proof
   *    becomes replayable inside its own validity window.
   *  - Must reject rather than return a value when the store cannot be reached. The
   *    verifier turns a rejection into `nonce_store_unavailable` and drops the caller to
   *    anonymous; silently returning `'accepted'` would turn an outage into a replay
   *    window.
   */
  consumeNonce(key: string, expiresAtMs: number): Promise<NonceOutcome>;

  /**
   * Increment the counter at `key` and return its value after the increment, so the
   * first request in a window returns 1.
   *
   * Contract:
   *  - Atomic increment. `INCR` plus `PEXPIREAT` on first write, or an upsert with
   *    `count = count + 1 RETURNING count`.
   *  - `windowEndsAtMs` is absolute wall-clock milliseconds; the key may be dropped at
   *    or after it. Dropping it early under-counts, which lets a caller exceed the
   *    limit; that is a smaller failure than over-counting, but set the TTL correctly.
   *  - Callers key by subject and window start, so the counter never needs resetting.
   *  - Must reject when the store cannot be reached. The gate treats a rejection as
   *    fail-open and lets the request through, because a counter outage should not take
   *    the venue down. That choice is the caller's: see `onStorageError`.
   */
  incrementWindow(key: string, windowEndsAtMs: number): Promise<number>;
}

interface Expiring<T> {
  readonly value: T;
  readonly expiresAtMs: number;
}

export interface InMemoryTierStorageOptions {
  readonly clock?: () => number;
  /**
   * Entries to touch per sweep. Expiry is lazy plus incremental so a process that holds
   * a large nonce set never pauses to walk all of it at once.
   */
  readonly sweepBatch?: number;
}

/**
 * Single-process implementation.
 *
 * Correct for a single instance and for tests. It is NOT correct behind a load
 * balancer: each instance holds its own nonce set, so a proof spent on instance A
 * replays successfully on instance B. If you run more than one process, implement
 * {@link TierStorage} against something shared.
 */
export class InMemoryTierStorage implements TierStorage {
  readonly #nonces = new Map<string, number>();
  readonly #counters = new Map<string, Expiring<number>>();
  readonly #clock: () => number;
  readonly #sweepBatch: number;

  constructor(options: InMemoryTierStorageOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#sweepBatch = options.sweepBatch ?? 64;
  }

  async consumeNonce(key: string, expiresAtMs: number): Promise<NonceOutcome> {
    const now = this.#clock();
    this.#sweep(now);
    const seenUntil = this.#nonces.get(key);
    if (seenUntil !== undefined && seenUntil > now) return 'replayed';
    this.#nonces.set(key, expiresAtMs);
    return 'accepted';
  }

  async incrementWindow(key: string, windowEndsAtMs: number): Promise<number> {
    const now = this.#clock();
    this.#sweep(now);
    const existing = this.#counters.get(key);
    const next = existing !== undefined && existing.expiresAtMs > now ? existing.value + 1 : 1;
    this.#counters.set(key, { value: next, expiresAtMs: windowEndsAtMs });
    return next;
  }

  /** Visible for tests and for a health endpoint that wants to report retained state. */
  get size(): { nonces: number; counters: number } {
    return { nonces: this.#nonces.size, counters: this.#counters.size };
  }

  #sweep(now: number): void {
    let budget = this.#sweepBatch;
    for (const [key, expiresAtMs] of this.#nonces) {
      if (budget-- <= 0) break;
      if (expiresAtMs <= now) this.#nonces.delete(key);
    }
    budget = this.#sweepBatch;
    for (const [key, entry] of this.#counters) {
      if (budget-- <= 0) break;
      if (entry.expiresAtMs <= now) this.#counters.delete(key);
    }
  }
}

/** Nonces are scoped to the wallet and chain so two agents may pick the same string. */
export function nonceKey(chainId: number, wallet: string, nonce: string): string {
  return `agentkit:nonce:${chainId}:${wallet.toLowerCase()}:${nonce}`;
}

export function rateLimitKey(subject: string, windowStartMs: number): string {
  return `agentkit:rate:${subject}:${windowStartMs}`;
}
