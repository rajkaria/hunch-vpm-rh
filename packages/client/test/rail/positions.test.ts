import { decodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';
import { settlerAbi } from '../../src/writes/abi.js';
import walletPositionsClassic from './fixtures/wallet-positions-classic.json';
import walletPositions from './fixtures/wallet-positions.json';
import {
  ALICE,
  MARKET_HEADROOM,
  MARKET_VOIDED,
  NOW,
  pagedWithMeta,
  SETTLER,
  SETTLER_CLASSIC,
  testRail,
} from './support.js';

const responses = {
  walletPositions: pagedWithMeta('positions', walletPositions.positions, walletPositions._meta),
};

/** The same position, served to the client's own single-position read. */
const positionResponses = {
  ...responses,
  position: { _meta: walletPositions._meta, position: walletPositions.positions[0] },
};

describe('positions: what the wallet holds, through the index', () => {
  it('lists every position the wallet has not claimed', async () => {
    const { rail } = testRail(responses);
    const held = await rail.positions(ALICE);

    expect(held.wallet).toBe('0x4444444444444444444444444444444444444444');
    expect(held.positions.map((position) => position.id)).toEqual([
      `${SETTLER}-20`,
      `${SETTLER}-21`,
      `${SETTLER}-22`,
    ]);
    expect(held.asOf).toBe(NOW);
    expect(held.index.block).toBe(2400n);
  });

  it('prices an open position by what has vested into its book since it entered', async () => {
    const { rail } = testRail(responses);
    const held = await rail.positions(ALICE);
    const position = held.positions[0];

    expect(position?.marketId).toBe(MARKET_HEADROOM);
    expect(position?.state).toBe('open');
    expect(position?.label).toBe('no');
    expect(position?.staked).toBe(20_000000n);
    expect(position?.accepted).toBe(14_000000n);
    expect(position?.refused).toBe(6_000000n);
    // The book's accumulator has moved 0.6 since entry, against 14 accepted.
    expect(position?.earned).toBe(8_400000n);
    expect(position?.payoutIfOutcomeWins).toBe(22_400000n);
  });

  it('reports the refused part as collectable without waiting for the market', async () => {
    const { rail } = testRail(responses);
    const held = await rail.positions(ALICE);
    const position = held.positions[0];

    expect(position?.claimableNow).toBe(6_000000n);
    expect(position?.claim?.call).toBe('withdrawRefund');
    expect(position?.claim?.amount).toBe(6_000000n);
    const decoded = decodeFunctionData({ abi: settlerAbi, data: position?.claim?.unsigned.data ?? '0x' });
    expect(decoded.functionName).toBe('withdrawRefund');
    expect(decoded.args).toEqual([20n]);
  });

  it('pays back accepted principal on a voided market, not the vested payout', async () => {
    const { rail } = testRail(responses);
    const held = await rail.positions(ALICE);
    const position = held.positions[1];

    expect(position?.marketId).toBe(MARKET_VOIDED);
    expect(position?.state).toBe('voided');
    // 1.5 has vested to it, so it would have been paid 4.5 had the market
    // resolved its way. A void pays the accepted principal and no vesting.
    expect(position?.payoutIfOutcomeWins).toBe(4_500000n);
    expect(position?.claimableNow).toBe(3_000000n);
    expect(position?.claim?.call).toBe('claim');
    expect(position?.claim?.amount).toBe(3_000000n);
  });

  it('says nothing about an entry whose vintage has not been finalized', async () => {
    const { rail } = testRail(responses);
    const held = await rail.positions(ALICE);
    const position = held.positions[2];

    // `accepted` is not fixed until the settler rations the vintage, so there
    // is no payout to quote and nothing to collect.
    expect(position?.state).toBe('pending-vintage');
    expect(position?.payoutIfOutcomeWins).toBeNull();
    expect(position?.earned).toBeNull();
    expect(position?.claimableNow).toBe(0n);
    expect(position?.claim).toBeNull();
  });

  it('prices a position on the classic settler by the index figure, not by vesting', async () => {
    const { rail } = testRail({
      walletPositions: pagedWithMeta(
        'positions',
        walletPositionsClassic.positions,
        walletPositionsClassic._meta,
      ),
    });
    const position = (await rail.positions(ALICE)).positions[0];

    expect(position?.marketId).toBe(`${SETTLER_CLASSIC}-1`);
    expect(position?.settlerKind).toBe('classic');
    expect(position?.state).toBe('won');
    // Nothing vests in a classic pool, so `earned` is null rather than a zero
    // that would read as "nothing has vested yet".
    expect(position?.earned).toBeNull();
    // floor(pool * accepted / winningPrincipal) = floor(10 * 2 / 6).
    expect(position?.payoutIfOutcomeWins).toBe(3_333333n);
    expect(position?.claimableNow).toBe(3_333333n);
    expect(position?.claim?.call).toBe('claim');
    expect(position?.claim?.unsigned.to).toBe(SETTLER_CLASSIC);
  });

  it('totals the wallet across markets', async () => {
    const { rail } = testRail(responses);
    const held = await rail.positions(ALICE);

    expect(held.totals.staked).toBe(24_000000n);
    expect(held.totals.accepted).toBe(17_000000n);
    expect(held.totals.refused).toBe(6_000000n);
    expect(held.totals.claimableNow).toBe(9_000000n);
  });

  it('hands back unsigned calls for every collection, and nothing else', async () => {
    const { rail } = testRail(responses);
    const held = await rail.positions(ALICE);

    for (const position of held.positions) {
      if (position.claim === null) continue;
      expect(position.claim.signed).toBe(false);
      expect(Object.keys(position.claim.unsigned).sort()).toEqual(['data', 'to', 'value']);
      expect(position.claim.unsigned.to).toBe(SETTLER);
      expect(position.claim.unsigned.value).toBe(0n);
      expect(position.claim.note).toContain('Sign and send');
    }
  });

  it('agrees with the client read that prices one position on its own', async () => {
    const { rail } = testRail(positionResponses);
    const held = await rail.positions(ALICE);
    const mine = held.positions[0];
    const theirs = await rail.client.vestingEarned(`${SETTLER}-20`);

    expect(mine?.state).toBe(theirs.state);
    expect(mine?.accepted).toBe(theirs.accepted);
    expect(mine?.refused).toBe(theirs.refused);
    expect(mine?.earned).toBe(theirs.earned);
    expect(mine?.payoutIfOutcomeWins).toBe(theirs.payoutIfOutcomeWins);
    expect(mine?.claimableNow).toBe(theirs.claimableNow);
  });

  it('walks the whole collection when it does not fit one page', async () => {
    const { rail, transport } = testRail(responses, { pageSize: 2 });
    const held = await rail.positions(ALICE);

    expect(held.positions).toHaveLength(3);
    expect(transport.calls.map((call) => call.operation)).toEqual(['walletPositions', 'walletPositions']);
    expect(transport.calls[1]?.variables?.['skip']).toBe(2);
  });

  it('asks the index for the wallet in the spelling the index stores', async () => {
    const { rail, transport } = testRail(responses);
    await rail.positions('0x4444444444444444444444444444444444444444');
    expect(transport.calls[0]?.variables?.['owner']).toBe('0x4444444444444444444444444444444444444444');
  });
});
