/**
 * The tier policy.
 *
 *   |                 | anonymous        | human-backed |
 *   | rate limit      | base             | 10x base     |
 *   | per-market cap  | small            | full         |
 *   | reward eligible | no               | yes          |
 *   | leaderboard     | shown, unbadged  | badged       |
 *
 * Anonymous is a working tier. Nothing here removes an agent's ability to read a book,
 * stake into it, or be paid out. What proving a human behind the wallet buys is
 * headroom against the abuse controls, and standing in the parts of the venue where one
 * human running fifty wallets would ruin the result.
 */

import type { AgentTier } from './types.js';

/** The human-backed rate limit is this multiple of the base. The table's "10x". */
export const HUMAN_BACKED_RATE_MULTIPLIER = 10;

export interface RateLimitPolicy {
  /** Requests permitted per window. */
  readonly requests: number;
  readonly windowMs: number;
}

export interface LeaderboardPolicy {
  /** Both tiers appear. Hiding anonymous agents would make the board a lie. */
  readonly visible: boolean;
  /** Only human-backed agents carry the badge. */
  readonly badged: boolean;
}

export interface TierPolicy {
  readonly tier: AgentTier;
  readonly rateLimit: RateLimitPolicy;
  /**
   * Ceiling on what one agent may offer into a single market, in USDC base units (6
   * decimals). `null` means no tier ceiling — the book's own headroom is the only
   * limit, which is the "full" column.
   */
  readonly perMarketCap: bigint | null;
  /**
   * Whether the agent counts for venue-funded reward distributions. A distribution
   * split across wallets is only meaningful if wallets are people, so this is the one
   * place where anonymity genuinely cannot be accommodated.
   */
  readonly rewardEligible: boolean;
  readonly leaderboard: LeaderboardPolicy;
}

export type TierPolicies = Readonly<Record<AgentTier, TierPolicy>>;

export interface TierPolicyOptions {
  /** Anonymous requests per window. Human-backed is this times the multiplier. */
  readonly baseRequests?: number;
  readonly windowMs?: number;
  /** Anonymous per-market ceiling in USDC base units. Default 25 USDC. */
  readonly anonymousPerMarketCap?: bigint;
  /** Human-backed per-market ceiling. Default `null`, meaning headroom is the limit. */
  readonly humanBackedPerMarketCap?: bigint | null;
}

export const DEFAULT_BASE_REQUESTS = 60;
export const DEFAULT_WINDOW_MS = 60_000;
/** 25 USDC. Enough for an anonymous agent to be a real participant, not enough to move a book alone. */
export const DEFAULT_ANONYMOUS_PER_MARKET_CAP = 25_000_000n;

/**
 * Builds both tiers together so the 10x relationship holds by construction. Setting the
 * two limits independently is how that invariant quietly stops being true.
 */
export function buildTierPolicies(options: TierPolicyOptions = {}): TierPolicies {
  const baseRequests = options.baseRequests ?? DEFAULT_BASE_REQUESTS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const anonymousPerMarketCap = options.anonymousPerMarketCap ?? DEFAULT_ANONYMOUS_PER_MARKET_CAP;
  const humanBackedPerMarketCap =
    options.humanBackedPerMarketCap === undefined ? null : options.humanBackedPerMarketCap;

  if (!Number.isInteger(baseRequests) || baseRequests <= 0) {
    throw new RangeError(`baseRequests must be a positive integer, got ${baseRequests}`);
  }
  if (!Number.isInteger(windowMs) || windowMs <= 0) {
    throw new RangeError(`windowMs must be a positive integer, got ${windowMs}`);
  }
  if (anonymousPerMarketCap <= 0n) {
    throw new RangeError(`anonymousPerMarketCap must be positive, got ${anonymousPerMarketCap}`);
  }
  if (humanBackedPerMarketCap !== null && humanBackedPerMarketCap < anonymousPerMarketCap) {
    throw new RangeError('humanBackedPerMarketCap must be at least the anonymous cap');
  }

  return {
    anonymous: {
      tier: 'anonymous',
      rateLimit: { requests: baseRequests, windowMs },
      perMarketCap: anonymousPerMarketCap,
      rewardEligible: false,
      leaderboard: { visible: true, badged: false },
    },
    'human-backed': {
      tier: 'human-backed',
      rateLimit: { requests: baseRequests * HUMAN_BACKED_RATE_MULTIPLIER, windowMs },
      perMarketCap: humanBackedPerMarketCap,
      rewardEligible: true,
      leaderboard: { visible: true, badged: true },
    },
  };
}

export const DEFAULT_TIER_POLICIES: TierPolicies = buildTierPolicies();

/**
 * `KAPPA_UNBOUNDED` as the settler spells it: the sentinel a book carries when its
 * capacity coefficient is unbounded, which is every book in an n-way market. A book
 * holding it is never rationed, so pass it rather than a large number.
 */
export const UNBOUNDED_HEADROOM = (1n << 256n) - 1n;

export interface OpposingBook {
  /** `H_w = C_w - V_w`, or {@link UNBOUNDED_HEADROOM}. */
  readonly headroom: bigint;
  /**
   * `D_w` minus this entry: everything else already offered into the same vintage that
   * counts as demand against book w. That is every other pending entry whose outcome is
   * not w, which includes entries on the same outcome as this one, because a stake is
   * demand against every book but its own (VestedParimutuel.sol `stake`, lines 300-304).
   *
   * Zero when this entry is alone in its vintage. There is no default, because assuming
   * an empty vintage is exactly how a client quotes itself an acceptance the settler
   * will not honour.
   */
  readonly otherDemand: bigint;
}

export interface AcceptanceInput {
  /** What the agent offered, `c` in the settler's terms. USDC base units. */
  readonly offered: bigint;
  /**
   * Every book but the one being staked into: one entry for a binary market, n-1 for an
   * n-way one. The settler minimises over all of them.
   */
  readonly opposing: readonly OpposingBook[];
  readonly policy: TierPolicy;
}

export interface AcceptanceResult {
  /** `min(offered, cap)` — what the tier cap lets reach the settler at all. */
  readonly submitted: bigint;
  /** `s`, what the settler accepts of `submitted` after rationing every opposing book. */
  readonly accepted: bigint;
  /** `offered - accepted`, refunded to the agent. Refused is not failed. */
  readonly refunded: bigint;
  readonly limitedBy: 'offer' | 'headroom' | 'tier-cap';
}

/**
 * What an offer is actually worth, given the tier cap and what the settler will then do
 * with what is left. Two different things cut it down, in this order.
 *
 * First the tier cap, applied here, before the stake is submitted. A capped offer is
 * simply a smaller offer; the contract never sees the difference.
 *
 * Then the settler's own rationing. It does not take a minimum against headroom — the
 * acceptance loop in VestedParimutuel.sol `_finalizeVintage` (lines 344-351) rations pro
 * rata whenever the vintage's joint demand on an opposing book exceeds that book's
 * headroom:
 *
 *     s = min over opposing w of ( D_w > H_w ? floor(c · H_w / D_w) : c )
 *
 * where `c` is the submitted amount and `D_w` is every pending entry in the vintage that
 * is demand against w, this one included. `min(c, H_w)` coincides with that only when
 * this entry is the whole of `D_w` — a single pending entry — and overstates acceptance
 * for every case where more than one entry shares a vintage, which is the only case
 * where headroom binds at all.
 *
 * `limitedBy` names the constraint that produced the number: `headroom` when the settler
 * rationed, `tier-cap` when it did not and the cap had already cut the offer, `offer`
 * when nothing bound. Headroom wins when both cut, because it is the constraint an agent
 * cannot buy its way out of by proving a human.
 *
 * This mirrors the contract; it does not replace it. A client cannot know who else will
 * land in the same block, so read the result as what happens if the vintage closes with
 * the demand you passed.
 */
export function effectiveAcceptance(input: AcceptanceInput): AcceptanceResult {
  const { offered, opposing, policy } = input;
  if (offered < 0n) throw new RangeError(`offered must not be negative, got ${offered}`);
  for (const book of opposing) {
    if (book.headroom < 0n) throw new RangeError(`headroom must not be negative, got ${book.headroom}`);
    if (book.otherDemand < 0n) {
      throw new RangeError(`otherDemand must not be negative, got ${book.otherDemand}`);
    }
  }

  const cap = policy.perMarketCap;
  const submitted = cap !== null && cap < offered ? cap : offered;

  let accepted = submitted;
  for (const book of opposing) {
    if (book.headroom === UNBOUNDED_HEADROOM) continue;
    const demand = book.otherDemand + submitted;
    if (demand <= book.headroom) continue;
    // Integer division floors, as the contract's does; the remainder is the residue a
    // named owner sweeps.
    const rationed = (submitted * book.headroom) / demand;
    if (rationed < accepted) accepted = rationed;
  }

  const limitedBy: AcceptanceResult['limitedBy'] =
    accepted < submitted ? 'headroom' : submitted < offered ? 'tier-cap' : 'offer';

  return { submitted, accepted, refunded: offered - accepted, limitedBy };
}

/** How an agent should be rendered on a public board. */
export interface LeaderboardPresentation {
  readonly visible: boolean;
  readonly badged: boolean;
  /** Shown next to a badged entry. Null when unbadged, so a UI has nothing to render. */
  readonly badgeLabel: string | null;
}

export function leaderboardPresentation(policy: TierPolicy): LeaderboardPresentation {
  return {
    visible: policy.leaderboard.visible,
    badged: policy.leaderboard.badged,
    badgeLabel: policy.leaderboard.badged ? 'human-backed' : null,
  };
}
