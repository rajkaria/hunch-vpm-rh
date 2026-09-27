/**
 * The client half: turning a wallet and a signing function into the header this
 * package's verifier expects.
 *
 * AgentKit's own client (`createAgentkitClient()` / `agentkit.fetch()`) builds and
 * attaches its proofs for you, and when you use it you do not need this. It is here for
 * the cases that client does not cover: an agent whose HTTP goes through something else,
 * a test that needs a real signature, and anyone who wants to read exactly what gets
 * signed rather than infer it.
 */

import { encodeProofHeader, type ProofEnvelope } from './proof.js';
import { DEFAULT_PROOF_HEADER } from './headers.js';
import { AGENTKIT_STATEMENT, formatSiweMessage, lowercaseAddress } from './siwe.js';
import type { Address, Hex, SupportedChainId } from './types.js';

export type MessageSigner = (message: string) => Promise<Hex>;

export interface BuildProofInput {
  readonly wallet: Address;
  /** The chain the agent signs on. AgentBook is still read on World Chain. */
  readonly chainId: SupportedChainId;
  /** The resource server's hostname, as it appears in the message's first line. */
  readonly domain: string;
  /** Full URI of the resource being requested. */
  readonly uri: string;
  /** EIP-191 personal_sign over the message. A viem account's `signMessage` fits. */
  readonly sign: MessageSigner;
  /** Defaults to AgentKit's documented statement line. */
  readonly statement?: string | null | undefined;
  /** Unique per proof. Defaults to a random UUID. */
  readonly nonce?: string | undefined;
  /** Defaults to now. */
  readonly issuedAtMs?: number | undefined;
  /** Defaults to 120s. Must stay within the server's `maxProofLifetimeSeconds`. */
  readonly lifetimeSeconds?: number | undefined;
  /**
   * Emit `Chain ID: eip155:480` (CAIP-122) rather than `Chain ID: 480` (EIP-4361).
   * Defaults to the CAIP-2 form, which is what World's field list specifies. Verifiers
   * built from this package read both.
   */
  readonly caip2ChainId?: boolean | undefined;
  readonly headerName?: string | undefined;
  readonly clock?: (() => number) | undefined;
}

export interface BuiltProof {
  /** Exactly what was signed. Log it next to a rejection and the mismatch is obvious. */
  readonly message: string;
  readonly signature: Hex;
  readonly envelope: ProofEnvelope;
  readonly headers: Readonly<Record<string, string>>;
}

export async function buildProof(input: BuildProofInput): Promise<BuiltProof> {
  const clock = input.clock ?? Date.now;
  const lifetimeSeconds = input.lifetimeSeconds ?? 120;
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds <= 0) {
    throw new RangeError(`lifetimeSeconds must be a positive integer, got ${lifetimeSeconds}`);
  }
  const issuedAtMs = input.issuedAtMs ?? clock();

  const message = formatSiweMessage({
    domain: input.domain,
    // EIP-4361 asks for an EIP-55 checksummed address here. The verifier compares
    // case-insensitively, so a lowercase address still verifies; a client talking to
    // somebody else's verifier should checksum it.
    address: lowercaseAddress(input.wallet),
    statement: input.statement === undefined ? AGENTKIT_STATEMENT : input.statement,
    uri: input.uri,
    chainId: (input.caip2ChainId ?? true) ? `eip155:${input.chainId}` : String(input.chainId),
    nonce: input.nonce ?? crypto.randomUUID(),
    issuedAt: new Date(issuedAtMs).toISOString(),
    expirationTime: new Date(issuedAtMs + lifetimeSeconds * 1000).toISOString(),
  });

  const signature = await input.sign(message);
  const envelope: ProofEnvelope = { message, signature };

  return {
    message,
    signature,
    envelope,
    headers: { [input.headerName ?? DEFAULT_PROOF_HEADER]: encodeProofHeader(envelope) },
  };
}
