/**
 * The proof envelope.
 *
 * AgentKit carries its signed challenge response in a single request header as
 * base64-encoded JSON. This reads that header: base64url or standard base64, and raw
 * JSON as well, because a proof you can paste into curl is a proof you can debug.
 */

import { isSignatureLike, parseSiweMessage } from './siwe.js';
import type { Hex, VerificationFailureCode } from './types.js';

/** The JSON inside the header. */
export interface ProofEnvelope {
  /** Exactly the bytes the agent signed. */
  readonly message: string;
  readonly signature: Hex;
}

export function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64(input: string): string | null {
  // Accepts both alphabets: the header is documented as base64, clients in the wild
  // reach for base64url, and telling them apart costs nothing.
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function encodeProofHeader(envelope: ProofEnvelope): string {
  return encodeBase64Url(JSON.stringify(envelope));
}

export type EnvelopeParseResult =
  | { readonly ok: true; readonly envelope: ProofEnvelope }
  | { readonly ok: false; readonly code: VerificationFailureCode; readonly detail: string };

function fail(detail: string, code: VerificationFailureCode = 'proof_malformed'): EnvelopeParseResult {
  return { ok: false, code, detail };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseProofHeader(raw: string): EnvelopeParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fail('the proof header was empty');

  const text = trimmed.startsWith('{') ? trimmed : decodeBase64(trimmed);
  if (text === null) return fail('the proof header was not valid base64');

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return fail('the proof envelope was not valid JSON');
  }
  if (!isPlainObject(decoded)) return fail('the proof envelope was not a JSON object');

  const { message, signature } = decoded;
  if (typeof message !== 'string' || message.length === 0) {
    return fail('the proof envelope carried no signed message');
  }
  if (typeof signature !== 'string' || !isSignatureLike(signature)) {
    return fail('the signature was missing or not a 65-byte 0x-hex string', 'signature_malformed');
  }
  // Fail on an unreadable message here rather than after a signature recovery, so a
  // caller sending noise cannot make us do elliptic-curve work.
  const parsed = parseSiweMessage(message);
  if (!parsed.ok) return fail(`the signed message could not be read: ${parsed.detail}`);

  return { ok: true, envelope: { message, signature: signature as Hex } };
}
