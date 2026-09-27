// TODO(S7): replace with @hunch-rh/client reads (counters, settled markets, refund drill, fee sweeps, Safe threshold).
/**
 * The /proof page's data. Before deployment every one of our addresses is empty and every
 * counter is null, and the page says "not yet deployed" rather than showing a zero that would
 * read as a measurement.
 */

import { tickerInfo } from '@/content/tickers';
import { USDG, addressUrl } from '@/lib/site';

import { readDeployment, type Deployment } from './deployment';
import type { ContractRow, ProofCounter, ProofData } from './types';

export function contractRows(deployment: Deployment): ContractRow[] {
  const { HunchVPM, StockRoundResolver, HunchMarketFactory } = deployment.contracts;
  return [
    {
      name: 'HunchVPM',
      role: 'Holds every stake and pays every winner. Nobody can move a stake or set a price.',
      address: HunchVPM.address,
      deployTx: HunchVPM.deployTx,
      verified: null,
    },
    {
      name: 'StockRoundResolver',
      role: 'Settles each market from two proven Chainlink rounds. It has no owner.',
      address: StockRoundResolver.address,
      deployTx: StockRoundResolver.deployTx,
      verified: null,
    },
    {
      name: 'HunchMarketFactory',
      role: 'Lists a market in one transaction, with the opening seed paid by the lister.',
      address: HunchMarketFactory.address,
      deployTx: HunchMarketFactory.deployTx,
      verified: null,
    },
    {
      name: 'USDG',
      role: 'Paxos Global Dollar, the only stake and payout asset.',
      address: deployment.usdg || USDG.address,
      deployTx: null,
      verified: null,
    },
  ];
}

export function feedRows(deployment: Deployment): ContractRow[] {
  return deployment.feeds.map((feed) => {
    const info = tickerInfo(feed.ticker);
    return {
      name: `${feed.ticker} / USD`,
      role: `Chainlink price of the ${info?.name ?? feed.ticker} Stock Token, 8 decimals, 0.5% deviation or 24 h heartbeat.`,
      address: feed.feed,
      deployTx: null,
      verified: null,
    };
  });
}

function counters(deployment: Deployment): ProofCounter[] {
  const factory = deployment.contracts.HunchMarketFactory.address;
  const settler = deployment.contracts.HunchVPM.address;
  const factoryUrl = factory === null ? null : addressUrl(factory);
  const settlerUrl = settler === null ? null : addressUrl(settler);
  return [
    { label: 'Markets opened', value: null, unit: 'count', sourceUrl: factoryUrl, sourceLabel: 'factory.listingCount()' },
    { label: 'Markets settled', value: null, unit: 'count', sourceUrl: settlerUrl, sourceLabel: 'resolver Resolved events' },
    { label: 'Markets refunded', value: null, unit: 'count', sourceUrl: settlerUrl, sourceLabel: 'void transactions' },
    {
      label: 'Distinct bettors',
      value: null,
      unit: 'count',
      sourceUrl: settlerUrl,
      sourceLabel: 'Entered owners',
      note: "Excludes Hunch's own wallets, which are shown separately.",
    },
    { label: 'USDG staked', value: null, unit: 'USDG', sourceUrl: settlerUrl, sourceLabel: 'sum of Entered.offered' },
    { label: 'USDG paid out', value: null, unit: 'USDG', sourceUrl: settlerUrl, sourceLabel: 'sum of Claimed payouts and refunds' },
  ];
}

export async function readProof(): Promise<ProofData> {
  const deployment = readDeployment();
  return {
    status: deployment.status,
    contracts: contractRows(deployment),
    feeds: feedRows(deployment),
    safe: { address: deployment.safe, threshold: null, owners: null },
    counters: counters(deployment),
    settled: [],
    refundDrill: null,
    feeSweeps: [],
  };
}
