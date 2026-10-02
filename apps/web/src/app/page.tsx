import Link from 'next/link';
import type { ReactNode } from 'react';

import { FaqList } from '@/components/faq/FaqList';
import { Hero } from '@/components/landing/Hero';
import { PriceTape } from '@/components/landing/PriceTape';
import { MarketGrid } from '@/components/market/MarketGrid';
import { HowItWorksSteps } from '@/components/mechanism/HowItWorksSteps';
import { EarlyVsLate, selectProof } from '@/components/proof/EarlyVsLate';
import { ContractTable } from '@/components/trust/ContractTable';
import { CountryNotice } from '@/components/trust/CountryNotice';
import { PowersTable } from '@/components/trust/PowersTable';
import { Container } from '@/components/ui/Container';
import { FactStrip, TextLink } from '@/components/ui/primitives';
import { FAQ } from '@/content/faq';
import { readDeployment } from '@/lib/deployment';
import { getPrices } from '@/lib/server/prices';
import { contractRowsSync } from '@/lib/server/proof';
import { readVenueState } from '@/lib/server/venue';
import { LATE_RULE, LINKS } from '@/lib/site';

/**
 * Rebuilt from cached chain reads at most every 15 s (docs/spec/05-web-app.md): the price tape
 * (`readPrices`), the markets grid (`readVenue`) and the proof card (the latest settled market,
 * else the labelled worked example).
 *
 * The page follows the Hunch landing page's order, one idea per block: the hero with the proof
 * card beside it and the price tape under it, the markets, how it works, who can do what, and
 * questions with where to go next. Anything longer lives one click away on its own page.
 */
export const revalidate = 15;

function Section({ id, children, className = '' }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={`pt-16 sm:pt-24 ${className}`}>
      <Container>{children}</Container>
    </section>
  );
}

/** A section's head, the Hunch way: a heading, one line under it, and at most one link across from it. */
function SectionHead({ title, sub, action, id }: { title: ReactNode; sub?: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 max-w-2xl">
        <h2 id={id} className="text-[28px] leading-[1.1] sm:text-4xl">
          {title}
        </h2>
        {sub === undefined ? null : <p className="mt-2.5 text-[15px] leading-relaxed text-muted">{sub}</p>}
      </div>
      {action === undefined ? null : <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** A quiet outline link that sits across from a section heading. */
function HeadLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="group inline-flex min-h-11 items-center gap-1.5 rounded-control border border-edge-strong bg-ghost px-4 text-sm font-semibold text-paper/85 transition-colors hover:border-paper/25 hover:bg-paper/5 hover:text-paper"
    >
      {children}
      <span aria-hidden className="transition-transform duration-150 group-hover:translate-x-0.5">
        →
      </span>
    </Link>
  );
}

/** A native disclosure row in the FAQ list's style: the detail is in the page, one tap away. */
function Disclosure({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 px-4 py-3.5 transition-colors hover:bg-paper/3 sm:px-5 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-[15px] leading-snug font-semibold text-paper">{title}</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-faint">{hint}</span>
        </span>
        <span
          aria-hidden
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-tag border border-edge text-muted transition-transform duration-150 group-open:rotate-45"
        >
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M6 1v10M1 6h10" strokeLinecap="round" />
          </svg>
        </span>
      </summary>
      <div className="px-4 pb-5 sm:px-5">{children}</div>
    </details>
  );
}

/** One of the closing cards: where to go next, the way the Hunch landing page ends. */
function NextCard({ eyebrow, title, body, href, cta, accent = false }: { eyebrow: string; title: string; body: string; href: string; cta: string; accent?: boolean }) {
  const external = !href.startsWith('/');
  const content = (
    <>
      <p className={`eyebrow ${accent ? '!text-lime' : ''}`}>{eyebrow}</p>
      <h3 className="mt-3 text-xl leading-tight text-paper">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
      <p className="mt-auto inline-flex items-center gap-1.5 pt-6 text-sm font-semibold text-paper">
        {cta}
        <span aria-hidden className="transition-transform duration-150 group-hover:translate-x-0.5">
          {external ? '↗' : '→'}
        </span>
        {external ? <span className="sr-only"> (opens in a new tab)</span> : null}
      </p>
    </>
  );
  const className = `lift group flex h-full flex-col rounded-card border bg-raised p-5 transition-colors duration-150 hover:bg-raised-2 sm:p-6 ${
    accent ? 'border-lime/25 hover:border-lime/40' : 'border-edge hover:border-paper/20'
  }`;
  return external ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className={className}>
      {content}
    </a>
  ) : (
    <Link href={href} className={className}>
      {content}
    </Link>
  );
}

export default async function LandingPage() {
  const now = Math.floor(Date.now() / 1000);
  const [prices, venue] = await Promise.all([getPrices(), readVenueState(now)]);
  const deployment = readDeployment();
  const proof = selectProof(venue.settled);
  const live = venue.status === 'deployed';
  const taking = venue.markets.filter((market) => (market.phase === 'opens' || market.phase === 'live') && market.acceptingBets !== false).length;
  const deployed = deployment.status === 'deployed';

  return (
    <>
      <Container className="pt-10 sm:pt-14 lg:pt-20">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-center lg:gap-14">
          <Hero live={live} liveCount={taking} />
          <div className="min-w-0">
            <p className="eyebrow px-1 !text-lime">{proof.kind === 'illustration' ? 'Why early pays more' : 'Latest settled market'}</p>
            <div className="mt-2.5">
              <EarlyVsLate proof={proof} />
            </div>
          </div>
        </div>
        <div className="mt-12 lg:mt-16">
          <PriceTape initial={prices} now={now} />
        </div>
      </Container>

      <Section id="markets">
        <SectionHead
          title={taking > 0 ? 'Live markets' : 'Markets'}
          sub={
            taking > 0
              ? `${taking} ${taking === 1 ? 'market' : 'markets'} taking bets until the closing bell. Tap one to see its rules, its price and every bet.`
              : 'Daily and weekly UP or DOWN markets on Robinhood Stock Tokens, open until the closing bell.'
          }
          action={<HeadLink href="/how-it-works">How a market settles</HeadLink>}
        />
        <div className="mt-8">
          <MarketGrid markets={venue.markets} deployment={deployment} now={now} degraded={venue.degraded ?? null} readAt={venue.readAt ?? null} />
        </div>
      </Section>

      <Section>
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
          <div className="min-w-0">
            <p className="eyebrow mb-3">How it works</p>
            <h2 className="text-[28px] leading-[1.1] sm:text-4xl">
              No house.
              <br />
              Early pays more.
            </h2>
            <p className="mt-4 max-w-md text-[15px] leading-relaxed text-muted sm:text-base">
              Bettors pay each other. In an ordinary pool a bet at 3:59 pm is paid like one at 9:30 am; here every opposing
              dollar that arrives after you is yours, so the market can stay open until the bell.
            </p>
            <p className="mt-6 max-w-md border-l-2 border-lime pl-4 text-[15px] leading-relaxed text-paper">{LATE_RULE}</p>
            <p className="mt-6 text-sm">
              <TextLink href="/how-it-works">The full explanation, with the arithmetic</TextLink>
            </p>
          </div>
          <div className="min-w-0 lg:pt-1">
            <HowItWorksSteps variant="list" />
          </div>
        </div>
      </Section>

      <Section>
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
          <div className="min-w-0">
            <p className="eyebrow mb-3">Who can do what</p>
            <h2 className="text-[28px] leading-[1.1] sm:text-4xl">Two privileged actions. Neither touches your money.</h2>
            <p className="mt-4 max-w-md text-[15px] leading-relaxed text-muted sm:text-base">
              Listing a market and pausing new bets are the only privileged actions. Nobody, Hunch included, can move a
              stake, set a price, or stop claims, refunds or settlement.
            </p>
            <p className="mt-6 text-sm">
              <TextLink href="/proof">Every contract, feed and settlement on the Proof page</TextLink>
            </p>
          </div>
          <div className="grid min-w-0 content-start gap-3">
            <FactStrip
              label="Who can do what, in three facts"
              facts={[
                { label: 'Privileged actions', value: <span className="num font-normal">2</span> },
                { label: 'Can move a stake', value: 'Nobody' },
                { label: 'Sets the price', value: 'Chainlink' },
              ]}
            />
            <div className="divide-y divide-edge-soft overflow-hidden rounded-card border border-edge bg-raised">
              <Disclosure title="Every privileged power, and what it cannot do" hint="The Safe, the keeper, anyone, and the resolver, from the contracts spec">
                <PowersTable />
              </Disclosure>
              <Disclosure
                title="Contracts on Robinhood Chain"
                hint={deployed ? 'Every address links to its source on Blockscout' : 'Not deployed yet; the addresses appear here the moment they are'}
              >
                <ContractTable rows={contractRowsSync(deployment)} compact />
              </Disclosure>
            </div>
          </div>
        </div>
      </Section>

      <Section>
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
          <div className="min-w-0">
            <p className="eyebrow mb-3">Questions</p>
            <h2 className="text-[28px] leading-[1.1] sm:text-4xl">Before your first bet</h2>
            <p className="mt-6 text-sm">
              <TextLink href="/docs/faq">All questions</TextLink>
            </p>
          </div>
          <div className="min-w-0">
            <FaqList items={FAQ.filter((item) => item.teaser === true)} />
          </div>
        </div>
      </Section>

      <Section className="pb-16 sm:pb-24">
        <SectionHead title="Where to next" />
        <div className="mt-8 grid gap-3 sm:gap-4 md:grid-cols-3">
          <NextCard
            accent
            eyebrow="Get set up"
            title="Ready before the bell."
            body="Add Robinhood Chain to your wallet and get USDG onto it. One signature per bet after that, and no ETH needed."
            href="/start"
            cta="Get set up in 2 minutes"
          />
          <NextCard
            eyebrow="Proof"
            title="Check every number yourself."
            body="Every contract, price feed, settlement and fee, each linked to its transaction on Blockscout."
            href="/proof"
            cta="Open the Proof page"
          />
          <NextCard
            eyebrow="Hunch Research"
            title="Read the paper."
            body="The payout rule, why it holds, and how it would have paid on a real trading tape, with the contract it specifies."
            href={LINKS.paper}
            cta="Open the paper"
          />
        </div>
        <CountryNotice className="mt-4" />
      </Section>
    </>
  );
}
