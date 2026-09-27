/**
 * The two ports the loop talks to.
 *
 * `ResearchSource` is read-only and answers the questions the policy asks. `Venue` turns a
 * decision into calls and sends them through the wallet. Both have a dry-run implementation
 * backed by fixtures and a live one backed by `@hunch-vpm/client`, and the loop cannot tell
 * which it has.
 */

import type { TxResult } from "../circle/types.js";
import type { ClaimablePosition, Hex, MarketSnapshot, PositionSnapshot } from "../domain/types.js";

export interface ResearchSource {
  readonly name: string;
  listMarkets(): Promise<readonly MarketSnapshot[]>;
  market(marketId: string): Promise<MarketSnapshot | undefined>;
  position(positionId: string): Promise<PositionSnapshot | undefined>;
  claimable(wallet: Hex): Promise<readonly ClaimablePosition[]>;
}

export interface EnterReceipt {
  readonly marketId: string;
  readonly outcome: number;
  /** c — what the agent offered. */
  readonly offered: bigint;
  /**
   * s — what the books had room for. Undefined on chain at send time: vintages finalize
   * lazily, so acceptance is not knowable in the entering transaction. The monitor step
   * reads it back once the vintage closes.
   */
  readonly accepted: bigint | undefined;
  readonly positionId: string | undefined;
  readonly txs: readonly TxResult[];
}

export interface ClaimReceipt {
  readonly positionId: string;
  readonly payout: bigint;
  readonly refund: bigint;
  readonly txs: readonly TxResult[];
}

export interface Venue {
  readonly name: string;
  /** Build the calls that stake `amount` on `outcome`, send them, report what happened. */
  enter(market: MarketSnapshot, outcome: number, amount: bigint): Promise<EnterReceipt>;
  claim(position: ClaimablePosition): Promise<ClaimReceipt>;
}

/** A clock the loop can own, so a demo does not have to run in real time. */
export interface Clock {
  /** Unix seconds. */
  now(): number;
  /** Move forward. The system clock ignores this; the simulated one does not. */
  advance(seconds: number): void;
}

export const systemClock: Clock = {
  now: () => Math.floor(Date.now() / 1000),
  advance: () => {
    /* the wall clock advances on its own */
  },
};

export class SimulatedClock implements Clock {
  #now: number;
  constructor(startUnixSeconds: number) {
    this.#now = startUnixSeconds;
  }
  now(): number {
    return this.#now;
  }
  advance(seconds: number): void {
    this.#now += Math.max(0, Math.trunc(seconds));
  }
}
