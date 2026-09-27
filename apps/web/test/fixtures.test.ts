import { describe, expect, it } from 'vitest';

import { createFixtureSource } from '@/lib/data/fixture-source';
import { buildFixtures, FIXTURE_WALLET } from '@/lib/data/fixtures';
import { ACC_SCALE } from '@/lib/units';
import { bookHeadroom, capacityBar, classicPayout, positionComparison, totalPrincipal, vpmPayout } from '@/lib/vpm';

/** A fixed moment, so every derived number in these tests is pinned. */
const NOW = 1_789_000_000n;
const data = buildFixtures(NOW);

const usdc = (whole: number): bigint => BigInt(whole) * 1_000_000n;

describe('the fixture dataset', () => {
  it('gives every market a distinct id and a question', () => {
    const ids = data.markets.map((market) => market.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const market of data.markets) {
      expect(market.question.length).toBeGreaterThan(10);
      expect(market.outcomes.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('covers every state a page has to render', () => {
    const states = data.markets.map((market) =>
      market.status === 'Open' ? (market.frozen ? 'frozen' : 'open') : market.status,
    );
    expect(states).toContain('open');
    expect(states).toContain('frozen');
    expect(states).toContain('Resolved');
    expect(states).toContain('Voided');
    expect(data.markets.some((market) => market.settlerKind === 'classic')).toBe(true);
    expect(data.markets.some((market) => market.kappa === null)).toBe(true);
    expect(data.markets.some((market) => market.positions.some((p) => p.refused > 0n))).toBe(true);
  });

  it('holds the conservation identity P_o + V_o = Pi on every vested book', () => {
    // Every accepted unit on one outcome vests into all the others, so a
    // book's own principal plus what vested into it is the whole pool. If a
    // fixture ever drifts from that, the payout column is quoting a state the
    // settler cannot reach.
    for (const market of data.markets) {
      if (market.settlerKind !== 'vested') continue;
      for (const outcome of market.outcomes) {
        expect(outcome.principal + outcome.vested).toBe(market.acceptedPool);
      }
    }
  });

  it('keeps capacity at exactly kappa times principal', () => {
    for (const market of data.markets) {
      if (market.settlerKind !== 'vested' || market.kappa === null) continue;
      for (const outcome of market.outcomes) {
        expect(outcome.capacity).toBe(market.kappa * outcome.principal);
      }
    }
  });

  it('leaves an n-way market unbounded, as the paper prescribes', () => {
    const nway = data.markets.find((market) => market.kappa === null);
    expect(nway).toBeDefined();
    for (const outcome of nway!.outcomes) {
      expect(outcome.capacity).toBeNull();
      expect(bookHeadroom(outcome.capacity, outcome.vested)).toBeNull();
    }
  });

  it('gives the classic market no capacity and no vesting to show', () => {
    const classic = data.markets.find((market) => market.settlerKind === 'classic');
    expect(classic).toBeDefined();
    for (const outcome of classic!.outcomes) {
      expect(outcome.vested).toBe(0n);
      expect(outcome.acc).toBe(0n);
      expect(outcome.capacity).toBeNull();
    }
  });

  it('samples a history that only moves forward', () => {
    for (const market of data.markets) {
      expect(market.history.length).toBeGreaterThan(0);
      for (let i = 1; i < market.history.length; i++) {
        expect(market.history[i]!.t >= market.history[i - 1]!.t).toBe(true);
      }
      // The last sample is the state the page renders.
      const last = market.history[market.history.length - 1]!;
      for (const outcome of market.outcomes) {
        const point = last.points.find((entry) => entry.outcome === outcome.outcome)!;
        expect(point.principal).toBe(outcome.principal);
        expect(point.acc).toBe(outcome.acc);
      }
    }
  });
});

describe('the flagship market', () => {
  const market = data.markets.find((entry) => entry.id === 'eth-3000-sep30')!;

  it('is the one with a book close to its ceiling', () => {
    expect(market).toBeDefined();
    const below = market.outcomes[1]!;
    expect(below.principal).toBe(usdc(2_900));
    expect(below.vested).toBe(usdc(81_000));
    expect(below.capacity).toBe(usdc(87_000));
    const bar = capacityBar(below.capacity, below.vested);
    expect(bar.headroom).toBe(usdc(6_000));
    expect(bar.consumedPpm).toBe(931_034n);
  });

  it('shows a real refusal on the wallet’s own position', () => {
    const rationed = market.positions.find((position) => position.refused > 0n)!;
    expect(rationed.offered).toBe(usdc(20_000));
    expect(rationed.accepted).toBe(usdc(15_000));
    expect(rationed.refused).toBe(usdc(5_000));
    expect(rationed.refundWithdrawn).toBe(false);
  });

  it('pays an early contrarian more under the vested rule than under the classic one', () => {
    const early = market.positions.find((position) => position.outcome === 1)!;
    const book = market.outcomes[1]!;
    const comparison = positionComparison({
      accepted: early.accepted,
      entryAcc: early.entryAcc,
      currentAcc: book.acc,
      outcomePrincipal: book.principal,
      acceptedPool: market.acceptedPool,
    });
    expect(early.accepted).toBe(usdc(800));
    expect(comparison.delta).toBeGreaterThan(0n);
    expect(comparison.vpm).toBeGreaterThan(comparison.classic);
  });

  it('pays a late entrant less under the vested rule, which is the point of it', () => {
    const late = market.positions.find((position) => position.outcome === 0)!;
    const book = market.outcomes[0]!;
    const comparison = positionComparison({
      accepted: late.accepted,
      entryAcc: late.entryAcc,
      currentAcc: book.acc,
      outcomePrincipal: book.principal,
      acceptedPool: market.acceptedPool,
    });
    expect(comparison.delta).toBeLessThan(0n);
  });

  it('never pays out more than the pool holds, whichever outcome happens', () => {
    // Everything the winning side is owed is its principal plus what vested
    // into its book, which is the whole pool by the conservation identity.
    for (const outcome of market.outcomes) {
      const owed = outcome.principal + outcome.vested;
      expect(owed).toBe(market.acceptedPool);
    }
  });
});

describe('the settled market', () => {
  const market = data.markets.find((entry) => entry.id === 'eth-3600-aug31')!;

  it('leaves a residue that is only the flooring dust', () => {
    expect(market.status).toBe('Resolved');
    expect(market.residue).toBeGreaterThanOrEqual(0n);
    // Per-position flooring can lose at most one unit per winning position.
    const winners = market.outcomes[market.winner!]!.principal;
    expect(winners).toBeGreaterThan(0n);
    expect(market.residue).toBeLessThan(usdc(1));
  });

  it('accounts for every unit: paid out, still owed, and residue', () => {
    const stillOwed = market.positions
      .filter((position) => position.outcome === market.winner && !position.claimed)
      .reduce(
        (total, position) =>
          total + vpmPayout(position.accepted, position.entryAcc, market.outcomes[position.outcome]!.acc),
        0n,
      );
    expect(market.paidOut + stillOwed + market.residue).toBe(market.acceptedPool);
  });
});

describe('the settled classic market', () => {
  const market = data.markets.find((entry) => entry.id === 'link-25-aug20-classic')!;

  it('gives the wallet a position on each side of a resolved classic pool', () => {
    // The case that makes the settler branch reachable at all: without a wallet
    // position here, quoting the vested payout rule on classic books is a bug
    // nothing renders.
    expect(market.settlerKind).toBe('classic');
    expect(market.status).toBe('Resolved');
    expect(market.winner).toBe(0);
    expect(market.positions.map((position) => position.outcome).sort()).toEqual([0, 1]);
  });

  it('settles a winner at its share of the whole pool, not at its principal', () => {
    const won = market.positions.find((position) => position.outcome === market.winner)!;
    const book = market.outcomes[won.outcome]!;
    expect(book.acc).toBe(0n);
    expect(won.accepted).toBe(usdc(1_000));
    // floor(11,500 * 1,000 / 3,500). The vested rule on these books would pay
    // the principal back, which is 3.28x short of what `claim` sends.
    expect(classicPayout(won.accepted, book.principal, market.acceptedPool)).toBe(3_285_714_285n);
    expect(vpmPayout(won.accepted, won.entryAcc, book.acc)).toBe(usdc(1_000));
  });

  it('leaves only flooring dust as residue, not the whole losing side', () => {
    // Under the vested rule these books would pay every winner its principal
    // and call the remaining 8,000 of losing stake residue.
    expect(market.residue).toBeGreaterThan(0n);
    expect(market.residue).toBeLessThan(usdc(1));
    // `positions` holds only the wallet's, and `paidOut` is what everybody
    // else has already taken, so the three add up to the pool exactly once.
    const owed = market.positions
      .filter((position) => position.outcome === market.winner && !position.claimed)
      .reduce(
        (total, position) =>
          total +
          classicPayout(position.accepted, market.outcomes[position.outcome]!.principal, market.acceptedPool),
        0n,
      );
    expect(market.paidOut + owed + market.residue).toBe(market.acceptedPool);
  });

  it('puts the classic settlement on the claim row, not the principal', () => {
    const row = data.claimable.items.find((item) => item.marketId === market.id)!;
    expect(row.call).toBe('claim');
    expect(row.breakdown.settlement).toBe(3_285_714_285n);
    expect(row.breakdown.refusedRemainder).toBe(0n);
  });
});

describe('claimable', () => {
  it('totals exactly what the rows add up to', () => {
    const sum = data.claimable.items.reduce((total, item) => total + item.amount, 0n);
    expect(data.claimable.totals.total).toBe(sum);
    for (const item of data.claimable.items) {
      const parts =
        item.breakdown.settlement +
        item.breakdown.voidRefund +
        item.breakdown.refusedRemainder +
        item.breakdown.residue;
      expect(parts).toBe(item.amount);
    }
  });

  it('sends an open market’s refused remainder through withdrawRefund and a settled one through claim', () => {
    for (const item of data.claimable.items) {
      const market = data.markets.find((entry) => entry.id === item.marketId)!;
      expect(item.call).toBe(market.status === 'Open' ? 'withdrawRefund' : 'claim');
    }
  });

  it('covers all three reasons a wallet is owed money', () => {
    expect(data.claimable.totals.settlement).toBeGreaterThan(0n);
    expect(data.claimable.totals.voidRefund).toBeGreaterThan(0n);
    expect(data.claimable.totals.refusedRemainder).toBe(usdc(5_000));
  });

  it('blocks the residue while a winner has not claimed', () => {
    expect(data.claimable.blockedResidue.length).toBeGreaterThan(0);
    for (const entry of data.claimable.blockedResidue) {
      const market = data.markets.find((candidate) => candidate.id === entry.marketId)!;
      expect(market.residueOwner).toBe(FIXTURE_WALLET);
      expect(entry.reason).toMatch(/not claimed/);
    }
  });
});

describe('the fixture data source', () => {
  const source = createFixtureSource({ now: NOW });

  it('puts the markets taking stake first and the soonest freeze at the top', () => {
    return source.listMarkets().then((markets) => {
      const open = markets.filter((market) => market.status === 'Open' && !market.frozen);
      expect(markets.slice(0, open.length)).toEqual(open);
      for (let i = 1; i < open.length; i++) {
        expect(open[i]!.resolutionTime >= open[i - 1]!.resolutionTime).toBe(true);
      }
    });
  });

  it('returns null for an id it does not hold, rather than throwing', async () => {
    expect(await source.getMarket('not-a-market')).toBeNull();
  });

  it('shows no positions at all when no wallet is connected', async () => {
    const disconnected = createFixtureSource({ now: NOW, wallet: null });
    const market = await disconnected.getMarket('eth-3000-sep30');
    expect(market!.positions).toEqual([]);
    expect(disconnected.currentWallet()).toBeNull();
  });

  it('owes another wallet nothing', async () => {
    const claimable = await source.getClaimable('0x0000000000000000000000000000000000000001');
    expect(claimable.totals.total).toBe(0n);
    expect(claimable.items).toEqual([]);
  });

  it('ranks agents by settled profit and loss', async () => {
    const agents = await source.listAgents();
    for (let i = 1; i < agents.length; i++) {
      expect(agents[i - 1]!.realizedPnl >= agents[i]!.realizedPnl).toBe(true);
    }
  });
});

describe('determinism', () => {
  it('produces the same books for the same moment', () => {
    const again = buildFixtures(NOW);
    expect(again.markets.map((market) => market.acceptedPool)).toEqual(
      data.markets.map((market) => market.acceptedPool),
    );
    expect(again.markets[0]!.outcomes[0]!.acc).toBe(data.markets[0]!.outcomes[0]!.acc);
  });

  it('keeps the accumulator in the settler’s fixed point', () => {
    for (const market of data.markets) {
      for (const outcome of market.outcomes) {
        expect(outcome.acc).toBeGreaterThanOrEqual(0n);
        expect(outcome.acc).toBeLessThan(ACC_SCALE * 10_000n);
      }
    }
  });
});
