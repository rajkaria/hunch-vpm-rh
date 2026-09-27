import { describe, expect, it } from 'vitest';
import marketEmpty from './fixtures/market-empty.json';
import marketOpen from './fixtures/market-open.json';
import marketUnbounded from './fixtures/market-unbounded.json';
import marketVoided from './fixtures/market-voided.json';
import unclaimedWinners from './fixtures/unclaimed-winners.json';
import walletResidue from './fixtures/wallet-residue.json';
import { formatPrice, formatUsdc } from '../src/units.js';
import { MARKET_A, MARKET_EMPTY, MARKET_UNBOUNDED, MARKET_VOIDED, testClient } from './support/client.js';

const NOW = 1_999_999_000n;

/** Market 5 has resolved to outcome 0 and is still waiting on one winner. */
const RESOLVED = '0x1111111111111111111111111111111111111111-5';
const resolvedResponses = {
  market: { _meta: { block: { number: 2100 }, hasIndexingErrors: false }, market: walletResidue.markets[0] },
  unclaimedWinners: (variables: Record<string, unknown>) => ({
    positions: (unclaimedWinners as Record<string, unknown[]>)[String(variables['market'])] ?? [],
  }),
};

describe('marketBook', () => {
  it('reports principal, vested, capacity and headroom per outcome', async () => {
    const { client } = testClient({ market: marketOpen });
    const book = await client.marketBook(MARKET_A, { now: NOW });

    expect(book.books[0]?.principal).toBe(6_000000n);
    expect(book.books[0]?.vested).toBe(101_000000n);
    expect(book.books[0]?.capacity).toBe(180_000000n);
    expect(book.books[0]?.headroom).toBe(79_000000n);
    expect(book.books[1]?.headroom).toBe(3_024_000000n);
  });

  it('separates a book its own room from the room a stake on it needs', async () => {
    const { client } = testClient({ market: marketOpen });
    const book = await client.marketBook(MARKET_A, { now: NOW });

    // Outcome 0's own book has 79 of room, but a stake ON outcome 0 vests into
    // book 1, which has 3024. These are different numbers and both matter.
    expect(book.books[0]?.headroom).toBe(79_000000n);
    expect(book.books[0]?.maxFullyAccepted).toBe(3_024_000000n);
  });

  it('carries the implied odds alongside the books', async () => {
    const { client } = testClient({ market: marketOpen });
    const book = await client.marketBook(MARKET_A, { now: NOW });
    expect(book.books[0]?.probabilityPercent).toBe('5.6074');
    expect(book.books[1]?.probabilityPercent).toBe('94.3925');
  });

  /**
   * Both ends of the arrival window, because a vested reader needs both: a stake is
   * rationed against the room its opposing books have left, and how much of that room
   * opens up before the freeze depends on how much of the window is already gone. The
   * countdown below is the far end; this is the near one, and nothing else in the
   * response implies it.
   */
  it('publishes the opening time, not only the freeze', async () => {
    const { client } = testClient({ market: marketOpen });
    const book = await client.marketBook(MARKET_A, { now: NOW });

    expect(book.createdAt).toBe(BigInt(marketOpen.market.createdAt));
    expect(book.createdAt).toBeLessThan(book.resolutionTime);
  });

  it('counts down to the freeze', async () => {
    const { client } = testClient({ market: marketOpen });
    const book = await client.marketBook(MARKET_A, { now: NOW });
    expect(book.secondsToFreeze).toBe(1000n);
    expect(book.frozen).toBe(false);
    expect(book.voidableFrom).toBe(2_000_086_400n);
  });

  it('floors the countdown at zero once frozen', async () => {
    const { client } = testClient({ market: marketOpen });
    const book = await client.marketBook(MARKET_A, { now: 2_500_000_000n });
    expect(book.secondsToFreeze).toBe(0n);
    expect(book.frozen).toBe(true);
  });

  it('carries the resolution spec so the terms are auditable', async () => {
    const { client } = testClient({ market: marketOpen });
    const book = await client.marketBook(MARKET_A, { now: NOW });

    expect(book.spec?.direction).toBe('above');
    expect(formatPrice(book.spec?.strike ?? 0n)).toBe('3000');
    expect(book.spec?.maxStaleness).toBe(300n);
    expect(book.spec?.oracle).toBe('0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62');
  });

  it('reports unbounded capacity as null', async () => {
    const { client } = testClient({ market: marketUnbounded });
    const book = await client.marketBook(MARKET_UNBOUNDED, { now: NOW });
    expect(book.kappa).toBeNull();
    expect(book.books.every((entry) => entry.capacity === null && entry.headroom === null)).toBe(true);
  });

  it('survives a market with nothing in it', async () => {
    const { client } = testClient({ market: marketEmpty });
    const book = await client.marketBook(MARKET_EMPTY, { now: NOW });
    expect(book.acceptedPool).toBe(0n);
    expect(book.residue).toBe(0n);
    expect(book.books.every((entry) => entry.decimalOddsPpm === null)).toBe(true);
    expect(formatUsdc(book.acceptedPool)).toBe('0');
  });

  it('has no winner on a voided market, and says what voided it', async () => {
    const { client } = testClient({ market: marketVoided });
    const book = await client.marketBook(MARKET_VOIDED, { now: NOW });
    expect(book.status).toBe('Voided');
    expect(book.winner).toBeNull();
    expect(book.spec?.direction).toBe('below');
    // The only reading available was 900 seconds old against a 300 second bound.
    expect(book.voidedStaleAge).toBe(900n);
    expect(book.residue).toBe(0n);
  });

  it('counts the winners a resolved market still owes, on the book that gates residue', async () => {
    const { client } = testClient(resolvedResponses);
    const book = await client.marketBook(RESOLVED, { now: NOW });

    expect(book.winner).toBe(0);
    expect(book.books[0]?.live).toBe(1);
    // The gate only means anything on the winning book, so no other book
    // claims a count it did not earn.
    expect(book.books[1]?.live).toBeNull();
    // The index's figure, which still contains that winner's settlement.
    expect(book.residue).toBe(18_666667n);
    expect(book.resolvedPrice).toBe(310_000000000n);
  });

  it('does not pay for the residue gate on a market that has not resolved', async () => {
    // No `unclaimedWinners` fixture is recorded, so asking for one would throw.
    const { client, transport } = testClient({ market: marketOpen });
    await client.marketBook(MARKET_A, { now: NOW });
    expect(transport.calls.map((call) => call.operation)).toEqual(['market']);
  });
});
