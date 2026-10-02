// @vitest-environment node
import type { Keeper, RelayResult } from '@hunch-rh/keeper';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const revalidateTag = vi.fn();
vi.mock('next/cache', () => ({
  revalidateTag: (...args: unknown[]) => revalidateTag(...args),
  unstable_cache: <T,>(fn: T) => fn,
  updateTag: vi.fn(),
}));
// `after` needs a live request scope; collect the callbacks and run them by hand.
const afterCallbacks: (() => Promise<void>)[] = [];
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (fn: () => Promise<void>) => void afterCallbacks.push(fn),
}));

import { GET as cron } from '@/app/api/cron/[job]/route';
import { GET as health } from '@/app/api/health/route';
import { POST as relay } from '@/app/api/relay/enter/route';
import { BUSY_MESSAGE, relayHttp } from '@/lib/api/relay';
import { cronAuthorized } from '@/lib/api/cron';
import { setKeeper } from '@/lib/server/keeper';

const TX = `0x${'cd'.repeat(32)}` as const;
const SIGNATURE = `0x${'5a'.repeat(65)}`;

function fakeKeeper(overrides: Partial<Keeper> = {}): Keeper & { relay: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn>; health: ReturnType<typeof vi.fn>; finalizeSoon: ReturnType<typeof vi.fn> } {
  return {
    relay: vi.fn(async (): Promise<RelayResult> => ({ ok: true, txHash: TX, nonce: `0x${'01'.repeat(32)}` })),
    run: vi.fn(async (job: string) => [{ job, deployed: true, dryRun: false, nowSec: 1, actions: [], notes: ['nothing to do'], pages: [] }]),
    health: vi.fn(async () => ({ ok: true, deployed: true, nowSec: 1, checks: [{ name: 'rpc-head', ok: true, detail: 'latest block is 1 s old' }] })),
    clients: {
      publicClient: {
        waitForTransactionReceipt: vi.fn(async () => ({ status: 'success', logs: [] })),
        getBlock: vi.fn(async () => ({ number: 100n, timestamp: 1n })),
        multicall: vi.fn(async () => [{ status: 'success', result: 42n }, { status: 'success', result: 1n }]),
      },
    },
    finalizeSoon: vi.fn(async () => ({ status: 'finalized', txHash: `0x${'cd'.repeat(32)}` })),
    ...overrides,
  } as never;
}

function relayRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://rh.playhunch.xyz/api/relay/enter', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const BODY = {
  from: '0x1111111111111111111111111111111111111111',
  marketId: '12',
  outcome: 0,
  amount: '10000000',
  validAfter: '0',
  validBefore: '1790712645',
  salt: `0x${'ab'.repeat(32)}`,
  signature: SIGNATURE,
};

beforeEach(() => {
  revalidateTag.mockClear();
});

afterEach(() => {
  setKeeper(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('relay error mapping', () => {
  const fail = (code: Parameters<typeof relayHttp>[0] extends infer R ? (R extends { ok: false; code: infer C } ? C : never) : never, message = 'm') =>
    relayHttp({ ok: false, code, status: 0, message });

  it('maps every keeper code to a status and a documented error', () => {
    expect(relayHttp({ ok: true, txHash: TX, nonce: '0x01' }, 'confirmed')).toEqual({ status: 200, body: { ok: true, txHash: TX, nonce: '0x01', receipt: 'confirmed' } });
    expect(fail('bad-request')).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(fail('bad-signature')).toMatchObject({ status: 400, body: { error: 'bad_signature', next: 'sign-again' } });
    expect(fail('wrong-domain')).toMatchObject({ status: 400, body: { error: 'bad_signature' } });
    expect(fail('expired')).toMatchObject({ status: 400, body: { error: 'expired' } });
    expect(fail('amount-out-of-range')).toMatchObject({ status: 400, body: { error: 'amount_out_of_bounds' } });
    expect(fail('geo-blocked')).toMatchObject({ status: 403, body: { error: 'region_blocked' } });
    expect(fail('market-not-found')).toMatchObject({ status: 404, body: { error: 'market_not_found' } });
    expect(fail('market-closed')).toMatchObject({ status: 409, body: { error: 'market_closed' } });
    expect(fail('entries-paused')).toMatchObject({ status: 409, body: { error: 'market_closed' } });
    expect(fail('nonce-used')).toMatchObject({ status: 409, body: { error: 'already_used' } });
    expect(fail('insufficient-balance')).toMatchObject({ status: 422, body: { error: 'insufficient_balance', next: 'get-usdg' } });
    expect(fail('simulation-failed')).toMatchObject({ status: 422, body: { error: 'simulation_failed' } });
    expect(fail('rate-limited')).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
    expect(fail('send-failed')).toMatchObject({ status: 502, body: { error: 'relay_failed', next: 'pay-gas' } });
    expect(fail('relayer-unavailable')).toMatchObject({ status: 503, body: { error: 'relay_unavailable', next: 'pay-gas' } });
    expect(fail('not-deployed')).toMatchObject({ status: 503, body: { error: 'not_deployed' } });
  });

  it('turns a full batch (VintageFull) into "busy" with a retry hint', () => {
    expect(fail('simulation-failed', BUSY_MESSAGE)).toMatchObject({ status: 503, body: { error: 'busy', next: 'retry', retryAfter: 3 } });
  });
});

describe('POST /api/relay/enter', () => {
  it('passes the country and the client IP to the keeper, waits for the receipt, answers 200', async () => {
    const keeper = fakeKeeper();
    setKeeper(keeper);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await relay(relayRequest(BODY, { 'x-vercel-ip-country': 'FR', 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, txHash: TX, nonce: `0x${'01'.repeat(32)}`, receipt: 'confirmed' });
    expect(keeper.relay).toHaveBeenCalledWith(BODY, { country: 'FR', ip: '203.0.113.7' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    // The market and the bettor's portfolio are expired so the next read shows the bet.
    expect(revalidateTag).toHaveBeenCalledWith('market:12', { expire: 0 });
    expect(revalidateTag).toHaveBeenCalledWith(`positions:${BODY.from}`, { expire: 0 });
    // Never a whole signature in the logs.
    const logged = info.mock.calls.flat().join(' ');
    expect(logged).not.toContain(SIGNATURE);
    expect(logged).toContain('0x5a5a');
    // After the response: the batch is written on chain once its Ethereum block passes.
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks.pop()!();
    expect(keeper.finalizeSoon).toHaveBeenCalledWith(12n, 42n, { maxWaitMs: 40_000 });
  });

  it('refuses a blocked country with 403 and plain words', async () => {
    const keeper = fakeKeeper({
      relay: vi.fn(async () => ({
        ok: false,
        code: 'geo-blocked',
        status: 451,
        message: 'Stock-price markets are not offered in the United States, Canada, the United Kingdom or Switzerland.',
      })) as never,
    });
    setKeeper(keeper);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await relay(relayRequest(BODY, { 'x-vercel-ip-country': 'US' }));
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, error: 'region_blocked', reason: 'geo-blocked' });
    expect(String(body.message)).toContain('United States');
    expect(keeper.relay.mock.calls[0]![1]).toMatchObject({ country: 'US' });
  });

  it('429 when rate limited, 502 when the send fails', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    setKeeper(fakeKeeper({ relay: vi.fn(async () => ({ ok: false, code: 'rate-limited', status: 429, message: 'Too many bets.' })) as never }));
    expect((await relay(relayRequest(BODY))).status).toBe(429);
    setKeeper(fakeKeeper({ relay: vi.fn(async () => ({ ok: false, code: 'send-failed', status: 502, message: 'Could not send.' })) as never }));
    const failed = await relay(relayRequest(BODY));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: 'relay_failed', next: 'pay-gas' });
  });

  it('400 for a body that is not JSON, 502 (with the pay-gas hint) when the keeper throws', async () => {
    setKeeper(fakeKeeper());
    expect((await relay(relayRequest('{not json'))).status).toBe(400);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setKeeper(fakeKeeper({ relay: vi.fn(async () => Promise.reject(new Error('boom https://rpc.example/v2/SECRETKEY123'))) as never }));
    const response = await relay(relayRequest(BODY));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain('SECRETKEY123');
    expect(JSON.parse(text)).toMatchObject({ error: 'relay_failed', next: 'pay-gas' });
  });
});

describe('GET /api/cron/[job]', () => {
  const call = (job: string, authorization?: string) =>
    cron(new Request(`https://rh.playhunch.xyz/api/cron/${job}`, { headers: authorization === undefined ? {} : { authorization } }), {
      params: Promise.resolve({ job }),
    });

  it('401 without the bearer secret, with a wrong one, and whenever CRON_SECRET is unset', async () => {
    const keeper = fakeKeeper();
    setKeeper(keeper);
    vi.stubEnv('CRON_SECRET', 'correct-horse-battery-staple');
    expect((await call('resolve')).status).toBe(401);
    expect((await call('resolve', 'Bearer wrong')).status).toBe(401);
    expect((await call('resolve', 'correct-horse-battery-staple')).status).toBe(401);
    vi.stubEnv('CRON_SECRET', '');
    expect((await call('resolve', 'Bearer ')).status).toBe(401);
    expect(keeper.run).not.toHaveBeenCalled();
  });

  it('runs the job and returns the keeper’s report', async () => {
    const keeper = fakeKeeper();
    setKeeper(keeper);
    vi.stubEnv('CRON_SECRET', 'correct-horse-battery-staple');
    const response = await call('deliver', 'Bearer correct-horse-battery-staple');
    expect(response.status).toBe(200);
    expect(keeper.run).toHaveBeenCalledWith('deliver');
    expect(await response.json()).toMatchObject({ ok: true, job: 'deliver', reports: [{ job: 'deliver', notes: ['nothing to do'] }] });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('404 for an unknown job (after auth)', async () => {
    setKeeper(fakeKeeper());
    vi.stubEnv('CRON_SECRET', 's3cret-value');
    expect((await call('all', 'Bearer s3cret-value')).status).toBe(404);
    expect((await call('drill', 'Bearer s3cret-value')).status).toBe(404);
  });

  it('compares the secret in constant time and only as a whole bearer token', () => {
    expect(cronAuthorized('Bearer abc', 'abc')).toBe(true);
    expect(cronAuthorized('Bearer abcd', 'abc')).toBe(false);
    expect(cronAuthorized('bearer abc', 'abc')).toBe(false);
    expect(cronAuthorized(null, 'abc')).toBe(false);
    expect(cronAuthorized('Bearer undefined', undefined)).toBe(false);
  });
});

describe('GET /api/health', () => {
  it('200 when every check holds', async () => {
    setKeeper(fakeKeeper());
    const response = await health();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, checks: [{ name: 'rpc-head', ok: true }] });
  });

  it('503 with the failing checks, and nothing secret', async () => {
    setKeeper(
      fakeKeeper({
        health: vi.fn(async () => ({
          ok: false,
          deployed: true,
          nowSec: 1,
          checks: [
            { name: 'rpc-head', ok: true, detail: 'latest block is 1 s old' },
            { name: 'keeper-eth', ok: false, detail: '0.0004 ETH (floor 0.001)' },
          ],
        })) as never,
      }),
    );
    const response = await health();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { ok: boolean; checks: { name: string; ok: boolean }[] };
    expect(body.ok).toBe(false);
    expect(body.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['keeper-eth']);
  });

  it('503 with a plain check when the keeper cannot start', async () => {
    vi.stubEnv('KEEPER_PRIVATE_KEY', 'not-a-key');
    setKeeper(null);
    const response = await health();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain('not-a-key');
    expect(JSON.parse(text)).toMatchObject({ ok: false, checks: [{ name: 'keeper', ok: false }] });
  });
});
