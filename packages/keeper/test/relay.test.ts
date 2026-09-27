import { MARKET_STATUS, UP, buildEnterAuthorization, enterNonce, randomSalt, loadDeployment } from '@hunch-rh/client';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { RateLimiter, relayEnter, validateRelayRequest, type RelayChain, type RelayContext, type RelayRequest } from '../src/index.js';
import { deployedDeployment } from '../../client/test/support/fakeChain.js';

const d = deployedDeployment();
const NOW = 1_790_600_000;
const account = privateKeyToAccount(generatePrivateKey());

async function signed(over: Partial<{ marketId: bigint; outcome: 0 | 1; amount: bigint; validAfter: bigint; validBefore: bigint; salt: Hex; hunchVpm: `0x${string}` }> = {}): Promise<RelayRequest> {
  const p = {
    marketId: 3n,
    outcome: UP as 0 | 1,
    amount: 5_000_000n,
    validAfter: 0n,
    validBefore: BigInt(NOW + 1800),
    salt: randomSalt(),
    hunchVpm: d.contracts.HunchVPM.address,
    ...over,
  };
  const auth = buildEnterAuthorization({ from: account.address, ...p });
  const signature = await account.signTypedData(auth);
  return {
    from: account.address,
    marketId: p.marketId.toString(),
    outcome: p.outcome,
    amount: p.amount.toString(),
    validAfter: p.validAfter.toString(),
    validBefore: p.validBefore.toString(),
    salt: p.salt,
    signature,
  };
}

function chain(over: Partial<RelayChain> & { used?: Set<string> } = {}): RelayChain {
  const used = over.used ?? new Set<string>();
  return {
    market: async (id) => (id === 3n ? { statusCode: MARKET_STATUS.Open, resolutionTime: NOW + 3600, minEntry: 1_000_000n, maxEntry: 100_000_000n } : null),
    entriesPaused: async () => false,
    authorizationUsed: async (_from, nonce) => used.has(nonce),
    usdgBalance: async () => 50_000_000n,
    isContract: async () => false,
    simulate: async () => ({ ok: true }),
    ...over,
  };
}

const ctx = (over: Partial<RelayContext> = {}): RelayContext => ({
  deployment: d,
  chain: chain(),
  nowSec: NOW,
  country: 'IN',
  ip: '203.0.113.7',
  limiter: new RateLimiter(10, 60_000),
  ...over,
});

describe('T9 · relay validation', () => {
  it('accepts a correctly signed entry and returns the nonce it binds', async () => {
    const req = await signed();
    const v = await validateRelayRequest(req, ctx());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.nonce).toBe(enterNonce({ hunchVpm: d.contracts.HunchVPM.address, marketId: 3n, outcome: UP, amount: 5_000_000n, salt: req.salt as Hex }));
    expect(v.request.from).toBe(account.address);
  });

  it('sends through the relayer and returns the tx hash', async () => {
    const sent: unknown[] = [];
    const r = await relayEnter(await signed(), { ...ctx(), sender: { send: async (x) => (sent.push(x), `0x${'ab'.repeat(32)}` as Hex) } });
    expect(r).toMatchObject({ ok: true, txHash: `0x${'ab'.repeat(32)}` });
    expect(sent.length).toBe(1);
    expect(await relayEnter(await signed(), { ...ctx(), sender: null })).toMatchObject({ ok: false, code: 'relayer-unavailable', status: 503 });
    expect(
      await relayEnter(await signed(), { ...ctx(), sender: { send: async () => { throw new Error('nonce too low'); } } }),
    ).toMatchObject({ ok: false, code: 'send-failed', status: 502 });
  });

  it('refuses before deployment', async () => {
    expect(await validateRelayRequest(await signed(), ctx({ deployment: loadDeployment({ env: {} }) }))).toMatchObject({ code: 'not-deployed', status: 503 });
  });

  it('bad shapes', async () => {
    const good = await signed();
    for (const bad of [null, {}, { ...good, from: 'nope' }, { ...good, outcome: 2 }, { ...good, amount: '1.5' }, { ...good, salt: '0x12' }, { ...good, signature: 'zz' }, { ...good, marketId: -1 }]) {
      expect((await validateRelayRequest(bad, ctx())) as { code?: string }).toMatchObject({ ok: false, code: 'bad-request', status: 400 });
    }
  });

  it('wrong domain: another chain or another contract', async () => {
    expect(await validateRelayRequest({ ...(await signed()), chainId: 1 }, ctx())).toMatchObject({ code: 'wrong-domain' });
    expect(await validateRelayRequest({ ...(await signed()), hunchVpm: '0x0000000000000000000000000000000000000bad' }, ctx())).toMatchObject({ code: 'wrong-domain' });
    // Signed for another contract (the nonce and `to` differ): recovery fails.
    const other = await signed({ hunchVpm: '0x0000000000000000000000000000000000000bad' });
    expect(await validateRelayRequest(other, ctx())).toMatchObject({ code: 'bad-signature' });
  });

  it('expired, not yet valid, or valid for too long', async () => {
    expect(await validateRelayRequest(await signed({ validBefore: BigInt(NOW + 10) }), ctx())).toMatchObject({ code: 'expired' });
    expect(await validateRelayRequest(await signed({ validBefore: BigInt(NOW - 1) }), ctx())).toMatchObject({ code: 'expired' });
    expect(await validateRelayRequest(await signed({ validAfter: BigInt(NOW + 5) }), ctx())).toMatchObject({ code: 'not-yet-valid' });
    expect(await validateRelayRequest(await signed({ validBefore: BigInt(NOW + 7200) }), ctx())).toMatchObject({ code: 'validity-too-long' });
  });

  it('amounts: 1–100 USDG venue-wide, then the market caps', async () => {
    expect(await validateRelayRequest(await signed({ amount: 999_999n }), ctx())).toMatchObject({ code: 'amount-out-of-range' });
    expect(await validateRelayRequest(await signed({ amount: 100_000_001n }), ctx())).toMatchObject({ code: 'amount-out-of-range' });
    const tight = chain({ market: async () => ({ statusCode: 0, resolutionTime: NOW + 3600, minEntry: 2_000_000n, maxEntry: 3_000_000n }) });
    expect(await validateRelayRequest(await signed({ amount: 1_500_000n }), ctx({ chain: tight }))).toMatchObject({ code: 'below-market-min' });
    expect(await validateRelayRequest(await signed({ amount: 4_000_000n }), ctx({ chain: tight }))).toMatchObject({ code: 'above-market-max' });
  });

  it('bad signature: a different signer or a tampered amount', async () => {
    const req = await signed();
    expect(await validateRelayRequest({ ...req, amount: '6000000' }, ctx())).toMatchObject({ code: 'bad-signature' });
    const stranger = privateKeyToAccount(generatePrivateKey());
    expect(await validateRelayRequest({ ...req, from: stranger.address }, ctx())).toMatchObject({ code: 'bad-signature' });
    // A smart wallet cannot be recovered; it goes on to the on-chain simulation.
    expect((await validateRelayRequest({ ...req, from: stranger.address }, ctx({ chain: chain({ isContract: async () => true }) }))).ok).toBe(true);
  });

  it('geo: US, CA, GB and CH are refused (451)', async () => {
    for (const c of ['US', 'ca', 'GB', 'CH']) expect(await validateRelayRequest(await signed(), ctx({ country: c }))).toMatchObject({ code: 'geo-blocked', status: 451 });
    expect((await validateRelayRequest(await signed(), ctx({ country: null }))).ok).toBe(true);
  });

  it('rate limit: 10 per minute per IP and per wallet', async () => {
    const limiter = new RateLimiter(10, 60_000);
    const results = [];
    for (let i = 0; i < 11; i++) results.push(await validateRelayRequest(await signed(), ctx({ limiter, ip: `198.51.100.${i}` })));
    expect(results.slice(0, 10).every((r) => r.ok)).toBe(true);
    expect(results[10]).toMatchObject({ code: 'rate-limited', status: 429 });
    const ipLimiter = new RateLimiter(10, 60_000);
    for (let i = 0; i < 10; i++) ipLimiter.take('ip:203.0.113.7', NOW * 1000);
    expect(await validateRelayRequest(await signed(), ctx({ limiter: ipLimiter }))).toMatchObject({ code: 'rate-limited' });
    // The window slides.
    expect((await validateRelayRequest(await signed(), ctx({ limiter: ipLimiter, nowSec: NOW + 61 }))).ok).toBe(true);
  });

  it('market state: unknown, settled, frozen, paused', async () => {
    expect(await validateRelayRequest(await signed({ marketId: 9n }), ctx())).toMatchObject({ code: 'market-not-found', status: 404 });
    const settled = chain({ market: async () => ({ statusCode: MARKET_STATUS.Resolved, resolutionTime: NOW - 10, minEntry: 0n, maxEntry: 0n }) });
    expect(await validateRelayRequest(await signed(), ctx({ chain: settled }))).toMatchObject({ code: 'market-closed' });
    const atTheBell = chain({ market: async () => ({ statusCode: 0, resolutionTime: NOW + 10, minEntry: 0n, maxEntry: 0n }) });
    expect(await validateRelayRequest(await signed(), ctx({ chain: atTheBell }))).toMatchObject({ code: 'market-closed' });
    expect(await validateRelayRequest(await signed(), ctx({ chain: chain({ entriesPaused: async () => true }) }))).toMatchObject({ code: 'entries-paused' });
  });

  it('replayed nonce, balance, simulation', async () => {
    const req = await signed();
    const nonce = enterNonce({ hunchVpm: d.contracts.HunchVPM.address, marketId: 3n, outcome: UP, amount: 5_000_000n, salt: req.salt as Hex });
    expect(await validateRelayRequest(req, ctx({ chain: chain({ used: new Set([nonce]) }) }))).toMatchObject({ code: 'nonce-used', status: 409 });
    expect(await validateRelayRequest(await signed(), ctx({ chain: chain({ usdgBalance: async () => 4_999_999n }) }))).toMatchObject({ code: 'insufficient-balance' });
    expect(await validateRelayRequest(await signed(), ctx({ chain: chain({ simulate: async () => ({ ok: false, reason: 'reverted: AddressFrozen' }) }) }))).toMatchObject({
      code: 'simulation-failed',
      status: 422,
      message: 'USDG has frozen this wallet, so it cannot bet.',
    });
    expect(await validateRelayRequest(await signed(), ctx({ chain: chain({ simulate: async () => ({ ok: false, reason: 'reverted: VintageFull' }) }) }))).toMatchObject({
      message: 'Many bets landed in the last few seconds. Try again in a moment.',
    });
    expect(await validateRelayRequest(await signed(), ctx({ chain: chain({ simulate: async () => ({ ok: false, reason: 'execution reverted' }) }) }))).toMatchObject({
      message: 'The bet would fail on chain: execution reverted',
    });
  });

  it('error messages follow the copy rules (plain words, no em dashes)', async () => {
    const r = await validateRelayRequest(await signed(), ctx({ country: 'US' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain('—');
  });
});
