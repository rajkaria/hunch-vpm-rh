import { describe, expect, it } from 'vitest';
import marketHeadroom from './fixtures/market-headroom.json';
import marketUnbounded from './fixtures/market-unbounded.json';
import marketVoided from './fixtures/market-voided.json';
import { ALICE, MARKET_HEADROOM, MARKET_UNBOUNDED, MARKET_VOIDED, SETTLER, testRail } from './support.js';

const BOB = '0x5555555555555555555555555555555555555555';

/** Who holds what on market 7, for the counterparty read. */
const holdings = {
  positions: [
    { id: `${SETTLER}-20`, positionId: '20', owner: { id: ALICE }, outcome: 1, accepted: '5000000' },
    { id: `${SETTLER}-23`, positionId: '23', owner: { id: BOB }, outcome: 0, accepted: '10000000' },
  ],
};

describe('research: what an agent needs to decide', () => {
  it('reports what is backing each outcome, with the labels the app configured', async () => {
    const { rail } = testRail({ market: marketHeadroom });
    const research = await rail.research(MARKET_HEADROOM);

    expect(research.rail).toBe('arc');
    expect(research.marketId).toBe(MARKET_HEADROOM);
    expect(research.status).toBe('Open');
    expect(research.totalAccepted).toBe(15_000000n);
    expect(research.outcomes).toEqual([
      {
        outcome: 0,
        label: 'yes',
        backing: 10_000000n,
        probabilityPpm: 666666n,
        probabilityPercent: '66.6666',
        decimalOddsPpm: 1_500000n,
      },
      {
        outcome: 1,
        label: 'no',
        backing: 5_000000n,
        probabilityPpm: 333333n,
        probabilityPercent: '33.3333',
        decimalOddsPpm: 3_000000n,
      },
    ]);
  });

  it('reports the headroom that decides a stake, which is the opposing book', async () => {
    const { rail } = testRail({ market: marketHeadroom });
    const research = await rail.research(MARKET_HEADROOM);

    const yes = research.headroom[0];
    // Outcome 0's own book has 14 of room, and that is not what limits a stake
    // ON outcome 0: that stake vests into book 1, which has 1 of room and 2
    // already queued against it in this block.
    expect(yes?.ownBookHeadroom).toBe(14_000000n);
    expect(yes?.bindingOutcome).toBe(1);
    expect(yes?.bindingHeadroom).toBe(1_000000n);
    expect(yes?.competingDemand).toBe(2_000000n);
    expect(yes?.maxFullyAccepted).toBe(0n);

    const no = research.headroom[1];
    expect(no?.ownBookHeadroom).toBe(1_000000n);
    expect(no?.bindingOutcome).toBe(0);
    expect(no?.maxFullyAccepted).toBe(14_000000n);
    expect(no?.opposing).toEqual([
      { outcome: 0, headroom: 14_000000n, competingDemand: 0n, allowance: 14_000000n },
    ]);
    expect(research.demandUnknown).toBe(false);
  });

  it('carries the resolution spec, so the terms are auditable before staking', async () => {
    const { rail } = testRail({ market: marketHeadroom });
    const research = await rail.research(MARKET_HEADROOM);

    expect(research.resolution.by).toBe('feed');
    expect(research.resolution.registered).toBe(true);
    expect(research.resolution.oracle).toBe('0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62');
    expect(research.resolution.strike).toBe(300_000000000n);
    expect(research.resolution.strikeDecimal).toBe('3000');
    expect(research.resolution.direction).toBe('above');
    expect(research.resolution.maxStaleness).toBe(300n);
    expect(research.resolution.voidableFrom).toBe(2_000_086_400n);
  });

  it('counts down to the freeze', async () => {
    const { rail } = testRail({ market: marketHeadroom });
    const research = await rail.research(MARKET_HEADROOM);

    expect(research.closesAt).toBe(2_000_000_000n);
    expect(research.secondsToClose).toBe(1000n);
    expect(research.closed).toBe(false);

    const frozen = await rail.research(MARKET_HEADROOM, { now: 2_000_000_500n });
    expect(frozen.secondsToClose).toBe(0n);
    expect(frozen.closed).toBe(true);
  });

  it('says a voided market is closed, and what voided it', async () => {
    const { rail } = testRail({ market: marketVoided });
    const research = await rail.research(MARKET_VOIDED);

    expect(research.status).toBe('Voided');
    expect(research.closed).toBe(true);
    expect(research.winner).toBeNull();
    // The only reading available was 900 seconds old against a 300 second bound.
    expect(research.resolution.voidedStaleAge).toBe(900n);
    expect(research.resolution.direction).toBe('below');
  });

  it('will not guess who resolves a market that was opened without a spec', async () => {
    const { rail } = testRail({ market: marketUnbounded });
    const research = await rail.research(MARKET_UNBOUNDED);

    expect(research.resolution.registered).toBe(false);
    expect(research.resolution.by).toBe('unknown');
    expect(research.resolution.strike).toBeNull();
  });

  it('reports unbounded capacity as unbounded, not as a very large number', async () => {
    const { rail } = testRail({ market: marketUnbounded });
    const research = await rail.research(MARKET_UNBOUNDED);

    expect(research.kappa).toBeNull();
    expect(research.headroom.every((entry) => entry.maxFullyAccepted === null)).toBe(true);
    expect(research.headroom[0]?.opposing.every((book) => book.headroom === null)).toBe(true);
  });

  it('does not pay for the counterparty read unless it is asked for', async () => {
    const { rail, transport } = testRail({ market: marketHeadroom });
    const research = await rail.research(MARKET_HEADROOM);

    expect(research.counterparty).toBeNull();
    // No `marketPositions` fixture is recorded, so asking for one would throw.
    expect(transport.calls.map((call) => call.operation)).toEqual(['market', 'market']);
  });

  it('reads who is on the other side when asked, and says when nothing rates them', async () => {
    const { rail } = testRail(
      { market: marketHeadroom, marketPositions: holdings },
      { includeCounterparty: true },
    );
    const research = await rail.research(MARKET_HEADROOM);

    const takingYes = research.counterparty?.sides[0];
    expect(takingYes?.opposingPrincipal).toBe(5_000000n);
    expect(takingYes?.counterparties).toBe(1);
    // No reputation subgraph is configured, so every wallet counts as unrated —
    // which is a different statement from "scores badly".
    expect(research.counterparty?.unavailable).toBe(true);
    expect(takingYes?.meanScore).toBeNull();
    expect(takingYes?.unratedSharePpm).toBe(1_000000n);
  });

  it('carries the index head, because every number here is as of a block', async () => {
    const { rail } = testRail({ market: marketHeadroom });
    const research = await rail.research(MARKET_HEADROOM);

    expect(research.index.block).toBe(1000n);
    expect(research.index.hasIndexingErrors).toBe(false);
    expect(research.settler).toBe(SETTLER);
    expect(research.settlerKind).toBe('vested');
    expect(research.onChainMarketId).toBe(7n);
  });
});
