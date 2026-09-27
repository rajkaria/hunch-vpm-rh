import { describe, expect, it } from 'vitest';
import { UnknownSideError } from '../../src/rail/errors.js';
import marketClassic from './fixtures/market-classic.json';
import marketFull from './fixtures/market-full.json';
import marketHeadroom from './fixtures/market-headroom.json';
import marketUnbounded from './fixtures/market-unbounded.json';
import marketVoided from './fixtures/market-voided.json';
import {
  MARKET_FULL,
  MARKET_HEADROOM,
  MARKET_UNBOUNDED,
  MARKET_VOIDED,
  NOW,
  SETTLER_CLASSIC,
  testRail,
} from './support.js';

/**
 * Market 7: kappa 2, outcome 0 backed by 10 with 6 vested into it (14 of room),
 * outcome 1 backed by 5 with 9 vested into it (1 of room). One entry of 2 is
 * queued on outcome 0 in the current block, which is demand against book 1.
 */
const headroomRail = () => testRail({ market: marketHeadroom });

describe('quote: what the books would actually take', () => {
  it('accepts a stake the binding book has room for, in full', async () => {
    const { rail } = headroomRail();
    const quote = await rail.quote(MARKET_HEADROOM, 'no', 10_000000n);

    expect(quote.outcome).toBe(1);
    expect(quote.accepted).toBe(10_000000n);
    expect(quote.refused).toBe(0n);
    expect(quote.acceptance).toBe('full');
    expect(quote.refusal).toBeNull();
    expect(quote.refund.amount).toBe(0n);
    expect(quote.refund.call).toBeNull();
    expect(quote.maxFullyAccepted).toBe(14_000000n);
  });

  it('refuses the part the opposing book cannot cover, and says which book', async () => {
    const { rail } = headroomRail();
    const quote = await rail.quote(MARKET_HEADROOM, 'no', 20_000000n);

    expect(quote.accepted).toBe(14_000000n);
    expect(quote.refused).toBe(6_000000n);
    expect(quote.acceptance).toBe('partial');
    expect(quote.refusal?.kind).toBe('headroom');
    expect(quote.refusal?.refused).toBe(6_000000n);
    // Nothing reverts: the entry lands and the excess becomes refundable.
    expect(quote.refusal?.revertsWith).toBeNull();
    expect(quote.binding?.outcome).toBe(0);
    expect(quote.binding?.headroom).toBe(14_000000n);
  });

  it('escrows the whole offer even when part of it is refused', async () => {
    const { rail } = headroomRail();
    const quote = await rail.quote(MARKET_HEADROOM, 'no', 20_000000n);

    // The settler pulls everything and hands the refused part back by pull.
    // A quote that reported only the accepted 14 would misstate what leaves the
    // wallet by 6.
    expect(quote.escrowed).toBe(20_000000n);
    expect(quote.refund.amount).toBe(6_000000n);
    expect(quote.refund.call).toBe('withdrawRefund');
    expect(quote.refusal?.detail).toContain('withdrawRefund');
  });

  it('counts stake queued in the same block against the same book', async () => {
    const { rail } = headroomRail();
    // Book 1 has 1 of room and 2 already offered against it this block. Three
    // units of demand chase one unit of room, so this offer takes a third.
    const quote = await rail.quote(MARKET_HEADROOM, 'yes', 1_000000n);

    expect(quote.outcome).toBe(0);
    expect(quote.accepted).toBe(333333n);
    expect(quote.refused).toBe(666667n);
    expect(quote.binding?.outcome).toBe(1);
    expect(quote.binding?.competingDemand).toBe(2_000000n);
    expect(quote.maxFullyAccepted).toBe(0n);
    expect(quote.demandUnknown).toBe(false);
  });

  it('accepts nothing against a book with no headroom left', async () => {
    const { rail } = testRail({ market: marketFull });
    const quote = await rail.quote(MARKET_FULL, 'yes', 5_000000n);

    expect(quote.accepted).toBe(0n);
    expect(quote.refused).toBe(5_000000n);
    expect(quote.acceptance).toBe('none');
    expect(quote.refusal?.kind).toBe('headroom');
    // The transaction still succeeds — it just accepts nothing — so the whole
    // stake is escrowed and has to be pulled back.
    expect(quote.refusal?.revertsWith).toBeNull();
    expect(quote.escrowed).toBe(5_000000n);
    expect(quote.refund.amount).toBe(5_000000n);
    expect(quote.refund.call).toBe('withdrawRefund');
    expect(quote.payoutIfResolvedNow.wins).toBe(0n);
  });

  it('is a per-outcome answer: the other side of a full book still takes stake', async () => {
    const { rail } = testRail({ market: marketFull });
    const closed = await rail.quote(MARKET_FULL, 'yes', 5_000000n);
    const open = await rail.quote(MARKET_FULL, 'no', 5_000000n);

    expect(closed.accepted).toBe(0n);
    expect(open.accepted).toBe(5_000000n);
    expect(open.acceptance).toBe('full');
  });

  it('takes everything when capacity is unbounded', async () => {
    const { rail } = testRail({ market: marketUnbounded });
    const quote = await rail.quote(MARKET_UNBOUNDED, 2, 1_000_000_000000n);

    expect(quote.accepted).toBe(1_000_000_000000n);
    expect(quote.refused).toBe(0n);
    expect(quote.maxFullyAccepted).toBeNull();
    expect(quote.binding).toBeNull();
    // Stake vests into every opposing book at once, which is why all of them
    // have to have room for it.
    expect(quote.vestsInto).toEqual([
      { outcome: 0, amount: 1_000_000_000000n },
      { outcome: 1, amount: 1_000_000_000000n },
    ]);
  });

  it('refuses everything past the freeze, and says the transaction would revert', async () => {
    const { rail } = headroomRail();
    const quote = await rail.quote(MARKET_HEADROOM, 'no', 10_000000n, { now: 2_000_000_000n });

    expect(quote.acceptance).toBe('none');
    expect(quote.accepted).toBe(0n);
    expect(quote.refused).toBe(10_000000n);
    expect(quote.refusal?.kind).toBe('market-frozen');
    expect(quote.refusal?.revertsWith).toBe('Frozen');
    expect(quote.closed).toBe(true);
    expect(quote.secondsToClose).toBe(0n);
    // Nothing lands, so nothing is escrowed and there is nothing to pull back.
    expect(quote.escrowed).toBe(0n);
    expect(quote.refund.amount).toBe(0n);
    expect(quote.refund.call).toBeNull();
  });

  it('refuses everything on a voided market', async () => {
    const { rail } = testRail({ market: marketVoided });
    const quote = await rail.quote(MARKET_VOIDED, 'yes', 4_000000n);

    expect(quote.status).toBe('Voided');
    expect(quote.acceptance).toBe('none');
    expect(quote.refusal?.kind).toBe('market-not-open');
    expect(quote.refusal?.revertsWith).toBe('NotOpen');
    expect(quote.escrowed).toBe(0n);
    expect(quote.maxFullyAccepted).toBe(0n);
  });

  it('prices what the accepted stake is worth if the market settled now', async () => {
    const { rail } = headroomRail();
    const quote = await rail.quote(MARKET_HEADROOM, 'no', 20_000000n);

    // On a vested market nothing has vested to a position at the moment it
    // enters — same-vintage entries never vest to each other — so a stake that
    // wins immediately is paid exactly what was accepted. The upside is stake
    // that arrives on the other side afterwards.
    expect(quote.payoutIfResolvedNow.wins).toBe(quote.accepted);
    expect(quote.payoutIfResolvedNow.loses).toBe(0n);
    // A void returns accepted principal exactly. The refused 6 comes back
    // either way, through withdrawRefund.
    expect(quote.payoutIfResolvedNow.voided).toBe(quote.accepted);
    expect(quote.notes.join(' ')).toContain('arrives on the other side later');
  });

  it('prices a classic market by its own rule, not by the vesting one', async () => {
    const { rail } = testRail({ market: marketClassic });
    const quote = await rail.quote(`${SETTLER_CLASSIC}-1`, 'yes', 2_000000n);

    // A classic pool has no capacity to run out of, so nothing is ever refused.
    expect(quote.settlerKind).toBe('classic');
    expect(quote.accepted).toBe(2_000000n);
    expect(quote.maxFullyAccepted).toBeNull();
    // The winner takes a pro-rata share of the whole pool:
    // floor((10 + 2) * 2 / (6 + 2)) = 3.
    expect(quote.payoutIfResolvedNow.wins).toBe(3_000000n);
    expect(quote.payoutIfResolvedNow.voided).toBe(2_000000n);
    // Nothing vests in a classic pool, so nothing is claimed to.
    expect(quote.vestsInto).toEqual([]);
    expect(quote.notes.join(' ')).not.toContain('vests into');
  });

  it('reports the implied probability the accepted stake would leave behind', async () => {
    const { rail } = headroomRail();
    const quote = await rail.quote(MARKET_HEADROOM, 'no', 20_000000n);

    // 5 of 15 before; 19 of 29 once the accepted 14 lands.
    expect(quote.probabilityPpm.before).toBe(333333n);
    expect(quote.probabilityPpm.after).toBe(655172n);
  });

  it('agrees with the client read it is built on', async () => {
    const { rail } = headroomRail();
    const quote = await rail.quote(MARKET_HEADROOM, 'no', 20_000000n);
    const headroom = await rail.client.bestHeadroom(MARKET_HEADROOM, { now: NOW });

    const outcome = headroom.outcomes.find((entry) => entry.outcome === 1);
    expect(quote.maxFullyAccepted).toBe(outcome?.maxFullyAccepted);
    expect(quote.binding?.outcome).toBe(outcome?.bindingOutcome);
    expect(quote.quotedAtBlock).toBe(headroom.index.block);
  });

  it('costs two index reads and touches no other operation', async () => {
    const { rail, transport } = headroomRail();
    await rail.quote(MARKET_HEADROOM, 'no', 1_000000n);
    expect(transport.calls.map((call) => call.operation)).toEqual(['market', 'market']);
  });

  it('rejects a stake that is not a positive amount, rather than quoting zero', async () => {
    const { rail } = headroomRail();
    await expect(rail.quote(MARKET_HEADROOM, 'no', 0n)).rejects.toThrow(RangeError);
    await expect(rail.quote(MARKET_HEADROOM, 'no', -5n)).rejects.toThrow(RangeError);
  });

  it('rejects a side it has no mapping for, naming the ones it has', async () => {
    const { rail } = headroomRail();
    await expect(rail.quote(MARKET_HEADROOM, 'maybe', 1_000000n)).rejects.toThrow(UnknownSideError);
    await expect(rail.quote(MARKET_HEADROOM, 'maybe', 1_000000n)).rejects.toThrow(/yes, no/);
  });

  it('rejects an outcome the market does not have', async () => {
    const { rail } = headroomRail();
    await expect(rail.quote(MARKET_HEADROOM, 4, 1_000000n)).rejects.toThrow(/2 outcomes/);
  });
});
