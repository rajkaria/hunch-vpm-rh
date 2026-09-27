import Link from 'next/link';

import { MarketCard } from '@/components/market/MarketCard';
import { Amount, Badge, Button, EmptyState, Stat } from '@/components/ui/primitives';
import { NETWORKS, isDeployed } from '@/lib/chain';
import { dataSourceFor } from '@/lib/data';
import { selectedNetwork } from '@/lib/network-server';
import type { MarketSummary } from '@/lib/data/types';

// Rendered per request, because which Arc the board lists is the viewer's
// choice, carried in a cookie. The countdown on each card is still a client
// clock reading an absolute deadline.

export default async function MarketsPage() {
  const network = await selectedNetwork();
  const markets = await dataSourceFor(network).listMarkets();
  const deployed = isDeployed(NETWORKS[network].addresses.vestedParimutuel);
  const liveBadge = !deployed
    ? network === 'mainnet'
      ? 'Launching on Arc mainnet'
      : 'Arc Testnet, sample data'
    : network === 'mainnet'
      ? 'Live on Arc'
      : 'Live on Arc Testnet';
  const open = markets.filter((market) => market.status === 'Open' && !market.frozen);
  const awaiting = markets.filter((market) => market.status === 'Open' && market.frozen);
  const settled = markets.filter((market) => market.status !== 'Open');

  const pool = markets.reduce((total, market) => total + market.acceptedPool, 0n);

  return (
    <div>
      {/*
        The hero carries the product's own opening: a row of tags, one display
        line set tight, the claim in a sentence, and a single lime call to
        action. The glow behind it is one radial at 8% and it is decoration —
        `aria-hidden`, `pointer-events-none`, and nothing is ever placed on it
        that has to stay legible.
      */}
      <section className="lift relative mb-8 overflow-hidden rounded-card border border-edge bg-raised">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-32 -right-24 h-72 w-72 rounded-full bg-[radial-gradient(circle,rgba(200,240,79,0.08),transparent_70%)]"
        />
        <div className="relative grid gap-8 px-5 py-8 sm:px-7 sm:py-10 md:grid-cols-[1.6fr_1fr] md:items-end">
          <div>
            <div className="mb-5 flex flex-wrap items-center gap-2">
              <Badge tone={deployed ? 'up' : 'note'}>{liveBadge}</Badge>
              <Badge tone="info">USDC native</Badge>
              <Badge tone="note">Agent readable</Badge>
            </div>
            <h1 className="display-xl max-w-xl text-4xl sm:text-5xl">
              Stake vests the moment it lands.
            </h1>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
              A classic pool pays money that arrives one second before the freeze the same multiple as money
              that was there from the start. This one does not. Stake on an outcome vests into the opposing
              books immediately, and it is accepted only up to the room those books have to cover it.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button href="#open" size="sm">
                See the board
              </Button>
              <Button href="/docs" variant="ghost" size="sm">
                How it works
              </Button>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-3 md:gap-4">
            <HeroStat label="Markets open">
              <span className="num">{open.length}</span>
            </HeroStat>
            <HeroStat label="Accepted principal">
              <Amount value={pool} />
            </HeroStat>
          </dl>
        </div>
      </section>

      <Section
        id="open"
        title="Open"
        hint="Taking stake until the freeze."
        markets={open}
        empty="No market is taking stake right now."
        emptyBody="Markets open with a seed on every outcome, and stay open until the freeze their creator fixed. When the next one opens it appears here."
      />

      {awaiting.length > 0 ? (
        <Section
          title="Awaiting resolution"
          hint="Frozen. Anyone can call the resolver; the feed decides, not a person."
          markets={awaiting}
        />
      ) : null}

      {settled.length > 0 ? (
        <Section title="Settled" hint="Resolved from the feed, or voided and refunded." markets={settled} />
      ) : null}
    </div>
  );
}

function Section({
  id,
  title,
  hint,
  markets,
  empty,
  emptyBody,
}: {
  id?: string;
  title: string;
  hint: string;
  markets: MarketSummary[];
  empty?: string;
  emptyBody?: string;
}) {
  return (
    <section id={id} className="mb-10 scroll-mt-24">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-lg">{title}</h2>
        <p className="text-sm text-muted">{hint}</p>
        <span className="num ml-auto rounded-pill border border-edge bg-ghost px-2.5 py-1 text-xs text-faint">
          {markets.length}
        </span>
      </div>

      {markets.length === 0 ? (
        empty === undefined ? null : <EmptyState title={empty}>{emptyBody}</EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {markets.map((market) => (
            <MarketCard key={market.id} market={market} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The hero's two numbers, each in its own box. They are the only figures on
 * the page not attached to a market, so they need an edge to belong to
 * something; `Stat` on its own reads as a stray label out here.
 */
function HeroStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col justify-between rounded-control border border-edge bg-raised-2 px-4 py-4">
      <Stat label={label}>{children}</Stat>
    </div>
  );
}
