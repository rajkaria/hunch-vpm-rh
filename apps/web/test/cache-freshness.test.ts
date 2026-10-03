// @vitest-environment node
/**
 * Regression: `/m/0` said "Price unavailable, retrying. Last read 9 h ago" while every chain read
 * succeeded. Next's data cache is stale-while-revalidate: the first request after an idle gap gets
 * the entry from the previous visit, however old, and refreshes it in the background. `cachedRead`
 * called anything older than a minute a failed read, so on a quiet site every first visitor saw the
 * failure line. The fake below behaves like `unstable_cache` does on Vercel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dataCache = new Map<string, { value: unknown; at: number }>();
const background: Promise<unknown>[] = [];

vi.mock('next/cache', () => ({
  unstable_cache:
    (load: () => Promise<unknown>, keyParts: string[], options: { revalidate: number }) =>
    async (): Promise<unknown> => {
      const key = keyParts.join(':');
      const hit = dataCache.get(key);
      if (hit !== undefined) {
        if (Date.now() - hit.at > options.revalidate * 1000) {
          // Stale: hand back the old entry now, refresh it in the background.
          background.push(
            load().then(
              (value) => dataCache.set(key, { value, at: Date.now() }),
              () => undefined,
            ),
          );
        }
        return hit.value;
      }
      const value = await load();
      dataCache.set(key, { value, at: Date.now() });
      return value;
    },
}));

const { cachedRead, clearLastGood } = await import('@/lib/server/cache');

const T0 = Date.UTC(2026, 9, 2, 21, 17, 17);
const NINE_HOURS = 9 * 3600 * 1000;
const sec = (ms: number): number => Math.floor(ms / 1000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(async () => {
  // A hung read's refresh never settles; give the others a moment, not forever.
  await Promise.race([Promise.allSettled(background.splice(0)), new Promise((resolve) => setTimeout(resolve, 50))]);
  dataCache.clear();
  clearLastGood();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function chain() {
  let price = 100n;
  let mode: 'up' | 'down' | 'hung' = 'up';
  const read = vi.fn(async () => {
    if (mode === 'down') throw new Error('fetch failed https://rpc.example/v2/SECRETKEY123');
    if (mode === 'hung') return new Promise<{ price: bigint }>(() => undefined);
    return { price };
  });
  return {
    read,
    setPrice: (next: bigint) => (price = next),
    setMode: (next: typeof mode) => (mode = next),
  };
}

describe('cached reads after an idle gap', () => {
  it('reads the chain again instead of calling a 9 h old entry a failure (the /m/0 bug)', async () => {
    const c = chain();
    const options = { key: ['market', '0'], tags: [], revalidate: 5, read: c.read };
    expect(await cachedRead(options)).toMatchObject({ data: { price: 100n }, stale: false, readAt: sec(T0) });

    vi.setSystemTime(T0 + NINE_HOURS);
    c.setPrice(101n);
    const later = await cachedRead(options);

    expect(later).toMatchObject({ data: { price: 101n }, stale: false, error: null, readAt: sec(T0 + NINE_HOURS) });
    // The foreground read and the data cache's background refresh share one chain read.
    expect(c.read).toHaveBeenCalledTimes(2);
  });

  it('within the freshness window it never waits on the chain: the background refresh is the only read', async () => {
    const c = chain();
    const options = { key: ['market', '1'], tags: [], revalidate: 5, read: c.read };
    await cachedRead(options);
    vi.setSystemTime(T0 + 30_000);
    const snapshot = await cachedRead(options);
    expect(snapshot.stale).toBe(false);
    expect(snapshot.readAt).toBeGreaterThanOrEqual(sec(T0));
    expect(c.read).toHaveBeenCalledTimes(2); // 1 initial + 1 background refresh, none in the foreground
  });

  it('says "unavailable" only when the chain read after the gap really fails, with the reason and the last numbers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const c = chain();
    const options = { key: ['market', '2'], tags: [], revalidate: 5, read: c.read };
    await cachedRead(options);
    vi.setSystemTime(T0 + NINE_HOURS);
    c.setMode('down');
    const snapshot = await cachedRead(options);
    expect(snapshot).toMatchObject({ data: { price: 100n }, stale: true, readAt: sec(T0) });
    expect(snapshot.error).toContain('fetch failed');
    expect(snapshot.error).not.toContain('SECRETKEY123');
  });

  it('does not hang a page on a read that never answers: the old value comes back, marked stale', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const c = chain();
    const options = { key: ['market', '3'], tags: [], revalidate: 5, read: c.read, foregroundMs: 30 };
    await cachedRead(options);
    vi.setSystemTime(T0 + NINE_HOURS);
    c.setMode('hung');
    const snapshot = await cachedRead(options);
    expect(snapshot).toMatchObject({ data: { price: 100n }, stale: true, readAt: sec(T0) });
    expect(snapshot.error).toMatch(/longer than/);
  });
});
