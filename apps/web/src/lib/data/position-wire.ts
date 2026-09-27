import type { NetworkId } from '../chain';
import type { MarketSummary, OutcomeTone, PortfolioEntry, PositionView } from './types';

/**
 * The `/api/positions` wire format, and both halves of the trip across it.
 *
 * Bigints cannot cross JSON, so every amount travels as a decimal string. The
 * encoder and the decoder sit side by side so the route and the pages reading
 * it cannot drift: the route used to send a trimmed position with no
 * `finalized`, `entryAcc` or `claimed`, which is enough for a portfolio list and
 * not enough for the market page to say anything true about an entry.
 */

export interface ApiPosition {
  id: string;
  positionId: string;
  owner: string;
  outcome: number;
  offered: string;
  accepted: string;
  refused: string;
  entryAcc: string;
  /** `null` on a classic position, which joins no vintage. */
  vintage: string | null;
  finalized: boolean;
  refundWithdrawn: boolean;
  claimed: boolean;
  enteredAt: string;
}

export interface ApiPositionEntry {
  market: {
    id: string;
    question: string;
    subject: string;
    status: MarketSummary['status'];
    frozen: boolean;
    settlerKind: MarketSummary['settlerKind'];
    winner: number | null;
    resolutionTime: string;
    outcomes: { outcome: number; label: string; tone: OutcomeTone }[];
  };
  position: ApiPosition;
}

export interface ApiPositions {
  source: 'fixture' | 'live';
  network: NetworkId;
  entries: ApiPositionEntry[];
}

export function encodePositionEntry(entry: PortfolioEntry): ApiPositionEntry {
  const { market, position } = entry;
  return {
    market: {
      id: market.id,
      question: market.question,
      subject: market.subject,
      status: market.status,
      frozen: market.frozen,
      settlerKind: market.settlerKind,
      winner: market.winner,
      resolutionTime: market.resolutionTime.toString(),
      outcomes: market.outcomes.map((outcome) => ({
        outcome: outcome.outcome,
        label: outcome.label,
        tone: outcome.tone,
      })),
    },
    position: {
      id: position.id,
      positionId: position.positionId.toString(),
      owner: position.owner,
      outcome: position.outcome,
      offered: position.offered.toString(),
      accepted: position.accepted.toString(),
      refused: position.refused.toString(),
      entryAcc: position.entryAcc.toString(),
      vintage: position.vintage === null ? null : position.vintage.toString(),
      finalized: position.finalized,
      refundWithdrawn: position.refundWithdrawn,
      claimed: position.claimed,
      enteredAt: position.enteredAt.toString(),
    },
  };
}

export function decodePosition(wire: ApiPosition): PositionView {
  return {
    id: wire.id,
    positionId: BigInt(wire.positionId),
    owner: wire.owner,
    outcome: wire.outcome,
    offered: BigInt(wire.offered),
    accepted: BigInt(wire.accepted),
    refused: BigInt(wire.refused),
    entryAcc: BigInt(wire.entryAcc),
    vintage: wire.vintage === null ? null : BigInt(wire.vintage),
    finalized: wire.finalized,
    refundWithdrawn: wire.refundWithdrawn,
    claimed: wire.claimed,
    enteredAt: BigInt(wire.enteredAt),
  };
}

/**
 * Entered, and not yet ruled on.
 *
 * A vested entry is buffered with `accepted: 0` until its block's vintage
 * finalizes, so its accepted and refused figures read as zero in between —
 * which is not what the books decided, only that they have not decided yet. A
 * classic entry has no vintage and is accepted in the same transaction.
 */
export function awaitingVintage(position: { vintage: unknown; finalized: boolean }): boolean {
  return position.vintage !== null && !position.finalized;
}
