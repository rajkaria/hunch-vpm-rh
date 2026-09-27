import { describe, expect, it } from 'vitest';
import positionEarning from './fixtures/position-earning.json';
import positionPending from './fixtures/position-pending.json';
import positionRefused from './fixtures/position-refused.json';
import { ACC_SCALE } from '../src/units.js';
import { ALICE, testClient } from './support/client.js';

const EARNING = '0x1111111111111111111111111111111111111111-2';
const REFUSED = '0x1111111111111111111111111111111111111111-5';
const PENDING = '0x1111111111111111111111111111111111111111-7';

describe('vestingEarned', () => {
  it('prices what has vested to a position since it entered', async () => {
    const { client } = testClient({ position: positionEarning });
    const vesting = await client.vestingEarned(EARNING);

    expect(vesting.owner).toBe(ALICE);
    expect(vesting.state).toBe('open');
    expect(vesting.accepted).toBe(5_000000n);
    // A_0 went from 1.0 to 17.666... while this position held 5 USDC.
    expect(vesting.earned).toBe(83_333333n);
    expect(vesting.payoutIfOutcomeWins).toBe(88_333333n);
  });

  it('agrees with the settler previewPayout formula', async () => {
    const { client } = testClient({ position: positionEarning });
    const vesting = await client.vestingEarned(EARNING);
    const settlerFormula = (vesting.accepted * (ACC_SCALE + vesting.currentAcc - vesting.entryAcc)) / ACC_SCALE;
    expect(vesting.payoutIfOutcomeWins).toBe(settlerFormula);
  });

  it('separates the refused remainder from the accepted principal', async () => {
    const { client } = testClient({ position: positionRefused });
    const vesting = await client.vestingEarned(REFUSED);

    expect(vesting.offered).toBe(3_000000n);
    expect(vesting.accepted).toBe(1_000000n);
    expect(vesting.refused).toBe(2_000000n);
    // Nothing has vested into book 0 since this entry, so it has earned nothing.
    expect(vesting.earned).toBe(0n);
    // The market is open, so the only thing pullable is what the books refused.
    expect(vesting.claimableNow).toBe(2_000000n);
  });

  it('refuses to guess before the vintage is finalized', async () => {
    const { client } = testClient({ position: positionPending });
    const vesting = await client.vestingEarned(PENDING);

    expect(vesting.state).toBe('pending-vintage');
    expect(vesting.offered).toBe(2_000000n);
    expect(vesting.earned).toBeNull();
    expect(vesting.payoutIfOutcomeWins).toBeNull();
    // How much was refused is not known yet either, so nothing is claimable.
    expect(vesting.refused).toBe(0n);
    expect(vesting.claimableNow).toBe(0n);
  });

  it('reports no vesting at all on a classic position, and still prices it', async () => {
    // The same 5 USDC entry under the classic rule: nothing vests, the
    // accumulators are 0 on both ends, and the payout is a flat pool share —
    // floor(107 * 5 / 6) — which the index computes under whichever rule the
    // market runs. Reporting `earned: 0` here would read as "nothing has
    // vested yet" on a market where nothing ever will.
    const classic = {
      ...positionEarning,
      position: {
        ...positionEarning.position,
        entryAcc: '0',
        vintage: null,
        previewPayout: '89166666',
        market: {
          ...positionEarning.position.market,
          settlerKind: 'CLASSIC',
          books: positionEarning.position.market.books.map((book) => ({ ...book, vested: '0', acc: '0' })),
        },
      },
    };
    const { client } = testClient({ position: classic });
    const vesting = await client.vestingEarned(EARNING);

    expect(vesting.earned).toBeNull();
    expect(vesting.payoutIfOutcomeWins).toBe(89_166666n);
  });

  it('reports a missing position as not found', async () => {
    const { client } = testClient({ position: { _meta: { block: { number: 1 } }, position: null } });
    await expect(client.vestingEarned('0xdead-1')).rejects.toThrow(/is not in the subgraph/);
  });
});
