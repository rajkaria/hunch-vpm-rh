import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { custodialRailCapabilities } from '../../src/rail/capabilities.js';
import { SideMap } from '../../src/rail/sides.js';
import { UnknownSideError } from '../../src/rail/errors.js';
import { isUnsignedTrade } from '../../src/rail/types.js';
import type {
  RailPositions,
  RailQuote,
  RailResearch,
  RailSide,
  RailTrade,
  SettlementRail,
} from '../../src/rail/types.js';
import marketHeadroom from './fixtures/market-headroom.json';
import walletPositions from './fixtures/wallet-positions.json';
import { ALICE, MARKET_HEADROOM, pagedWithMeta, testRail } from './support.js';

/**
 * A stand-in for the custodial book the private app already has: the venue
 * holds the money, fills in full, and returns a position rather than something
 * to sign. It exists here to prove the interface is implementable by both rails
 * and that a call site written against it does not know which one it holds.
 */
const custodialRail: SettlementRail = {
  capabilities: custodialRailCapabilities('postgres'),
  async research(marketId: string): Promise<RailResearch> {
    return {
      rail: 'postgres',
      marketId,
      status: 'Open',
      closesAt: 2_000_000_000n,
      closed: false,
      outcomes: [
        { outcome: 0, label: 'yes', backing: 60n, probabilityPpm: 600000n, probabilityPercent: '60.0000', decimalOddsPpm: 1_666666n },
        { outcome: 1, label: 'no', backing: 40n, probabilityPpm: 400000n, probabilityPercent: '40.0000', decimalOddsPpm: 2_500000n },
      ],
      totalAccepted: 100n,
      winner: null,
      asOf: 1_999_999_000n,
      // A custodial book answers none of these, and says so rather than
      // inventing a value.
      secondsToClose: null,
      headroom: null,
      resolution: null,
      counterparty: null,
    };
  },
  async quote(marketId: string, _side: RailSide, amount: bigint): Promise<RailQuote> {
    return {
      rail: 'postgres',
      marketId,
      outcome: 0,
      requested: amount,
      accepted: amount,
      refused: 0n,
      acceptance: 'full',
      refusal: null,
      payoutIfResolvedNow: { wins: amount * 2n, loses: 0n, voided: null },
      asOf: 1_999_999_000n,
    };
  },
  async positions(wallet: Address): Promise<RailPositions> {
    return {
      rail: 'postgres',
      wallet,
      positions: [],
      totals: { staked: 0n, accepted: 0n, refused: 0n, claimableNow: 0n },
      asOf: 1_999_999_000n,
    };
  },
  async trade(_marketId: string, _side: RailSide, amount: bigint): Promise<RailTrade> {
    return {
      kind: 'executed',
      custody: 'venue',
      rail: 'postgres',
      reference: 'fill-1',
      accepted: amount,
      refused: 0n,
    };
  },
};

/** What the app's own handler does with whatever `trade` gave it. */
function describeTrade(trade: RailTrade): string {
  return isUnsignedTrade(trade)
    ? `sign ${trade.steps.length} transaction(s) from your own wallet`
    : `filled as ${trade.reference}`;
}

describe('SettlementRail: one interface, two rails', () => {
  it('holds the Arc rail behind the same type as a custodial one', async () => {
    const { rail } = testRail({
      market: marketHeadroom,
      walletPositions: pagedWithMeta('positions', walletPositions.positions, walletPositions._meta),
    });
    const rails: SettlementRail[] = [rail, custodialRail];

    for (const registered of rails) {
      const research = await registered.research(MARKET_HEADROOM);
      const quote = await registered.quote(MARKET_HEADROOM, 'no', 10_000000n);
      const held = await registered.positions(ALICE);

      expect(research.outcomes.length).toBeGreaterThan(0);
      expect(quote.accepted + quote.refused).toBe(quote.requested);
      expect(held.wallet).toBeDefined();
    }
  });

  it('makes the difference in `trade` impossible to miss', async () => {
    const { rail } = testRail({ market: marketHeadroom });

    const custodial = await custodialRail.trade(MARKET_HEADROOM, 'no', 10_000000n);
    expect(custodial.kind).toBe('executed');
    expect(describeTrade(custodial)).toBe('filled as fill-1');

    const arc = await rail.trade(MARKET_HEADROOM, 'no', 10_000000n);
    expect(arc.kind).toBe('unsigned-calldata');
    expect(describeTrade(arc)).toBe('sign 2 transaction(s) from your own wallet');
  });

  it('describes itself so the app branches on a fact, not on a name', async () => {
    const { rail } = testRail({ market: marketHeadroom });

    expect(rail.capabilities).toEqual({
      rail: 'arc',
      custody: 'self',
      counterparty: 'other-stakers',
      refusal: true,
      quote: 'acceptance',
      resolution: 'feed',
      payout: 'pull',
      signing: 'agent-wallet',
      cancellable: false,
      chainId: 5042002,
      asset: { symbol: 'USDC', decimals: 6, address: '0x3600000000000000000000000000000000000000' },
    });

    // Every behavioural field differs from the custodial book. None of these is
    // a detail the app can carry over untouched.
    const behavioural = [
      'custody',
      'counterparty',
      'refusal',
      'quote',
      'resolution',
      'payout',
      'signing',
      'cancellable',
    ] as const;
    for (const key of behavioural) {
      expect(rail.capabilities[key], key).not.toEqual(custodialRail.capabilities[key]);
    }
  });
});

describe('side labels', () => {
  it('translates the labels an existing agent already sends', () => {
    const sides = new SideMap('arc', { yes: 0, no: 1 });
    expect(sides.resolve('yes', 2)).toBe(0);
    expect(sides.resolve('NO', 2)).toBe(1);
    expect(sides.resolve(' no ', 2)).toBe(1);
    expect(sides.label(1)).toBe('no');
  });

  it('takes an outcome index, as a number or as the string an HTTP call carries', () => {
    const sides = new SideMap('arc', {});
    expect(sides.resolve(0, 2)).toBe(0);
    expect(sides.resolve('1', 2)).toBe(1);
    expect(sides.label(0)).toBeNull();
  });

  it('names the labels it does have when it cannot resolve one', () => {
    const sides = new SideMap('arc', { yes: 0, no: 1 });
    expect(() => sides.resolve('maybe', 2)).toThrow(UnknownSideError);
    expect(() => sides.resolve('maybe', 2)).toThrow(/yes, no/);
  });

  it('points at the configuration when no labels are set at all', () => {
    const sides = new SideMap('arc', {});
    expect(() => sides.resolve('yes', 2)).toThrow(/sides/);
  });

  it('refuses a label pointing past the end of the market', () => {
    const sides = new SideMap('arc', { yes: 0, no: 1, draw: 2 });
    expect(() => sides.resolve('draw', 2)).toThrow(/2 outcomes/);
    expect(sides.resolve('draw', 3)).toBe(2);
  });

  it('refuses a configuration that is not an outcome index', () => {
    expect(() => new SideMap('arc', { yes: -1 })).toThrow(RangeError);
    expect(() => new SideMap('arc', { yes: 1.5 })).toThrow(RangeError);
  });
});
