import { MARKET_STATUS, PREVIEW_STATUS, PREVIEW_STATUS_NAME } from '@hunch-rh/client';
import type { Hex } from 'viem';

/**
 * Resolve vs void vs page (docs/spec/06 §Void policy). Pure and stateless: the STALE
 * double-check is two independent reads (primary + fallback transport) that both say
 * STALE at or after finalTime + 15 min. Proofs at past bells cannot change, so the second
 * read only guards against a misbehaving RPC. BADPROOF and phase boundaries are never
 * auto-voided: the operator is paged and the settler's 72 h timeout is the backstop.
 */

/** Seconds after the final bell before the keeper acts (lets the chain's clock pass it). */
export const RESOLVE_MARGIN_SEC = 60;
/** STALE may be voided from finalTime + 15 min. */
export const STALE_VOID_AFTER_SEC = 15 * 60;
/** OraclePaused may be voided from finalTime + 24 h (the resolver enforces it too). */
export const PAUSED_VOID_AFTER_SEC = 24 * 3600;

export type RoundsOutcome =
  | { ok: true; strikeRound: bigint; finalRound: bigint }
  | { ok: false; problem: 'before-first-round' | 'phase-boundary' | string };

export interface ResolveCandidate {
  marketId: bigint;
  specId: Hex;
  ticker: string;
  finalTime: number;
  /** HunchVPM status: 0 Open, 1 Resolved, 2 Voided. */
  statusCode: number;
  settledByResolver: boolean;
  /** The primary reader's rounds (undefined = not read, e.g. before the bell). */
  rounds?: RoundsOutcome;
  /** `preview(specId, strikeRound, finalRound)` status on the primary transport. */
  preview?: number | null;
  /** The independent fallback read (only needed for STALE). */
  confirm?: { rounds: RoundsOutcome; preview: number | null } | null;
  /** A read failed (message, redacted by the caller). */
  error?: string;
}

export type ResolveAction =
  | { kind: 'skip'; why: string }
  | { kind: 'wait'; why: string }
  | { kind: 'retry'; why: string }
  | { kind: 'page'; why: string }
  | { kind: 'resolve'; specId: Hex; strikeRound: bigint; finalRound: bigint; expect: 'UP' | 'DOWN' | 'FLAT'; why: string }
  | { kind: 'voidStale'; specId: Hex; strikeRound: bigint; finalRound: bigint; why: string }
  | { kind: 'voidPaused'; specId: Hex; why: string };

/** Whether the runner should read rounds + preview for this candidate at all. */
export function needsResolution(c: Pick<ResolveCandidate, 'statusCode' | 'settledByResolver' | 'finalTime'>, nowSec: number): boolean {
  return c.statusCode === MARKET_STATUS.Open && !c.settledByResolver && nowSec >= c.finalTime + RESOLVE_MARGIN_SEC;
}

/** Whether the STALE double-check needs the fallback read now. */
export function needsConfirmation(c: Pick<ResolveCandidate, 'preview' | 'finalTime'>, nowSec: number): boolean {
  return c.preview === PREVIEW_STATUS.STALE && nowSec >= c.finalTime + STALE_VOID_AFTER_SEC;
}

export function decideResolve(c: ResolveCandidate, nowSec: number): ResolveAction {
  if (c.statusCode !== MARKET_STATUS.Open || c.settledByResolver) return { kind: 'skip', why: 'already settled' };
  if (nowSec < c.finalTime + RESOLVE_MARGIN_SEC) return { kind: 'wait', why: 'before the final bell (+60 s)' };
  if (c.error !== undefined) return { kind: 'retry', why: `read failed: ${c.error}` };
  if (c.rounds === undefined) return { kind: 'retry', why: 'rounds not read yet' };
  if (!c.rounds.ok) {
    return {
      kind: 'page',
      why:
        c.rounds.problem === 'phase-boundary'
          ? `${c.ticker} market ${c.marketId}: the round in effect at a bell is more than 8 feed phases back (PhaseBoundary, should never happen). Not voiding; page an operator; the 72 h settler timeout is the backstop.`
          : `${c.ticker} market ${c.marketId}: no provable round (${c.rounds.problem}). Not voiding.`,
    };
  }
  const { strikeRound, finalRound } = c.rounds;
  const status = c.preview;
  if (status === null || status === undefined) return { kind: 'retry', why: 'preview unavailable' };
  switch (status) {
    case PREVIEW_STATUS.UP:
    case PREVIEW_STATUS.DOWN:
    case PREVIEW_STATUS.FLAT: {
      const expect = status === PREVIEW_STATUS.UP ? 'UP' : status === PREVIEW_STATUS.DOWN ? 'DOWN' : 'FLAT';
      return { kind: 'resolve', specId: c.specId, strikeRound, finalRound, expect, why: expect === 'FLAT' ? 'FLAT: resolve voids and refunds everyone' : `${expect} proven` };
    }
    case PREVIEW_STATUS.NOT_READY:
      return { kind: 'retry', why: 'resolver says not ready' };
    case PREVIEW_STATUS.STALE: {
      if (nowSec < c.finalTime + STALE_VOID_AFTER_SEC) return { kind: 'wait', why: 'STALE: waiting until finalTime + 15 min to confirm' };
      const confirm = c.confirm;
      if (confirm === undefined || confirm === null || confirm.preview === null) {
        return { kind: 'retry', why: 'STALE on the primary read; the independent read is unavailable, not voiding on one read' };
      }
      if (!confirm.rounds.ok || confirm.rounds.strikeRound !== strikeRound || confirm.rounds.finalRound !== finalRound) {
        return { kind: 'page', why: `${c.ticker} market ${c.marketId}: primary and fallback RPCs found different rounds. Not voiding.` };
      }
      if (confirm.preview !== PREVIEW_STATUS.STALE) {
        return { kind: 'page', why: `${c.ticker} market ${c.marketId}: primary says STALE, fallback says ${PREVIEW_STATUS_NAME[confirm.preview] ?? confirm.preview}. Not voiding.` };
      }
      return { kind: 'voidStale', specId: c.specId, strikeRound, finalRound, why: 'STALE confirmed by two independent reads: refund everyone' };
    }
    case PREVIEW_STATUS.BADPROOF:
      return { kind: 'page', why: `${c.ticker} market ${c.marketId}: preview says BADPROOF for the found rounds. Not voiding.` };
    case PREVIEW_STATUS.PAUSED:
      if (nowSec >= c.finalTime + PAUSED_VOID_AFTER_SEC) return { kind: 'voidPaused', specId: c.specId, why: 'oracle paused for over 24 h after the bell: refund everyone' };
      return { kind: 'retry', why: 'Robinhood has paused the token price (corporate action); retrying' };
    default:
      return { kind: 'page', why: `unknown preview status ${status}` };
  }
}
