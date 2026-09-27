/**
 * The AgentBook seam.
 *
 * `npx @worldcoin/agentkit-cli register <wallet>` puts a binding between an agent wallet
 * and an anonymous, persistent human identifier into AgentBook. Verification asks that
 * registry one question: is this wallet bound to a human, and is that binding still live.
 *
 * The lookup always resolves on World Chain even when the agent signed its proof on
 * Base. The caller's chain and the registry's chain are separate things and conflating
 * them produces a verifier that rejects every Base-side agent.
 *
 * The question is an interface, not a chain call, for two reasons. A resource server
 * should be able to run its tests without a node, and a production deployment will want
 * a cache in front of the read because it sits on the request path of every call.
 */

import type { PublicClient } from 'viem';
import { lowercaseAddress } from './siwe.js';
import type { Address, AgentBookRecord } from './types.js';
import { AGENT_BOOK_CHAIN_ID } from './types.js';

export interface AgentBookRegistry {
  /**
   * Must reject, not return an unregistered record, when the lookup itself fails. The
   * verifier distinguishes "this wallet has no human" from "we could not find out",
   * and only the second is a reason to retry.
   */
  lookup(wallet: Address): Promise<AgentBookRecord>;
}

export const UNREGISTERED: AgentBookRecord = Object.freeze({
  registered: false,
  revoked: false,
  humanId: null,
  registeredAt: null,
});

export const PLACEHOLDER_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

export function isPlaceholderAddress(address: string): boolean {
  return lowercaseAddress(address) === PLACEHOLDER_ADDRESS;
}

/**
 * The canonical AgentBook on World Chain.
 *
 * This is a placeholder, not a guess at the real address. AgentKit's own verifier
 * defaults to the canonical deployment and exposes a `contractAddress` override; this
 * package has no such default to fall back on, and a wrong registry address is worse
 * than no default at all, because verification would fail for every real agent and the
 * venue would look like nobody had ever registered. Configure it explicitly — the
 * reader refuses to construct with the placeholder.
 */
export const CANONICAL_AGENT_BOOK: Address = PLACEHOLDER_ADDRESS;

/**
 * The slice of AgentBook this package reads.
 *
 * This shape is inferred from what registration has to store, not copied from a
 * published artifact. If the canonical registry's
 * accessor differs, do not patch this constant: implement {@link AgentBookRegistry}
 * against the real contract. That is a ten-line function and it keeps the mismatch
 * visible instead of buried in an ABI.
 */
export const AGENT_BOOK_ABI = [
  {
    type: 'function',
    name: 'agentOf',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [
      { name: 'humanId', type: 'bytes32' },
      { name: 'registeredAt', type: 'uint64' },
      { name: 'revoked', type: 'bool' },
    ],
  },
] as const;

const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;

export interface ViemAgentBookOptions {
  /** A client pointed at World Chain. The agent's own chain is irrelevant here. */
  readonly client: PublicClient;
  readonly address: Address;
}

export class AgentBookConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentBookConfigurationError';
  }
}

/** Reads AgentBook over RPC. Wrap it in {@link createCachingAgentBook} before shipping. */
export function createViemAgentBook(options: ViemAgentBookOptions): AgentBookRegistry {
  const address = lowercaseAddress(options.address);
  if (isPlaceholderAddress(address)) {
    throw new AgentBookConfigurationError(
      'AgentBook address is the zero placeholder. Set the canonical World Chain address; ' +
        'reading the zero address would make every wallet look unregistered.',
    );
  }
  return {
    async lookup(wallet) {
      const [humanId, registeredAt, revoked] = await options.client.readContract({
        address,
        abi: AGENT_BOOK_ABI,
        functionName: 'agentOf',
        args: [wallet],
      });
      if (humanId === ZERO_BYTES32) return UNREGISTERED;
      return { registered: true, revoked, humanId, registeredAt: Number(registeredAt) };
    },
  };
}

/** Keyed by lowercase wallet. Anything absent is unregistered. */
export type StaticAgentBookRecords = Readonly<Record<string, AgentBookRecord>>;

/** For tests and local development. */
export function createStaticAgentBook(records: StaticAgentBookRecords): AgentBookRegistry {
  return {
    async lookup(wallet) {
      return records[lowercaseAddress(wallet)] ?? UNREGISTERED;
    },
  };
}

export interface CachingAgentBookOptions {
  /** How long a registered record stays cached. Default 5 minutes. */
  readonly registeredTtlMs?: number;
  /**
   * How long an unregistered record stays cached. Default 30 seconds, deliberately much
   * shorter: an agent that registers while we hold a negative entry would otherwise be
   * stuck at anonymous for the full TTL, and that is the one cache miss users notice.
   */
  readonly unregisteredTtlMs?: number;
  readonly maxEntries?: number;
  readonly clock?: () => number;
}

interface CacheEntry {
  readonly record: AgentBookRecord;
  readonly expiresAtMs: number;
}

/**
 * A TTL cache in front of a registry. Failures are never cached — a registry that is
 * down should be retried on the next request, not remembered as down.
 */
export function createCachingAgentBook(
  inner: AgentBookRegistry,
  options: CachingAgentBookOptions = {},
): AgentBookRegistry {
  const registeredTtlMs = options.registeredTtlMs ?? 300_000;
  const unregisteredTtlMs = options.unregisteredTtlMs ?? 30_000;
  const maxEntries = options.maxEntries ?? 10_000;
  const clock = options.clock ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  return {
    async lookup(wallet) {
      const key = lowercaseAddress(wallet);
      const now = clock();
      const hit = cache.get(key);
      if (hit !== undefined && hit.expiresAtMs > now) return hit.record;
      if (hit !== undefined) cache.delete(key);

      const record = await inner.lookup(wallet);
      const ttl = record.registered ? registeredTtlMs : unregisteredTtlMs;
      // Insertion-ordered eviction. A perfect LRU would need a second structure for a
      // cache this small; oldest-first is enough to keep memory bounded.
      if (cache.size >= maxEntries) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(key, { record, expiresAtMs: now + ttl });
      return record;
    },
  };
}

export { AGENT_BOOK_CHAIN_ID };
