import type { Metadata } from 'next';

import { DocPage } from '@/components/docs/DocPage';
import { B, Callout, H2, LI, P, UL } from '@/components/docs/prose';
import { readDeployment } from '@/lib/deployment';
import { BETA_NOTICE, COUNTRY_NOTICE } from '@/lib/site';
import { formatAmount } from '@/lib/units';

export const metadata: Metadata = {
  title: 'Risks and limits',
  description:
    'What can go wrong with Hunch on Robinhood Chain, in plain words: USDG freezes, the chain operator, price feeds, corporate actions, beta limits, an unaudited contract and legal limits.',
  alternates: { canonical: '/docs/risks' },
};

const TOC = [
  { id: 'money', label: 'Your money' },
  { id: 'chain', label: 'The chain' },
  { id: 'prices', label: 'The prices' },
  { id: 'software', label: 'The software' },
  { id: 'legal', label: 'Legal and eligibility' },
  { id: 'not-advice', label: 'Not advice' },
] as const;

export default function RisksDoc() {
  const { params } = readDeployment();
  const max = formatAmount(BigInt(params.maxEntry), { fractionDigits: 0 });

  return (
    <DocPage slug="risks" toc={TOC}>
      <Callout title="Only bet what you can afford to lose" tone="caution">
        <p>
          A losing bet pays nothing. {BETA_NOTICE}
        </p>
      </Callout>

      <H2 id="money">Your money</H2>
      <UL>
        <LI>
          <B>USDG can be frozen or paused by Paxos.</B> Paxos, which issues USDG, can freeze any address or pause the token.
          If a winner&rsquo;s address is frozen, only that payout fails and it waits until Paxos unfreezes it; everyone
          else is paid. A pause of USDG itself would stop every transfer, bets and payouts included, until Paxos lifts it.
          Nothing in these contracts can work around that.
        </LI>
        <LI>
          <B>A losing bet pays nothing; a late winning bet pays little.</B> A bet placed near the bell earns about its stake
          back even if right. That is the design, and the bet panel says so first.
        </LI>
        <LI>
          <B>No early exit.</B> There is no way to cash out before the bell in this version. A position can be transferred
          on-chain, but nobody is obliged to buy it.
        </LI>
      </UL>

      <H2 id="chain">The chain</H2>
      <UL>
        <LI>
          <B>The chain operator can filter transactions.</B> Robinhood Chain runs Arbitrum&rsquo;s ArbOS 61, which lets its
          operator filter transactions, and forcing a transaction in through Ethereum is not a guaranteed way around that.
          There is also no sequencer-uptime feed on this chain. The markets&rsquo; age limits and the 72-hour refund timeout
          are the guards.
        </LI>
        <LI>
          <B>Public RPC limits.</B> The public RPC is rate-limited and keeps little history. The site reads through a keyed
          provider with the public RPC as a fallback, and shows &ldquo;Price unavailable, retrying&rdquo; with the last good
          value rather than a blank.
        </LI>
        <LI>
          <B>Wallets.</B> Some wallets cannot add or switch to chain 4663 on request; the network details on the Start page
          let you add it by hand. Whether Robinhood Wallet can connect to this site is not yet verified.
        </LI>
      </UL>

      <H2 id="prices">The prices</H2>
      <UL>
        <LI>
          <B>The price at the bell can be hours old and up to about 0.5% off the official print.</B> Chainlink&rsquo;s stock
          prices update on 0.5% moves or once a day, so the price in effect at 4:00 pm is the last update before it. The
          rules box says so on every market.
        </LI>
        <LI>
          <B>Calm sessions end flat.</B> If the price never moves 0.5% between the bells, both readings are the same update
          and everyone is refunded. Tickers are checked for how often that happens before they are listed.
        </LI>
        <LI>
          <B>A feed can go quiet.</B> If a price is older than the market&rsquo;s limit at either bell, the market is refunded
          in full, on proof. A feed that misbehaves is taken off the list for new markets.
        </LI>
        <LI>
          <B>A feed can change version mid-market.</B> Settlement then stops rather than guess, the operator is alerted, and
          the 72-hour refund is the backstop.
        </LI>
        <LI>
          <B>Corporate actions.</B> Splits and similar events can pause a token&rsquo;s price. Markets are not listed across
          an announced split; a pause of more than a day after the bell refunds the market.
        </LI>
      </UL>

      <H2 id="software">The software</H2>
      <UL>
        <LI>
          <B>Unaudited.</B> The main contract is the paper&rsquo;s reference contract plus ten listed changes, but no
          external firm has reviewed it. An external review is the first roadmap item.
        </LI>
        <LI>
          <B>Beta limits.</B> At most {max} USDG per bet, a small opening seed, and a pause on new bets that can never stop
          payouts, refunds or settlement. These bound what a bug could cost.
        </LI>
        <LI>
          <B>The keeper can stop.</B> If it does, anyone can settle markets and deliver payouts, and after 72 hours anyone
          can refund an unsettled market.
        </LI>
        <LI>
          <B>The relayer can refuse or be down.</B> Your signed bet can then be sent by anyone, or you can pay the gas
          yourself. The relayer cannot change a bet.
        </LI>
      </UL>

      <H2 id="legal">Legal and eligibility</H2>
      <UL>
        <LI>
          <B>{COUNTRY_NOTICE}</B> It is the same list Robinhood applies to Stock Tokens.
        </LI>
        <LI>
          <B>Prediction markets are regulated in many countries,</B> and bets on stock prices can resemble products that
          some regulators restrict for retail customers. Make sure it is legal where you are. Hunch does not claim this
          venue complies with any particular regime.
        </LI>
        <LI>
          <B>The country block is a front-end control.</B> The contracts are permissionless; this site blocks and asks, the
          chain does not.
        </LI>
      </UL>

      <H2 id="not-advice">Not advice</H2>
      <P>
        Nothing on this site is investment, financial, legal or tax advice. Hunch is not affiliated with Robinhood,
        Chainlink or Paxos, and a market on a Stock Token&rsquo;s price is not an offer of that token or of any security.
      </P>
    </DocPage>
  );
}
