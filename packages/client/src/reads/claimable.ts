import type { Address } from 'viem';
import { getAddress } from 'viem';
import type { ResolvedConfig } from '../config.js';
import type { RawMeta } from '../decode.js';
import { addressFilter, decodeMarket, decodeMeta, decodePosition } from '../decode.js';
import { walletPositionsQuery, walletResidueQuery } from '../queries.js';
import type { BlockedResidue, Claimable, ClaimableItem, ClaimBreakdown, Market, Position } from '../types.js';
import { maxBigInt } from '../units.js';
import { fetchUnclaimedWinners, paginate } from './shared.js';

interface WalletPositionsResponse {
  _meta?: RawMeta | null;
  positions?: unknown[] | null;
}

interface WalletResidueResponse {
  markets?: unknown[] | null;
}

function emptyBreakdown(): ClaimBreakdown {
  return { settlement: 0n, voidRefund: 0n, refusedRemainder: 0n, residue: 0n };
}

function sumBreakdown(breakdown: ClaimBreakdown): bigint {
  return breakdown.settlement + breakdown.voidRefund + breakdown.refusedRemainder + breakdown.residue;
}

/**
 * What one position is owed right now, and which call pays it.
 *
 * While the market is open the only thing available is the remainder the books
 * refused, and `claim` reverts — so the item names `withdrawRefund`. Once the
 * market has settled, `claim` pays the settlement and any outstanding
 * remainder together, so there is one item, not two.
 *
 * The settlement figure is the index's `previewPayout` rather than this
 * package's own vesting arithmetic, because the two settlers pay by different
 * formulas — `s*(S + A_o - A_o(tau))/S` under the vested rule, a flat pool
 * share under the classic one — and `previewPayout` is already whichever one
 * governs this market.
 */
function itemForPosition(position: Position): ClaimableItem | null {
  if (!position.finalized || position.claimed) return null;
  const market = position.market;
  const breakdown = emptyBreakdown();
  const outstandingRefund = position.refundWithdrawn ? 0n : maxBigInt(0n, position.refused);

  let call: ClaimableItem['call'];
  if (market.status === 'Open') {
    if (outstandingRefund === 0n) return null;
    breakdown.refusedRemainder = outstandingRefund;
    call = 'withdrawRefund';
  } else {
    breakdown.refusedRemainder = outstandingRefund;
    if (market.status === 'Voided') {
      // A void refunds accepted principal exactly; no vesting is paid.
      breakdown.voidRefund = position.accepted;
    } else if (market.winner === position.outcome) {
      breakdown.settlement = position.previewPayout;
    }
    call = 'claim';
  }

  const amount = sumBreakdown(breakdown);
  if (amount === 0n) return null;

  return {
    id: position.id,
    marketId: market.id,
    amount,
    breakdown,
    call,
    argument: position.positionId,
    settler: market.settler,
  };
}

/**
 * Residue is the flooring remainder the settler cannot assign to anyone: the
 * accepted pool less every settlement it pays out. The settler refuses to hand
 * it over until the last winning position has claimed, because its own
 * `acceptedPool - paidOut` still contains those unpaid settlements.
 *
 * The index does know what each of them will take (`previewPayout`), so the
 * residue itself is knowable before they claim: it is what is left after
 * subtracting them. That is reported as `amount`; the raw
 * `acceptedPool - paidOut` is reported separately as `atMostAmount`, because
 * the difference between the two is other people's money.
 */
async function residueFor(
  config: ResolvedConfig,
  market: Market,
): Promise<{ ready: boolean; amount: bigint; blocked: BlockedResidue | null }> {
  const atMost = maxBigInt(0n, market.acceptedPool - market.paidOut);
  if (market.status !== 'Resolved' || market.residueClaimed || market.winner === null || atMost === 0n) {
    return { ready: false, amount: 0n, blocked: null };
  }

  const winners = await fetchUnclaimedWinners(config, market.id, market.winner);
  if (winners.count === 0) {
    // Nothing outstanding, so what is left in the pool is the residue exactly.
    return { ready: true, amount: atMost, blocked: null };
  }

  const exact = maxBigInt(0n, atMost - winners.outstandingPayout);
  const plural = winners.count === 1 ? 'position has' : 'positions have';
  // A market whose winners take the pool to the unit has no residue to wait
  // for, so there is nothing to report as blocked.
  if (winners.complete && exact === 0n) return { ready: false, amount: 0n, blocked: null };
  return {
    ready: false,
    amount: 0n,
    blocked: winners.complete
      ? {
          marketId: market.id,
          amount: exact,
          atMostAmount: atMost,
          isUpperBound: false,
          reason:
            `${winners.count} winning ${plural} not claimed yet, and the settler will not release ` +
            `residue before they do. Their settlements are the rest of what is still in the pool.`,
        }
      : {
          marketId: market.id,
          amount: atMost,
          atMostAmount: atMost,
          isUpperBound: true,
          reason:
            `more than ${winners.count} winning positions have not claimed yet — too many to price ` +
            `in one walk, so this is the whole unpaid pool, not the residue alone.`,
        },
  };
}

/**
 * Everything a wallet can pull right now, across every market, with totals.
 *
 * Four things can be owed and they are not the same thing: a settlement on a
 * market that resolved your way, a refund on a market that voided, the part of
 * a stake the books refused for want of headroom, and residue if you are the
 * market's named residue owner. They are reported separately and summed, and
 * each item is one transaction.
 */
export async function claimable(config: ResolvedConfig, wallet: Address): Promise<Claimable> {
  const owner = getAddress(wallet);
  const filter = addressFilter(owner);

  let index = decodeMeta(null);
  const positions = await paginate(config.pageSize, async (first, skip) => {
    const data = await config.transport.request<WalletPositionsResponse>({
      url: config.subgraphUrl,
      query: walletPositionsQuery(),
      variables: { owner: filter, first, skip },
      operation: 'walletPositions',
    });
    if (skip === 0) index = decodeMeta(data._meta);
    return (data.positions ?? []).map(decodePosition);
  });

  const residueMarkets = await paginate(config.pageSize, async (first, skip) => {
    const data = await config.transport.request<WalletResidueResponse>({
      url: config.subgraphUrl,
      query: walletResidueQuery(),
      variables: { owner: filter, first, skip },
      operation: 'walletResidue',
    });
    return (data.markets ?? []).map(decodeMarket);
  });

  const items: ClaimableItem[] = [];
  const blockedResidue: BlockedResidue[] = [];

  for (const position of positions) {
    const item = itemForPosition(position);
    if (item !== null) items.push(item);
  }

  for (const market of residueMarkets) {
    const residue = await residueFor(config, market);
    if (residue.blocked !== null) blockedResidue.push(residue.blocked);
    if (!residue.ready || residue.amount === 0n) continue;
    const breakdown = emptyBreakdown();
    breakdown.residue = residue.amount;
    items.push({
      id: market.id,
      marketId: market.id,
      amount: residue.amount,
      breakdown,
      call: 'claimResidue',
      argument: market.marketId,
      settler: market.settler,
    });
  }

  items.sort((a, b) => (a.amount === b.amount ? a.id.localeCompare(b.id) : a.amount > b.amount ? -1 : 1));

  const totals = items.reduce(
    (total, item) => ({
      total: total.total + item.amount,
      settlement: total.settlement + item.breakdown.settlement,
      voidRefund: total.voidRefund + item.breakdown.voidRefund,
      refusedRemainder: total.refusedRemainder + item.breakdown.refusedRemainder,
      residue: total.residue + item.breakdown.residue,
    }),
    { total: 0n, ...emptyBreakdown() },
  );

  return { wallet: owner, totals, items, blockedResidue, index };
}
