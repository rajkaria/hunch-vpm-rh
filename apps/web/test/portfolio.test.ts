import { describe, expect, it, vi } from 'vitest';

import { GET } from '@/app/api/positions/route';
import { createFixtureSource } from '@/lib/data/fixture-source';
import { ARC_TESTNET_ADDRESSES, UNDEPLOYED, type NetworkId } from '@/lib/chain';
import { createLiveSource, type LiveClient } from '@/lib/data/live';

const NOW = 1_789_000_000n;

describe('getPositions on the fixture source', () => {
  it('returns every position the sample wallet holds, across markets', async () => {
    const source = createFixtureSource({ now: NOW });
    const wallet = source.currentWallet()!;
    const entries = await source.getPositions(wallet);

    expect(entries.length).toBeGreaterThan(0);
    // A portfolio spans markets — that is the whole reason it exists separately
    // from the per-market panel.
    expect(new Set(entries.map((entry) => entry.market.id)).size).toBeGreaterThan(1);
  });

  it('is newest first', async () => {
    const source = createFixtureSource({ now: NOW });
    const entries = await source.getPositions(source.currentWallet()!);
    const times = entries.map((entry) => entry.position.enteredAt);
    expect([...times].sort((a, b) => Number(b - a))).toEqual(times);
  });

  it('gives another address nothing rather than the sample wallet’s positions', async () => {
    const source = createFixtureSource({ now: NOW });
    expect(await source.getPositions('0x000000000000000000000000000000000000dead')).toEqual([]);
  });

  it('pairs each position with a market that carries its outcome labels', async () => {
    const source = createFixtureSource({ now: NOW });
    const [first] = await source.getPositions(source.currentWallet()!);
    const labelled = first!.market.outcomes.find((o) => o.outcome === first!.position.outcome);
    expect(labelled?.label).toBeTruthy();
  });
});

describe('getPositions on the live source', () => {
  const WALLET = '0x6D2a4c1b9E0f3A8d5C7b2E1f4A9c8B3d6E5f0a42';
  const SETTLER = '0xc743940c75619f65f6178b7e49c0c3a0be012eec';
  const MARKET_A = `${SETTLER}-0`;
  const MARKET_B = `${SETTLER}-1`;

  const side = (outcome: number) => ({
    outcome,
    principal: 1_000000n,
    vested: 0n,
    capacity: 30_000000n,
    headroom: 30_000000n,
    probabilityPpm: 500_000n,
    maxFullyAccepted: 30_000000n,
    acc: 0n,
    live: null,
  });

  const book = (marketId: string) => ({
    marketId,
    settler: SETTLER,
    settlerKind: 'vested' as const,
    onChainMarketId: BigInt(marketId.split('-')[1]!),
    token: '0x3600000000000000000000000000000000000000',
    status: 'Open' as const,
    winner: null,
    kappa: 30n,
    acceptedPool: 2_000000n,
    paidOut: 0n,
    residue: 0n,
    residueOwner: WALLET,
    residueClaimed: false,
    resolutionTime: 1_800_000_000n,
    secondsToFreeze: 11_000_000n,
    frozen: false,
    voidTimeout: 86_400n,
    voidableFrom: 1_800_086_400n,
    books: [side(0), side(1)],
    spec: null,
    index: { block: 61_841_000n, hasIndexingErrors: false },
  });

  const held = (positionId: number, marketId: string, createdAt: bigint, vintage: bigint | null) => ({
    id: `${SETTLER}-${positionId}`,
    positionId: BigInt(positionId),
    owner: WALLET.toLowerCase(),
    outcome: 0,
    offered: 5_000000n,
    accepted: 4_000000n,
    refused: 1_000000n,
    entryAcc: 0n,
    vintage,
    finalized: true,
    refundWithdrawn: false,
    claimed: positionId === 1,
    createdAt,
    market: { id: marketId },
  });

  function fakeClient() {
    const marketBook = vi.fn(async (id: string) => book(id));
    const client = {
      marketBook,
      claimable: async () => {
        throw new Error('not read by getPositions');
      },
      // The client's own read returns newest first; the source must keep that order.
      positions: async (wallet: string) => ({
        wallet,
        positions: [
          held(3, MARKET_B, 1_789_000_300n, 61_840_990n),
          held(2, MARKET_A, 1_789_000_200n, 61_840_980n),
          held(1, MARKET_A, 1_789_000_100n, null),
        ],
        index: { block: 61_841_000n, hasIndexingErrors: false },
      }),
    } as unknown as LiveClient;
    return { client, marketBook };
  }

  const liveOn = (network: NetworkId, client: LiveClient, seen?: (config: Record<string, unknown>) => void) =>
    createLiveSource({
      subgraphUrl: 'https://example.invalid',
      marketIds: [],
      wallet: null,
      network,
      createClient: (config) => {
        seen?.(config);
        return client;
      },
    });

  it('lists every position the client returns, newest first, each with its own market', async () => {
    const entries = await liveOn('testnet', fakeClient().client).getPositions(WALLET);

    expect(entries.map((entry) => entry.position.positionId)).toEqual([3n, 2n, 1n]);
    expect(entries.map((entry) => entry.market.id)).toEqual([MARKET_B, MARKET_A, MARKET_A]);
    // Claimed positions are part of a portfolio: a settled win must not vanish from it.
    expect(entries.find((entry) => entry.position.positionId === 1n)?.position.claimed).toBe(true);
  });

  it('reads each market once, however many positions sit in it', async () => {
    const { client, marketBook } = fakeClient();
    await liveOn('testnet', client).getPositions(WALLET);

    expect(marketBook).toHaveBeenCalledTimes(2);
  });

  it('carries the entry time, and leaves a classic position without a vintage', async () => {
    const entries = await liveOn('testnet', fakeClient().client).getPositions(WALLET);
    const byId = (id: bigint) => entries.find((entry) => entry.position.positionId === id)!.position;

    expect(byId(2n).enteredAt).toBe(1_789_000_200n);
    expect(byId(2n).vintage).toBe(61_840_980n);
    // Not 0n: that is the seed vintage, and the position panel would badge it "Seed leg".
    expect(byId(1n).vintage).toBeNull();
  });

  it('tells the client which Arc its index is for', async () => {
    let chainId: number | undefined;
    await liveOn('mainnet', fakeClient().client, (config) => {
      chainId = (config['chain'] as { id: number }).id;
    }).getPositions(WALLET);

    expect(chainId).toBe(5042);
  });

  it('names the resolver of the network it reads, never testnet’s on mainnet', async () => {
    const [onTestnet] = await liveOn('testnet', fakeClient().client).getPositions(WALLET);
    const [onMainnet] = await liveOn('mainnet', fakeClient().client).getPositions(WALLET);

    expect((onTestnet!.market as { resolver?: string }).resolver).toBe(ARC_TESTNET_ADDRESSES.feedResolver);
    expect((onMainnet!.market as { resolver?: string }).resolver).toBe(UNDEPLOYED);
  });
});

describe('/api/positions', () => {
  const ok = (address: string) => GET(new Request(`http://x/api/positions?address=${address}`));

  it('refuses anything that is not an address', async () => {
    expect((await ok('nope')).status).toBe(400);
    expect((await GET(new Request('http://x/api/positions'))).status).toBe(400);
  });

  it('answers with every amount as a decimal string', async () => {
    const response = await ok('0x6D2a4c1b9E0f3A8d5C7b2E1f4A9c8B3d6E5f0a42');
    expect(response.status).toBe(200);
    const body = await response.json();
    for (const entry of body.entries) {
      expect(typeof entry.position.offered).toBe('string');
      expect(typeof entry.position.accepted).toBe('string');
      expect(typeof entry.position.refused).toBe('string');
    }
  });

  it('never lets one visitor cache another’s positions', async () => {
    const response = await ok('0x6D2a4c1b9E0f3A8d5C7b2E1f4A9c8B3d6E5f0a42');
    expect(response.headers.get('cache-control')).toMatch(/private/);
  });

  it('says which source answered, so the empty state can explain itself', async () => {
    const body = await (await ok('0x6D2a4c1b9E0f3A8d5C7b2E1f4A9c8B3d6E5f0a42')).json();
    expect(['fixture', 'live']).toContain(body.source);
  });
});
