/**
 * The core verifier. Takes headers, returns a typed result, knows nothing about HTTP
 * frameworks. Every adapter in this package is a thin wrapper over `verify`.
 *
 * It does not throw on a bad proof. A proof that fails any check produces an
 * `anonymous` result carrying the reason, because the product decision is that agents
 * without a human keep working. Configuration mistakes do throw, at construction, so a
 * misconfigured server fails at boot rather than quietly grading every agent anonymous.
 */

import { recoverMessageAddress } from 'viem';
import type { AgentBookRegistry } from './agentbook.js';
import type { NormalizedHeaders } from './headers.js';
import {
  ConflictingHeaderError,
  DEFAULT_PROOF_HEADER,
  readProofHeader,
  tryNormalizeHeaders,
} from './headers.js';
import { parseProofHeader } from './proof.js';
import { lowercaseAddress, parseChainId, parseSiweMessage, parseTimestamp } from './siwe.js';
import type { TierStorage } from './storage.js';
import { nonceKey } from './storage.js';
import type {
  Address,
  AgentKitProof,
  AnonymousVerification,
  HeaderSource,
  Hex,
  VerifiableRequest,
  VerificationFailureCode,
  VerificationResult,
} from './types.js';
import { isSupportedChainId } from './types.js';

/** Thrown at construction. Never thrown from `verify`. */
export class AgentTierConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTierConfigurationError';
  }
}

export type SignerRecovery = (message: string, signature: Hex) => Promise<Address>;

/** EIP-191 personal_sign recovery. Replaceable so tests and alternative stacks can swap it. */
export const defaultSignerRecovery: SignerRecovery = async (message, signature) => {
  const recovered = await recoverMessageAddress({ message, signature });
  return lowercaseAddress(recovered);
};

export interface VerifierOptions {
  readonly agentBook: AgentBookRegistry;
  readonly storage: TierStorage;
  /** This server's hostname. A proof minted for any other domain is refused. */
  readonly domain: string;
  readonly proofHeader?: string | undefined;
  /** Caller chains accepted in a proof. Default World Chain and Base. */
  readonly acceptedChainIds?: readonly number[] | undefined;
  /**
   * Ceiling on `expirationTime - issuedAt`. Bounds how long a spent nonce has to be
   * retained, which is the only thing keeping the nonce store finite. Default 300s.
   */
  readonly maxProofLifetimeSeconds?: number | undefined;
  /**
   * How old `issuedAt` may be. AgentKit's own default is 5 minutes; a proof minted long
   * ago and held is worth refusing even when its expiry is still in the future.
   */
  readonly maxProofAgeSeconds?: number | undefined;
  /** Tolerance for a client clock running ahead of ours. Default 30s. */
  readonly clockSkewSeconds?: number | undefined;
  /**
   * Require the caller to supply a path so the proof's URI can be checked against it.
   * Off by default: when a path is supplied the URI is always checked, and this only
   * governs what happens when one is not.
   */
  readonly requireUriMatch?: boolean | undefined;
  /** Milliseconds since the epoch. */
  readonly clock?: (() => number) | undefined;
  readonly recoverSigner?: SignerRecovery | undefined;
}

export interface AgentTierVerifier {
  verify(request: VerifiableRequest): Promise<VerificationResult>;
  /**
   * `verify` for a caller that has already normalised the headers.
   *
   * The gate uses this because it needs the same map twice — once to read the proof and
   * once to attribute the request to a rate-limit bucket — and normalising raw headers a
   * second time, in a place that has no way to answer a malformed one, is what made the
   * gate throw where `verify` returned a decision.
   */
  verifyNormalized(headers: NormalizedHeaders, request: VerifiableRequest): Promise<VerificationResult>;
  readonly domain: string;
  readonly proofHeader: string;
  readonly acceptedChainIds: readonly number[];
}

function anonymous(
  reason: VerificationFailureCode,
  detail: string,
  presented: boolean,
): AnonymousVerification {
  return { tier: 'anonymous', presented, reason, detail };
}

export interface NormalizedRequestHeaders {
  readonly headers: NormalizedHeaders;
  /**
   * The result to return instead of reading the proof, or null when there is none. Set
   * only when the proof header itself was ambiguous; `headers` is still populated, so a
   * caller that needs the other headers (to key a rate-limit bucket, say) still has them.
   */
  readonly refusal: AnonymousVerification | null;
}

/**
 * Normalise a request's headers once, turning the one ambiguity that stops verification
 * into the anonymous result the caller would otherwise have to invent.
 */
export function normalizeRequestHeaders(
  source: HeaderSource,
  proofHeader: string,
): NormalizedRequestHeaders {
  const { headers, conflictingHeader } = tryNormalizeHeaders(source, proofHeader);
  if (conflictingHeader === null) return { headers, refusal: null };
  return {
    headers,
    refusal: anonymous('headers_malformed', new ConflictingHeaderError(conflictingHeader).message, true),
  };
}

export function createAgentTierVerifier(options: VerifierOptions): AgentTierVerifier {
  const domain = options.domain.trim().toLowerCase();
  const proofHeader = (options.proofHeader ?? DEFAULT_PROOF_HEADER).toLowerCase();
  const acceptedChainIds = options.acceptedChainIds ?? [480, 8453];
  const maxProofLifetimeSeconds = options.maxProofLifetimeSeconds ?? 300;
  const maxProofAgeSeconds = options.maxProofAgeSeconds ?? 300;
  const clockSkewSeconds = options.clockSkewSeconds ?? 30;
  const requireUriMatch = options.requireUriMatch ?? false;
  const clock = options.clock ?? Date.now;
  const recoverSigner = options.recoverSigner ?? defaultSignerRecovery;

  if (domain.length === 0) {
    throw new AgentTierConfigurationError('domain must be a non-empty hostname');
  }
  if (proofHeader.length === 0) {
    throw new AgentTierConfigurationError('proofHeader must be a non-empty header name');
  }
  if (acceptedChainIds.length === 0) {
    throw new AgentTierConfigurationError('acceptedChainIds must list at least one chain');
  }
  for (const chainId of acceptedChainIds) {
    if (!isSupportedChainId(chainId)) {
      throw new AgentTierConfigurationError(
        `chainId ${chainId} is not a chain AgentKit signs on (480 World Chain, 8453 Base)`,
      );
    }
  }
  for (const [name, value] of [
    ['maxProofLifetimeSeconds', maxProofLifetimeSeconds],
    ['maxProofAgeSeconds', maxProofAgeSeconds],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new AgentTierConfigurationError(`${name} must be a positive integer`);
    }
  }
  if (!Number.isInteger(clockSkewSeconds) || clockSkewSeconds < 0) {
    throw new AgentTierConfigurationError('clockSkewSeconds must be a non-negative integer');
  }

  async function verify(request: VerifiableRequest): Promise<VerificationResult> {
    const { headers, refusal } = normalizeRequestHeaders(request.headers, proofHeader);
    return refusal ?? verifyNormalized(headers, request);
  }

  async function verifyNormalized(
    headers: NormalizedHeaders,
    request: VerifiableRequest,
  ): Promise<VerificationResult> {
    const raw = readProofHeader(headers, proofHeader);
    if (raw === undefined) {
      return anonymous('no_proof_presented', `no ${proofHeader} header was present`, false);
    }

    const envelope = parseProofHeader(raw);
    if (!envelope.ok) return anonymous(envelope.code, envelope.detail, true);

    // parseProofHeader already proved this parses; re-reading here keeps the envelope
    // module free of the field types and costs one pass over a short string.
    const parsed = parseSiweMessage(envelope.envelope.message);
    /* c8 ignore next */
    if (!parsed.ok) return anonymous('proof_malformed', parsed.detail, true);
    const fields = parsed.fields;

    if (fields.version !== '1') {
      return anonymous(
        'proof_unsupported_version',
        `message declares version ${JSON.stringify(fields.version)}; this server reads version 1`,
        true,
      );
    }
    if (fields.domain.toLowerCase() !== domain) {
      return anonymous(
        'proof_domain_mismatch',
        `proof was minted for ${JSON.stringify(fields.domain)}, not ${JSON.stringify(domain)}`,
        true,
      );
    }

    const chainId = parseChainId(fields.chainId);
    if (chainId === null) {
      return anonymous(
        'proof_malformed',
        `could not read ${JSON.stringify(fields.chainId)} as a chain id; expected 480 or eip155:480`,
        true,
      );
    }
    if (!acceptedChainIds.includes(chainId)) {
      return anonymous(
        'proof_chain_unsupported',
        `proof was signed on chain ${chainId}; this server accepts ${acceptedChainIds.join(', ')}`,
        true,
      );
    }

    const uriCheck = checkUri(fields.uri, request.path, requireUriMatch);
    if (uriCheck !== null) return anonymous('proof_uri_mismatch', uriCheck, true);

    const issuedAtMs = parseTimestamp(fields.issuedAt);
    if (issuedAtMs === null) {
      return anonymous('proof_malformed', `Issued At ${JSON.stringify(fields.issuedAt)} is not a timestamp`, true);
    }
    if (fields.expirationTime === null) {
      return anonymous('proof_malformed', 'the message carried no Expiration Time', true);
    }
    const expiresAtMs = parseTimestamp(fields.expirationTime);
    if (expiresAtMs === null) {
      return anonymous(
        'proof_malformed',
        `Expiration Time ${JSON.stringify(fields.expirationTime)} is not a timestamp`,
        true,
      );
    }
    let notBeforeMs: number | null = null;
    if (fields.notBefore !== null) {
      notBeforeMs = parseTimestamp(fields.notBefore);
      if (notBeforeMs === null) {
        return anonymous('proof_malformed', `Not Before ${JSON.stringify(fields.notBefore)} is not a timestamp`, true);
      }
    }
    if (expiresAtMs <= issuedAtMs) {
      return anonymous('proof_malformed', 'Expiration Time was not after Issued At', true);
    }

    // Cheap checks before the expensive ones: an expired proof should not cost a
    // signature recovery, and neither should cost a registry round trip.
    const nowMs = clock();
    const skewMs = clockSkewSeconds * 1000;
    if (expiresAtMs - issuedAtMs > maxProofLifetimeSeconds * 1000) {
      return anonymous(
        'proof_lifetime_too_long',
        `proof is valid for ${Math.round((expiresAtMs - issuedAtMs) / 1000)}s; this server accepts at most ${maxProofLifetimeSeconds}s`,
        true,
      );
    }
    if (issuedAtMs > nowMs + skewMs) {
      return anonymous('proof_not_yet_valid', 'Issued At is ahead of this server by more than the skew allowance', true);
    }
    if (notBeforeMs !== null && notBeforeMs > nowMs + skewMs) {
      return anonymous('proof_not_yet_valid', 'Not Before has not been reached', true);
    }
    if (nowMs - issuedAtMs > maxProofAgeSeconds * 1000 + skewMs) {
      return anonymous(
        'proof_stale',
        `proof was issued ${Math.round((nowMs - issuedAtMs) / 1000)}s ago; this server accepts at most ${maxProofAgeSeconds}s`,
        true,
      );
    }
    if (expiresAtMs <= nowMs) {
      return anonymous('proof_expired', `proof expired at ${fields.expirationTime}`, true);
    }

    const wallet = lowercaseAddress(fields.address);
    let recovered: Address;
    try {
      // Recovery runs against the message exactly as it arrived. Re-rendering it from
      // the parsed fields first would make every whitespace difference a forgery.
      recovered = await recoverSigner(envelope.envelope.message, envelope.envelope.signature);
    } catch (error) {
      return anonymous('signature_malformed', `signature could not be recovered: ${describe(error)}`, true);
    }
    if (recovered !== wallet) {
      return anonymous(
        'signature_mismatch',
        `signature recovers to ${recovered}, not to the address in the message (${wallet})`,
        true,
      );
    }

    // The registry read goes last of the expensive checks, so a proof that recovers to
    // the wrong address never reaches the RPC. That is an ordering, not a bound: anyone
    // can sign with a key they generated a second ago, so a valid signature costs an
    // attacker nothing. Bounding how many lookups a caller can cause is the gate's
    // `verificationBudget`, which runs before any of this.
    let record;
    try {
      record = await options.agentBook.lookup(wallet);
    } catch (error) {
      return anonymous('agentbook_unavailable', `AgentBook lookup failed: ${describe(error)}`, true);
    }
    if (!record.registered || record.humanId === null) {
      return anonymous('agentbook_unregistered', `${wallet} is not registered in AgentBook`, true);
    }
    if (record.revoked) {
      return anonymous('agentbook_revoked', `the AgentBook registration for ${wallet} is revoked`, true);
    }

    // Consumed last, and only on an otherwise complete pass. A nonce burned by a proof
    // that failed for any other reason would let an observer replay the failure to lock
    // out the legitimate retry.
    let outcome;
    try {
      outcome = await options.storage.consumeNonce(nonceKey(chainId, wallet, fields.nonce), expiresAtMs);
    } catch (error) {
      return anonymous(
        'nonce_store_unavailable',
        `nonce store failed, so replay protection cannot be guaranteed: ${describe(error)}`,
        true,
      );
    }
    if (outcome === 'replayed') {
      return anonymous('nonce_replayed', 'this proof has already been presented', true);
    }

    const proof: AgentKitProof = {
      message: envelope.envelope.message,
      signature: envelope.envelope.signature,
      fields,
      wallet,
      chainId,
      issuedAtMs,
      expiresAtMs,
      notBeforeMs,
    };

    return {
      tier: 'human-backed',
      presented: true,
      proof,
      identity: {
        wallet,
        chainId,
        humanId: record.humanId,
        registeredAt: record.registeredAt,
        proofExpiresAtMs: expiresAtMs,
      },
    };
  }

  return { verify, verifyNormalized, domain, proofHeader, acceptedChainIds };
}

/**
 * Returns a detail string when the URI does not match, or null when it does.
 *
 * Only the path is compared. Query strings are excluded so a proof survives a
 * cache-busting parameter appended by something in the middle, and the host is not
 * compared because the domain line already covers it.
 *
 * Note what this cannot do: a CAIP-122 message has no method field, so a proof bound to
 * `/v1/markets/42` is equally valid on a GET and on a POST to that path. The nonce being
 * single-use is what stops a captured read proof being replayed as a write.
 */
function checkUri(uri: string, path: string | undefined, required: boolean): string | null {
  if (path === undefined) {
    return required ? 'this server requires a path to check the proof URI against' : null;
  }
  let proofPath: string;
  try {
    proofPath = new URL(uri).pathname;
  } catch {
    // A relative URI is legal in EIP-4361 and compares directly.
    proofPath = uri.split('?')[0] ?? uri;
  }
  if (proofPath !== path) {
    return `proof is for ${JSON.stringify(proofPath)} but the request is for ${JSON.stringify(path)}`;
  }
  return null;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
