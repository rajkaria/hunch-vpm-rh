import { describe, expect, it } from 'vitest';
import marketLean from './fixtures/market-lean.json';
import marketEmpty from './fixtures/market-empty.json';
import marketOpen from './fixtures/market-open.json';
import marketOpenVintage from './fixtures/market-open-vintage.json';
import marketStaleVintage from './fixtures/market-stale-vintage.json';
import marketTight from './fixtures/market-tight.json';
import marketUnbounded from './fixtures/market-unbounded.json';
import marketVoided from './fixtures/market-voided.json';
import { MARKET_A, MARKET_EMPTY, MARKET_TIGHT, MARKET_UNBOUNDED, MARKET_VOIDED, testClient } from './support/client.js';

const NOW = 1_900_000_000n;

describe('bestHeadroom', () => {
  it('names the outcome with the most room, bound by the opposing book', async () => {
    const { client } = testClient({ market: marketOpen });
    const answer = await client.bestHeadroom(MARKET_A, { now: NOW });

    // Book 1 has 3024 USDC of room, so a stake on outcome 0 — which vests into
    // book 1 — is the one that will not be refused.
    expect(answer.best?.outcome).toBe(0);
    expect(answer.best?.bindingHeadroom).toBe(3_024_000000n);
    expect(answer.best?.maxFullyAccepted).toBe(3_024_000000n);
    expect(answer.best?.bindingOutcome).toBe(1);

    // Book 0 has only 79 USDC of room, which caps a stake on outcome 1.
    expect(answer.outcomes[1]?.maxFullyAccepted).toBe(79_000000n);
    expect(answer.outcomes[1]?.bindingOutcome).toBe(0);

    expect(answer.frozen).toBe(false);
    expect(answer.demandUnknown).toBe(false);
    expect(answer.index.block).toBe(1000n);
  });

  it('subtracts stake already queued in this block', async () => {
    const { client } = testClient({ market: marketOpenVintage });
    const answer = await client.bestHeadroom(MARKET_A, { now: NOW });

    const onOutcomeOne = answer.outcomes[1];
    expect(onOutcomeOne?.bindingHeadroom).toBe(79_000000n);
    expect(onOutcomeOne?.competingDemand).toBe(50_000000n);
    // 79 of room, 50 already queued against book 0 this block: 29 gets in whole.
    expect(onOutcomeOne?.maxFullyAccepted).toBe(29_000000n);
  });

  it('ignores a vintage from an earlier block, which the entry itself rolls', async () => {
    const { client } = testClient({ market: marketStaleVintage });
    const answer = await client.bestHeadroom(MARKET_A, { now: NOW });
    expect(answer.outcomes[1]?.competingDemand).toBe(0n);
    expect(answer.outcomes[1]?.maxFullyAccepted).toBe(79_000000n);
  });

  it('says so when it was not asked to read the queue', async () => {
    const { client } = testClient({ market: marketLean }, { readOpenVintage: false });
    const answer = await client.bestHeadroom(MARKET_A, { now: NOW });
    expect(answer.demandUnknown).toBe(true);
    expect(answer.outcomes[1]?.maxFullyAccepted).toBe(79_000000n);
  });

  it('skips an outcome whose opposing book is full', async () => {
    const { client } = testClient({ market: marketTight });
    const answer = await client.bestHeadroom(MARKET_TIGHT, { now: NOW });

    // Book 1 is vested up to its capacity, so nothing can go on outcome 0.
    expect(answer.outcomes[0]?.maxFullyAccepted).toBe(0n);
    expect(answer.best?.outcome).toBe(1);
    expect(answer.best?.maxFullyAccepted).toBe(3_000000n);
  });

  it('reports unbounded capacity as null rather than a sentinel number', async () => {
    const { client } = testClient({ market: marketUnbounded });
    const answer = await client.bestHeadroom(MARKET_UNBOUNDED, { now: NOW });

    expect(answer.best?.outcome).toBe(0);
    expect(answer.best?.maxFullyAccepted).toBeNull();
    expect(answer.best?.bindingHeadroom).toBeNull();
    for (const outcome of answer.outcomes) {
      expect(outcome.bookHeadroom).toBeNull();
    }
  });

  it('has no answer for a market with no principal at all', async () => {
    const { client } = testClient({ market: marketEmpty });
    const answer = await client.bestHeadroom(MARKET_EMPTY, { now: NOW });
    expect(answer.best).toBeNull();
    expect(answer.outcomes.every((outcome) => outcome.maxFullyAccepted === 0n)).toBe(true);
  });

  it('has no answer past the freeze, whatever the books say', async () => {
    const { client } = testClient({ market: marketOpen });
    const answer = await client.bestHeadroom(MARKET_A, { now: 2_000_000_000n });
    expect(answer.frozen).toBe(true);
    expect(answer.best).toBeNull();
    // The room is still reported; it just cannot be used.
    expect(answer.outcomes[0]?.maxFullyAccepted).toBe(3_024_000000n);
  });

  it('has no answer on a settled market', async () => {
    const { client } = testClient({ market: marketVoided });
    const answer = await client.bestHeadroom(MARKET_VOIDED, { now: 1_600_000_000n });
    expect(answer.status).toBe('Voided');
    expect(answer.frozen).toBe(true);
    expect(answer.best).toBeNull();
  });

  it('reports a missing market as not found rather than an empty book', async () => {
    const { client } = testClient({ market: { _meta: { block: { number: 1 } }, market: null } });
    await expect(client.bestHeadroom('0xdead-9')).rejects.toThrow(/is not in the subgraph/);
  });
});
