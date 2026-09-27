import { describe, expect, it } from 'vitest';
import type { OpposingBook } from '../src/tiers.js';
import {
  DEFAULT_ANONYMOUS_PER_MARKET_CAP,
  DEFAULT_BASE_REQUESTS,
  DEFAULT_TIER_POLICIES,
  HUMAN_BACKED_RATE_MULTIPLIER,
  UNBOUNDED_HEADROOM,
  buildTierPolicies,
  effectiveAcceptance,
  leaderboardPresentation,
} from '../src/tiers.js';

const anonymous = DEFAULT_TIER_POLICIES.anonymous;
const humanBacked = DEFAULT_TIER_POLICIES['human-backed'];

describe('the tier table', () => {
  it('gives human-backed agents exactly ten times the base rate limit', () => {
    expect(humanBacked.rateLimit.requests).toBe(
      anonymous.rateLimit.requests * HUMAN_BACKED_RATE_MULTIPLIER,
    );
    expect(humanBacked.rateLimit.windowMs).toBe(anonymous.rateLimit.windowMs);
  });

  it('keeps the 10x relationship when the base is reconfigured', () => {
    const policies = buildTierPolicies({ baseRequests: 7, windowMs: 1_000 });
    expect(policies['human-backed'].rateLimit.requests).toBe(70);
  });

  it('caps an anonymous agent per market and leaves a human-backed one uncapped', () => {
    expect(anonymous.perMarketCap).toBe(DEFAULT_ANONYMOUS_PER_MARKET_CAP);
    expect(humanBacked.perMarketCap).toBeNull();
  });

  it('makes only human-backed agents eligible for venue-funded rewards', () => {
    expect(anonymous.rewardEligible).toBe(false);
    expect(humanBacked.rewardEligible).toBe(true);
  });

  it('shows both tiers on the leaderboard and badges only the human-backed one', () => {
    expect(leaderboardPresentation(anonymous)).toEqual({
      visible: true,
      badged: false,
      badgeLabel: null,
    });
    expect(leaderboardPresentation(humanBacked)).toEqual({
      visible: true,
      badged: true,
      badgeLabel: 'human-backed',
    });
  });

  it('does not hide anonymous agents anywhere; there is no excluded state', () => {
    expect(anonymous.rateLimit.requests).toBeGreaterThan(0);
    expect(anonymous.perMarketCap).toBeGreaterThan(0n);
    expect(anonymous.leaderboard.visible).toBe(true);
  });

  it('uses documented defaults', () => {
    expect(anonymous.rateLimit.requests).toBe(DEFAULT_BASE_REQUESTS);
    expect(anonymous.rateLimit.windowMs).toBe(60_000);
  });
});

describe('buildTierPolicies validation', () => {
  it.each([
    ['a zero base', { baseRequests: 0 }],
    ['a fractional base', { baseRequests: 1.5 }],
    ['a zero window', { windowMs: 0 }],
    ['a zero cap', { anonymousPerMarketCap: 0n }],
    ['a human cap below the anonymous cap', { anonymousPerMarketCap: 100n, humanBackedPerMarketCap: 50n }],
  ])('refuses %s', (_label, options) => {
    expect(() => buildTierPolicies(options)).toThrow(RangeError);
  });

  it('allows a finite human-backed cap for a venue that wants one', () => {
    const policies = buildTierPolicies({
      anonymousPerMarketCap: 25_000_000n,
      humanBackedPerMarketCap: 5_000_000_000n,
    });
    expect(policies['human-backed'].perMarketCap).toBe(5_000_000_000n);
  });
});

/** One opposing book, for the binary case. */
function alone(headroom: bigint): readonly OpposingBook[] {
  return [{ headroom, otherDemand: 0n }];
}

describe('effectiveAcceptance', () => {
  it('accepts the whole offer when neither headroom nor the cap binds', () => {
    expect(
      effectiveAcceptance({ offered: 10_000_000n, opposing: alone(900_000_000n), policy: humanBacked }),
    ).toEqual({
      submitted: 10_000_000n,
      accepted: 10_000_000n,
      refunded: 0n,
      limitedBy: 'offer',
    });
  });

  it('refuses the part of an offer the books have no headroom for', () => {
    expect(
      effectiveAcceptance({ offered: 100_000_000n, opposing: alone(4_000_000n), policy: humanBacked }),
    ).toEqual({
      submitted: 100_000_000n,
      accepted: 4_000_000n,
      refunded: 96_000_000n,
      limitedBy: 'headroom',
    });
  });

  // The case min(c, H_w) gets wrong. Two agents offering 100 USDC each into a book with
  // 100 USDC of headroom: the settler gives each ⌊100e6 · 100e6 / 200e6⌋, not 100e6.
  it('rations pro rata when another entry shares the vintage, as the settler does', () => {
    expect(
      effectiveAcceptance({
        offered: 100_000_000n,
        opposing: [{ headroom: 100_000_000n, otherDemand: 100_000_000n }],
        policy: humanBacked,
      }),
    ).toEqual({
      submitted: 100_000_000n,
      accepted: 50_000_000n,
      refunded: 50_000_000n,
      limitedBy: 'headroom',
    });
  });

  it('floors the ration, as integer division in the contract does', () => {
    // ⌊1 · 1 / 3⌋ = 0. The remainder is residue, swept by the owner fixed at creation.
    expect(
      effectiveAcceptance({
        offered: 1n,
        opposing: [{ headroom: 1n, otherDemand: 2n }],
        policy: humanBacked,
      }).accepted,
    ).toBe(0n);
  });

  it('minimises over every opposing book, so an n-way market is bound by its tightest', () => {
    const result = effectiveAcceptance({
      offered: 20_000_000n,
      opposing: [
        { headroom: 100_000_000n, otherDemand: 0n },
        { headroom: 10_000_000n, otherDemand: 10_000_000n },
      ],
      policy: humanBacked,
    });
    // ⌊20e6 · 10e6 / 30e6⌋, from the second book; the first does not bind.
    expect(result.accepted).toBe(6_666_666n);
    expect(result.limitedBy).toBe('headroom');
  });

  it('never rations against a book whose capacity is unbounded', () => {
    expect(
      effectiveAcceptance({
        offered: 100_000_000n,
        opposing: [{ headroom: UNBOUNDED_HEADROOM, otherDemand: 10_000_000_000n }],
        policy: humanBacked,
      }).accepted,
    ).toBe(100_000_000n);
  });

  it('applies the anonymous cap even when the books could take more', () => {
    expect(
      effectiveAcceptance({ offered: 100_000_000n, opposing: alone(900_000_000n), policy: anonymous }),
    ).toEqual({
      submitted: DEFAULT_ANONYMOUS_PER_MARKET_CAP,
      accepted: DEFAULT_ANONYMOUS_PER_MARKET_CAP,
      refunded: 100_000_000n - DEFAULT_ANONYMOUS_PER_MARKET_CAP,
      limitedBy: 'tier-cap',
    });
  });

  it('cuts by the cap first, so the capped amount is what the settler rations', () => {
    const result = effectiveAcceptance({
      offered: 100_000_000n,
      opposing: [{ headroom: 25_000_000n, otherDemand: 25_000_000n }],
      policy: anonymous,
    });
    // Submitted 25e6 after the cap, then ⌊25e6 · 25e6 / 50e6⌋ from the settler.
    expect(result.submitted).toBe(DEFAULT_ANONYMOUS_PER_MARKET_CAP);
    expect(result.accepted).toBe(12_500_000n);
    expect(result.refunded).toBe(87_500_000n);
  });

  it('reports headroom, not the cap, when both cut', () => {
    const result = effectiveAcceptance({
      offered: 100_000_000n,
      opposing: [{ headroom: 25_000_000n, otherDemand: 25_000_000n }],
      policy: anonymous,
    });
    expect(result.limitedBy).toBe('headroom');
  });

  it('reports the cap when demand fits the headroom exactly, because nothing was rationed', () => {
    const result = effectiveAcceptance({
      offered: 100_000_000n,
      opposing: alone(DEFAULT_ANONYMOUS_PER_MARKET_CAP),
      policy: anonymous,
    });
    expect(result.accepted).toBe(DEFAULT_ANONYMOUS_PER_MARKET_CAP);
    expect(result.limitedBy).toBe('tier-cap');
  });

  it('accepts nothing into a book with no headroom, and refunds the offer', () => {
    expect(effectiveAcceptance({ offered: 50_000_000n, opposing: alone(0n), policy: humanBacked })).toEqual({
      submitted: 50_000_000n,
      accepted: 0n,
      refunded: 50_000_000n,
      limitedBy: 'headroom',
    });
  });

  it('leaves a small offer alone under the anonymous cap', () => {
    expect(
      effectiveAcceptance({ offered: 1_000_000n, opposing: alone(900_000_000n), policy: anonymous }),
    ).toEqual({
      submitted: 1_000_000n,
      accepted: 1_000_000n,
      refunded: 0n,
      limitedBy: 'offer',
    });
  });

  it('refuses negative inputs, which would mean a caller miscomputed a book', () => {
    expect(() => effectiveAcceptance({ offered: -1n, opposing: alone(1n), policy: anonymous })).toThrow(
      RangeError,
    );
    expect(() => effectiveAcceptance({ offered: 1n, opposing: alone(-1n), policy: anonymous })).toThrow(
      RangeError,
    );
    expect(() =>
      effectiveAcceptance({
        offered: 1n,
        opposing: [{ headroom: 1n, otherDemand: -1n }],
        policy: anonymous,
      }),
    ).toThrow(RangeError);
  });
});
