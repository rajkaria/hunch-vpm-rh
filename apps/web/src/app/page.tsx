import Link from 'next/link';

import { FaqList } from '@/components/faq/FaqList';
import { Hero } from '@/components/landing/Hero';
import { PriceTape } from '@/components/landing/PriceTape';
import { MarketGrid } from '@/components/market/MarketGrid';
import { EarlyPaysMore } from '@/components/mechanism/EarlyPaysMore';
import { HowItWorksSteps } from '@/components/mechanism/HowItWorksSteps';
import { EarlyVsLate, selectProof } from '@/components/proof/EarlyVsLate';
import { ContractTable } from '@/components/trust/ContractTable';
import { CountryNotice } from '@/components/trust/CountryNotice';
import { PowersTable } from '@/components/trust/PowersTable';
import { WhyRobinhoodChain } from '@/components/trust/WhyRobinhoodChain';
import { Container } from '@/components/ui/Container';
import { ButtonLink, SectionHeading, TextLink } from '@/components/ui/primitives';
import { FAQ } from '@/content/faq';
import { readDeployment } from '@/lib/deployment';
import { getPrices } from '@/lib/server/prices';
import { contractRowsSync } from '@/lib/server/proof';
import { readVenueState } from '@/lib/server/venue';
import { LINKS } from '@/lib/site';

/**
 * Rebuilt from cached chain reads at most every 15 s (docs/spec/05-web-app.md): the price tape
 * (`readPrices`), the markets grid (`readVenue`) and the proof card (the latest settled market,
 * else the labelled worked example).
 */
export const revalidate = 15;

function Section({ id, children, className = '' }: { id?: string; children: React.ReactNode; className?: string }) {
  return (
    <section id={id} className={`border-t border-edge py-16 sm:py-24 ${className}`}>
      <Container>{children}</Container>
    </section>
  );
}

export default async function LandingPage() {
  const now = Math.floor(Date.now() / 1000);
  const [prices, venue] = await Promise.all([getPrices(), readVenueState(now)]);
  const deployment = readDeployment();
  const proof = selectProof(venue.settled);
  const live = venue.status === 'deployed';
  const anyOpen = venue.markets.some((market) => market.phase === 'opens' || market.phase === 'live');

  return (
    <>
      <PriceTape initial={prices} now={now} />

      <Container className="grid gap-12 pb-16 pt-10 sm:pt-16 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-center lg:gap-14 lg:pb-24 lg:pt-20">
        <Hero live={live} />
        <div className="min-w-0">
          <EarlyVsLate proof={proof} />
        </div>
      </Container>

      <Section id="markets">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <SectionHeading
            eyebrow="Markets"
            title={anyOpen ? 'Live markets' : 'Markets'}
            lead="Daily and weekly UP or DOWN markets on Robinhood Stock Tokens, open until the closing bell. Tap a market to see its rules, its price and every bet."
          />
        </div>
        <div className="mt-10">
          <MarketGrid markets={venue.markets} deployment={deployment} now={now} degraded={venue.degraded ?? null} readAt={venue.readAt ?? null} />
        </div>
      </Section>

      <Section>
        <SectionHeading
          eyebrow="How it works"
          title="Three steps, one rule that matters"
          lead="There is no bookmaker and no house. Bettors pay each other, and the order they arrive in decides who gets what."
        />
        <div className="mt-10">
          <HowItWorksSteps />
        </div>
      </Section>

      <Section>
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-14">
          <div>
            <SectionHeading
              eyebrow="Why early pays more"
              title="In an ordinary pool, the last-second bet is paid like the first"
              lead="Most pool markets split the pot at the end in proportion to stake. A dollar that arrives at 3:59 pm, when the answer is nearly known, earns the same multiple as the dollar that took the risk at 9:30 am. So nobody bets early, and operators close betting before the most exciting minutes."
            />
            <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">
              Here, the moment a bet lands it is paid to the people already on the other side. The early caller collects
              every opposing dollar that comes after; the late bettor gets their stake back plus whatever arrives after
              them. That is why the market can stay open until the bell.
            </p>
            <p className="mt-6 text-sm">
              <TextLink href="/how-it-works">The full explanation, with the arithmetic</TextLink>
            </p>
          </div>
          <EarlyPaysMore />
        </div>
      </Section>

      <Section>
        <SectionHeading
          eyebrow="Who can do what"
          title="Two privileged actions, and neither touches your money"
          lead="Listing a market and pausing new bets are the only privileged actions. Nobody, Hunch included, can move a stake, set a price, or stop claims, refunds or settlement."
        />
        <div className="mt-10">
          <PowersTable />
        </div>
        <div className="mt-12 grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
          <div>
            <h3 className="font-body text-[15px] font-semibold tracking-normal text-paper">Contracts on Robinhood Chain</h3>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">
              {deployment.status === 'deployed'
                ? 'Every address links to its source on Blockscout.'
                : 'Our contracts are not deployed yet. Their addresses appear here, linked to Blockscout, the moment they are.'}
            </p>
            <p className="mt-4 text-sm">
              <TextLink href="/proof">Every contract, feed and settlement on the Proof page</TextLink>
            </p>
          </div>
          <ContractTable rows={contractRowsSync(deployment)} compact />
        </div>
      </Section>

      <Section>
        <SectionHeading
          eyebrow="Why Robinhood Chain"
          title="What this venue needs, and where it comes from"
          lead="Stated as dependencies, not praise. Take one away and the product does not work."
        />
        <div className="mt-10">
          <WhyRobinhoodChain />
        </div>
      </Section>

      <Section>
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:gap-14">
          <div>
            <SectionHeading eyebrow="Questions" title="Before your first bet" />
            <div className="mt-8">
              <FaqList items={FAQ.filter((item) => item.teaser === true)} />
            </div>
            <p className="mt-5 text-sm">
              <TextLink href="/docs/faq">All questions</TextLink>
            </p>
          </div>
          <div className="grid content-start gap-4">
            <CountryNotice />
            <div className="rounded-card border border-edge p-4 sm:p-5">
              <p className="text-sm font-semibold text-paper">Read the paper</p>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                The payout rule, why it holds, and how it would have paid on a real trading tape are written up in Hunch
                Research&rsquo;s paper, with the contract it specifies.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <ButtonLink href={LINKS.paper} variant="secondary" size="sm">
                  Open the paper
                </ButtonLink>
                <Link
                  href="/start"
                  className="inline-flex min-h-11 items-center px-1 text-sm font-semibold text-paper underline decoration-paper/25 underline-offset-4 hover:decoration-lime"
                >
                  Get set up
                </Link>
              </div>
            </div>
          </div>
        </div>
      </Section>
    </>
  );
}
