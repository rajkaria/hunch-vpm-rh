import { AddressLink } from '@/components/market/AddressLink';
import type { MarketDetail } from '@/lib/data/types';
import { NETWORKS, type NetworkId } from '@/lib/chain';

/**
 * Where this market actually lives.
 *
 * Three addresses decide everything about it: the settler that holds the
 * books, the resolver that is allowed to end it, and the token it is
 * denominated in. The market's own index on the settler is here too, because
 * that — not the subgraph id in the URL — is what `enter` and `claim` take.
 */
export function ContractsPanel({ market, network }: { market: MarketDetail; network: NetworkId }) {
  const facts = NETWORKS[network].facts;

  return (
    <dl className="grid gap-x-8 gap-y-4 px-4 py-5 text-sm sm:grid-cols-2 sm:px-5">
      <Row label="Settler" hint={market.settlerKind === 'vested' ? 'VestedParimutuel' : 'ClassicParimutuel'}>
        <AddressLink address={market.settler} chain={facts} />
      </Row>
      <Row label="Market id on the settler" hint="what enter and claim take">
        <span className="num text-sm">{market.onChainMarketId.toString()}</span>
      </Row>
      <Row label="Resolver" hint="FeedResolver — permissionless, reads a price feed">
        <AddressLink address={market.resolver} chain={facts} />
      </Row>
      <Row label="Settlement asset" hint="USDC, the native gas token on Arc — 6 decimals through ERC-20, 18 natively">
        <AddressLink address={market.token} chain={facts} />
      </Row>
      <Row label="Residue owner" hint="fixed at creation; the only address that can sweep the flooring remainder">
        <AddressLink address={market.residueOwner} chain={facts} />
      </Row>
      <Row label="Network" hint={`chain id ${facts.id}`}>
        <span className="num text-sm text-muted">{facts.name}</span>
      </Row>
    </dl>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-[0.12em] text-faint">{label}</dt>
      <dd className="mt-1.5">{children}</dd>
      {hint === undefined ? null : <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}
