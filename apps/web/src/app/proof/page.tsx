import type { Metadata } from 'next';

import { Toc } from '@/components/docs/prose';
import { FeeSweeps, ProofCounters, RefundDrill, SafePanel, SettledMarkets } from '@/components/proof/ProofSections';
import { ContractTable } from '@/components/trust/ContractTable';
import { PowersTable } from '@/components/trust/PowersTable';
import { Container } from '@/components/ui/Container';
import { SectionHeading, TextLink } from '@/components/ui/primitives';
import { formatEtDateTime } from '@/lib/et';
import { getProof } from '@/lib/server/proof';

export const metadata: Metadata = {
  title: 'Proof',
  description:
    'Verify it yourself: every contract, price feed and settled market on Robinhood Chain, the refund drill, fees swept and live counters, each linked to its source.',
  alternates: { canonical: '/proof' },
};

export const revalidate = 60;

const SECTIONS = [
  { id: 'counters', label: 'Live counters' },
  { id: 'contracts', label: 'Contracts' },
  { id: 'feeds', label: 'Price feeds' },
  { id: 'safe', label: 'The Safe' },
  { id: 'powers', label: 'Who can do what' },
  { id: 'settled', label: 'Settled markets' },
  { id: 'refund-drill', label: 'Refund drill' },
  { id: 'fees', label: 'Fees swept' },
] as const;

function Block({ id, title, lead, children }: { id: string; title: string; lead?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="scroll-mt-24">
      <h2 id={id} className="text-[22px] leading-tight sm:text-[26px]">
        {title}
      </h2>
      {lead === undefined ? null : <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">{lead}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

export default async function ProofPage() {
  const { view: proof, extras } = await getProof();
  const deployed = proof.status === 'deployed';

  return (
    <Container className="pb-24 pt-12 sm:pt-16">
      <SectionHeading
        as="h1"
        eyebrow="Proof"
        title="Verify it yourself"
        lead="Every number on this page comes from a chain read or links to one. Nothing here is typed in, and nothing that has not happened yet is shown as if it had."
      />

      {deployed ? null : (
        <div className="mt-8 flex flex-col gap-2 rounded-card border border-dashed border-edge-strong p-4 sm:flex-row sm:items-center sm:gap-4 sm:p-5">
          <span className="inline-flex w-fit items-center rounded-tag border border-paper/25 bg-paper/8 px-2 py-1 text-[11px] leading-none font-semibold tracking-[0.05em] text-paper uppercase">
            Not yet deployed
          </span>
          <p className="text-sm leading-relaxed text-muted">
            Hunch&rsquo;s contracts are not on Robinhood Chain yet, so their sections are empty. The Chainlink feeds and USDG
            listed below are live today; follow their links.
          </p>
        </div>
      )}

      {deployed && (extras.stale || extras.missing.length > 0) ? (
        <p className="mt-8 rounded-card border border-coral/35 bg-coral/10 p-4 text-sm leading-relaxed text-paper" role="status">
          {extras.missing.length > 0 ? `Not read just now: ${extras.missing.join(', ')}. ` : ''}
          {extras.stale ? 'Showing the last good read' : 'Retrying'}
          {extras.readAt === null ? '.' : ` from ${formatEtDateTime(extras.readAt)}.`}
        </p>
      ) : null}
      {deployed && extras.readAt !== null ? (
        <p className="mt-4 text-xs text-faint">
          Read from Robinhood Chain at <span className="num">{formatEtDateTime(extras.readAt)}</span>. The same data as JSON:{' '}
          <a href="/api/proof" className="num underline decoration-edge-strong underline-offset-2 hover:text-paper">
            /api/proof
          </a>
          .
        </p>
      ) : null}

      <div className="mt-12 grid gap-12 lg:grid-cols-[minmax(0,1fr)_200px] lg:gap-16">
        <div className="grid min-w-0 gap-16">
          <Block
            id="counters"
            title="Live counters"
            lead="Read from the chain, each linked to the call or query it came from. Hunch's own wallets are excluded from bettors and shown separately."
          >
            <ProofCounters counters={proof.counters} deployed={deployed} />
          </Block>

          <Block
            id="contracts"
            title="Contracts"
            lead="Each address links to Blockscout, where the verified source can be read. There are no upgradeable proxies."
          >
            <ContractTable rows={proof.contracts} />
          </Block>

          <Block
            id="feeds"
            title="Price feeds"
            lead="Chainlink's standard price feeds for each Robinhood Stock Token on chain 4663. They are the only input a settlement reads."
          >
            <ContractTable rows={proof.feeds} />
          </Block>

          <Block id="safe" title="The Safe">
            <SafePanel safe={proof.safe} />
          </Block>

          <Block
            id="powers"
            title="Who can do what"
            lead="Stated once, verbatim, as the contracts enforce it. There is no owner of the betting contract, no upgrade, and no price input anywhere."
          >
            <PowersTable />
          </Block>

          <Block
            id="settled"
            title="Settled markets"
            lead={
              <>
                Each market names the two Chainlink rounds that decided it. Anyone can check them, or settle a market
                themselves: see <TextLink href="/docs/markets#resolve-it-yourself">resolve it yourself</TextLink>.
              </>
            }
          >
            <SettledMarkets rows={proof.settled} />
          </Block>

          <Block
            id="refund-drill"
            title="Refund drill"
            lead="The safety proof: a market whose price could not be trusted, refunded to every bettor on-chain."
          >
            <RefundDrill drill={proof.refundDrill} />
          </Block>

          <Block id="fees" title="Fees swept">
            <FeeSweeps rows={proof.feeSweeps} />
          </Block>
        </div>

        <aside className="hidden lg:block">
          <div className="sticky top-24">
            <Toc items={SECTIONS} />
          </div>
        </aside>
      </div>
    </Container>
  );
}
