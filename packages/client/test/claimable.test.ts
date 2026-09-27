import { describe, expect, it } from 'vitest';
import unclaimedWinners from './fixtures/unclaimed-winners.json';
import walletPositions from './fixtures/wallet-positions.json';
import walletResidue from './fixtures/wallet-residue.json';
import { CREATOR, testClient } from './support/client.js';
import type { Responder } from './support/transport.js';

const MARKET_OWING_A_WINNER = '0x1111111111111111111111111111111111111111-5';
const MARKET_FULLY_CLAIMED = '0x1111111111111111111111111111111111111111-6';

/** The residue gate, served per market and paged like the real collection. */
const winners: Responder = (variables) => {
  const market = String(variables['market']);
  const rows = (unclaimedWinners as Record<string, unknown[]>)[market] ?? [];
  const first = Number(variables['first'] ?? rows.length);
  const skip = Number(variables['skip'] ?? 0);
  return { positions: rows.slice(skip, skip + first) };
};

const responses = { walletPositions, walletResidue, unclaimedWinners: winners };

describe('claimable', () => {
  it('totals everything ready to pull, split by why it is owed', async () => {
    const { client } = testClient(responses);
    const ready = await client.claimable(CREATOR);

    expect(ready.wallet).toBe(CREATOR);
    expect(ready.totals.settlement).toBe(18_666666n);
    expect(ready.totals.voidRefund).toBe(1_000000n);
    expect(ready.totals.refusedRemainder).toBe(4_000000n);
    expect(ready.totals.residue).toBe(1n);
    expect(ready.totals.total).toBe(23_666667n);
  });

  it('emits one item per transaction, never two calls on the same position', async () => {
    const { client } = testClient(responses);
    const ready = await client.claimable(CREATOR);

    const keys = ready.items.map((item) => `${item.call}:${item.argument}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ready.items.every((item) => item.amount > 0n)).toBe(true);
  });

  it('pays a settlement and an outstanding remainder in the same claim', async () => {
    const { client } = testClient(responses);
    const ready = await client.claimable(CREATOR);

    // Position 11 is on a voided market with 2 USDC refused: one `claim` pays both.
    const voided = ready.items.find((item) => item.argument === 11n);
    expect(voided?.call).toBe('claim');
    expect(voided?.breakdown.voidRefund).toBe(1_000000n);
    expect(voided?.breakdown.refusedRemainder).toBe(2_000000n);
    expect(voided?.amount).toBe(3_000000n);
  });

  it('uses withdrawRefund while the market is still open, because claim would revert', async () => {
    const { client } = testClient(responses);
    const ready = await client.claimable(CREATOR);

    const open = ready.items.find((item) => item.argument === 12n);
    expect(open?.call).toBe('withdrawRefund');
    expect(open?.breakdown.refusedRemainder).toBe(2_000000n);
    expect(open?.breakdown.settlement).toBe(0n);
  });

  it('leaves out a losing position that has nothing left to pull', async () => {
    const { client } = testClient(responses);
    const ready = await client.claimable(CREATOR);
    expect(ready.items.find((item) => item.argument === 13n)).toBeUndefined();
  });

  it('leaves out a position whose vintage has not been finalized', async () => {
    const { client } = testClient(responses);
    const ready = await client.claimable(CREATOR);
    expect(ready.items.find((item) => item.argument === 14n)).toBeUndefined();
  });

  it('sweeps residue only once every winning position has claimed', async () => {
    const { client } = testClient(responses);
    const ready = await client.claimable(CREATOR);

    const residue = ready.items.find((item) => item.call === 'claimResidue');
    expect(residue?.argument).toBe(6n);
    expect(residue?.marketId).toBe(MARKET_FULLY_CLAIMED);
    expect(residue?.amount).toBe(1n);

    expect(ready.blockedResidue).toHaveLength(1);
    expect(ready.blockedResidue[0]?.marketId).toBe(MARKET_OWING_A_WINNER);
    expect(ready.blockedResidue[0]?.reason).toMatch(/not claimed yet/);
  });

  it('prices blocked residue at the residue, not at the whole unpaid pool', async () => {
    const { client } = testClient(responses);
    const ready = await client.claimable(CREATOR);

    // 18.666667 USDC is still in the pool, but 18.666666 of it belongs to the
    // one winner who has not claimed. The residue owner gets the last unit.
    const blocked = ready.blockedResidue[0];
    expect(blocked?.atMostAmount).toBe(18_666667n);
    expect(blocked?.amount).toBe(1n);
    expect(blocked?.isUpperBound).toBe(false);

    // And that same 18.666666 is claimable by the winner, not by both of them.
    expect(ready.items.find((item) => item.argument === 10n)?.amount).toBe(18_666666n);
  });

  it('falls back to the upper bound when there are more winners than it can walk', async () => {
    const inexhaustible: Responder = (variables) => {
      const first = Number(variables['first'] ?? 0);
      const skip = Number(variables['skip'] ?? 0);
      return {
        positions: Array.from({ length: first }, (_, offset) => ({
          id: `0x1111111111111111111111111111111111111111-${skip + offset}`,
          positionId: String(skip + offset),
          previewPayout: '1',
        })),
      };
    };
    const { client } = testClient({
      walletPositions: { _meta: walletPositions._meta, positions: [] },
      walletResidue: { markets: [walletResidue.markets[0]] },
      unclaimedWinners: inexhaustible,
    });
    const ready = await client.claimable(CREATOR);

    expect(ready.items).toHaveLength(0);
    expect(ready.blockedResidue).toHaveLength(1);
    expect(ready.blockedResidue[0]?.isUpperBound).toBe(true);
    expect(ready.blockedResidue[0]?.amount).toBe(18_666667n);
    expect(ready.blockedResidue[0]?.atMostAmount).toBe(18_666667n);
    expect(ready.blockedResidue[0]?.reason).toMatch(/too many to price/);
  });

  it('ignores a market that has not resolved, which has no residue to sweep', async () => {
    const unresolved = {
      markets: walletResidue.markets.map((market) => ({ ...market, status: 'OPEN', winner: null, paidOut: '0' })),
    };
    const { client } = testClient({
      walletPositions: { _meta: walletPositions._meta, positions: [] },
      walletResidue: unresolved,
    });
    const ready = await client.claimable(CREATOR);

    expect(ready.items).toHaveLength(0);
    expect(ready.blockedResidue).toHaveLength(0);
  });

  it('is empty for a wallet that is owed nothing', async () => {
    const { client } = testClient({
      walletPositions: { _meta: walletPositions._meta, positions: [] },
      walletResidue: { markets: [] },
    });
    const ready = await client.claimable(CREATOR);
    expect(ready.items).toHaveLength(0);
    expect(ready.totals.total).toBe(0n);
  });
});
