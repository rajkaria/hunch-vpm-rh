import { describe, expect, it, vi } from 'vitest';
import { SHARED_ANONYMOUS_SUBJECT, defaultSubject } from '../src/gate.js';
import { normalizeHeaders } from '../src/headers.js';
import { InMemoryTierStorage } from '../src/storage.js';
import { buildTierPolicies } from '../src/tiers.js';
import {
  PATH,
  counterStoreDown,
  countingAgentBook,
  createHarness,
  impostor,
  makeProof,
  registeredAgent,
  requestFor,
} from './support/harness.js';

const tightPolicies = buildTierPolicies({ baseRequests: 2, windowMs: 60_000 });

describe('a human-backed request', () => {
  it('passes with the human-backed policy and advertises it', async () => {
    const { gate, clock } = createHarness();
    const proof = await makeProof(clock);

    const decision = await gate.evaluate(requestFor(proof.headers));

    expect(decision.ok).toBe(true);
    expect(decision.status).toBe(200);
    expect(decision.tier).toBe('human-backed');
    expect(decision.policy.rewardEligible).toBe(true);
    expect(decision.policy.perMarketCap).toBeNull();
    expect(decision.headers['x-agent-tier']).toBe('human-backed');
    expect(decision.headers['ratelimit-limit']).toBe('600');
    expect(decision.identity?.wallet).toBe(registeredAgent.address.toLowerCase());
    expect(decision.subject).toBe(`wallet:${registeredAgent.address.toLowerCase()}`);
  });
});

describe('an anonymous request', () => {
  it('passes with the anonymous policy, which is the whole point', async () => {
    const { gate } = createHarness();

    const decision = await gate.evaluate({ headers: {} });

    expect(decision.ok).toBe(true);
    expect(decision.tier).toBe('anonymous');
    expect(decision.policy.perMarketCap).toBeGreaterThan(0n);
    expect(decision.policy.leaderboard.visible).toBe(true);
    expect(decision.headers['ratelimit-limit']).toBe('60');
  });

  it('is told nothing about proofs it never tried to present', async () => {
    const { gate } = createHarness();

    expect((await gate.evaluate({ headers: {} })).headers['x-agent-proof-status']).toBeUndefined();
  });

  it('is told why when it did present something and it did not hold up', async () => {
    const { gate, clock } = createHarness();
    const proof = await makeProof(clock, { signAs: impostor });

    const decision = await gate.evaluate(requestFor(proof.headers));

    expect(decision.ok).toBe(true);
    expect(decision.tier).toBe('anonymous');
    expect(decision.headers['x-agent-proof-status']).toBe('signature_mismatch');
  });
});

describe('onInvalidProof', () => {
  it('answers 401 for a broken proof when told to reject', async () => {
    const { gate, clock } = createHarness({ onInvalidProof: 'reject' });
    const proof = await makeProof(clock, { signAs: impostor });

    const decision = await gate.evaluate(requestFor(proof.headers));

    expect(decision.ok).toBe(false);
    expect(decision.status).toBe(401);
    expect(decision.problem?.code).toBe('invalid_agent_proof');
  });

  it('still lets a caller through that presented nothing at all', async () => {
    const { gate } = createHarness({ onInvalidProof: 'reject' });

    const decision = await gate.evaluate({ headers: {} });

    expect(decision.ok).toBe(true);
    expect(decision.tier).toBe('anonymous');
  });

  // A duplicated `accept` is an ordinary request from an ordinary client. Rejecting it
  // would be a 401 titled "Invalid agent proof" for a caller that presented no proof.
  it('does not treat a duplicated unrelated header as a broken proof', async () => {
    const { gate } = createHarness({ onInvalidProof: 'reject', subject: () => 'fixed' });

    const decision = await gate.evaluate({
      headers: { accept: ['application/json', 'text/html'] },
      path: PATH,
    });

    expect(decision.ok).toBe(true);
    expect(decision.tier).toBe('anonymous');
    expect(decision.verification.presented).toBe(false);
    expect(decision.headers['x-agent-proof-status']).toBeUndefined();
  });
});

describe('a request the gate cannot read', () => {
  it('returns a decision for a conflicting proof header rather than throwing', async () => {
    const { gate, clock } = createHarness();
    const proof = await makeProof(clock);

    const decision = await gate.evaluate({
      headers: { agentkit: [proof.headers.agentkit as string, 'other'] },
      path: PATH,
    });

    expect(decision.ok).toBe(true);
    expect(decision.tier).toBe('anonymous');
    expect(decision.verification.presented).toBe(true);
    expect(decision.headers['x-agent-proof-status']).toBe('headers_malformed');
  });

  it('rejects that one under onInvalidProof: reject, because a proof really was presented', async () => {
    const { gate, clock } = createHarness({ onInvalidProof: 'reject' });
    const proof = await makeProof(clock);

    const decision = await gate.evaluate({
      headers: { agentkit: [proof.headers.agentkit as string, 'other'] },
      path: PATH,
    });

    expect(decision.status).toBe(401);
  });

  it('still attributes such a request to its own bucket, not the shared one', async () => {
    const { gate } = createHarness();

    const decision = await gate.evaluate({
      headers: { agentkit: ['one', 'two'], 'x-forwarded-for': '203.0.113.7' },
      path: PATH,
    });

    expect(decision.subject).toBe('ip:203.0.113.7');
  });

  it('does not throw for a duplicated header on any name at all', async () => {
    const { gate } = createHarness();

    const decision = await gate.evaluate({
      headers: { accept: ['application/json', 'text/html'] },
      path: PATH,
    });

    expect(decision.ok).toBe(true);
  });
});

describe('the verification budget', () => {
  it('stops verifying once one source has spent it, and stops reading the registry', async () => {
    const agentBook = countingAgentBook();
    const { gate, clock } = createHarness({
      agentBook,
      // Default budget here would be the human-backed limit of 20; two makes the point in
      // four requests rather than twenty-one.
      policies: tightPolicies,
      verificationBudget: 2,
    });

    const outcomes = [];
    for (let i = 0; i < 4; i += 1) {
      const proof = await makeProof(clock);
      outcomes.push(
        await gate.evaluate({
          headers: { ...proof.headers, 'x-forwarded-for': '203.0.113.7' },
          method: 'GET',
          path: PATH,
        }),
      );
    }

    expect(outcomes.map((d) => d.ok)).toEqual([true, true, false, false]);
    expect(outcomes[2]?.status).toBe(429);
    expect(outcomes[2]?.problem?.code).toBe('rate_limited');
    expect(outcomes[2]?.verification.presented).toBe(true);
    expect(outcomes[2]?.headers['x-agent-proof-status']).toBe('verification_budget_exhausted');
    expect(outcomes[2]?.subject).toBe('verify:ip:203.0.113.7');
    // The two refused requests cost no recovery and no lookup, which is the whole point.
    expect(agentBook.lookups).toBe(2);
  });

  it('answers 429 and not 401 when told to reject, because no proof was ever read', async () => {
    const { gate, clock } = createHarness({
      policies: tightPolicies,
      verificationBudget: 1,
      onInvalidProof: 'reject',
    });

    await gate.evaluate(requestFor((await makeProof(clock)).headers));
    const blocked = await gate.evaluate(requestFor((await makeProof(clock)).headers));

    expect(blocked.status).toBe(429);
    expect(blocked.problem?.code).toBe('rate_limited');
  });

  it('never counts a request that presented no proof, because tiering one costs nothing', async () => {
    const { gate } = createHarness({ policies: tightPolicies, verificationBudget: 1 });
    const headers = { 'x-forwarded-for': '203.0.113.7' };

    // Two anonymous requests fit the base allowance of 2 and never touch the budget.
    expect((await gate.evaluate({ headers })).ok).toBe(true);
    expect((await gate.evaluate({ headers })).ok).toBe(true);
  });

  it('defaults to the human-backed limit, so a caller entitled to it is never cut short', async () => {
    const { gate, clock } = createHarness({ policies: tightPolicies });

    for (let i = 0; i < 20; i += 1) {
      const proof = await makeProof(clock);
      expect((await gate.evaluate(requestFor(proof.headers))).ok).toBe(true);
    }
  });

  it('can be turned off, and then every offered proof is verified however many there are', async () => {
    const agentBook = countingAgentBook();
    const { gate, clock } = createHarness({
      agentBook,
      policies: tightPolicies,
      verificationBudget: null,
      enforceRateLimit: false,
    });

    for (let i = 0; i < 25; i += 1) {
      const proof = await makeProof(clock);
      await gate.evaluate(requestFor(proof.headers));
    }

    expect(agentBook.lookups).toBe(25);
  });

  it('refuses a budget that is not a positive integer', () => {
    expect(() => createHarness({ verificationBudget: 0 })).toThrow(RangeError);
    expect(() => createHarness({ verificationBudget: 1.5 })).toThrow(RangeError);
  });
});

describe('rate limiting through the gate', () => {
  it('blocks an anonymous caller past its allowance and says when to come back', async () => {
    const { gate } = createHarness({ policies: tightPolicies });
    const headers = { 'x-forwarded-for': '203.0.113.7' };

    expect((await gate.evaluate({ headers })).ok).toBe(true);
    expect((await gate.evaluate({ headers })).ok).toBe(true);
    const blocked = await gate.evaluate({ headers });

    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe(429);
    expect(blocked.problem?.code).toBe('rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.problem?.detail).toContain('AgentKit');
  });

  it('gives a human-backed caller ten times the same allowance', async () => {
    const { gate, clock } = createHarness({ policies: tightPolicies });

    for (let i = 0; i < 20; i += 1) {
      const proof = await makeProof(clock);
      const decision = await gate.evaluate(requestFor(proof.headers));
      expect(decision.tier).toBe('human-backed');
      expect(decision.ok).toBe(true);
    }

    const proof = await makeProof(clock);
    expect((await gate.evaluate(requestFor(proof.headers))).ok).toBe(false);
  });

  it('keeps two anonymous callers in separate buckets when they can be told apart', async () => {
    const { gate } = createHarness({ policies: tightPolicies });

    await gate.evaluate({ headers: { 'x-forwarded-for': '203.0.113.7' } });
    await gate.evaluate({ headers: { 'x-forwarded-for': '203.0.113.7' } });

    expect((await gate.evaluate({ headers: { 'x-forwarded-for': '203.0.113.8' } })).ok).toBe(true);
  });

  it('can be turned off entirely for a route that meters itself', async () => {
    const { gate } = createHarness({ policies: tightPolicies, enforceRateLimit: false });

    for (let i = 0; i < 10; i += 1) {
      expect((await gate.evaluate({ headers: {} })).ok).toBe(true);
    }
  });

  it('lets requests through, loudly, when the counter store is down', async () => {
    const onRateLimitStorageError = vi.fn();
    const { gate } = createHarness({
      policies: tightPolicies,
      storage: counterStoreDown(new InMemoryTierStorage()),
      onRateLimitStorageError,
    });

    for (let i = 0; i < 5; i += 1) {
      const decision = await gate.evaluate({ headers: {} });
      expect(decision.ok).toBe(true);
      expect(decision.rateLimit.degraded).toBe(true);
    }
    expect(onRateLimitStorageError).toHaveBeenCalledTimes(5);
  });

  // Documented rather than fixed: the default resolver keys on the wallet while a proof
  // is presented and on the address once it is not, so the two buckets are different
  // buckets. Bounded at base + 10·base per window, and not fixable without an identifier
  // that survives the proof going away.
  it('hands a caller that stops presenting its proof the anonymous bucket as well', async () => {
    const oneAndTen = buildTierPolicies({ baseRequests: 1, windowMs: 60_000 });
    const { gate, clock } = createHarness({ policies: oneAndTen });
    const from = { 'x-forwarded-for': '203.0.113.7' };

    for (let i = 0; i < 10; i += 1) {
      const proof = await makeProof(clock);
      const decision = await gate.evaluate({ headers: { ...proof.headers, ...from }, path: PATH });
      expect(decision.ok).toBe(true);
    }
    const eleventh = await gate.evaluate({
      headers: { ...(await makeProof(clock)).headers, ...from },
      path: PATH,
    });
    const unproven = await gate.evaluate({ headers: from, path: PATH });

    expect(eleventh.ok).toBe(false);
    expect(unproven.ok).toBe(true);
    expect(unproven.subject).toBe('ip:203.0.113.7');
  });

  it('holds one bucket for both tiers when the resolver gives it one, which is the fix', async () => {
    const oneAndTen = buildTierPolicies({ baseRequests: 1, windowMs: 60_000 });
    const { gate, clock } = createHarness({ policies: oneAndTen, subject: () => 'api-key:k1' });

    for (let i = 0; i < 10; i += 1) {
      await gate.evaluate(requestFor((await makeProof(clock)).headers));
    }

    expect((await gate.evaluate({ headers: {}, path: PATH })).ok).toBe(false);
  });

  it('accepts a caller-supplied subject resolver', async () => {
    const { gate } = createHarness({
      policies: tightPolicies,
      subject: (request) => {
        const key = request.headers instanceof Headers ? request.headers.get('x-api-key') : null;
        return `api-key:${key ?? 'none'}`;
      },
    });

    expect((await gate.evaluate({ headers: new Headers({ 'x-api-key': 'k1' }) })).subject).toBe(
      'api-key:k1',
    );
  });
});

describe('defaultSubject', () => {
  it('keys a human-backed caller on the wallet, which cannot be forged', async () => {
    const { verifier, clock } = createHarness();
    const proof = await makeProof(clock);
    const result = await verifier.verify(requestFor(proof.headers));

    expect(defaultSubject({ headers: proof.headers, path: PATH }, result)).toBe(
      `wallet:${registeredAgent.address.toLowerCase()}`,
    );
  });

  it('falls back to a single shared bucket when a caller cannot be attributed', () => {
    expect(
      defaultSubject(
        { headers: {} },
        { tier: 'anonymous', presented: false, reason: 'no_proof_presented', detail: '' },
      ),
    ).toBe(SHARED_ANONYMOUS_SUBJECT);
  });

  it('uses the normalised map when it is given one, which is what the gate passes', () => {
    expect(
      defaultSubject(
        { headers: {} },
        { tier: 'anonymous', presented: false, reason: 'no_proof_presented', detail: '' },
        normalizeHeaders({ 'x-forwarded-for': '203.0.113.7' }),
      ),
    ).toBe('ip:203.0.113.7');
  });

  // The gate always hands the map down; this only covers a direct caller.
  it('answers without throwing when it has to normalise a conflicting proof header itself', () => {
    expect(
      defaultSubject(
        { headers: { agentkit: ['one', 'two'], 'x-real-ip': '203.0.113.9' } },
        { tier: 'anonymous', presented: true, reason: 'headers_malformed', detail: '' },
      ),
    ).toBe('ip:203.0.113.9');
  });
});
