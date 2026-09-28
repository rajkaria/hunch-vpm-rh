/**
 * `/proof` and `/api/proof`: every number from a chain read, each linked to the call it came from.
 *
 * Counters come from `@hunch-rh/client`'s `readProof` (views only: listings → positions →
 * settlement math; Hunch's own wallets excluded from bettors and counted separately). Settled
 * markets name the two rounds that decided them (from the resolver's `Resolved` log, else the
 * round finder, which proves the same unique pair). The refund drill, fee sweeps and transaction
 * links come from logs and degrade to "not read" rather than to a number.
 */

import {
  MARKET_STATUS,
  cachedRoundReader,
  findResolutionRounds,
  readAllPositions,
  readListings,
  readProof,
  roundReaderFromClient,
  settlementOf,
  type Deployment,
  type MarketView,
  type ProofSnapshot,
} from '@hunch-rh/client';

import { tickerInfo } from '@/content/tickers';
import { toJsonSafe, type JsonValue } from '@/lib/codec';
import { addressOrNull, readDeployment } from '@/lib/deployment';
import { feedRoundUrl, txLink } from '@/lib/view/early-vs-late';
import type { ContractRow, FeeSweepRow, ProofCounter, ProofData, RefundDrillData, RefundRow, RoundRef, SettledMarketRow } from '@/lib/view/types';

import { TAG, cachedRead } from './cache';
import { serverClient } from './client';
import { readFeeSweeps, type FeeSweepLog, type ResolutionLog } from './logs';
import { getMarketBundle, getResolutionLogs } from './market';

export const PROOF_REVALIDATE = 60;

const readTab = (explorer: string, address: string): string => `${explorer.replace(/\/$/, '')}/address/${address}?tab=read_contract`;

async function verified(explorer: string, address: string | null): Promise<boolean | null> {
  if (address === null) return null;
  try {
    const response = await fetch(`${explorer.replace(/\/$/, '')}/api/v2/smart-contracts/${address}`, { next: { revalidate: 3600 } });
    if (!response.ok) return null;
    const body = (await response.json()) as { is_verified?: boolean; is_fully_verified?: boolean };
    return body.is_verified === true || body.is_fully_verified === true;
  } catch {
    return null;
  }
}

export async function contractRows(deployment: Deployment, check = false): Promise<ContractRow[]> {
  const { HunchVPM, StockRoundResolver, HunchMarketFactory } = deployment.contracts;
  const rows = [
    {
      name: 'HunchVPM',
      role: 'Holds every stake and pays every winner. Nobody can move a stake or set a price.',
      address: addressOrNull(HunchVPM.address),
      deployTx: HunchVPM.deployTx,
    },
    {
      name: 'StockRoundResolver',
      role: 'Settles each market from two proven Chainlink rounds. It has no owner.',
      address: addressOrNull(StockRoundResolver.address),
      deployTx: StockRoundResolver.deployTx,
    },
    {
      name: 'HunchMarketFactory',
      role: 'Lists a market in one transaction, with the opening seed paid by the lister.',
      address: addressOrNull(HunchMarketFactory.address),
      deployTx: HunchMarketFactory.deployTx,
    },
    {
      name: 'USDG',
      role: 'Paxos Global Dollar, the only stake and payout asset.',
      address: deployment.usdg,
      deployTx: null,
    },
  ];
  const checks = check ? await Promise.all(rows.map((row) => verified(deployment.explorer, row.name === 'USDG' ? null : row.address))) : rows.map(() => null);
  return rows.map((row, i) => ({ ...row, verified: checks[i] ?? null }));
}

/** Synchronous rows (no Blockscout check), for pages that only list addresses. */
export function contractRowsSync(deployment: Deployment): ContractRow[] {
  const { HunchVPM, StockRoundResolver, HunchMarketFactory } = deployment.contracts;
  return [
    { name: 'HunchVPM', role: 'Holds every stake and pays every winner. Nobody can move a stake or set a price.', address: addressOrNull(HunchVPM.address), deployTx: HunchVPM.deployTx, verified: null },
    { name: 'StockRoundResolver', role: 'Settles each market from two proven Chainlink rounds. It has no owner.', address: addressOrNull(StockRoundResolver.address), deployTx: StockRoundResolver.deployTx, verified: null },
    { name: 'HunchMarketFactory', role: 'Lists a market in one transaction, with the opening seed paid by the lister.', address: addressOrNull(HunchMarketFactory.address), deployTx: HunchMarketFactory.deployTx, verified: null },
    { name: 'USDG', role: 'Paxos Global Dollar, the only stake and payout asset.', address: deployment.usdg, deployTx: null, verified: null },
  ];
}

export function feedRows(deployment: Deployment): ContractRow[] {
  return deployment.feeds.map((feed) => {
    const info = tickerInfo(feed.ticker);
    return {
      name: `${feed.ticker} / USD`,
      role: `Chainlink price of the ${info?.name ?? feed.ticker} Stock Token, 8 decimals, 0.5% deviation or 24 h heartbeat.${
        feed.pendingFlatRateCheck === true ? ' Listed only once its flat-rate check passes.' : ''
      }`,
      address: feed.feed,
      deployTx: null,
      verified: null,
    };
  });
}

function counters(deployment: Deployment, s: ProofSnapshot | null): ProofCounter[] {
  const factory = addressOrNull(deployment.contracts.HunchMarketFactory.address);
  const settler = addressOrNull(deployment.contracts.HunchVPM.address);
  const factoryUrl = factory === null ? null : readTab(deployment.explorer, factory);
  const settlerUrl = settler === null ? null : readTab(deployment.explorer, settler);
  const value = <T,>(pick: (snapshot: ProofSnapshot) => T): T | null => (s === null ? null : pick(s));
  return [
    { label: 'Markets opened', value: value((x) => BigInt(x.counts.marketsOpened)), unit: 'count', sourceUrl: factoryUrl, sourceLabel: 'factory.listingCount()' },
    {
      label: 'Markets settled',
      value: value((x) => BigInt(x.counts.marketsResolved)),
      unit: 'count',
      sourceUrl: settlerUrl,
      sourceLabel: 'getMarket(id).status for every listing',
      note: 'Resolved UP or DOWN.',
    },
    {
      label: 'Markets refunded',
      value: value((x) => BigInt(x.counts.marketsVoided)),
      unit: 'count',
      sourceUrl: settlerUrl,
      sourceLabel: 'getMarket(id).status for every listing',
      note: 'Flat, stale or paused prices, and the refund drill.',
    },
    {
      label: 'Distinct bettors',
      value: value((x) => BigInt(x.bettors.distinct)),
      unit: 'count',
      sourceUrl: settlerUrl,
      sourceLabel: 'positions(id).owner for every marketPositions(id)',
      note: "Excludes Hunch's own wallets (the lister, the keeper and the Safe).",
    },
    {
      label: "Hunch's own bets",
      value: value((x) => BigInt(x.bettors.operatorBets)),
      unit: 'count',
      sourceUrl: settlerUrl,
      sourceLabel: 'positions(id) owned by the lister, keeper or Safe',
      note: 'Shown separately and never counted as bettors. Opening seeds are not bets.',
    },
    { label: 'USDG staked by bettors', value: value((x) => x.usdg.staked), unit: 'USDG', sourceUrl: settlerUrl, sourceLabel: 'sum of positions(id).offered' },
    {
      label: 'USDG paid to bettors',
      value: value((x) => x.usdg.paidToBettors),
      unit: 'USDG',
      sourceUrl: settlerUrl,
      sourceLabel: 'claimed positions, settlement math',
      note: 'Winnings and refunded stakes after the fee.',
    },
    { label: 'Fees swept to the treasury', value: value((x) => x.usdg.feesSwept), unit: 'USDG', sourceUrl: settlerUrl, sourceLabel: 'fees taken minus feesAccrued(USDG)' },
  ];
}

function roundRef(explorer: string, feed: string, roundId: bigint | null, answer: bigint | null, at: number | null): RoundRef | null {
  if (roundId === null || answer === null || at === null) return null;
  return { answer, roundId: roundId.toString(), at, url: feedRoundUrl(explorer, feed) };
}

/** The two rounds of a settled market: from the resolver's log, else the finder (cached for a day: they never change). */
async function roundsOf(deployment: Deployment, m: MarketView, log: ResolutionLog | undefined): Promise<{ strike: RoundRef | null; final: RoundRef | null }> {
  if (log !== undefined && log.kind === 'resolved') {
    return {
      strike: roundRef(deployment.explorer, m.feed, log.strikeRound, log.strikeAnswer, log.strikeAt),
      final: roundRef(deployment.explorer, m.feed, log.finalRound, log.finalAnswer, log.finalAt),
    };
  }
  if (!m.settledByResolver && m.statusCode === MARKET_STATUS.Voided) return { strike: null, final: null };
  try {
    const rounds = await cachedRead({
      key: ['rounds', m.specId],
      tags: [TAG.proof],
      revalidate: 86_400,
      read: () =>
        findResolutionRounds(cachedRoundReader(roundReaderFromClient(serverClient())), {
          feed: m.feed,
          strikeTime: m.strikeTime,
          finalTime: m.finalTime,
          maxStrikeAge: m.maxStrikeAge,
          maxFinalAge: m.maxFinalAge,
        }),
    });
    const r = rounds.data;
    if (!r.ok) return { strike: null, final: null };
    return {
      strike: roundRef(deployment.explorer, m.feed, r.strike.round.roundId, r.strike.round.answer, Number(r.strike.round.updatedAt)),
      final: roundRef(deployment.explorer, m.feed, r.final.round.roundId, r.final.round.answer, Number(r.final.round.updatedAt)),
    };
  } catch {
    return { strike: null, final: null };
  }
}

interface MarketTotals {
  bets: number;
  paid: bigint;
}

async function perMarketTotals(deployment: Deployment, views: readonly MarketView[]): Promise<Map<string, MarketTotals>> {
  const client = serverClient();
  const listings = await readListings(client, deployment);
  const positions = await readAllPositions(client, deployment, listings);
  const byId = new Map(views.map((m) => [m.id.toString(), m]));
  const out = new Map<string, MarketTotals>();
  for (const { position: p, listing } of positions) {
    const key = listing.marketId.toString();
    const m = byId.get(key);
    const totals = out.get(key) ?? { bets: 0, paid: 0n };
    if (p.vintage !== 0n) totals.bets += 1;
    if (m !== undefined && p.claimed) {
      const winnerBook = m.statusCode === MARKET_STATUS.Resolved && m.winner !== null ? m.books[m.winner] : null;
      totals.paid += settlementOf({ ...p, claimed: false, refunded: true }, { status: m.statusCode, winner: m.winner ?? 0 }, winnerBook, m.feeBps).net;
    }
    if (p.refunded && p.vintage !== 0n) totals.paid += p.offered - p.accepted;
    out.set(key, totals);
  }
  return out;
}

async function refundDrill(deployment: Deployment, markets: readonly MarketView[], logs: ResolutionLog[] | null): Promise<RefundDrillData | null> {
  const drill = markets.filter((m) => m.family === 'drill').sort((a, b) => b.finalTime - a.finalTime)[0];
  if (drill === undefined) return null;
  const bundle = await getMarketBundle(drill.id).catch(() => null);
  const detail = bundle?.data ?? null;
  const log = logs?.filter((entry) => entry.marketId === drill.id).at(-1);
  const voided = drill.statusCode === MARKET_STATUS.Voided;
  const reason: RefundDrillData['reason'] = !voided
    ? null
    : !drill.settledByResolver
      ? 'timeout'
      : log?.kind === 'voided-paused'
        ? 'paused'
        : log?.kind === 'voided-bad-answer'
          ? 'bad-answer'
          : log?.kind === 'resolved'
          ? 'flat'
          : 'stale';
  const refunds: RefundRow[] = [];
  if (detail !== null && bundle?.activity != null) {
    for (const p of detail.positions) {
      for (const claim of bundle.activity.claims[p.id.toString()] ?? []) {
        const amount = claim.payout + claim.refund;
        if (amount === 0n) continue;
        const txUrl = txLink(deployment.explorer, claim.txHash);
        if (txUrl === null) continue;
        refunds.push({ owner: p.owner, amount, txUrl, ...(p.isSeed ? { label: 'Hunch opening seed' } : p.isOpener ? { label: 'Hunch operator' } : {}) });
      }
    }
  }
  const rounds = voided ? await roundsOf(deployment, drill, undefined) : { strike: null, final: null };
  const voidTx = log?.txHash ?? bundle?.activity?.voided?.txHash ?? null;
  return {
    id: drill.id.toString(),
    href: `/m/${drill.id.toString()}`,
    question: drill.question,
    status: voided ? 'refunded' : 'listed',
    finalTime: drill.finalTime,
    reason,
    voidTxUrl: txLink(deployment.explorer, voidTx),
    strike: rounds.strike,
    final: rounds.final,
    refunds,
  };
}

export interface ProofExtras {
  snapshot: ProofSnapshot | null;
  readAt: number | null;
  stale: boolean;
  /** Which log-based sections could not be read. */
  missing: string[];
}

async function readAll(deployment: Deployment): Promise<{ view: ProofData; extras: Omit<ProofExtras, 'readAt' | 'stale'> }> {
  const client = serverClient();
  const snapshot = await readProof(client, deployment);
  const missing: string[] = [];
  const [logs, sweeps, totals, contracts] = await Promise.all([
    getResolutionLogs(),
    readFeeSweeps(client, deployment).catch((): FeeSweepLog[] | null => null),
    perMarketTotals(deployment, snapshot.markets).catch((): Map<string, MarketTotals> => new Map()),
    contractRows(deployment, true),
  ]);
  if (logs === null) missing.push('settlement transactions');
  if (sweeps === null) missing.push('fee sweeps');

  const settledMarkets = snapshot.markets
    .filter((m) => m.statusCode !== MARKET_STATUS.Open && m.family !== 'drill')
    .sort((a, b) => b.finalTime - a.finalTime)
    .slice(0, 50);
  const settled: SettledMarketRow[] = await Promise.all(
    settledMarkets.map(async (m) => {
      const log = logs?.filter((entry) => entry.marketId === m.id).at(-1);
      const rounds = await roundsOf(deployment, m, log);
      const outcome: SettledMarketRow['outcome'] =
        m.statusCode === MARKET_STATUS.Resolved ? (m.winner === 0 ? 'UP' : 'DOWN') : log?.kind === 'resolved' && log.outcome === 'FLAT' ? 'FLAT' : 'VOID';
      const t = totals.get(m.id.toString());
      return {
        id: m.id.toString(),
        href: `/m/${m.id.toString()}`,
        question: m.question,
        outcome,
        strike: rounds.strike,
        final: rounds.final,
        resolveTxUrl: txLink(deployment.explorer, log?.txHash),
        positions: t?.bets ?? 0,
        totalPaid: t?.paid ?? 0n,
      };
    }),
  );

  const feeSweeps: FeeSweepRow[] = (sweeps ?? []).flatMap((sweep) => {
    const url = txLink(deployment.explorer, sweep.txHash);
    return url === null ? [] : [{ txUrl: url, amount: sweep.amount, at: sweep.timestamp }];
  });

  const view: ProofData = {
    status: 'deployed',
    contracts,
    feeds: feedRows(deployment),
    safe: {
      address: addressOrNull(deployment.safe),
      threshold: snapshot.safe?.threshold ?? null,
      owners: snapshot.safe?.owners?.length ?? null,
    },
    counters: counters(deployment, snapshot),
    settled,
    refundDrill: await refundDrill(deployment, snapshot.markets, logs),
    feeSweeps,
  };
  return { view, extras: { snapshot, missing } };
}

export function notDeployedProof(deployment: Deployment): ProofData {
  return {
    status: 'not-deployed',
    contracts: contractRowsSync(deployment),
    feeds: feedRows(deployment),
    safe: { address: addressOrNull(deployment.safe), threshold: null, owners: null },
    counters: counters(deployment, null),
    settled: [],
    refundDrill: null,
    feeSweeps: [],
  };
}

/** Never throws: before deployment, and if the chain has never been readable, the rows say so. */
export async function getProof(): Promise<{ view: ProofData; extras: ProofExtras }> {
  const deployment = readDeployment();
  if (deployment.status !== 'deployed') {
    return { view: notDeployedProof(deployment), extras: { snapshot: null, readAt: null, stale: false, missing: [] } };
  }
  try {
    const result = await cachedRead({
      key: ['proof', deployment.contracts.HunchVPM.address],
      tags: [TAG.proof, TAG.venue],
      revalidate: PROOF_REVALIDATE,
      read: () => readAll(deployment),
    });
    return { view: result.data.view, extras: { ...result.data.extras, readAt: result.readAt, stale: result.stale } };
  } catch {
    return { view: { ...notDeployedProof(deployment), status: 'deployed' }, extras: { snapshot: null, readAt: null, stale: true, missing: ['every chain read'] } };
  }
}

/** The documented `/api/proof` body. */
export function proofJson(view: ProofData, extras: ProofExtras): JsonValue {
  return toJsonSafe({
    status: view.status,
    contracts: view.contracts,
    feeds: view.feeds,
    safe: view.safe,
    counters: view.counters.map((c) => ({ label: c.label, value: c.value, unit: c.unit, source: c.sourceUrl, sourceLabel: c.sourceLabel, note: c.note ?? null })),
    settled: view.settled.map((row) => ({
      id: row.id,
      question: row.question,
      outcome: row.outcome,
      strike: row.strike === null ? null : { answer: row.strike.answer, roundId: row.strike.roundId, at: row.strike.at },
      final: row.final === null ? null : { answer: row.final.answer, roundId: row.final.roundId, at: row.final.at },
      resolveTx: row.resolveTxUrl === null ? null : row.resolveTxUrl.split('/tx/')[1] ?? null,
      positions: row.positions,
      totalPaid: row.totalPaid,
    })),
    refundDrill: view.refundDrill,
    feeSweeps: view.feeSweeps.map((row) => ({ tx: row.txUrl.split('/tx/')[1] ?? null, amount: row.amount, at: row.at })),
    bettors: extras.snapshot?.bettors ?? null,
    usdg: extras.snapshot?.usdg ?? null,
    counts: extras.snapshot?.counts ?? null,
    missing: extras.missing,
    readAt: extras.readAt,
    stale: extras.stale,
  });
}
