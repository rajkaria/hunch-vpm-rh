/**
 * `POST /api/relay/enter`: the keeper's relay result as an HTTP response. Every error is a
 * sentence a bettor can act on, with a `next` hint the bet panel uses (retry, sign again, pay gas
 * yourself, get USDG).
 */

import { revertInWords, type RelayErrorCode, type RelayResult } from '@hunch-rh/keeper';

/** The keeper's words for a `VintageFull` revert: many bets landed in this Ethereum block. */
export const BUSY_MESSAGE = revertInWords('reverted: VintageFull');

/**
 * `retry-same`: the outcome is unknown (the bet may already be on chain), so the panel offers to
 * send the SAME signature again, which can never charge twice (USDG accepts each signed bet
 * once), and never suggests paying gas, which would.
 */
export type RelayNext = 'retry' | 'retry-same' | 'sign-again' | 'pay-gas' | 'get-usdg' | 'wait' | 'none';

export interface RelayErrorBody {
  ok: false;
  /** Stable API code (documented on /docs/api). */
  error: string;
  /** The keeper's own code, for debugging. */
  reason: RelayErrorCode | 'bad-json' | 'keeper-unavailable' | 'keeper-error';
  message: string;
  next: RelayNext;
  /** Seconds to wait before retrying the same signed bet (only for `busy`). */
  retryAfter?: number;
}

export interface RelaySuccessBody {
  ok: true;
  /** null: the bet is already on chain (an earlier send of this same signature); hash unknown. */
  txHash: string | null;
  nonce: string;
  /** Whether the relayer saw the receipt before answering. */
  receipt: 'confirmed' | 'reverted' | 'pending';
}

const TABLE: Record<RelayErrorCode, { status: number; error: string; next: RelayNext }> = {
  'bad-request': { status: 400, error: 'invalid_request', next: 'none' },
  'wrong-domain': { status: 400, error: 'bad_signature', next: 'sign-again' },
  'bad-signature': { status: 400, error: 'bad_signature', next: 'sign-again' },
  'contract-signer': { status: 400, error: 'contract_signer', next: 'pay-gas' },
  'not-yet-valid': { status: 400, error: 'expired', next: 'sign-again' },
  expired: { status: 400, error: 'expired', next: 'sign-again' },
  'validity-too-long': { status: 400, error: 'expired', next: 'sign-again' },
  'amount-out-of-range': { status: 400, error: 'amount_out_of_bounds', next: 'none' },
  'below-market-min': { status: 400, error: 'amount_out_of_bounds', next: 'none' },
  'above-market-max': { status: 400, error: 'amount_out_of_bounds', next: 'none' },
  'geo-blocked': { status: 403, error: 'region_blocked', next: 'none' },
  'market-not-found': { status: 404, error: 'market_not_found', next: 'none' },
  'market-closed': { status: 409, error: 'market_closed', next: 'none' },
  'entries-paused': { status: 409, error: 'market_closed', next: 'none' },
  'nonce-used': { status: 409, error: 'already_used', next: 'sign-again' },
  'insufficient-balance': { status: 422, error: 'insufficient_balance', next: 'get-usdg' },
  'simulation-failed': { status: 422, error: 'simulation_failed', next: 'none' },
  'rate-limited': { status: 429, error: 'rate_limited', next: 'wait' },
  'send-failed': { status: 502, error: 'relay_failed', next: 'retry-same' },
  'relayer-unavailable': { status: 503, error: 'relay_unavailable', next: 'pay-gas' },
  'not-deployed': { status: 503, error: 'not_deployed', next: 'none' },
};

export function relayHttp(result: RelayResult, receipt: RelaySuccessBody['receipt'] = 'pending'): { status: number; body: RelaySuccessBody | RelayErrorBody } {
  if (result.ok) return { status: 200, body: { ok: true, txHash: result.txHash, nonce: result.nonce, receipt } };
  if (result.code === 'simulation-failed' && result.message === BUSY_MESSAGE) {
    return {
      status: 503,
      body: { ok: false, error: 'busy', reason: result.code, message: 'Busy: many bets landed in the last few seconds. Retrying in a few seconds.', next: 'retry', retryAfter: 3 },
    };
  }
  const row = TABLE[result.code] ?? { status: 502, error: 'relay_failed', next: 'retry-same' as const };
  return { status: row.status, body: { ok: false, error: row.error, reason: result.code, message: result.message, next: row.next } };
}

/** `0x1234…abcd`: enough of a signature to match a log line to a request, never the whole thing. */
export function shortSignature(signature: unknown): string {
  if (typeof signature !== 'string' || signature.length < 14) return 'none';
  return `${signature.slice(0, 6)}…${signature.slice(-4)}`;
}
