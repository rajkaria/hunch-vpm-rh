import type { ResolvedConfig } from '../config.js';
import type { PositionHolding, RawMeta } from '../decode.js';
import { decodeMarket, decodeMeta, decodePosition, decodeUnclaimedWinner } from '../decode.js';
import { marketQuery, positionQuery, unclaimedWinnersQuery } from '../queries.js';
import type { IndexStatus, Market, Position } from '../types.js';

export class NotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(
      `${kind} ${id} is not in the subgraph. Either the id is wrong, or the index has not ` +
        `reached the block that created it.`,
    );
    this.name = 'NotFoundError';
  }
}

interface MarketResponse {
  _meta?: RawMeta | null;
  market?: unknown;
}

interface PositionResponse {
  _meta?: RawMeta | null;
  position?: unknown;
}

interface UnclaimedWinnersResponse {
  positions?: unknown[] | null;
}

export async function fetchMarket(
  config: ResolvedConfig,
  marketId: string,
): Promise<{ market: Market; index: IndexStatus }> {
  const data = await config.transport.request<MarketResponse>({
    url: config.subgraphUrl,
    query: marketQuery(config.readOpenVintage),
    variables: { id: marketId },
    operation: 'market',
  });
  if (data.market === null || data.market === undefined) throw new NotFoundError('market', marketId);
  return { market: decodeMarket(data.market), index: decodeMeta(data._meta) };
}

export async function fetchPosition(
  config: ResolvedConfig,
  positionId: string,
): Promise<{ position: Position; index: IndexStatus }> {
  const data = await config.transport.request<PositionResponse>({
    url: config.subgraphUrl,
    query: positionQuery(),
    variables: { id: positionId },
    operation: 'position',
  });
  if (data.position === null || data.position === undefined) throw new NotFoundError('position', positionId);
  return { position: decodePosition(data.position), index: decodeMeta(data._meta) };
}

/**
 * Walk a paginated collection with `first`/`skip`.
 *
 * Skip-based paging is what the hosted gateway allows up to 5000 entities, and
 * every collection this client walks (one market's holders, one wallet's open
 * positions) is far below that. The loop stops on a short page, so a
 * collection that grows mid-walk costs one extra request, not an infinite one.
 */
export async function paginate<T>(
  pageSize: number,
  fetchPage: (first: number, skip: number) => Promise<T[]>,
): Promise<T[]> {
  const all: T[] = [];
  for (let skip = 0; ; skip += pageSize) {
    const page = await fetchPage(pageSize, skip);
    all.push(...page);
    if (page.length < pageSize) return all;
  }
}

/**
 * The hosted gateway refuses `skip` past 5000, so a walk that would need to go
 * further has to stop and say it stopped.
 */
export const MAX_PAGED_ENTITIES = 5000;

/**
 * `paginate`, but bounded: it stops at `MAX_PAGED_ENTITIES` and reports
 * whether it saw the whole collection. Used where a partial answer is
 * dangerous rather than merely incomplete — counting the winners a residue is
 * waiting on, where missing one turns "not yet" into "go ahead".
 */
export async function paginateBounded<T>(
  pageSize: number,
  fetchPage: (first: number, skip: number) => Promise<T[]>,
): Promise<{ rows: T[]; complete: boolean }> {
  const rows: T[] = [];
  for (let skip = 0; skip < MAX_PAGED_ENTITIES; skip += pageSize) {
    const first = Math.min(pageSize, MAX_PAGED_ENTITIES - skip);
    const page = await fetchPage(first, skip);
    rows.push(...page);
    if (page.length < first) return { rows, complete: true };
  }
  return { rows, complete: false };
}

/**
 * The winning positions a resolved market still owes, and what they will take.
 *
 * This is the settler's residue gate (`m.books[winner].live != 0`) asked of
 * the index instead of the chain. The payouts come back with it because they
 * are what separates the residue from the money that is merely still in the
 * pool.
 */
export async function fetchUnclaimedWinners(
  config: ResolvedConfig,
  marketId: string,
  outcome: number,
): Promise<{ count: number; outstandingPayout: bigint; complete: boolean }> {
  const { rows, complete } = await paginateBounded(config.pageSize, async (first, skip) => {
    const data = await config.transport.request<UnclaimedWinnersResponse>({
      url: config.subgraphUrl,
      query: unclaimedWinnersQuery(),
      variables: { market: marketId, outcome, first, skip },
      operation: 'unclaimedWinners',
    });
    return (data.positions ?? []).map(decodeUnclaimedWinner);
  });

  return {
    count: rows.length,
    outstandingPayout: rows.reduce((total, winner) => total + winner.previewPayout, 0n),
    complete,
  };
}

/** Unix seconds, as a bigint. Overridable so a read can be evaluated at any instant. */
export function nowSeconds(now?: bigint): bigint {
  return now ?? BigInt(Math.floor(Date.now() / 1000));
}

/**
 * The block the client reasons about when deciding whether an open vintage
 * competes with a new entry. It is the index head, not the chain head: if the
 * index is behind, the client is conservative about demand rather than wrong
 * about it.
 */
export function headBlock(index: IndexStatus): bigint {
  return index.block;
}

export type { PositionHolding };
