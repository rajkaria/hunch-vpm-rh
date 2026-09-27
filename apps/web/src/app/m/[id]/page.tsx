import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { BookTable } from '@/components/market/BookTable';
import { ContractsPanel } from '@/components/market/ContractsPanel';
import { Countdown } from '@/components/market/Countdown';
import { HeadroomBar } from '@/components/market/HeadroomBar';
import { MarketRuleComparator } from '@/components/market/MarketRuleComparator';
import { PositionGate } from '@/components/market/PositionGate';
import { ResolutionPanel } from '@/components/market/ResolutionPanel';
import { StakePanel } from '@/components/market/StakePanel';
import type { WireBook, WirePosition } from '@/components/market/RuleComparator';
import { SettlerBadge, StatusBadge } from '@/components/market/StatusBadge';
import { VestingCurve, type CurveSeries } from '@/components/market/VestingCurve';
import { Amount, Badge, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { NETWORKS } from '@/lib/chain';
import { dataSourceFor } from '@/lib/data';
import { selectedNetwork } from '@/lib/network-server';
import type { MarketDetail } from '@/lib/data/types';
import { formatUtc } from '@/lib/time';
import { ACC_SCALE, formatAmount } from '@/lib/units';

/**
 * Only the ids `generateStaticParams` returned are routes; anything else is a
 * real 404 from the router.
 *
 * Letting unknown ids render on demand looks more permissive but is worse: an
 * ISR-cached `notFound()` is served with a 200, so a wrong address would
 * answer "Nothing here" while telling every crawler and every client that the
 * page exists. The set of ids is not a limitation either — the board and these
 * pages read the same lists, from the fixtures or from each network's
 * NEXT_PUBLIC_HUNCH_MARKET_IDS_*, so a market that is listed always has a page.
 * An id listed on the other network renders this network's 404.
 */
export const dynamicParams = false;

export async function generateStaticParams(): Promise<{ id: string }[]> {
  const lists = await Promise.all(
    (['testnet', 'mainnet'] as const).map((network) => dataSourceFor(network).listMarkets()),
  );
  return [...new Set(lists.flat().map((market) => market.id))].map((id) => ({ id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const market = await dataSourceFor(await selectedNetwork()).getMarket(id);
  if (market === null) return { title: 'Market not found' };

  const description = `${market.subject} · ${formatAmount(market.acceptedPool)} USDC of accepted principal, settled under the ${
    market.settlerKind === 'vested' ? 'vested' : 'classic pool'
  } rule on Arc.`;

  /*
   * OpenGraph is overridden per market, not left to inherit the root.
   *
   * Without this a shared market link previews as "Hunch VPM — the vested
   * parimutuel" whatever market it points at, so three links to three different
   * questions are indistinguishable in a chat window — which is where most of
   * them get shared. The image is still the site card; a per-market image would
   * need a generated OG route and is noted in REPORT.md.
   */
  return {
    title: market.question,
    description,
    openGraph: {
      type: 'website',
      siteName: 'Hunch VPM',
      title: market.question,
      description,
      url: `/m/${market.id}`,
    },
    twitter: {
      card: 'summary_large_image',
      title: market.question,
      description,
    },
  };
}

export default async function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const network = await selectedNetwork();
  const market = await dataSourceFor(network).getMarket(id);
  if (market === null) notFound();

  const now = Math.floor(Date.now() / 1000);
  const wireBooks: WireBook[] = market.outcomes.map((outcome) => ({
    outcome: outcome.outcome,
    label: outcome.label,
    tone: outcome.tone,
    principal: outcome.principal.toString(),
    vested: outcome.vested.toString(),
    capacity: outcome.capacity === null ? null : outcome.capacity.toString(),
    demand: outcome.demand.toString(),
    acc: outcome.acc.toString(),
  }));
  const wirePositions: WirePosition[] = market.positions.map((position) => ({
    positionId: position.positionId.toString(),
    outcome: position.outcome,
    offered: position.offered.toString(),
    accepted: position.accepted.toString(),
    refused: position.refused.toString(),
    entryAcc: position.entryAcc.toString(),
  }));

  const series = toCurveSeries(market);
  const markers = market.positions.map((position) => ({
    outcome: position.outcome,
    t: Number(position.enteredAt),
    label: 'you',
  }));
  const held = market.positions[0]?.outcome ?? market.outcomes[0]?.outcome ?? 0;

  return (
    <div>
      <Link href="/" className="mb-5 inline-block text-sm text-muted hover:text-paper">
        ← All markets
      </Link>

      <header className="lift rounded-card border border-edge bg-raised">
        <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-2.5 sm:px-5">
          <Badge tone="quiet">{market.subject}</Badge>
          <SettlerBadge kind={market.settlerKind} />
          <span className="ml-auto">
            <StatusBadge status={market.status} frozen={market.frozen} />
          </span>
        </div>

        <div className="px-4 py-5 sm:px-5">
          <h1 className="display-xl max-w-3xl text-[28px] sm:text-4xl">{market.question}</h1>

          {/*
            The four headline figures, ruled off from each other. A gap alone
            let "each book can absorb kappa times its own principal" read as if
            it belonged to the column on its left; a hairline says it does not.
          */}
          <dl className="mt-7 grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4 sm:gap-x-0 sm:[&>*+*]:border-l sm:[&>*+*]:border-edge sm:[&>*+*]:pl-6 sm:[&>*]:pr-6">
            <Stat label="Accepted principal">
              <Amount value={market.acceptedPool} />
            </Stat>
            <Stat label={market.frozen ? 'Froze' : 'Freezes in'}>
              {market.frozen ? (
                <span className="num text-base">{formatUtc(market.resolutionTime)}</span>
              ) : (
                <Countdown deadline={Number(market.resolutionTime)} initialSeconds={Number(market.secondsToFreeze)} />
              )}
            </Stat>
            <Stat
              label="Capacity coefficient"
              hint={
                market.settlerKind === 'classic'
                  ? 'recorded for interface parity; the classic rule never reads it'
                  : market.kappa === null
                    ? 'unbounded, as the paper prescribes for n-way markets'
                    : 'each book can absorb kappa times its own principal'
              }
            >
              <span className="num">{market.kappa === null ? 'unbounded' : `${market.kappa.toString()}x`}</span>
            </Stat>
            <Stat
              label="Residue"
              hint={
                market.status === 'Resolved'
                  ? 'what per-position flooring left behind, swept by the owner named at creation'
                  : 'there is none until the market settles and the floors are taken'
              }
            >
              {market.status === 'Resolved' ? (
                <Amount value={market.residue} fractionDigits={6} />
              ) : (
                <span className="num text-muted">—</span>
              )}
            </Stat>
          </dl>
        </div>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="min-w-0 space-y-6">
          <Panel>
            <PanelHeader
              title="Capacity"
              hint="A book can only absorb so much of the other side. When it runs out, stake is refused and refunded — that is the rule working, not a failure."
            />
            <div className="space-y-5 px-4 py-5 sm:px-5">
              {market.outcomes.map((outcome) => {
                const others = market.outcomes.filter((entry) => entry.outcome !== outcome.outcome);
                const constrains =
                  others.length === 1
                    ? `Limits stake on ${others[0]?.label ?? 'the other outcome'}`
                    : 'Limits stake on every other outcome';
                return (
                  <HeadroomBar
                    key={outcome.outcome}
                    label={outcome.label}
                    tone={outcome.tone}
                    capacity={outcome.capacity}
                    vested={outcome.vested}
                    constrains={constrains}
                  />
                );
              })}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="The book" hint="Per outcome, as the settler holds it." />
            <BookTable market={market} />
          </Panel>

          {market.settlerKind === 'vested' ? (
            <Panel>
              <PanelHeader
                title="Vesting over this market's life"
                hint="What one unit of opening stake is worth under each rule, sampled at every vintage."
              />
              <VestingCurve
                series={series}
                freezeAt={Number(market.resolutionTime)}
                nowSeconds={now}
                defaultOutcome={held}
                markers={markers}
              />
            </Panel>
          ) : (
            <Panel>
              <PanelHeader title="Vesting over this market's life" />
              <p className="px-4 py-6 text-sm leading-relaxed text-muted sm:px-5">
                Nothing vests here. This market settles under the classic pool rule: the pool is every stake,
                winning and losing, and each winner takes a share of it in proportion to stake, whenever that
                stake arrived. There is no accumulator to plot.
              </p>
            </Panel>
          )}

          <Panel>
            <PanelHeader
              title="Vested against classic"
              hint="The same money, the same books, settled under each rule. The difference is a number, not a claim."
            />
            <MarketRuleComparator
              marketId={market.id}
              books={wireBooks}
              positions={wirePositions}
              settlerKind={market.settlerKind}
              frozen={market.frozen}
            />
          </Panel>
        </div>

        <div className="min-w-0 space-y-6">
          {/*
            The stake panel leads the sidebar: it is the thing a reader came to
            do, and the acceptance estimate inside it is the one number that has
            to be seen before anything is signed.
          */}
          <StakePanel market={market} />

          <Panel>
            <PanelHeader title="Your position" />
            <PositionGate market={market} />
          </Panel>

          <Panel>
            <PanelHeader title="How it resolves" />
            <ResolutionPanel market={market} chain={NETWORKS[network].facts} />
          </Panel>

          <Panel>
            <PanelHeader title="Contracts" />
            <ContractsPanel market={market} network={network} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

/**
 * The curve's series, per outcome.
 *
 * Both lines are what one unit of the creator's opening stake is worth: the
 * vested line is `1 + A_o(t)/S` — the seed legs enter with A = 0 — and the
 * classic line is the pool over that outcome's principal at the same instant.
 * They start equal because at creation the seed legs are each other's
 * counterparties under either rule, so everything after the first sample is
 * the two rules diverging rather than two different starting points.
 *
 * These are the only ratios on the surface that become floats. They are chart
 * coordinates; nothing downstream of them is money.
 */
function toCurveSeries(market: MarketDetail): CurveSeries[] {
  const scale = Number(ACC_SCALE);
  return market.outcomes.map((outcome) => ({
    outcome: outcome.outcome,
    label: outcome.label,
    tone: outcome.tone,
    points: market.history.map((sample) => {
      const point = sample.points.find((entry) => entry.outcome === outcome.outcome);
      const pool = sample.points.reduce((total, entry) => total + entry.principal, 0n);
      const principal = point?.principal ?? 0n;
      return {
        t: Number(sample.t),
        vpm: 1 + Number(point?.acc ?? 0n) / scale,
        classic: principal === 0n ? 1 : Number(pool) / Number(principal),
      };
    }),
  }));
}
