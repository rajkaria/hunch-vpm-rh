/**
 * The policy knobs, with the reasoning for each default.
 *
 * Every one of these is a number a reader can argue with, which is the point: the
 * decision procedure in `decide.ts` has no hidden constants.
 */

import { parseUsdc } from "../domain/units.js";

export interface PolicyConfig {
  /**
   * Minimum trust-weighted edge before the agent will stake at all.
   * 3 points. Below that the estimate is not distinguishable from the book given the
   * crudeness of a driftless digital model.
   */
  readonly minEdge: number;
  /**
   * Edge at which the agent is already sizing at `maxBankrollFraction`. Between `minEdge`
   * and here the stake ramps linearly, so a 4-point edge is not treated like a 20-point one.
   */
  readonly edgeSaturation: number;
  /**
   * Seconds before the freeze inside which the agent refuses to enter, whatever the edge.
   *
   * This is the mechanism-aware rule. A position is paid
   * `s * (1 + A_o(T) - A_o(entry))`: everything above its own principal comes from stake
   * that lands AFTER it. Inside the last few minutes essentially nothing lands after, so
   * a late entry takes the full outcome risk for a payoff close to 1x. In a classic pool
   * late money earns the same multiple as early money and this rule would be pointless.
   * Here it is the difference between trading the mechanism and ignoring it.
   */
  readonly freezeBufferSeconds: number;
  /**
   * Minimum share of the market's arrival window that must still be ahead.
   * The graded version of the rule above: expected future inflow into the agent's own
   * book scales with how much of the window is left, so the agent wants a real share of
   * it, not the last sliver.
   */
  readonly minVestingOutlook: number;
  /**
   * Floor on counterparty trust. ERC-8004 reputation is opt-in and young, so an unknown
   * counterparty is unknown, not bad — zeroing the edge against every anonymous book
   * would make the agent refuse to trade in a market that is mostly anonymous today.
   */
  readonly trustFloor: number;
  /** Largest share of bankroll a single entry may take at saturation edge. */
  readonly maxBankrollFraction: number;
  /**
   * Share of the visible headroom the agent is willing to consume. Headroom is read from
   * an indexer that lags the chain by at least a block, and headroom shrinks whenever
   * anyone else enters. Asking for all of it is asking for a partial fill.
   */
  readonly headroomUtilisation: number;
  /** Hard cap on a single entry, independent of bankroll. */
  readonly maxTicket: bigint;
  /** Below this an entry is not worth the round trip, so the agent abstains instead. */
  readonly minTicket: bigint;
}

export const DEFAULT_POLICY: PolicyConfig = {
  minEdge: 0.03,
  edgeSaturation: 0.15,
  freezeBufferSeconds: 900,
  minVestingOutlook: 0.1,
  trustFloor: 0.25,
  maxBankrollFraction: 0.2,
  headroomUtilisation: 0.9,
  maxTicket: parseUsdc("250"),
  minTicket: parseUsdc("1"),
};

export type PolicyOverrides = Partial<PolicyConfig>;

export function withOverrides(base: PolicyConfig, overrides: PolicyOverrides): PolicyConfig {
  return { ...base, ...overrides };
}

export interface PolicyEnvResult {
  readonly overrides: PolicyOverrides;
  /**
   * Names of environment variables that were set but could not be read. A malformed
   * override keeps the default rather than stopping the agent, but silently keeping it
   * would mean a typo looks exactly like a correct run, so the names come back here and
   * `describeConfig` prints them beside the values that did take effect.
   */
  readonly ignored: readonly string[];
}

/** Read overrides from an environment map. Unset values fall through; unreadable ones are reported. */
export function policyFromEnv(env: Readonly<Record<string, string | undefined>>): PolicyEnvResult {
  const out: Record<string, number | bigint> = {};
  const ignored: string[] = [];
  const num = (key: string, field: keyof PolicyConfig): void => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") return;
    const value = Number(raw);
    if (Number.isFinite(value)) out[field] = value;
    else ignored.push(key);
  };
  const amount = (key: string, field: keyof PolicyConfig): void => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") return;
    try {
      out[field] = parseUsdc(raw);
    } catch {
      ignored.push(key);
    }
  };
  num("HUNCH_MIN_EDGE", "minEdge");
  num("HUNCH_EDGE_SATURATION", "edgeSaturation");
  num("HUNCH_FREEZE_BUFFER_S", "freezeBufferSeconds");
  num("HUNCH_MIN_VESTING_OUTLOOK", "minVestingOutlook");
  num("HUNCH_TRUST_FLOOR", "trustFloor");
  num("HUNCH_MAX_BANKROLL_FRACTION", "maxBankrollFraction");
  num("HUNCH_HEADROOM_UTILISATION", "headroomUtilisation");
  amount("HUNCH_MAX_TICKET_USDC", "maxTicket");
  amount("HUNCH_MIN_TICKET_USDC", "minTicket");
  return { overrides: out as PolicyOverrides, ignored };
}
