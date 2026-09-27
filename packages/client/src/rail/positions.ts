import type { Address } from 'viem';
import { getAddress } from 'viem';
import type { HunchClient } from '../client.js';
import type { RawMeta } from '../decode.js';
import { addressFilter, decodeMeta, decodePosition } from '../decode.js';
import { earnedVesting } from '../mechanics.js';
import { walletPositionsQuery } from '../queries.js';
import { paginate } from '../reads/shared.js';
import type { IndexStatus, MarketStatus, Position, PositionState, SettlerKind } from '../types.js';
import { maxBigInt } from '../units.js';
import type { UnsignedCall } from '../writes/calldata.js';
import { ARC_RAIL } from './capabilities.js';
import type { SideMap } from './sides.js';
import type { RailPosition, RailPositions } from './types.js';

/**
 * What the wallet has to send to collect what it is owed.
 *
 * Nothing is pushed on this rail. A resolved market does not credit an account
 * somewhere; the money sits in the settler's escrow until the owner sends one
 * of these two calls. Like every write in this package it is unsigned.
 */
export interface PositionClaim {
  readonly call: 'claim' | 'withdrawRefund';
  /** What this one call pays. */
  readonly amount: bigint;
  /** Always `false`. */
  readonly signed: false;
  readonly unsigned: UnsignedCall;
  readonly note: string;
}

export interface ArcPosition extends RailPosition {
  /** The settler's own position index, which is what `claim` takes. */
  readonly positionId: bigint;
  readonly settler: Address;
  readonly settlerKind: SettlerKind;
  readonly marketStatus: MarketStatus;
  readonly winner: number | null;
  /** Whether the entry's vintage has been finalized, which is what fixes `accepted`. */
  readonly finalized: boolean;
  /** The block whose vintage this entry joined. `null` on a classic market. */
  readonly vintage: bigint | null;
  /** Whether the refused part has already been pulled back. */
  readonly refundWithdrawn: boolean;
  /** Stake that has vested to this position since it entered. `null` before it is fixed. */
  readonly earned: bigint | null;
  readonly entryAcc: bigint;
  readonly currentAcc: bigint;
  /** The call that collects, or `null` when there is nothing to collect yet. */
  readonly claim: PositionClaim | null;
}

export interface ArcPositions extends RailPositions {
  readonly rail: 'arc';
  readonly positions: readonly ArcPosition[];
  readonly index: IndexStatus;
}

/**
 * The position's state, by the same rules as the client's own `vestingEarned`
 * read (`src/reads/vestingEarned.ts`), which is the definition of record. It is
 * restated here because this verb prices a whole wallet from one paged query
 * rather than one position per round trip, and the tests assert the two agree.
 */
function stateOf(position: Position): PositionState {
  if (position.claimed) return 'claimed';
  if (!position.finalized) return 'pending-vintage';
  const market = position.market;
  if (market.status === 'Voided') return 'voided';
  if (market.status === 'Resolved') return market.winner === position.outcome ? 'won' : 'lost';
  return 'open';
}

function priceOne(position: Position, sides: SideMap, client: HunchClient): ArcPosition {
  const market = position.market;
  const book = market.books.find((candidate) => candidate.outcome === position.outcome);
  const currentAcc = book?.acc ?? 0n;
  const state = stateOf(position);
  const vests = market.settlerKind === 'vested';

  const earned = position.finalized && vests ? earnedVesting(position.accepted, position.entryAcc, currentAcc) : null;
  const payoutIfOutcomeWins = !position.finalized
    ? null
    : vests
      ? position.accepted + (earned ?? 0n)
      : position.previewPayout;
  // `refused` is meaningless until the vintage is finalized, so it is not
  // reported before then rather than reported as zero.
  const refused = position.finalized ? position.refused : 0n;
  const outstandingRefund = position.refundWithdrawn ? 0n : maxBigInt(0n, refused);

  let claimableNow = 0n;
  if (!position.claimed) {
    if (state === 'won' && payoutIfOutcomeWins !== null) claimableNow += payoutIfOutcomeWins;
    // A void refunds accepted principal exactly. No vesting is paid.
    if (state === 'voided') claimableNow += position.accepted;
  }
  if (position.finalized) claimableNow += outstandingRefund;

  return {
    id: position.id,
    marketId: market.id,
    outcome: position.outcome,
    label: sides.label(position.outcome),
    state,
    staked: position.offered,
    accepted: position.accepted,
    refused,
    payoutIfOutcomeWins,
    claimableNow,
    positionId: position.positionId,
    settler: market.settler,
    settlerKind: market.settlerKind,
    marketStatus: market.status,
    winner: market.winner,
    finalized: position.finalized,
    vintage: position.vintage,
    refundWithdrawn: position.refundWithdrawn,
    earned,
    entryAcc: position.entryAcc,
    currentAcc,
    claim: claimFor(position, state, claimableNow, outstandingRefund, client),
  };
}

/**
 * Which call collects, and what it pays.
 *
 * There is exactly one call per position, never two: on a settled market
 * `claim` pays the settlement AND any refused remainder that has not been
 * pulled, and sending it twice reverts. While the market is still open the only
 * thing available is that remainder, and `claim` would revert.
 */
function claimFor(
  position: Position,
  state: PositionState,
  claimableNow: bigint,
  outstandingRefund: bigint,
  client: HunchClient,
): PositionClaim | null {
  if (position.claimed || !position.finalized || claimableNow === 0n) return null;
  const settler = position.market.settler;

  if (position.market.status === 'Open') {
    if (outstandingRefund === 0n) return null;
    return {
      call: 'withdrawRefund',
      amount: outstandingRefund,
      signed: false,
      unsigned: client.withdrawRefundCalldata({ positionId: position.positionId, settler }),
      note:
        'The books refused this much for want of headroom. It can be pulled back now, without waiting ' +
        'for the market to settle. Sign and send this from the wallet that owns the position.',
    };
  }

  return {
    call: 'claim',
    amount: claimableNow,
    signed: false,
    unsigned: client.claimCalldata({ positionId: position.positionId, settler }),
    note:
      state === 'voided'
        ? 'This market voided. One call returns the accepted principal and any refused remainder. Sign ' +
          'and send it from the wallet that owns the position.'
        : 'One call pays the settlement and any refused remainder together. Sign and send it from the ' +
          'wallet that owns the position.',
  };
}

interface WalletPositionsResponse {
  _meta?: RawMeta | null;
  positions?: unknown[] | null;
}

/**
 * What a wallet holds, through the index.
 *
 * Every position the wallet has not yet claimed, priced under whichever rule
 * its market runs, with the unsigned call that would collect it. Positions that
 * have already been claimed are not holdings and are not listed — the index
 * query filters them out.
 */
export async function arcPositions(
  client: HunchClient,
  sides: SideMap,
  wallet: Address,
  at: bigint,
): Promise<ArcPositions> {
  const config = client.config;
  const owner = getAddress(wallet);
  const filter = addressFilter(owner);

  let index: IndexStatus = decodeMeta(null);
  const rows = await paginate(config.pageSize, async (first, skip) => {
    const data = await config.transport.request<WalletPositionsResponse>({
      url: config.subgraphUrl,
      query: walletPositionsQuery(),
      variables: { owner: filter, first, skip },
      operation: 'walletPositions',
    });
    if (skip === 0) index = decodeMeta(data._meta);
    return (data.positions ?? []).map(decodePosition);
  });

  const positions = rows.map((position) => priceOne(position, sides, client));
  const totals = positions.reduce(
    (total, position) => ({
      staked: total.staked + position.staked,
      accepted: total.accepted + position.accepted,
      refused: total.refused + position.refused,
      claimableNow: total.claimableNow + position.claimableNow,
    }),
    { staked: 0n, accepted: 0n, refused: 0n, claimableNow: 0n },
  );

  return { rail: ARC_RAIL, wallet: owner, positions, totals, index, asOf: at };
}
