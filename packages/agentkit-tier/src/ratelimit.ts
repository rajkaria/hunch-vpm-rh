/**
 * Fixed-window counting.
 *
 * A fixed window lets a caller spend two windows' worth of requests across a boundary.
 * That is the accepted cost of an algorithm that needs one atomic increment per
 * request and no per-subject timer state; a sliding window would need either a sorted
 * set per subject or a second counter, and neither is worth it for an abuse control
 * whose job is to bound a burst rather than to meter it precisely.
 *
 * The counter is keyed on the subject alone: this module never sees a tier, so the same
 * subject cannot hold two buckets. Be clear about what that does and does not buy you.
 * The gate's default subject resolver keys a human-backed caller on its wallet and an
 * anonymous one on its forwarded address, so one caller that stops presenting its proof
 * moves from `wallet:0x…` to `ip:…` and gets the anonymous allowance on top of the
 * human-backed one it has already spent — and the same trick tops up a spent anonymous
 * bucket by presenting a proof. The cost is bounded (base + 10·base per window rather
 * than 10·base) and it cannot be fixed here: a wallet is only known once a proof has
 * been checked, so nothing keyed on it can also count the requests where the proof is
 * absent. A deployment that has an identifier surviving both cases — an API key, a
 * mutual-TLS identity — should supply it through the gate's `subject` option.
 */

import type { TierPolicy } from './tiers.js';
import type { TierStorage } from './storage.js';
import { rateLimitKey } from './storage.js';

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  readonly windowStartMs: number;
  readonly resetAtMs: number;
  /** Zero when allowed. */
  readonly retryAfterSeconds: number;
  /**
   * True when the counter store failed and the request was let through uncounted. Emit
   * a metric on this: a gate that is quietly degraded is a gate that is not there.
   */
  readonly degraded: boolean;
}

export interface EnforceRateLimitInput {
  readonly storage: TierStorage;
  /** What is being limited: a wallet for human-backed callers, whatever you can attribute otherwise. */
  readonly subject: string;
  readonly policy: TierPolicy;
  readonly nowMs: number;
  /** Called when the store rejects. The request is allowed through regardless. */
  readonly onStorageError?: ((error: unknown) => void) | undefined;
}

export function windowStartFor(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

export async function enforceRateLimit(input: EnforceRateLimitInput): Promise<RateLimitDecision> {
  const { storage, subject, policy, nowMs } = input;
  const { requests: limit, windowMs } = policy.rateLimit;
  const windowStartMs = windowStartFor(nowMs, windowMs);
  const resetAtMs = windowStartMs + windowMs;

  let used: number;
  try {
    used = await storage.incrementWindow(rateLimitKey(subject, windowStartMs), resetAtMs);
  } catch (error) {
    // Fail open. A counter outage should not take the venue offline; it should be loud.
    input.onStorageError?.(error);
    return {
      allowed: true,
      limit,
      used: 0,
      remaining: limit,
      windowStartMs,
      resetAtMs,
      retryAfterSeconds: 0,
      degraded: true,
    };
  }

  const allowed = used <= limit;
  return {
    allowed,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    windowStartMs,
    resetAtMs,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)),
    degraded: false,
  };
}
