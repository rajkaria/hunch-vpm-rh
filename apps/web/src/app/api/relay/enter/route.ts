/**
 * POST /api/relay/enter: relays a bettor's signed USDG authorization (docs/spec/06 `relay`).
 *
 * The keeper checks it off-chain (shape, geo, rate limit, domain, amount, validity window,
 * signature, market state and caps, nonce, balance), simulates, and sends
 * `enterWithAuthorization` from the keeper key. It cannot change what was signed, and anyone can
 * send the same call directly. This route passes the country and client IP, waits briefly for the
 * receipt so the next read shows the bet, and maps the result to plain words.
 */

import { revalidateTag } from 'next/cache';

import { json } from '@/lib/api/http';
import { relayHttp, shortSignature, type RelayErrorBody, type RelaySuccessBody } from '@/lib/api/relay';
import { TAG } from '@/lib/server/cache';
import { redactError } from '@/lib/server/client';
import { COUNTRY_HEADER, clientIp } from '@/lib/server/geo';
import { getKeeper } from '@/lib/server/keeper';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const RECEIPT_WAIT_MS = 10_000;

function refused(status: number, body: RelayErrorBody): Response {
  return json(body, { status, cache: 'none' });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refused(400, { ok: false, error: 'invalid_request', reason: 'bad-json', message: 'Send the signed bet as a JSON body.', next: 'none' });
  }

  let keeper;
  try {
    keeper = getKeeper();
  } catch {
    return refused(503, {
      ok: false,
      error: 'relay_unavailable',
      reason: 'keeper-unavailable',
      message: 'Gasless bets are unavailable right now. Use "Pay gas yourself".',
      next: 'pay-gas',
    });
  }

  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const summary = `market=${String(b.marketId)} side=${String(b.outcome)} amount=${String(b.amount)} sig=${shortSignature(b.signature)}`;

  let result;
  try {
    result = await keeper.relay(body, { country: request.headers.get(COUNTRY_HEADER), ip: clientIp(request.headers) });
  } catch (error) {
    console.error(`[relay] ${summary} failed: ${redactError(error)}`);
    return refused(502, {
      ok: false,
      error: 'relay_failed',
      reason: 'keeper-error',
      message: 'The relayer could not send this bet. Try again, or use "Pay gas yourself".',
      next: 'pay-gas',
    });
  }

  let receipt: RelaySuccessBody['receipt'] = 'pending';
  if (result.ok) {
    try {
      const mined = await keeper.clients.publicClient.waitForTransactionReceipt({ hash: result.txHash, timeout: RECEIPT_WAIT_MS });
      receipt = mined.status === 'success' ? 'confirmed' : 'reverted';
    } catch {
      receipt = 'pending';
    }
    if (typeof b.marketId === 'string' && /^\d+$/.test(b.marketId)) revalidateTag(TAG.market(b.marketId), { expire: 0 });
    if (typeof b.from === 'string') revalidateTag(TAG.positions(b.from), { expire: 0 });
    revalidateTag(TAG.venue, 'max');
  }

  const { status, body: out } = relayHttp(result, receipt);
  console.info(`[relay] ${summary} -> ${result.ok ? `sent ${result.txHash} (${receipt})` : result.code}`);
  return json(out, { status, cache: 'none' });
}
