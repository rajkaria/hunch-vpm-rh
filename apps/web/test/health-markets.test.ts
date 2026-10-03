// @vitest-environment node
/**
 * `/api/health` used to check the RPC head and the keeper, so it stayed green while `/m/0` told
 * every visitor "Price unavailable, retrying. Last read 9 h ago". `market-reads` and `market-logs`
 * check what the pages show.
 */
import { MARKET_STATUS, type MarketView, type VenueSnapshot } from '@hunch-rh/client';
import { describe, expect, it, vi } from 'vitest';

import { ReadUnavailableError, type Snapshot } from '@/lib/server/cache';
import { marketHealthChecks, type MarketHealthSources } from '@/lib/server/health';
import type { ActivityData } from '@/lib/server/logs';
import type { MarketBundle } from '@/lib/server/market';

import { marketFixture } from './fixtures/market';

const NOW = 1_791_042_468;

function view(id: bigint, open = true): MarketView {
  const m = marketFixture(open ? {} : { outcome: 'UP' });
  return { ...m, id, statusCode: open ? MARKET_STATUS.Open : m.statusCode };
}

function venue(markets: MarketView[], over: Partial<Snapshot<VenueSnapshot>> = {}): Snapshot<VenueSnapshot> {
  const data = { deployed: true, markets } as unknown as VenueSnapshot;
  return { data, readAt: NOW - 3, stale: false, error: null, ...over };
}

function bundle(over: Partial<MarketBundle> = {}): MarketBundle {
  return { data: marketFixture(), readAt: NOW - 2, stale: false, error: null, activity: null, log: null, ...over };
}

const activity = (over: Partial<Snapshot<ActivityData>> = {}): Snapshot<ActivityData> => ({
  data: { entries: { '0': { txHash: `0x${'aa'.repeat(32)}`, blockNumber: 1n, timestamp: NOW - 100 } }, claims: {}, resolved: null, voided: null },
  readAt: NOW - 5,
  stale: false,
  error: null,
  ...over,
});

function sources(over: Partial<MarketHealthSources> = {}): MarketHealthSources {
  return {
    venue: async () => venue([view(0n), view(1n)]),
    market: async () => bundle(),
    activity: async () => activity(),
    nowSec: () => NOW,
    ...over,
  };
}

const byName = (checks: { name: string; ok: boolean; detail: string }[]) => Object.fromEntries(checks.map((c) => [c.name, c]));

describe('/api/health market checks', () => {
  it('green when every open market and the newest market logs read current', async () => {
    const market = vi.fn(async (_id: bigint) => bundle());
    const checks = byName(await marketHealthChecks(sources({ market })));
    expect(checks['market-reads']).toMatchObject({ ok: true, detail: '2 open markets read current (oldest 2s)' });
    expect(checks['market-logs']).toMatchObject({ ok: true, detail: '/m/1 entry times and links read (1 entry)' });
    expect(market.mock.calls.map(([id]) => id)).toEqual([0n, 1n]);
  });

  it('fails market-reads when a market page would say "Price unavailable" (the /m/0 bug)', async () => {
    const checks = byName(
      await marketHealthChecks(
        sources({ market: async (id) => (id === 0n ? bundle({ readAt: NOW - 9 * 3600, stale: true, error: 'fetch failed' }) : bundle()) }),
      ),
    );
    expect(checks['market-reads']!.ok).toBe(false);
    expect(checks['market-reads']!.detail).toBe('/m/0: read failing, last good read 9h ago (fetch failed)');
  });

  it('fails market-reads on an old read even when it is not flagged stale', async () => {
    const checks = byName(await marketHealthChecks(sources({ market: async () => bundle({ readAt: NOW - 600 }) })));
    expect(checks['market-reads']!.ok).toBe(false);
    expect(checks['market-reads']!.detail).toContain('/m/0: last read 10m ago');
  });

  it('fails market-reads when the market list itself is failing, or was never read', async () => {
    const failing = byName(await marketHealthChecks(sources({ venue: async () => venue([view(0n)], { stale: true, readAt: NOW - 7200, error: 'timeout' }) })));
    expect(failing['market-reads']).toMatchObject({ ok: false });
    expect(failing['market-reads']!.detail).toContain('market list: read failing, last good read 2h ago (timeout)');
    const never = byName(await marketHealthChecks(sources({ venue: async () => Promise.reject(new ReadUnavailableError('venue', 'rpc down')) })));
    expect(never['market-reads']).toMatchObject({ ok: false });
    expect(never['market-reads']!.detail).toContain('the market list cannot be read');
  });

  it('fails market-reads when a market was never readable', async () => {
    const checks = byName(await marketHealthChecks(sources({ market: async () => Promise.reject(new ReadUnavailableError('market:0', 'rpc down')) })));
    expect(checks['market-reads']!.ok).toBe(false);
    expect(checks['market-reads']!.detail).toContain('/m/0: never read');
  });

  it('with no open market it still reads the newest one, so the check is never vacuous', async () => {
    const market = vi.fn(async (_id: bigint) => bundle());
    const checks = byName(await marketHealthChecks(sources({ venue: async () => venue([view(0n, false), view(3n, false)]), market })));
    expect(checks['market-reads']).toMatchObject({ ok: true, detail: 'newest market (/m/3) read current (oldest 2s)' });
    expect(market).toHaveBeenCalledWith(3n);
  });

  it('fails market-logs when entry times and links cannot be read', async () => {
    const failing = byName(await marketHealthChecks(sources({ activity: async () => activity({ stale: true, error: 'eth_getLogs: more than 64 requests' }) })));
    expect(failing['market-logs']).toMatchObject({ ok: false, detail: '/m/1 entry times and links: logs read failing (eth_getLogs: more than 64 requests)' });
    const never = byName(await marketHealthChecks(sources({ activity: async () => Promise.reject(new Error('HTTP 413')) })));
    expect(never['market-logs']).toMatchObject({ ok: false });
    expect(never['market-logs']!.detail).toContain('logs never readable (HTTP 413)');
  });

  it('passes the market-logs scan the market’s opening time, so it starts where the market began', async () => {
    const seen = vi.fn(async (_id: bigint, _settled: boolean, _openedAt: number) => activity());
    await marketHealthChecks(sources({ activity: seen }));
    const newest = view(1n);
    expect(seen).toHaveBeenCalledWith(1n, false, newest.openedAt);
  });

  it('green with nothing listed yet', async () => {
    const checks = byName(await marketHealthChecks(sources({ venue: async () => venue([]) })));
    expect(checks['market-reads']).toMatchObject({ ok: true, detail: 'no market listed yet' });
    expect(checks['market-logs']).toMatchObject({ ok: true, detail: 'no market listed yet' });
  });
});
