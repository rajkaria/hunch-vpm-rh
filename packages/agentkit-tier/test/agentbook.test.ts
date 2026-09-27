import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_BOOK_ABI,
  AGENT_BOOK_CHAIN_ID,
  AgentBookConfigurationError,
  CANONICAL_AGENT_BOOK,
  PLACEHOLDER_ADDRESS,
  UNREGISTERED,
  createCachingAgentBook,
  createStaticAgentBook,
  createViemAgentBook,
  isPlaceholderAddress,
  type AgentBookRegistry,
} from '../src/agentbook.js';
import type { Address, AgentBookRecord } from '../src/types.js';
import { Clock } from './support/harness.js';

const WALLET = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Address;
const registered: AgentBookRecord = {
  registered: true,
  revoked: false,
  humanId: '0xfeed',
  registeredAt: 1_699_000_000,
};

describe('createStaticAgentBook', () => {
  it('returns the record it was given', async () => {
    const book = createStaticAgentBook({ [WALLET]: registered });
    expect(await book.lookup(WALLET)).toEqual(registered);
  });

  it('treats an unknown wallet as unregistered', async () => {
    expect(await createStaticAgentBook({}).lookup(WALLET)).toEqual(UNREGISTERED);
  });

  it('is insensitive to wallet casing', async () => {
    const book = createStaticAgentBook({ [WALLET]: registered });
    expect((await book.lookup('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')).registered).toBe(true);
  });
});

describe('createViemAgentBook', () => {
  it('refuses the zero placeholder, which would make every wallet look unregistered', () => {
    const client = { readContract: vi.fn() } as never;
    expect(() => createViemAgentBook({ client, address: PLACEHOLDER_ADDRESS })).toThrow(
      AgentBookConfigurationError,
    );
  });

  it('reads a registered binding out of the contract call', async () => {
    const readContract = vi.fn().mockResolvedValue([`0x${'11'.repeat(32)}`, 1_699_000_000n, false]);
    const book = createViemAgentBook({
      client: { readContract } as never,
      address: '0x1111111111111111111111111111111111111111',
    });

    const record = await book.lookup(WALLET);

    expect(record).toEqual({
      registered: true,
      revoked: false,
      humanId: `0x${'11'.repeat(32)}`,
      registeredAt: 1_699_000_000,
    });
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'agentOf', args: [WALLET] }),
    );
  });

  it('reads a zero human id as unregistered', async () => {
    const readContract = vi.fn().mockResolvedValue([`0x${'00'.repeat(32)}`, 0n, false]);
    const book = createViemAgentBook({
      client: { readContract } as never,
      address: '0x1111111111111111111111111111111111111111',
    });

    expect(await book.lookup(WALLET)).toEqual(UNREGISTERED);
  });

  it('lets an RPC failure surface rather than reporting "no human"', async () => {
    const readContract = vi.fn().mockRejectedValue(new Error('rpc down'));
    const book = createViemAgentBook({
      client: { readContract } as never,
      address: '0x1111111111111111111111111111111111111111',
    });

    await expect(book.lookup(WALLET)).rejects.toThrow('rpc down');
  });
});

describe('createCachingAgentBook', () => {
  function counting(record: AgentBookRecord): { book: AgentBookRegistry; calls: () => number } {
    let calls = 0;
    return {
      book: {
        async lookup() {
          calls += 1;
          return record;
        },
      },
      calls: () => calls,
    };
  }

  it('serves a registered record from cache inside its TTL', async () => {
    const clock = new Clock();
    const inner = counting(registered);
    const book = createCachingAgentBook(inner.book, { registeredTtlMs: 1_000, clock: clock.now });

    await book.lookup(WALLET);
    await book.lookup(WALLET);

    expect(inner.calls()).toBe(1);
  });

  it('refetches once the TTL has passed', async () => {
    const clock = new Clock();
    const inner = counting(registered);
    const book = createCachingAgentBook(inner.book, { registeredTtlMs: 1_000, clock: clock.now });

    await book.lookup(WALLET);
    clock.advanceMs(1_001);
    await book.lookup(WALLET);

    expect(inner.calls()).toBe(2);
  });

  it('holds a negative answer for much less time than a positive one', async () => {
    const clock = new Clock();
    const inner = counting(UNREGISTERED);
    const book = createCachingAgentBook(inner.book, {
      registeredTtlMs: 300_000,
      unregisteredTtlMs: 1_000,
      clock: clock.now,
    });

    await book.lookup(WALLET);
    clock.advanceMs(1_001);
    await book.lookup(WALLET);

    // An agent that registers while we hold a negative entry is stuck anonymous until
    // it expires, so the negative TTL is the one that has to be short.
    expect(inner.calls()).toBe(2);
  });

  it('does not cache a failure', async () => {
    const lookup = vi
      .fn<AgentBookRegistry['lookup']>()
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockResolvedValue(registered);
    const book = createCachingAgentBook({ lookup }, { clock: new Clock().now });

    await expect(book.lookup(WALLET)).rejects.toThrow('rpc down');
    expect((await book.lookup(WALLET)).registered).toBe(true);
  });

  it('evicts oldest-first once it is full', async () => {
    const inner = counting(registered);
    const book = createCachingAgentBook(inner.book, { maxEntries: 2, clock: new Clock().now });

    await book.lookup('0x1111111111111111111111111111111111111111');
    await book.lookup('0x2222222222222222222222222222222222222222');
    await book.lookup('0x3333333333333333333333333333333333333333');
    // The first wallet was evicted to make room, so asking again hits the inner book.
    await book.lookup('0x1111111111111111111111111111111111111111');

    expect(inner.calls()).toBe(4);
  });
});

describe('chain and address constants', () => {
  it('resolves AgentBook on World Chain, whichever chain the agent signed on', () => {
    expect(AGENT_BOOK_CHAIN_ID).toBe(480);
  });

  it('ships a placeholder rather than a guessed address', () => {
    expect(isPlaceholderAddress(CANONICAL_AGENT_BOOK)).toBe(true);
  });
});

describe('AGENT_BOOK_ABI', () => {
  it('reads a wallet and returns the human binding, its age and whether it was revoked', () => {
    const [fn] = AGENT_BOOK_ABI;
    expect(fn.name).toBe('agentOf');
    expect(fn.stateMutability).toBe('view');
    expect(fn.inputs.map((i) => i.type)).toEqual(['address']);
    expect(fn.outputs.map((o) => o.name)).toEqual(['humanId', 'registeredAt', 'revoked']);
  });
});
