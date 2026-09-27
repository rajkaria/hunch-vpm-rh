/**
 * The dry-run research source and venue, backed by `FixtureWorld`.
 *
 * Reads settle any market whose freeze the clock has passed, the same way a keeper calling
 * `FeedResolver.resolve` would, so `run` ends with a real claim rather than a stub.
 */

import type { AgentTx, AgentWallet, TxResult } from "../circle/types.js";
import type { ClaimablePosition, Hex, MarketSnapshot, PositionSnapshot } from "../domain/types.js";
import type { FixtureWorld } from "./fixture-world.js";
import type { Clock, ClaimReceipt, EnterReceipt, ResearchSource, Venue } from "./source.js";

export class FixtureResearchSource implements ResearchSource {
  readonly name = "fixtures";

  constructor(
    private readonly world: FixtureWorld,
    private readonly clock: Clock,
  ) {}

  listMarkets(): Promise<readonly MarketSnapshot[]> {
    this.world.settleDue(this.clock.now());
    return Promise.resolve(this.world.list().map((m) => this.world.snapshot(m)));
  }

  market(marketId: string): Promise<MarketSnapshot | undefined> {
    this.world.settleDue(this.clock.now());
    const market = this.world.find(marketId);
    return Promise.resolve(market === undefined ? undefined : this.world.snapshot(market));
  }

  position(positionId: string): Promise<PositionSnapshot | undefined> {
    return Promise.resolve(this.world.positionSnapshot(positionId));
  }

  claimable(wallet: Hex): Promise<readonly ClaimablePosition[]> {
    this.world.settleDue(this.clock.now());
    return Promise.resolve(this.world.claimable(wallet));
  }
}

export interface FixtureVenueOptions {
  /**
   * Where a claim's proceeds go. In dry-run there is no chain to credit the wallet, so
   * the venue hands the amount back to whoever is keeping the balance.
   */
  readonly onProceeds: (amount: bigint) => void;
}

/**
 * The dry-run venue still goes through the wallet, so the same code path runs in both
 * modes: calldata is built, the wallet is asked to send it, and the world moves only once
 * the send comes back confirmed.
 */
export class FixtureVenue implements Venue {
  readonly name = "fixtures";

  constructor(
    private readonly world: FixtureWorld,
    private readonly wallet: AgentWallet,
    private readonly options: FixtureVenueOptions,
  ) {}

  async enter(market: MarketSnapshot, outcome: number, amount: bigint): Promise<EnterReceipt> {
    const owner = await this.wallet.address();
    const txs: TxResult[] = [];
    for (const tx of enterCalls(market, outcome, amount)) {
      const result = await this.wallet.send(tx);
      txs.push(result);
      if (result.status === "failed") {
        return {
          marketId: market.marketId,
          outcome,
          offered: amount,
          accepted: 0n,
          positionId: undefined,
          txs,
        };
      }
    }
    const { position } = this.world.enter(market.marketId, outcome, amount, owner);
    return {
      marketId: market.marketId,
      outcome,
      offered: amount,
      accepted: position.accepted,
      positionId: position.positionId,
      txs,
    };
  }

  async claim(position: ClaimablePosition): Promise<ClaimReceipt> {
    const settler = this.world.find(position.marketId)?.settler ?? ZERO;
    const result = await this.wallet.send({
      label: "claim",
      to: settler,
      data: "0x",
      value: 0n,
      settlementDebit: 0n,
    });
    if (result.status === "confirmed") {
      this.world.markClaimed(position.positionId);
      this.options.onProceeds(position.payout + position.refund);
    }
    return {
      positionId: position.positionId,
      payout: position.payout,
      refund: position.refund,
      txs: [result],
    };
  }
}

/**
 * The two calls a real entry needs: an allowance for the settler to pull the stake, then
 * the entry itself. The dry-run calldata is empty; the shape is what matters, because the
 * live venue sends exactly these two steps with real bytes from the client.
 */
function enterCalls(market: MarketSnapshot, outcome: number, amount: bigint): readonly AgentTx[] {
  return [
    { label: "approve", to: market.token, data: "0x", value: 0n, settlementDebit: 0n },
    { label: `enter#${String(outcome)}`, to: market.settler, data: "0x", value: 0n, settlementDebit: amount },
  ];
}

const ZERO: Hex = "0x0000000000000000000000000000000000000000";
