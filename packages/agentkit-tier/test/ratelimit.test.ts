import { describe, expect, it, vi } from 'vitest';
import { enforceRateLimit, windowStartFor } from '../src/ratelimit.js';
import { InMemoryTierStorage } from '../src/storage.js';
import { DEFAULT_TIER_POLICIES, buildTierPolicies } from '../src/tiers.js';
import { Clock, counterStoreDown } from './support/harness.js';

const policies = buildTierPolicies({ baseRequests: 3, windowMs: 60_000 });

async function spend(
  storage: InMemoryTierStorage,
  clock: Clock,
  tier: 'anonymous' | 'human-backed',
  times: number,
) {
  let last = await enforceRateLimit({
    storage,
    subject: 'subject',
    policy: policies[tier],
    nowMs: clock.nowMs,
  });
  for (let i = 1; i < times; i += 1) {
    last = await enforceRateLimit({ storage, subject: 'subject', policy: policies[tier], nowMs: clock.nowMs });
  }
  return last;
}

describe('enforceRateLimit', () => {
  it('allows the base allowance and blocks the next request', async () => {
    const clock = new Clock();
    const storage = new InMemoryTierStorage({ clock: clock.now });

    const third = await spend(storage, clock, 'anonymous', 3);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);

    const fourth = await spend(storage, clock, 'anonymous', 1);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('gives a human-backed agent ten times as many before blocking', async () => {
    const clock = new Clock();
    const storage = new InMemoryTierStorage({ clock: clock.now });

    const thirtieth = await spend(storage, clock, 'human-backed', 30);
    expect(thirtieth.allowed).toBe(true);

    const thirtyFirst = await spend(storage, clock, 'human-backed', 1);
    expect(thirtyFirst.allowed).toBe(false);
  });

  // What this proves is narrow: one subject is one counter whatever tier the policy
  // describes. It does NOT prove a downgraded agent keeps its bucket — that depends
  // entirely on the subject resolver, and the gate's default one changes with the tier.
  // See "a caller that stops presenting its proof" in gate.test.ts.
  it('holds one counter per subject, whichever tier the policy names', async () => {
    const clock = new Clock();
    const storage = new InMemoryTierStorage({ clock: clock.now });

    await spend(storage, clock, 'human-backed', 3);
    const asAnonymous = await spend(storage, clock, 'anonymous', 1);

    expect(asAnonymous.used).toBe(4);
    expect(asAnonymous.allowed).toBe(false);
  });

  it('starts over in the next window', async () => {
    const clock = new Clock();
    const storage = new InMemoryTierStorage({ clock: clock.now });

    await spend(storage, clock, 'anonymous', 4);
    clock.advanceMs(60_000);

    const next = await enforceRateLimit({
      storage,
      subject: 'subject',
      policy: policies.anonymous,
      nowMs: clock.nowMs,
    });
    expect(next.allowed).toBe(true);
    expect(next.used).toBe(1);
  });

  it('reports a reset time at the end of the current window', async () => {
    const clock = new Clock(1_700_000_030_000);
    const storage = new InMemoryTierStorage({ clock: clock.now });

    const decision = await enforceRateLimit({
      storage,
      subject: 'subject',
      policy: policies.anonymous,
      nowMs: clock.nowMs,
    });

    expect(decision.windowStartMs).toBe(windowStartFor(clock.nowMs, 60_000));
    expect(decision.resetAtMs).toBe(decision.windowStartMs + 60_000);
  });

  it('lets the request through and says so when the counter store is down', async () => {
    const clock = new Clock();
    const storage = counterStoreDown(new InMemoryTierStorage({ clock: clock.now }));
    const onStorageError = vi.fn();

    const decision = await enforceRateLimit({
      storage,
      subject: 'subject',
      policy: DEFAULT_TIER_POLICIES.anonymous,
      nowMs: clock.nowMs,
    });
    const withHook = await enforceRateLimit({
      storage,
      subject: 'subject',
      policy: DEFAULT_TIER_POLICIES.anonymous,
      nowMs: clock.nowMs,
      onStorageError,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.degraded).toBe(true);
    expect(withHook.degraded).toBe(true);
    expect(onStorageError).toHaveBeenCalledOnce();
  });
});

describe('windowStartFor', () => {
  it('snaps to the window boundary below the instant', () => {
    expect(windowStartFor(120_000, 60_000)).toBe(120_000);
    expect(windowStartFor(125_000, 60_000)).toBe(120_000);
    expect(windowStartFor(179_999, 60_000)).toBe(120_000);
    expect(windowStartFor(180_000, 60_000)).toBe(180_000);
  });
});
