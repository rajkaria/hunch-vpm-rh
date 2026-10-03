import type { Metadata } from 'next';

import { CountryNotice } from '@/components/trust/CountryNotice';
import { Container } from '@/components/ui/Container';
import { CopyButton } from '@/components/ui/CopyButton';
import { ButtonLink, SectionHeading, TextLink } from '@/components/ui/primitives';
import { AddNetworkButton } from '@/components/wallet/AddNetworkButton';
import { FUNDING_ROUTES } from '@/content/funding-routes';
import { readDeployment } from '@/lib/deployment';
import { LINKS, ROBINHOOD_CHAIN, USDG, addressUrl } from '@/lib/site';
import { formatAmount } from '@/lib/units';

export const metadata: Metadata = {
  title: 'Get set up',
  description:
    'Get set up in 2 minutes: USDG on Robinhood Chain with Across, Robinhood Chain in your wallet, and your first bet. No ETH needed to bet.',
  alternates: { canonical: '/start' },
};

function StepHeader({ n, title, id }: { n: number; title: string; id: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="num inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-tag border border-edge-strong text-sm text-paper">
        {n}
      </span>
      <h2 id={id} className="text-[22px] leading-tight sm:text-[26px]">
        {title}
      </h2>
    </div>
  );
}

const NETWORK = [
  { label: 'Network name', value: ROBINHOOD_CHAIN.name },
  { label: 'Chain ID', value: String(ROBINHOOD_CHAIN.id), hint: `hex ${ROBINHOOD_CHAIN.idHex}` },
  { label: 'RPC URL', value: ROBINHOOD_CHAIN.rpcUrl },
  { label: 'Currency symbol', value: ROBINHOOD_CHAIN.currency.symbol },
  { label: 'Block explorer', value: ROBINHOOD_CHAIN.explorerUrl },
];

export default function StartPage() {
  const deployment = readDeployment();
  const min = formatAmount(BigInt(deployment.params.minEntry), { fractionDigits: 0 });
  const max = formatAmount(BigInt(deployment.params.maxEntry), { fractionDigits: 0 });
  const [recommended, ...others] = FUNDING_ROUTES;

  return (
    <Container className="pb-24 pt-12 sm:pt-16">
      <SectionHeading
        as="h1"
        eyebrow="Start"
        title="Get set up in 2 minutes"
        lead="Three steps: dollars on Robinhood Chain, the chain in your wallet, then your first bet. You never need ETH to bet."
      />

      <div className="mt-12 grid gap-10 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-14">
        <div className="grid min-w-0 gap-14">
          {/* 1 · USDG */}
          <section aria-labelledby="step-usdg">
            <StepHeader n={1} id="step-usdg" title="Get USDG on Robinhood Chain" />
            <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">
              Every bet and every payout is in USDG, Paxos&rsquo;s Global Dollar. The quickest way in is to bridge USDC you
              already hold.
            </p>

            {recommended === undefined ? null : (
              <div className="lift mt-6 rounded-card border border-edge bg-raised p-4 sm:p-6">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center rounded-tag border border-paper/25 bg-paper/8 px-2 py-1 text-[11px] leading-none font-semibold tracking-[0.05em] text-paper uppercase">
                    Recommended
                  </span>
                  <span className="text-xs text-faint">One transaction · arrives in seconds</span>
                </div>
                <p className="mt-4 text-lg font-semibold text-paper">USDC on Arbitrum One or Base, through Across</p>
                <ol className="mt-4 grid gap-2.5 text-[15px] text-muted">
                  {[
                    'Open Across and connect the wallet that holds your USDC.',
                    'From: Arbitrum One or Base, token USDC.',
                    'To: Robinhood Chain. It arrives as USDG.',
                    'Confirm the one transaction.',
                  ].map((line, index) => (
                    <li key={line} className="grid grid-cols-[22px_1fr] gap-2">
                      <span className="num text-faint">{index + 1}.</span>
                      <span>{line}</span>
                    </li>
                  ))}
                </ol>
                <div className="mt-6 flex flex-wrap items-center gap-4">
                  <ButtonLink href={LINKS.across}>Open Across</ButtonLink>
                  <span className="text-sm text-muted">With gasless bets you need no ETH at all.</span>
                </div>
              </div>
            )}

            <h3 className="mt-10 font-body text-[15px] font-semibold tracking-normal text-paper">Other routes</h3>
            <ul className="mt-4 grid gap-3">
              {others.map((route) => (
                <li key={route.route} className="rounded-card border border-edge p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <p className="min-w-0 flex-1 text-[15px] font-semibold text-paper">{route.route}</p>
                    {route.href === null ? null : (
                      <a
                        href={route.href}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex min-h-11 items-center text-sm font-semibold text-paper underline decoration-paper/25 underline-offset-4 hover:decoration-lime"
                      >
                        {route.linkLabel}
                      </a>
                    )}
                  </div>
                  <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                    <dt className="text-faint">Steps</dt>
                    <dd className="text-muted">{route.steps}</dd>
                    <dt className="text-faint">Lands as</dt>
                    <dd className="text-muted">{route.landsAs}</dd>
                  </dl>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{route.notes}</p>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-sm leading-relaxed text-faint">
              USDG on Robinhood Chain is contract{' '}
              <a
                href={addressUrl(USDG.address)}
                target="_blank"
                rel="noreferrer noopener"
                className="num break-hash text-muted underline decoration-edge-strong underline-offset-2 hover:text-paper"
              >
                {USDG.address}
              </a>
              . Look-alike tokens exist; check the address before you add it to your wallet.
            </p>
          </section>

          {/* 2 · the chain */}
          <section aria-labelledby="step-network">
            <StepHeader n={2} id="step-network" title="Add Robinhood Chain to your wallet" />
            <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">
              One tap in a browser wallet such as MetaMask or Rabby. Or type the details in by hand.
            </p>
            <dl className="mt-6 divide-y divide-edge-soft rounded-card border border-edge bg-raised">
              {NETWORK.map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-3 py-1.5 pl-4 pr-2 sm:pl-5">
                  <div className="min-w-0">
                    <dt className="text-[11px] text-faint">{row.label}</dt>
                    <dd className="num break-hash mt-0.5 text-sm text-paper">
                      {row.value}
                      {row.hint === undefined ? null : <span className="ml-2 text-xs text-faint">{row.hint}</span>}
                    </dd>
                  </div>
                  <CopyButton value={row.value} label={row.label} />
                </div>
              ))}
            </dl>
            <div className="mt-6">
              <AddNetworkButton />
            </div>
            <div className="mt-8 rounded-card border border-edge p-4 sm:p-5">
              <p className="text-sm font-semibold text-paper">Robinhood Wallet</p>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Robinhood Wallet supports Robinhood Chain natively. Whether it can connect to this site, through
                WalletConnect or its in-app browser, has not been verified yet. Until it is, use MetaMask or Rabby. This page
                will say so plainly once it is confirmed either way.
              </p>
            </div>
          </section>

          {/* 3 · first bet */}
          <section aria-labelledby="step-bet">
            <StepHeader n={3} id="step-bet" title="Place your first bet" />
            <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">
              Pick a market, choose UP or DOWN, enter {min} to {max} USDG. Your wallet asks for one signature: a USDG
              transfer of exactly that amount into exactly that market and side. Hunch submits it and pays the gas; nobody
              who relays it can change what you signed.
            </p>
            <div className="mt-6 rounded-card border border-dashed border-edge-strong p-4 sm:p-5">
              {deployment.status === 'deployed' ? (
                <p className="text-sm leading-relaxed text-muted">
                  The live markets are on the home page, soonest bell first.{' '}
                  <TextLink href="/#markets">See the markets</TextLink>
                </p>
              ) : (
                <p className="text-sm leading-relaxed text-muted">
                  Markets open at the next opening bell once the venue is live. Nothing here takes a bet yet.{' '}
                  <TextLink href="/#markets">See what will be listed</TextLink>
                </p>
              )}
            </div>
            <ul className="mt-6 grid gap-3 text-sm sm:grid-cols-3">
              {[
                { title: 'No ETH needed', body: 'One signature. Hunch pays the gas.' },
                { title: 'Open until the bell', body: 'Bets are accepted until 4:00 pm ET.' },
                { title: 'Paid automatically', body: 'Winnings arrive in your wallet after settlement.' },
              ].map((item) => (
                <li key={item.title} className="rounded-card border border-edge bg-raised p-4">
                  <p className="font-semibold text-paper">{item.title}</p>
                  <p className="mt-1 text-muted">{item.body}</p>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside className="grid content-start gap-4 lg:sticky lg:top-24">
          <CountryNotice />
          <div className="rounded-card border border-edge p-4 sm:p-5">
            <p className="text-sm font-semibold text-paper">Before you bet</p>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Bet late and you get your stake back plus whatever the other side adds after you. Bet early and you collect
              more.
            </p>
            <p className="mt-3 text-sm">
              <TextLink href="/how-it-works">How payouts work</TextLink>
            </p>
          </div>
          <div className="rounded-card border border-edge p-4 sm:p-5">
            <p className="text-sm font-semibold text-paper">Stuck?</p>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              The docs cover wallets, funding, signing and what each error means.
            </p>
            <p className="mt-3 text-sm">
              <TextLink href="/docs/getting-started">Getting started in the docs</TextLink>
            </p>
          </div>
        </aside>
      </div>
    </Container>
  );
}
