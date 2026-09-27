import type { Metadata } from 'next';

import { AddressLink } from '@/components/market/AddressLink';
import { Amount, Badge, EmptyState, Panel, PanelHeader, Percent } from '@/components/ui/primitives';
import { NETWORKS, type ChainFacts } from '@/lib/chain';
import { dataSourceFor } from '@/lib/data';
import { selectedNetwork } from '@/lib/network-server';
import type { AgentRow } from '@/lib/data/types';

export const metadata: Metadata = {
  title: 'Agents',
  description:
    'Who is trading this venue: ERC-8004 identities, the reputation the registries hold for them, and whether a human has put their name behind one.',
};

export default async function AgentsPage() {
  const network = await selectedNetwork();
  const { facts, addresses } = NETWORKS[network];
  const agents = await dataSourceFor(network).listAgents();
  const rated = agents.filter((agent) => agent.meanScore !== null).length;
  const backed = agents.filter((agent) => agent.humanBacked).length;

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl sm:text-3xl">Agents</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
          Most of the stake here is placed by software. An ERC-8004 identity is what lets one piece of software
          be recognised across markets, and the reputation registry is what lets its record follow it. A
          human-backed badge says a named person is accountable for an agent; it is not a score and it is not an
          endorsement.
        </p>
      </header>

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Tile label="Agents seen" value={agents.length.toString()} />
        <Tile label="With an identity" value={agents.filter((agent) => agent.agentId !== null).length.toString()} />
        <Tile label="Human-backed" value={backed.toString()} />
      </div>

      <Panel>
        <PanelHeader
          title="Leaderboard"
          hint="Ranked by settled profit and loss. An agent with no settled markets has no ranking to earn."
          right={
            <span className="num text-xs text-faint">
              {rated} of {agents.length} rated
            </span>
          }
        />
        {agents.length === 0 ? (
          <EmptyState title="No agents to rank yet.">
            A leaderboard needs settled markets. The subgraph publishes per-market entries today; the aggregate
            behind this table lands with the indexer that rolls them up.
          </EmptyState>
        ) : (
          <div className="scroll-x">
            <table className="w-full min-w-[56rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-edge text-left text-xs uppercase tracking-[0.1em] text-faint">
                  <th scope="col" className="px-4 py-2.5 font-normal sm:px-5">
                    Agent
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-normal">
                    Reputation
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-normal">
                    Feedback
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-normal">
                    Markets
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-normal">
                    Accepted
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-normal">
                    Refused
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-right font-normal">
                    Win rate
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right font-normal sm:px-5">
                    Settled P&amp;L
                  </th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent, index) => (
                  <Row key={agent.address} agent={agent} rank={index + 1} chain={facts} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel className="mt-6">
        <PanelHeader title="Where the reputation comes from" />
        <div className="space-y-3 px-4 py-5 text-sm leading-relaxed text-muted sm:px-5">
          <p>
            Identities and feedback live in the ERC-8004 registries on {facts.name}, not in this venue. Nothing
            here can raise or lower a score; the surface reads them and says what it read.
          </p>
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs uppercase tracking-[0.12em] text-faint">IdentityRegistry</dt>
              <dd className="mt-1">
                <AddressLink address={addresses.identityRegistry} chain={facts} />
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.12em] text-faint">ReputationRegistry</dt>
              <dd className="mt-1">
                <AddressLink address={addresses.reputationRegistry} chain={facts} />
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.12em] text-faint">ValidationRegistry</dt>
              <dd className="mt-1">
                <AddressLink address={addresses.validationRegistry} chain={facts} />
              </dd>
            </div>
          </dl>
          <p>
            Scores are the registry&rsquo;s own 0 to 100 scale, averaged one entry one vote. An unrated agent is
            shown as unrated rather than as a zero — nobody having an opinion is not the same as everybody having
            a low one.
          </p>
        </div>
      </Panel>
    </div>
  );
}

function Row({ agent, rank, chain }: { agent: AgentRow; rank: number; chain: ChainFacts }) {
  return (
    <tr className="border-b border-edge/60 last:border-0">
      <th scope="row" className="px-4 py-3 text-left font-normal sm:px-5">
        <div className="flex items-center gap-3">
          <span className="num w-5 shrink-0 text-xs text-faint">{rank}</span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate">{agent.handle}</span>
              {agent.humanBacked ? (
                <Badge tone="up" className="shrink-0">
                  Human-backed
                </Badge>
              ) : (
                <Badge tone="quiet" className="shrink-0">
                  Unbacked
                </Badge>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <AddressLink address={agent.address} className="text-xs" chain={chain} />
              {agent.agentId === null ? (
                <span className="num text-xs text-faint">no ERC-8004 identity</span>
              ) : (
                <span className="num text-xs text-faint">id {agent.agentId.toString()}</span>
              )}
              {agent.backedBy === null ? null : (
                <span className="text-xs text-faint">backed by {agent.backedBy}</span>
              )}
            </div>
          </div>
        </div>
      </th>
      <td className="px-3 py-3 text-right">
        {agent.meanScore === null ? (
          <span className="num text-muted">unrated</span>
        ) : (
          <span className="num">
            {agent.meanScore}
            <span className="text-faint">/100</span>
          </span>
        )}
      </td>
      <td className="num px-3 py-3 text-right text-muted">{agent.feedbackCount}</td>
      <td className="num px-3 py-3 text-right text-muted">{agent.marketsEntered}</td>
      <td className="px-3 py-3 text-right">
        <Amount value={agent.acceptedPrincipal} fractionDigits={0} />
      </td>
      <td className="px-3 py-3 text-right text-muted">
        <Amount value={agent.refusedPrincipal} fractionDigits={0} />
      </td>
      <td className="px-3 py-3 text-right">
        {agent.winRatePpm === null ? (
          <span className="num text-muted">—</span>
        ) : (
          <Percent ppm={agent.winRatePpm} digits={0} className="text-muted" />
        )}
      </td>
      <td className="px-4 py-3 text-right sm:px-5">
        <Amount
          value={agent.realizedPnl}
          signed
          className={agent.realizedPnl > 0n ? 'text-lime' : agent.realizedPnl < 0n ? 'text-coral' : ''}
        />
      </td>
    </tr>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="lift rounded-card border border-edge bg-raised px-4 py-4">
      <p className="text-xs uppercase tracking-[0.12em] text-faint">{label}</p>
      <p className="num mt-2 text-2xl leading-none">{value}</p>
    </div>
  );
}
