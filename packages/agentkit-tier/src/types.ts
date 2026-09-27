/**
 * The vocabulary of the package. Nothing here imports a framework, a chain client
 * or a store, so a caller can depend on these types without pulling in viem.
 */

/** 20-byte hex address. Lowercased everywhere this package compares one. */
export type Address = `0x${string}`;

/** 0x-prefixed hex string of arbitrary length. */
export type Hex = `0x${string}`;

/**
 * The two tiers. There is no third state and no rejected state: an agent that
 * cannot prove a human behind it is `anonymous`, and anonymous agents keep
 * working. See README, "Why not just require it".
 */
export type AgentTier = 'anonymous' | 'human-backed';

/**
 * Chains an agent may present a proof from.
 *
 * These are caller-side. The AgentBook lookup itself always resolves on World Chain
 * regardless of which of these the agent signed on, which is why
 * {@link AGENT_BOOK_CHAIN_ID} is separate.
 */
export const SUPPORTED_CHAIN_IDS = {
  worldChain: 480,
  /** Where the venue's existing x402 rail already runs, so no new chain is needed. */
  base: 8453,
} as const;

export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[keyof typeof SUPPORTED_CHAIN_IDS];

/** AgentBook is read on World Chain. The caller's chain does not change that. */
export const AGENT_BOOK_CHAIN_ID = 480;

export function isSupportedChainId(value: number): value is SupportedChainId {
  return value === SUPPORTED_CHAIN_IDS.worldChain || value === SUPPORTED_CHAIN_IDS.base;
}

/**
 * The fields of the signed message, as they appeared in it.
 *
 * AgentKit challenges an agent with a CAIP-122 / EIP-4361 "sign in with Ethereum"
 * message and the agent signs it with EIP-191. These are that message's fields,
 * verbatim strings rather than parsed values, because the thing that was signed is the
 * text and a verifier that re-serialises before checking is a verifier with a
 * canonicalisation bug waiting in it.
 */
export interface SiweFields {
  /** The server hostname the message was minted for. */
  readonly domain: string;
  /** The agent wallet. EIP-4361 says this is EIP-55 checksummed; casing is not relied on. */
  readonly address: Address;
  readonly statement: string | null;
  /** Full resource URI the proof is for. */
  readonly uri: string;
  readonly version: string;
  /** Verbatim: either a bare `480` (EIP-4361) or `eip155:480` (CAIP-122). Both are read. */
  readonly chainId: string;
  readonly nonce: string;
  /** ISO 8601. */
  readonly issuedAt: string;
  /** ISO 8601, or null when the message omitted it. */
  readonly expirationTime: string | null;
  readonly notBefore: string | null;
  readonly requestId: string | null;
  readonly resources: readonly string[];
}

/** A parsed message plus the values the verifier actually compares against. */
export interface AgentKitProof {
  /** Exactly the bytes that were signed. Recovery runs against this, never a re-render. */
  readonly message: string;
  readonly signature: Hex;
  readonly fields: SiweFields;
  readonly wallet: Address;
  readonly chainId: number;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly notBeforeMs: number | null;
}

/** Every distinct way a presented proof can fail to establish a human. */
export type VerificationFailureCode =
  /** Nothing was presented. The ordinary anonymous caller. */
  | 'no_proof_presented'
  /** The header appeared more than once with conflicting values. */
  | 'headers_malformed'
  /** Envelope is not base64url/JSON, or the message inside is not a readable CAIP-122 message. */
  | 'proof_malformed'
  | 'proof_unsupported_version'
  | 'proof_chain_unsupported'
  /** Minted for a different server. */
  | 'proof_domain_mismatch'
  /** The URI in the message is not the resource being requested. */
  | 'proof_uri_mismatch'
  | 'proof_expired'
  /** `issuedAt` or `notBefore` is further in the future than the allowed clock skew. */
  | 'proof_not_yet_valid'
  /** `issuedAt` is older than this server accepts, even if the message has not expired. */
  | 'proof_stale'
  /** `expirationTime - issuedAt` exceeds the configured ceiling. */
  | 'proof_lifetime_too_long'
  /** Not a 65-byte 0x-hex signature, or recovery threw. */
  | 'signature_malformed'
  /** Recovered signer is not the address in the message. */
  | 'signature_mismatch'
  | 'agentbook_unregistered'
  | 'agentbook_revoked'
  /** The registry lookup itself failed. "Cannot find out", not "no human". */
  | 'agentbook_unavailable'
  | 'nonce_replayed'
  /** The nonce store failed, so replay protection cannot be guaranteed. */
  | 'nonce_store_unavailable'
  /**
   * The gate's per-source verification budget was spent, so the proof was never checked.
   * The only code here the verifier does not produce: it says nothing about the proof,
   * only that this source had already made the server do that work too many times in the
   * current window.
   */
  | 'verification_budget_exhausted';

/** What AgentBook says about a wallet. */
export interface AgentBookRecord {
  readonly registered: boolean;
  readonly revoked: boolean;
  /**
   * The anonymous, persistent human identifier bound to the wallet, or null when the
   * wallet is unregistered. Treat it as a pseudonym: stable per human, opaque, and not
   * to be published next to anything else that identifies them.
   */
  readonly humanId: string | null;
  /** Unix seconds, or null when unregistered. */
  readonly registeredAt: number | null;
}

/** The identity a successful verification establishes. */
export interface HumanBackedIdentity {
  readonly wallet: Address;
  /** The chain the agent signed on, not the chain AgentBook was read on. */
  readonly chainId: number;
  readonly humanId: string;
  readonly registeredAt: number | null;
  /** Milliseconds since the epoch, from the proof's `expirationTime`. */
  readonly proofExpiresAtMs: number;
}

export interface HumanBackedVerification {
  readonly tier: 'human-backed';
  /** Always true here; kept so callers can branch on one field across both shapes. */
  readonly presented: true;
  readonly identity: HumanBackedIdentity;
  readonly proof: AgentKitProof;
}

export interface AnonymousVerification {
  readonly tier: 'anonymous';
  /**
   * Whether the caller tried. `false` is the ordinary anonymous agent; `true` means a
   * proof was presented and did not hold up, which is worth logging and may be worth
   * rejecting outright — see `onInvalidProof`.
   */
  readonly presented: boolean;
  readonly reason: VerificationFailureCode;
  /** Human-readable, safe to log. Never contains the signature or the raw envelope. */
  readonly detail: string;
}

export type VerificationResult = HumanBackedVerification | AnonymousVerification;

/** Headers in any of the shapes an HTTP layer is likely to hand us. */
export type HeaderSource =
  | Headers
  | ReadonlyMap<string, string>
  | Readonly<Record<string, string | readonly string[] | undefined>>;

/** The only thing the core verifier needs from a request. */
export interface VerifiableRequest {
  readonly headers: HeaderSource;
  readonly method?: string | undefined;
  /** Path only, no query string. Compared against the path of the proof's URI. */
  readonly path?: string | undefined;
}
