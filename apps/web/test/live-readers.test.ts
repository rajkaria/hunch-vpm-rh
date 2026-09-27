import { describe, expect, it } from 'vitest';

import { TICKERS } from '@/content/tickers';
import { NOT_DEPLOYED, parseDeployment } from '@/lib/live/deployment';
import { createPriceReader, type FeedReader, type RawRound } from '@/lib/live/prices';
import { readProof } from '@/lib/live/proof';
import { readVenue } from '@/lib/live/venue';

const round = (answer: bigint, updatedAt = 1_790_000_000n, roundId = 100n): RawRound => ({ answer, updatedAt, roundId });

describe('price reader', () => {
  it('reads every ticker and serialises for the client', async () => {
    const read: FeedReader = async (feeds) => feeds.map((_, index) => round(22_566_018_707n + BigInt(index)));
    const snapshot = await createPriceReader(read, () => 1_790_000_060_000)();
    expect(snapshot.status).toBe('live');
    expect(snapshot.readAt).toBe(1_790_000_060);
    expect(snapshot.readings.map((reading) => reading.ticker)).toEqual(TICKERS.map((ticker) => ticker.ticker));
    expect(snapshot.readings[0]).toMatchObject({ answer: '22566018707', roundId: '100', updatedAt: 1_790_000_000 });
  });

  it('says unavailable, with no invented prices, when it has never read', async () => {
    const snapshot = await createPriceReader(async () => {
      throw new Error('rpc down');
    })();
    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.readings.every((reading) => reading.answer === null)).toBe(true);
  });

  it('keeps the last good value, with its age, when the RPC fails', async () => {
    let fail = false;
    const read: FeedReader = async (feeds) => {
      if (fail) throw new Error('rpc down');
      return feeds.map(() => round(10_000_000_000n));
    };
    let clock = 1_790_000_000_000;
    const readPrices = createPriceReader(read, () => clock);
    const good = await readPrices();
    fail = true;
    clock += 45_000;
    const degraded = await readPrices();
    expect(degraded.status).toBe('stale-cache');
    expect(degraded.readAt).toBe(good.readAt);
    expect(degraded.readings).toEqual(good.readings);
  });

  it('rejects answers outside the sanity band and keeps that feed last good value', async () => {
    let call = 0;
    const read: FeedReader = async (feeds) => {
      call += 1;
      return feeds.map((_, index) => (call === 2 && index === 1 ? round(10n ** 20n) : round(5_000_000_000n + BigInt(call))));
    };
    const readPrices = createPriceReader(read);
    await readPrices();
    const second = await readPrices();
    expect(second.status).toBe('live');
    expect(second.readings[0]?.answer).toBe('5000000002');
    expect(second.readings[1]?.answer).toBe('5000000001'); // the garbage answer was refused
  });
});

describe('deployment', () => {
  it('is "not deployed" unless a valid chain-4663 deployment is supplied', () => {
    expect(parseDeployment(undefined)).toBe(NOT_DEPLOYED);
    expect(parseDeployment('')).toBe(NOT_DEPLOYED);
    expect(parseDeployment('{not json')).toBe(NOT_DEPLOYED);
    expect(parseDeployment(JSON.stringify({ chainId: 1, status: 'deployed' }))).toBe(NOT_DEPLOYED);
    expect(NOT_DEPLOYED.contracts.HunchVPM.address).toBeNull();
    expect(NOT_DEPLOYED.params).toMatchObject({ kappa: 30, feeBps: 200, minEntry: '1000000', maxEntry: '100000000' });
  });

  it('reads a deployed file', () => {
    const parsed = parseDeployment(
      JSON.stringify({
        chainId: 4663,
        status: 'deployed',
        contracts: { HunchVPM: { address: '0x00000000000000000000000000000000000000a1', deployTx: '0xabc', block: 5 } },
        safe: '0x00000000000000000000000000000000000000b2',
      }),
    );
    expect(parsed.status).toBe('deployed');
    expect(parsed.contracts.HunchVPM).toEqual({ address: '0x00000000000000000000000000000000000000a1', deployTx: '0xabc', block: 5 });
    expect(parsed.contracts.StockRoundResolver.address).toBeNull();
    expect(parsed.safe).toBe('0x00000000000000000000000000000000000000b2');
  });
});

describe('venue and proof before deployment', () => {
  it('has no markets and no settled market, so the page shows the launching state and the labelled example', async () => {
    const venue = await readVenue();
    expect(venue.markets).toEqual([]);
    expect(venue.settled).toEqual({ weekly: null, daily: null });
  });

  it('shows every contract as not deployed and every counter as unread, never zero', async () => {
    const proof = await readProof();
    expect(proof.contracts.map((row) => row.name)).toEqual(['HunchVPM', 'StockRoundResolver', 'HunchMarketFactory', 'USDG']);
    expect(proof.contracts.slice(0, 3).every((row) => row.address === null)).toBe(true);
    expect(proof.feeds).toHaveLength(TICKERS.length);
    expect(proof.counters.every((counter) => counter.value === null)).toBe(true);
  });
});
