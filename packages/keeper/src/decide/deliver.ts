import { MARKET_STATUS, ONE_USDG, type Settlement } from '@hunch-rh/client';
import type { Address } from 'viem';

/**
 * Push money to owners (docs/spec/06 `deliver`). Pure. One call per position, never
 * batched, so a Paxos-frozen address fails alone and never blocks anyone else.
 *   1. `finalizeVintage` for any market whose open vintage's L1 block has passed (so
 *      accrued values and refused remainders appear within one run);
 *   2. `withdrawRefundFor` for refused remainders in open markets once finalized;
 *   3. `claimFor` for every unclaimed position of a settled market with a non-zero payout
 *      or refund (winners, seeds, void refunds);
 *   4. `sweepFees(USDG)` once accrued fees exceed the threshold.
 */

export const SWEEP_THRESHOLD = 5n * ONE_USDG;

export interface DeliverPosition {
  id: bigint;
  owner: Address;
  finalized: boolean;
  refunded: boolean;
  claimed: boolean;
  offered: bigint;
  accepted: bigint;
  settlement: Settlement;
}

export interface DeliverMarket {
  marketId: bigint;
  statusCode: number;
  pendingCount: bigint;
  /** The open vintage's L1 block (null when none is open). */
  vintageBlock: bigint | null;
  positions: readonly DeliverPosition[];
}

export interface DeliverInput {
  markets: readonly DeliverMarket[];
  /** Current L1 block estimate (Multicall3 `getBlockNumber()`). */
  l1Block: bigint;
  feesAccrued: bigint;
  sweepThreshold?: bigint;
  /** Owners to skip (e.g. known frozen addresses), lower-cased. */
  skipOwners?: ReadonlySet<string>;
}

export type DeliverAction =
  | { kind: 'finalizeVintage'; marketId: bigint; why: string }
  | { kind: 'withdrawRefundFor'; marketId: bigint; positionId: bigint; owner: Address; amount: bigint; why: string }
  | { kind: 'claimFor'; marketId: bigint; positionId: bigint; owner: Address; amount: bigint; why: string }
  | { kind: 'sweepFees'; amount: bigint; why: string };

export function decideDeliver(input: DeliverInput): DeliverAction[] {
  const finalize: DeliverAction[] = [];
  const refunds: DeliverAction[] = [];
  const claims: DeliverAction[] = [];
  const skip = input.skipOwners ?? new Set<string>();
  for (const m of input.markets) {
    if (m.statusCode === MARKET_STATUS.Open) {
      if (m.pendingCount > 0n && m.vintageBlock !== null && input.l1Block > m.vintageBlock) {
        finalize.push({ kind: 'finalizeVintage', marketId: m.marketId, why: `vintage ${m.vintageBlock} is past (L1 ${input.l1Block})` });
      }
      for (const p of m.positions) {
        if (!p.finalized || p.refunded || p.claimed || p.offered <= p.accepted) continue;
        if (skip.has(p.owner.toLowerCase())) continue;
        refunds.push({
          kind: 'withdrawRefundFor',
          marketId: m.marketId,
          positionId: p.id,
          owner: p.owner,
          amount: p.offered - p.accepted,
          why: 'refused remainder (the other side could not cover it)',
        });
      }
      continue;
    }
    for (const p of m.positions) {
      if (p.claimed || !p.settlement.deliverable || p.settlement.total === 0n) continue;
      if (skip.has(p.owner.toLowerCase())) continue;
      claims.push({
        kind: 'claimFor',
        marketId: m.marketId,
        positionId: p.id,
        owner: p.owner,
        amount: p.settlement.total,
        why: m.statusCode === MARKET_STATUS.Voided ? 'void refund' : p.settlement.gross > 0n ? 'winning payout' : 'refused remainder',
      });
    }
  }
  const out = [...finalize, ...refunds, ...claims];
  const threshold = input.sweepThreshold ?? SWEEP_THRESHOLD;
  if (input.feesAccrued > threshold) out.push({ kind: 'sweepFees', amount: input.feesAccrued, why: `fees ${input.feesAccrued} > threshold ${threshold}` });
  return out;
}
