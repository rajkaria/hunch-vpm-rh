import type { Address } from 'viem';
import { getAddress } from 'viem';
import type { ResolvedConfig } from '../config.js';
import type { RawMeta, RawRecord } from '../decode.js';
import { addressFilter, bigIntFrom, decodeMeta, decodePosition } from '../decode.js';
import { ownerPositionsQuery } from '../queries.js';
import type { IndexStatus, OwnedPosition, WalletPositions } from '../types.js';
import { paginate } from './shared.js';

interface OwnerPositionsResponse {
  _meta?: RawMeta | null;
  positions?: unknown[] | null;
}

export function decodeOwnedPosition(raw: unknown): OwnedPosition {
  const position = decodePosition(raw);
  return { ...position, createdAt: bigIntFrom((raw as RawRecord)['createdAt'], 'position.createdAt') };
}

/** Newest entry first; two entries in the same block fall back to the settler's own order. */
function newestFirst(a: OwnedPosition, b: OwnedPosition): number {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  if (a.positionId !== b.positionId) return a.positionId > b.positionId ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Every position a wallet holds or has held, across every market, newest first.
 *
 * This is the portfolio question, and it is deliberately wider than `claimable`:
 * a wallet with three live positions and nothing settled has nothing to claim,
 * and an empty answer there reads as money gone. So nothing is filtered out here
 * — open, unfinalized, settled and already-claimed positions are all listed,
 * each with the market it sits in.
 *
 * The collection is paged by `id`, which is stable under `skip`; ordering by
 * `createdAt` on the server would let two entries from one block trade places
 * between pages. The order a reader wants is applied once everything is in.
 */
export async function ownerPositions(config: ResolvedConfig, wallet: Address): Promise<WalletPositions> {
  const owner = getAddress(wallet);

  let index: IndexStatus = decodeMeta(null);
  const rows = await paginate(config.pageSize, async (first, skip) => {
    const data = await config.transport.request<OwnerPositionsResponse>({
      url: config.subgraphUrl,
      query: ownerPositionsQuery(),
      variables: { owner: addressFilter(owner), first, skip },
      operation: 'ownerPositions',
    });
    if (skip === 0) index = decodeMeta(data._meta);
    return (data.positions ?? []).map(decodeOwnedPosition);
  });

  return { wallet: owner, positions: rows.sort(newestFirst), index };
}
