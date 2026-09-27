import { describe, expect, it } from 'vitest';
import { InMemoryTierStorage, nonceKey, rateLimitKey } from '../src/storage.js';
import { Clock } from './support/harness.js';

describe('InMemoryTierStorage nonces', () => {
  it('accepts a nonce once', async () => {
    const clock = new Clock();
    const storage = new InMemoryTierStorage({ clock: clock.now });

    expect(await storage.consumeNonce('a', clock.nowMs + 60_000)).toBe('accepted');
    expect(await storage.consumeNonce('a', clock.nowMs + 60_000)).toBe('replayed');
  });

  it('keeps distinct keys independent', async () => {
    const clock = new Clock();
    const storage = new InMemoryTierStorage({ clock: clock.now });

    expect(await storage.consumeNonce('a', clock.nowMs + 60_000)).toBe('accepted');
    expect(await storage.consumeNonce('b', clock.nowMs + 60_000)).toBe('accepted');
  });

  it('lets a key be reused once its deadline has passed', async () => {
    const clock = new Clock();
    const storage = new InMemoryTierStorage({ clock: clock.now });

    await storage.consumeNonce('a', clock.nowMs + 60_000);
    clock.advanceMs(60_001);

    expect(await storage.consumeNonce('a', clock.nowMs + 60_000)).toBe('accepted');
  });

  it('still refuses a replay one millisecond before the deadline', async () => {
    const clock = new Clock();
    const storage = new InMemoryTierStorage({ clock: clock.now });

    await storage.consumeNonce('a', clock.nowMs + 60_000);
    clock.advanceMs(59_999);

    expect(await storage.consumeNonce('a', clock.nowMs + 60_000)).toBe('replayed');
  });

  it('drops expired entries rather than growing without bound', async () => {
    const clock = new Clock();
    const storage = new InMemoryTierStorage({ clock: clock.now, sweepBatch: 1_000 });

    for (let i = 0; i < 100; i += 1) await storage.consumeNonce(`n${i}`, clock.nowMs + 1_000);
    expect(storage.size.nonces).toBe(100);

    clock.advanceMs(1_001);
    await storage.consumeNonce('fresh', clock.nowMs + 1_000);

    expect(storage.size.nonces).toBe(1);
  });
});

describe('InMemoryTierStorage counters', () => {
  it('returns the count after the increment, so the first request is 1', async () => {
    const clock = new Clock();
    const storage = new InMemoryTierStorage({ clock: clock.now });

    expect(await storage.incrementWindow('k', clock.nowMs + 1_000)).toBe(1);
    expect(await storage.incrementWindow('k', clock.nowMs + 1_000)).toBe(2);
  });

  it('starts a new count once the previous window has ended', async () => {
    const clock = new Clock();
    const storage = new InMemoryTierStorage({ clock: clock.now });

    await storage.incrementWindow('k', clock.nowMs + 1_000);
    clock.advanceMs(1_001);

    expect(await storage.incrementWindow('k', clock.nowMs + 1_000)).toBe(1);
  });

  it('keeps subjects apart', async () => {
    const clock = new Clock();
    const storage = new InMemoryTierStorage({ clock: clock.now });

    await storage.incrementWindow('a', clock.nowMs + 1_000);
    expect(await storage.incrementWindow('b', clock.nowMs + 1_000)).toBe(1);
  });
});

describe('key construction', () => {
  it('scopes a nonce to its chain and wallet, so two agents may pick the same string', () => {
    const a = nonceKey(480, '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'shared');
    const b = nonceKey(480, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'shared');
    const c = nonceKey(8453, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'shared');

    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('lowercases the wallet, so casing cannot buy a second use of one nonce', () => {
    expect(nonceKey(480, '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'n')).toBe(
      nonceKey(480, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'n'),
    );
  });

  it('puts the window start in the rate-limit key so counters never need resetting', () => {
    expect(rateLimitKey('wallet:0xabc', 60_000)).not.toBe(rateLimitKey('wallet:0xabc', 120_000));
  });
});
