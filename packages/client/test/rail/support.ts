import type { ArcRail, ArcRailConfig } from '../../src/rail/createArcRail.js';
import { createArcRail } from '../../src/rail/createArcRail.js';
import type { FixtureTransport, Responder } from '../support/transport.js';
import { fixtureTransport } from '../support/transport.js';

export const SETTLER = '0x1111111111111111111111111111111111111111';
/** A market on the classic settler, which runs the other settlement rule. */
export const SETTLER_CLASSIC = '0x2222222222222222222222222222222222222222';
export const FACTORY = '0x9999999999999999999999999999999999999999';
export const USDC = '0x3600000000000000000000000000000000000000';
export const ALICE = '0x4444444444444444444444444444444444444444';

export const MARKET_HEADROOM = `${SETTLER}-7`;
export const MARKET_FULL = `${SETTLER}-8`;
export const MARKET_VOIDED = `${SETTLER}-9`;
export const MARKET_UNBOUNDED = `${SETTLER}-10`;

/** 1000 seconds before the freeze on every open fixture. */
export const NOW = 1_999_999_000n;

/**
 * A rail wired to recorded responses, with the clock pinned.
 *
 * `.invalid` is a reserved TLD, so a read that escaped the fixture transport
 * would fail to resolve rather than reach anything.
 */
export function testRail(
  responses: Record<string, unknown>,
  config: ArcRailConfig = {},
): { rail: ArcRail; transport: FixtureTransport } {
  const transport = fixtureTransport(responses);
  const rail = createArcRail({
    subgraphUrl: 'https://subgraph.invalid/hunch-vpm',
    transport,
    sides: { yes: 0, no: 1 },
    now: () => NOW,
    ...config,
  });
  return { rail, transport };
}

/** Serve one recorded collection through `first`/`skip`, with `_meta` on the first page. */
export function pagedWithMeta(field: string, rows: readonly unknown[], meta: unknown): Responder {
  return (variables) => {
    const first = Number(variables['first'] ?? rows.length);
    const skip = Number(variables['skip'] ?? 0);
    return { _meta: meta, [field]: rows.slice(skip, skip + first) };
  };
}

/** Every key in an object tree, at any depth, with the path that reaches it. */
export function everyKey(value: unknown, path: string[] = []): { path: string; value: unknown }[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => everyKey(entry, [...path, String(index)]));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => [
      { path: [...path, key].join('.'), value: entry },
      ...everyKey(entry, [...path, key]),
    ]);
  }
  return [];
}
