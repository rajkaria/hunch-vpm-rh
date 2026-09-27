import { describe, expect, it } from 'vitest';
import agentsByOwner from './fixtures/agents-by-owner.json';
import agentsByWallet from './fixtures/agents-by-wallet.json';
import agentsRegisteredUnrated from './fixtures/agents-registered-unrated.json';
import marketOpen from './fixtures/market-open.json';
import marketPositions from './fixtures/market-positions.json';
import { createHunchClient } from '../src/client.js';
import { BOB, MARKET_A, testClient } from './support/client.js';
import { fixtureTransport, pagedResponder } from './support/transport.js';

// Alice signs from an address that is not the one holding her identity NFT, so
// the registry finds her by `agentWallet`. Bob holds his own, so he is only
// found by `owner`. Both paths have to work or half the side reads as anonymous.
const responses = {
  market: marketOpen,
  marketPositions,
  agents: agentsByWallet,
  agentsByOwner,
};

describe('counterpartyTrust', () => {
  it('aggregates who is on the other side of each outcome', async () => {
    const { client } = testClient(responses);
    const trust = await client.counterpartyTrust(MARKET_A);

    const againstOutcomeZero = trust.sides[0];
    expect(againstOutcomeZero?.opposingPrincipal).toBe(101_000000n);
    expect(againstOutcomeZero?.counterparties).toBe(2);
    expect(againstOutcomeZero?.ratedCounterparties).toBe(1);
    // Bob: four live feedbacks averaging 90, matched on the NFT holder.
    expect(againstOutcomeZero?.meanScore).toBe(90);
    expect(againstOutcomeZero?.wallets[0]?.address).toBe(BOB);
    expect(againstOutcomeZero?.wallets[0]?.principal).toBe(100_000000n);

    const againstOutcomeOne = trust.sides[1];
    expect(againstOutcomeOne?.opposingPrincipal).toBe(6_000000n);
    // Alice: two feedbacks averaging 50, matched on the signing wallet.
    expect(againstOutcomeOne?.meanScore).toBe(50);
  });

  it('reports the share of the opposing book held by wallets with no reputation', async () => {
    const { client } = testClient(responses);
    const trust = await client.counterpartyTrust(MARKET_A);

    // The creator's seed leg is 1 of the 101 opposing outcome 0, and the
    // registry has never heard of that wallet.
    expect(trust.sides[0]?.unratedPrincipal).toBe(1_000000n);
    expect(trust.sides[0]?.unratedSharePpm).toBe(9_900n);
    // 1 of the 6 opposing outcome 1.
    expect(trust.sides[1]?.unratedPrincipal).toBe(1_000000n);
    expect(trust.sides[1]?.unratedSharePpm).toBe(166_666n);
  });

  it('weights the mean by principal, so a large unrated holder is not averaged away', async () => {
    const { client } = testClient(responses);
    const trust = await client.counterpartyTrust(MARKET_A);
    // Only Bob is rated on that side, so the weighted mean is his score.
    expect(trust.sides[0]?.principalWeightedMeanScore).toBe(90);
  });

  it('treats an agent whose feedback was all revoked as unrated, not as a zero', async () => {
    const { client } = testClient({ ...responses, agents: agentsRegisteredUnrated });
    const trust = await client.counterpartyTrust(MARKET_A);

    const againstOutcomeOne = trust.sides[1];
    expect(againstOutcomeOne?.ratedCounterparties).toBe(0);
    expect(againstOutcomeOne?.meanScore).toBeNull();
    expect(againstOutcomeOne?.principalWeightedMeanScore).toBeNull();
    expect(againstOutcomeOne?.unratedSharePpm).toBe(1_000_000n);
    const alice = againstOutcomeOne?.wallets.find((wallet) => wallet.agentId === 17n);
    expect(alice?.meanScore).toBeNull();
    expect(alice?.feedbackCount).toBe(0);
  });

  it('says so when no reputation source is configured', async () => {
    const client = createHunchClient({
      subgraphUrl: 'https://subgraph.invalid/hunch-vpm',
      transport: fixtureTransport({ market: marketOpen, marketPositions }),
    });
    const trust = await client.counterpartyTrust(MARKET_A);

    expect(trust.reputationUnavailable).toBe(true);
    expect(trust.sides[0]?.meanScore).toBeNull();
    expect(trust.sides[0]?.unratedSharePpm).toBe(1_000_000n);
  });

  it('accepts a replacement reputation source', async () => {
    const { client } = testClient({ market: marketOpen, marketPositions });
    const trust = await client.counterpartyTrust(MARKET_A, {
      reputation: async (addresses) =>
        addresses
          .filter((address) => address === BOB)
          .map((address) => ({
            address,
            owner: address,
            agentWallet: null,
            agentId: 42n,
            feedbackCount: 1,
            scoreSum: '10',
            meanScore: 10,
          })),
    });
    expect(trust.sides[0]?.meanScore).toBe(10);
    expect(trust.reputationUnavailable).toBe(false);
  });

  it('walks every page of holders', async () => {
    const { client, transport } = testClient(
      {
        market: marketOpen,
        marketPositions: pagedResponder('positions', marketPositions.positions),
        agents: pagedResponder('agents', agentsByWallet.agents),
        agentsByOwner: pagedResponder('agents', agentsByOwner.agents),
      },
      { pageSize: 2 },
    );
    const trust = await client.counterpartyTrust(MARKET_A);

    // 4 holders at 2 per page: two full pages then a short one that ends the walk.
    expect(transport.calls.filter((call) => call.operation === 'marketPositions')).toHaveLength(3);
    expect(trust.sides[0]?.counterparties).toBe(2);
    expect(trust.sides[0]?.opposingPrincipal).toBe(101_000000n);
  });
});
