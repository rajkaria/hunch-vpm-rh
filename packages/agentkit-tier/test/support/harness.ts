/**
 * Test harness. Real secp256k1 signatures from viem local accounts, a stub AgentBook,
 * and a hand-cranked clock so expiry and rate-limit windows are deterministic.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { createStaticAgentBook, type AgentBookRegistry } from '../../src/agentbook.js';
import { buildProof, type BuildProofInput } from '../../src/client.js';
import { createAgentTierGate, type AgentTierGate, type GateOptions } from '../../src/gate.js';
import { InMemoryTierStorage, type NonceOutcome, type TierStorage } from '../../src/storage.js';
import type { TierPolicies } from '../../src/tiers.js';
import type { AgentBookRecord, Address, Hex, SupportedChainId } from '../../src/types.js';
import { createAgentTierVerifier, type AgentTierVerifier } from '../../src/verify.js';

/** Anvil's published test keys. Public by design; nothing is ever funded with them. */
const REGISTERED_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const UNREGISTERED_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const REVOKED_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const IMPOSTOR_KEY = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';

export const registeredAgent = privateKeyToAccount(REGISTERED_KEY);
export const unregisteredAgent = privateKeyToAccount(UNREGISTERED_KEY);
export const revokedAgent = privateKeyToAccount(REVOKED_KEY);
export const impostor = privateKeyToAccount(IMPOSTOR_KEY);

export const DOMAIN = 'api.hunch.test';
export const PATH = '/v1/markets';
export const URI = `https://${DOMAIN}${PATH}`;
export const CHAIN_ID: SupportedChainId = 480;
export const HUMAN_ID = '0xabc0000000000000000000000000000000000000000000000000000000000001';

/** 2023-11-14T22:13:20Z. Any fixed instant would do; this one is readable in a failure. */
export const T0_MS = 1_700_000_000_000;

export class Clock {
  nowMs: number;
  constructor(startMs = T0_MS) {
    this.nowMs = startMs;
  }
  readonly now = (): number => this.nowMs;
  advanceMs(ms: number): void {
    this.nowMs += ms;
  }
  advanceSeconds(seconds: number): void {
    this.advanceMs(seconds * 1000);
  }
}

export function defaultAgentBook(): AgentBookRegistry {
  return createStaticAgentBook({
    [registeredAgent.address.toLowerCase()]: {
      registered: true,
      revoked: false,
      humanId: HUMAN_ID,
      registeredAt: 1_699_000_000,
    } satisfies AgentBookRecord,
    [revokedAgent.address.toLowerCase()]: {
      registered: true,
      revoked: true,
      humanId: HUMAN_ID,
      registeredAt: 1_699_000_000,
    } satisfies AgentBookRecord,
  });
}

export interface CountingAgentBook extends AgentBookRegistry {
  /** How many times the registry was asked. Stands in for the RPC bill. */
  readonly lookups: number;
}

/** Wraps a registry so a test can assert how much work a request actually caused. */
export function countingAgentBook(inner: AgentBookRegistry = defaultAgentBook()): CountingAgentBook {
  let lookups = 0;
  return {
    lookup(wallet) {
      lookups += 1;
      return inner.lookup(wallet);
    },
    get lookups() {
      return lookups;
    },
  };
}

/** A registry that always rejects, for the "cannot find out" path. */
export function failingAgentBook(message = 'rpc unreachable'): AgentBookRegistry {
  return {
    async lookup() {
      throw new Error(message);
    },
  };
}

/** Storage whose nonce side fails while its counter side keeps working. */
export function nonceStoreDown(inner: TierStorage): TierStorage {
  return {
    async consumeNonce(): Promise<NonceOutcome> {
      throw new Error('nonce store unreachable');
    },
    incrementWindow: (key, endsAt) => inner.incrementWindow(key, endsAt),
  };
}

/** Storage whose counter side fails while its nonce side keeps working. */
export function counterStoreDown(inner: TierStorage): TierStorage {
  return {
    consumeNonce: (key, expiresAt) => inner.consumeNonce(key, expiresAt),
    async incrementWindow(): Promise<number> {
      throw new Error('counter store unreachable');
    },
  };
}

export interface Harness {
  readonly clock: Clock;
  readonly storage: InMemoryTierStorage;
  readonly verifier: AgentTierVerifier;
  readonly gate: AgentTierGate;
}

export type HarnessOverrides = Partial<
  Pick<
    GateOptions,
    | 'agentBook'
    | 'storage'
    | 'domain'
    | 'proofHeader'
    | 'acceptedChainIds'
    | 'maxProofLifetimeSeconds'
    | 'maxProofAgeSeconds'
    | 'clockSkewSeconds'
    | 'requireUriMatch'
    | 'onInvalidProof'
    | 'subject'
    | 'enforceRateLimit'
    | 'verificationBudget'
    | 'verificationSubject'
    | 'onRateLimitStorageError'
  >
> & { readonly policies?: TierPolicies };

export function createHarness(overrides: HarnessOverrides = {}): Harness {
  const clock = new Clock();
  const storage = new InMemoryTierStorage({ clock: clock.now });
  const options: GateOptions = {
    agentBook: defaultAgentBook(),
    storage,
    domain: DOMAIN,
    clock: clock.now,
    ...overrides,
  };
  return {
    clock,
    storage,
    verifier: createAgentTierVerifier(options),
    gate: createAgentTierGate(options),
  };
}

export interface SigningAccount {
  readonly address: string;
  signMessage(args: { message: string }): Promise<Hex>;
}

export interface ProofOverrides extends Partial<Omit<BuildProofInput, 'sign' | 'wallet'>> {
  readonly account?: SigningAccount;
  /** Sign as somebody else while the message still names `account`. */
  readonly signAs?: SigningAccount;
  readonly wallet?: Address;
}

/** Builds a valid proof unless an override makes it invalid. */
export async function makeProof(clock: Clock, overrides: ProofOverrides = {}): Promise<{
  readonly message: string;
  readonly signature: Hex;
  readonly headers: Readonly<Record<string, string>>;
}> {
  const account = overrides.account ?? registeredAgent;
  const signer = overrides.signAs ?? account;
  return buildProof({
    wallet: overrides.wallet ?? (account.address.toLowerCase() as Address),
    chainId: overrides.chainId ?? CHAIN_ID,
    domain: overrides.domain ?? DOMAIN,
    uri: overrides.uri ?? URI,
    sign: (message) => signer.signMessage({ message }),
    clock: clock.now,
    ...(overrides.statement === undefined ? {} : { statement: overrides.statement }),
    ...(overrides.nonce === undefined ? {} : { nonce: overrides.nonce }),
    ...(overrides.issuedAtMs === undefined ? {} : { issuedAtMs: overrides.issuedAtMs }),
    ...(overrides.lifetimeSeconds === undefined ? {} : { lifetimeSeconds: overrides.lifetimeSeconds }),
    ...(overrides.caip2ChainId === undefined ? {} : { caip2ChainId: overrides.caip2ChainId }),
    ...(overrides.headerName === undefined ? {} : { headerName: overrides.headerName }),
  });
}

/** Re-wraps a message and signature into a header without going through the builder. */
export async function headerFor(message: string, signer: SigningAccount): Promise<Record<string, string>> {
  const { encodeProofHeader } = await import('../../src/proof.js');
  return { agentkit: encodeProofHeader({ message, signature: await signer.signMessage({ message }) }) };
}

/** A request with the path the default proof URI names. */
export function requestFor(headers: Readonly<Record<string, string>>) {
  return { headers, method: 'GET', path: PATH };
}
