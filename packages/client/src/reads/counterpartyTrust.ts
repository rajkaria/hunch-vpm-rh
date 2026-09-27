import type { Address } from 'viem';
import type { ResolvedConfig } from '../config.js';
import type { PositionHolding } from '../decode.js';
import { addressFilter, decodeAgent, decodeHolding } from '../decode.js';
import type { AgentIdentityField } from '../queries.js';
import { agentsQuery, marketPositionsQuery } from '../queries.js';
import type { AgentReputation, Counterparty, CounterpartyTrust, Market, OpposingSideTrust } from '../types.js';
import { shareToPpm } from '../units.js';
import { fetchMarket, paginate } from './shared.js';

interface PositionsResponse {
  positions?: unknown[] | null;
}

interface AgentsResponse {
  agents?: unknown[] | null;
}

async function fetchHoldings(config: ResolvedConfig, marketId: string): Promise<PositionHolding[]> {
  return paginate(config.pageSize, async (first, skip) => {
    const data = await config.transport.request<PositionsResponse>({
      url: config.subgraphUrl,
      query: marketPositionsQuery(),
      variables: { market: marketId, first, skip },
      operation: 'marketPositions',
    });
    return (data.positions ?? []).map(decodeHolding);
  });
}

/**
 * Reputation for a set of wallets. Replaceable, because the ERC-8004 subgraph
 * is a standardized schema we deploy rather than one we own: if the deployed
 * field names differ from the ones queried here, supply your own lookup
 * instead of forking the client.
 */
export type ReputationLookup = (addresses: Address[]) => Promise<AgentReputation[]>;

/**
 * An ERC-8004 identity carries two addresses and either can be the one that
 * staked: `agentWallet`, the address the agent signs and transacts as, and
 * `owner`, the holder of the identity NFT. They are frequently different, and
 * which one appears as a position's owner depends on how the agent is wired.
 * So both are asked for, and `agentWallet` wins when one identity answers to
 * both — it is the address that did the staking.
 */
export function subgraphReputationLookup(config: ResolvedConfig): ReputationLookup | null {
  const url = config.erc8004SubgraphUrl;
  if (url === null) return null;

  const byIdentity = async (identity: AgentIdentityField, filters: string[]): Promise<AgentReputation[]> =>
    paginate(config.pageSize, async (first, skip) => {
      const data = await config.transport.request<AgentsResponse>({
        url,
        query: agentsQuery(identity),
        variables: { addresses: filters, first, skip },
        operation: identity === 'agentWallet' ? 'agents' : 'agentsByOwner',
      });
      return (data.agents ?? []).map((agent) => decodeAgent(agent, identity));
    });

  return async (addresses) => {
    if (addresses.length === 0) return [];
    const filters = addresses.map(addressFilter);
    const [byWallet, byOwner] = await Promise.all([byIdentity('agentWallet', filters), byIdentity('owner', filters)]);
    const merged = new Map<string, AgentReputation>();
    for (const agent of byOwner) merged.set(agent.address.toLowerCase(), agent);
    for (const agent of byWallet) merged.set(agent.address.toLowerCase(), agent);
    return [...merged.values()];
  };
}

export interface CounterpartyTrustOptions {
  /** Override the reputation source, e.g. a cache or a different schema. */
  reputation?: ReputationLookup;
}

function summarize(
  outcome: number,
  holdings: PositionHolding[],
  reputationByAddress: Map<string, AgentReputation>,
): OpposingSideTrust {
  const principalByWallet = new Map<string, { address: Address; principal: bigint }>();
  for (const holding of holdings) {
    if (holding.outcome === outcome) continue;
    const key = holding.owner.toLowerCase();
    const existing = principalByWallet.get(key);
    if (existing === undefined) {
      principalByWallet.set(key, { address: holding.owner, principal: holding.accepted });
    } else {
      existing.principal += holding.accepted;
    }
  }

  const opposingPrincipal = [...principalByWallet.values()].reduce((total, entry) => total + entry.principal, 0n);

  const wallets: Counterparty[] = [...principalByWallet.entries()]
    .map(([key, entry]) => {
      const reputation = reputationByAddress.get(key);
      return {
        address: entry.address,
        principal: entry.principal,
        sharePpm: shareToPpm(entry.principal, opposingPrincipal),
        meanScore: reputation?.meanScore ?? null,
        feedbackCount: reputation?.feedbackCount ?? 0,
        agentId: reputation?.agentId ?? null,
      };
    })
    .sort((a, b) => (a.principal === b.principal ? a.address.localeCompare(b.address) : a.principal > b.principal ? -1 : 1));

  const rated = wallets.filter((wallet) => wallet.meanScore !== null);
  const unratedPrincipal = wallets
    .filter((wallet) => wallet.meanScore === null)
    .reduce((total, wallet) => total + wallet.principal, 0n);

  // The principal-weighted mean uses ppm shares so the weights stay integers
  // until the last step; the division-by-zero case is a side whose rated
  // wallets happen to hold nothing.
  const ratedPrincipal = rated.reduce((total, wallet) => total + wallet.principal, 0n);
  let weighted: number | null = null;
  if (rated.length > 0 && ratedPrincipal > 0n) {
    let accumulator = 0;
    for (const wallet of rated) {
      const weight = Number(shareToPpm(wallet.principal, ratedPrincipal));
      accumulator += weight * (wallet.meanScore ?? 0);
    }
    weighted = accumulator / 1_000_000;
  }

  return {
    outcome,
    opposingPrincipal,
    counterparties: wallets.length,
    ratedCounterparties: rated.length,
    meanScore:
      rated.length === 0 ? null : rated.reduce((total, wallet) => total + (wallet.meanScore ?? 0), 0) / rated.length,
    principalWeightedMeanScore: weighted,
    unratedPrincipal,
    unratedSharePpm: shareToPpm(unratedPrincipal, opposingPrincipal),
    wallets,
  };
}

/**
 * Who is on the other side of each outcome, and how much the registries say
 * about them.
 *
 * `sides[o]` answers "if I take outcome o, who is against me": the wallets
 * holding accepted principal on every other outcome, their share of that
 * book, and their ERC-8004 reputation. The number worth looking at first is
 * `unratedSharePpm` — the fraction of the money opposing you that belongs to
 * wallets the reputation registry has never heard of. A high mean score over
 * a side that is 90% anonymous is not a signal.
 */
export async function counterpartyTrust(
  config: ResolvedConfig,
  marketId: string,
  options: CounterpartyTrustOptions = {},
): Promise<CounterpartyTrust> {
  const { market, index } = await fetchMarket(config, marketId);
  const holdings = await fetchHoldings(config, marketId);

  const lookup = options.reputation ?? subgraphReputationLookup(config);
  const reputationByAddress = new Map<string, AgentReputation>();
  if (lookup !== null) {
    const distinct = new Map<string, Address>();
    for (const holding of holdings) distinct.set(holding.owner.toLowerCase(), holding.owner);
    const agents = await lookup([...distinct.values()]);
    for (const agent of agents) {
      reputationByAddress.set(agent.address.toLowerCase(), agent);
    }
  }

  return {
    marketId: market.id,
    sides: outcomesOf(market).map((outcome) => summarize(outcome, holdings, reputationByAddress)),
    reputationUnavailable: lookup === null,
    index,
  };
}

function outcomesOf(market: Market): number[] {
  if (market.books.length > 0) return market.books.map((book) => book.outcome);
  return Array.from({ length: market.outcomeCount }, (_, index) => index);
}
