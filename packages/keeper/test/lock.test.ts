import { describe, expect, it } from 'vitest';
import { KEEPER_LOCK_KEY, lockFromEnv, memoryLock, upstashLock } from '../src/index.js';

/** An in-memory Upstash REST endpoint: SET NX EX, and the compare-and-delete EVAL. */
function fakeUpstash() {
  const store = new Map<string, { value: string; until: number }>();
  let now = 0;
  const calls: unknown[][] = [];
  const fetchImpl = async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    const args = JSON.parse(init.body) as (string | number)[];
    calls.push(args);
    if (init.headers.authorization !== 'Bearer tok') return { ok: false, status: 401, json: async () => ({}) };
    const [cmd, key] = args as [string, string];
    let result: unknown = null;
    if (cmd === 'SET') {
      const cur = store.get(key);
      if (cur === undefined || cur.until <= now) {
        store.set(key, { value: String(args[2]), until: now + Number(args[5]) * 1000 });
        result = 'OK';
      }
    } else if (cmd === 'EVAL') {
      const k = String(args[3]);
      if (store.get(k)?.value === String(args[4])) {
        store.delete(k);
        result = 1;
      } else result = 0;
    }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
  return { fetchImpl, store, calls, advance: (ms: number) => (now += ms) };
}

describe('T9 · one keeper run at a time', () => {
  it('memory lock: a second run skips until the first releases or the lock expires', async () => {
    let t = 0;
    const lock = memoryLock(() => t);
    const a = await lock.acquire(KEEPER_LOCK_KEY, 10);
    expect(a).not.toBeNull();
    expect(await lock.acquire(KEEPER_LOCK_KEY, 10)).toBeNull();
    await a!.release();
    const b = await lock.acquire(KEEPER_LOCK_KEY, 10);
    expect(b).not.toBeNull();
    t += 11_000; // a crashed run's lock expires
    const c = await lock.acquire(KEEPER_LOCK_KEY, 10);
    expect(c).not.toBeNull();
    await b!.release(); // a stale holder cannot release the new holder's lock
    expect(await lock.acquire(KEEPER_LOCK_KEY, 10)).toBeNull();
  });

  it('Upstash lock: SET NX EX across instances, released only by its holder', async () => {
    const up = fakeUpstash();
    const one = upstashLock('https://kv.example/', 'tok', up.fetchImpl as never);
    const two = upstashLock('https://kv.example', 'tok', up.fetchImpl as never);
    expect(one.shared).toBe(true);
    const a = await one.acquire(KEEPER_LOCK_KEY, 310);
    expect(a).not.toBeNull();
    expect(up.calls[0]).toEqual(['SET', KEEPER_LOCK_KEY, expect.any(String), 'NX', 'EX', 310]);
    expect(await two.acquire(KEEPER_LOCK_KEY, 310)).toBeNull();
    up.advance(311_000);
    const b = await two.acquire(KEEPER_LOCK_KEY, 310);
    expect(b).not.toBeNull();
    await a!.release(); // expired holder: the compare-and-delete leaves b's lock alone
    expect(up.store.has(KEEPER_LOCK_KEY)).toBe(true);
    await b!.release();
    expect(up.store.has(KEEPER_LOCK_KEY)).toBe(false);
  });

  it('Upstash errors surface (the route then runs unlocked and says so)', async () => {
    const up = fakeUpstash();
    await expect(upstashLock('https://kv.example', 'wrong', up.fetchImpl as never).acquire('k', 5)).rejects.toThrow(/HTTP 401/);
  });

  it('lockFromEnv: the shared store when configured, else one lock per process', () => {
    expect(lockFromEnv({}).shared).toBe(false);
    expect(lockFromEnv({})).toBe(lockFromEnv({}));
    expect(lockFromEnv({ KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 't' }).shared).toBe(true);
    expect(lockFromEnv({ UPSTASH_REDIS_REST_URL: 'https://kv.example', UPSTASH_REDIS_REST_TOKEN: 't' }).shared).toBe(true);
    expect(lockFromEnv({ KV_REST_API_URL: 'https://kv.example' }).shared).toBe(false);
  });
});
