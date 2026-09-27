import type { Metadata } from 'next';
import Link from 'next/link';

import { DocPage } from '@/components/docs/DocPage';
import { B, Callout, H2, LI, P, Table, UL } from '@/components/docs/prose';
import { DOCS, docHref } from '@/content/docs-nav';
import { readDeployment } from '@/lib/live/deployment';
import { COUNTRY_NOTICE, LATE_RULE } from '@/lib/site';
import { formatAmount } from '@/lib/units';

export const metadata: Metadata = {
  title: 'Docs',
  description: 'Hunch on Robinhood Chain documentation: getting started, payouts, markets and settlement, gasless betting, contracts, keeper, API, risks.',
  alternates: { canonical: '/docs' },
};

const TOC = [
  { id: 'what-it-is', label: 'What it is' },
  { id: 'status', label: 'Status' },
  { id: 'markets', label: 'The markets' },
  { id: 'key-facts', label: 'Key facts' },
  { id: 'these-docs', label: 'These docs' },
] as const;

export default function DocsOverview() {
  const deployment = readDeployment();
  const { params } = deployment;
  const min = formatAmount(BigInt(params.minEntry), { fractionDigits: 0 });
  const max = formatAmount(BigInt(params.maxEntry), { fractionDigits: 0 });

  return (
    <DocPage slug="" toc={TOC}>
      <H2 id="what-it-is">What it is</H2>
      <P>
        <B>Prediction markets on Robinhood Stock Tokens that pay an early call more than a late one, and stay open until
        the closing bell.</B> You bet UP or DOWN on whether a Stock Token&rsquo;s price will be higher or lower at the
        closing bell than at the opening bell, in USDG on Robinhood Chain. Chainlink&rsquo;s price feed decides; nobody
        types in a price.
      </P>
      <P>
        What makes it different is the payout rule. In an ordinary pool, the pot is split at the end in proportion to
        stake, so a dollar that arrives at 3:59 pm is paid the same multiple as the dollar that took the risk at 9:30 am.
        Here, the moment a bet lands it is paid to the people already on the other side. {LATE_RULE}
      </P>

      <H2 id="status">Status</H2>
      {deployment.status === 'deployed' ? (
        <P>
          The contracts are deployed on Robinhood Chain mainnet (chain id 4663). Addresses are on the{' '}
          <Link href="/docs/contracts" className="text-paper underline decoration-paper/25 underline-offset-4">
            Contracts
          </Link>{' '}
          page and the{' '}
          <Link href="/proof" className="text-paper underline decoration-paper/25 underline-offset-4">
            Proof
          </Link>{' '}
          page.
        </P>
      ) : (
        <Callout title="Launching: not yet deployed">
          <p>
            The contracts are not deployed on Robinhood Chain yet, so no market is open. These docs describe the venue as
            it is built; anything that needs a deployment says so where it matters. The Chainlink feeds and USDG it depends
            on are live today.
          </p>
        </Callout>
      )}
      <Callout title="Beta, unaudited" tone="caution">
        <p>
          This is a beta on mainnet with small limits ({min} to {max} USDG per bet). The contracts have not had an external
          audit. {COUNTRY_NOTICE}
        </p>
      </Callout>

      <H2 id="markets">The markets</H2>
      <P>Binary only: the outcomes are the words UP and DOWN.</P>
      <Table
        caption="The market catalogue"
        head={['Family', 'Question', 'Opening price', 'Closing price', 'Bets close']}
        minWidth={640}
        rows={[
          [
            'Weekly',
            '“Will NVDA finish the week UP?”',
            "Chainlink price in effect at the week's first 9:30 am ET",
            'Chainlink price in effect at Friday 4:00 pm ET',
            'Friday 4:00 pm ET',
          ],
          [
            'Daily',
            '“Will TSLA close UP today?”',
            'Chainlink price in effect at 9:30 am ET',
            'Chainlink price in effect at 4:00 pm ET',
            '4:00 pm ET',
          ],
        ]}
      />
      <P>
        Tickers: NVDA, TSLA and AAPL, plus COIN if its price feed passes the check for how often it goes a whole session
        without moving. SPY is left out: its feed can go a day without an update, and a calm index would end in a refund
        too often.
      </P>

      <H2 id="key-facts">Key facts</H2>
      <UL>
        <LI>
          <B>Stake asset:</B> USDG only. {min} to {max} USDG per bet during the beta.
        </LI>
        <LI>
          <B>Fee:</B> {params.feeBps / 100}% of a winner&rsquo;s gain (payout minus stake), taken when paid. Nothing on stakes,
          refunds, refunded markets or losing bets.
        </LI>
        <LI>
          <B>Refunds:</B> same price at both bells, a price older than its limit, or a corporate-action pause of more than a
          day refunds every bet in full with no fee.
        </LI>
        <LI>
          <B>No ETH needed:</B> a bet is one signature over USDG; Hunch sends it and pays the gas.
        </LI>
        <LI>
          <B>Paid automatically:</B> after settlement, payouts are pushed to every winner. Anyone can deliver a payout, and it
          always goes to its owner.
        </LI>
        <LI>
          <B>Two privileged actions:</B> listing markets and pausing new bets. Neither can move a stake, set a price, or stop
          claims, refunds or settlement.
        </LI>
      </UL>

      <H2 id="these-docs">These docs</H2>
      <ul className="mt-5 grid gap-3 sm:grid-cols-2">
        {DOCS.filter((doc) => doc.slug !== '').map((doc) => (
          <li key={doc.slug}>
            <Link
              href={docHref(doc.slug)}
              className="flex h-full flex-col rounded-card border border-edge bg-raised p-4 transition-colors hover:border-paper/20 hover:bg-raised-2"
            >
              <span className="text-[15px] font-semibold text-paper">{doc.title}</span>
              <span className="mt-1.5 text-sm leading-relaxed text-muted">{doc.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </DocPage>
  );
}
