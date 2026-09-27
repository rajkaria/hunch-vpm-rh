import type { Metadata } from 'next';

import { DocPage } from '@/components/docs/DocPage';
import { B, C, Callout, H2, H3, LI, OL, P, Step, Table, UL } from '@/components/docs/prose';
import { TextLink } from '@/components/ui/primitives';
import { readDeployment } from '@/lib/live/deployment';
import { LATE_RULE, LINKS, ROBINHOOD_CHAIN, USDG } from '@/lib/site';
import { formatAmount } from '@/lib/units';

export const metadata: Metadata = {
  title: 'Getting started',
  description: 'A wallet, USDG on Robinhood Chain, and your first bet on Hunch, step by step, with what each error means.',
  alternates: { canonical: '/docs/getting-started' },
};

const TOC = [
  { id: 'what-you-need', label: 'What you need' },
  { id: 'wallet', label: '1. A wallet on Robinhood Chain' },
  { id: 'usdg', label: '2. USDG' },
  { id: 'first-bet', label: '3. Your first bet' },
  { id: 'after-the-bell', label: 'After the bell' },
  { id: 'troubleshooting', label: 'Troubleshooting' },
] as const;

export default function GettingStarted() {
  const { params } = readDeployment();
  const min = formatAmount(BigInt(params.minEntry), { fractionDigits: 0 });
  const max = formatAmount(BigInt(params.maxEntry), { fractionDigits: 0 });

  return (
    <DocPage slug="getting-started" toc={TOC}>
      <H2 id="what-you-need">What you need</H2>
      <UL>
        <LI>
          <B>A wallet that can use Robinhood Chain.</B> A browser wallet such as MetaMask or Rabby works. WalletConnect
          wallets connect through a QR code once betting opens.
        </LI>
        <LI>
          <B>USDG on Robinhood Chain.</B> At least {min} USDG; a bet is {min} to {max} USDG during the beta.
        </LI>
        <LI>
          <B>No ETH.</B> A bet is a signature, and Hunch pays the gas. You only need ETH if you choose to send the
          transaction yourself.
        </LI>
        <LI>
          <B>To be eligible.</B> Stock-price markets are not offered to persons in the United States, Canada, the United
          Kingdom or Switzerland.
        </LI>
      </UL>

      <H2 id="wallet">1. A wallet on Robinhood Chain</H2>
      <P>
        On the <TextLink href="/start">Start</TextLink> page, the add button puts Robinhood Chain into a browser wallet and
        switches to it in one step. It is free: adding and switching networks sends no transaction. To add it by hand:
      </P>
      <Table
        caption="Robinhood Chain network details"
        head={['Field', 'Value']}
        minWidth={320}
        rows={[
          ['Network name', ROBINHOOD_CHAIN.name],
          ['Chain ID', <span key="id" className="num">{`${ROBINHOOD_CHAIN.id} (${ROBINHOOD_CHAIN.idHex})`}</span>],
          ['RPC URL', <span key="rpc" className="num break-hash">{ROBINHOOD_CHAIN.rpcUrl}</span>],
          ['Currency symbol', 'ETH'],
          ['Block explorer', <span key="ex" className="num break-hash">{ROBINHOOD_CHAIN.explorerUrl}</span>],
        ]}
      />
      <H3 id="robinhood-wallet">Robinhood Wallet</H3>
      <P>
        Robinhood Wallet supports Robinhood Chain natively. Whether it can connect to this site, through WalletConnect or
        its in-app browser, has not been verified yet. Until it is, use MetaMask or Rabby; the Start page will say plainly
        once it is confirmed either way.
      </P>

      <H2 id="usdg">2. USDG</H2>
      <P>
        USDG is Paxos&rsquo;s Global Dollar, the chain&rsquo;s native dollar, with 6 decimals. On Robinhood Chain it is{' '}
        <C>{USDG.address}</C>. Look-alike tokens exist; check the address.
      </P>
      <P>
        The quickest route is <B>USDC on Arbitrum One or Base, bridged with Across</B>: one transaction on{' '}
        <TextLink href={LINKS.across}>across.to</TextLink>, and it arrives as USDG on Robinhood Chain in seconds. Other
        routes (ETH through Relay and a swap, USDG from Ethereum or Solana through Stargate, the Arbitrum bridge) are listed
        with their links on the <TextLink href="/start">Start</TextLink> page.
      </P>

      <H2 id="first-bet">3. Your first bet</H2>
      <OL>
        <Step n={1} title="Open a market">
          From the home page, tap a market. Its page starts with the rules box: exactly which two Chainlink prices decide it,
          when bets close, and when everyone is refunded. Read it once; it is the contract.
        </Step>
        <Step n={2} title="Pick UP or DOWN and an amount">
          Between {min} and {max} USDG. The bet panel shows your USDG balance on Robinhood Chain.
        </Step>
        <Step n={3} title="Read the quote">
          Before you sign, the panel tells you: how much is accepted now (and how much would come straight back if the other
          side cannot cover it all), what you would be paid at least if your side wins, which only goes up as people bet the
          other way, that the fee is 2% of winnings only, and that no ETH is needed. It also says the rule: {LATE_RULE}
        </Step>
        <Step n={4} title="Place the bet">
          The button walks you through connect, then switching to Robinhood Chain (free), then one signature. The first time
          in a session you also confirm you are not a resident of a blocked country and that prediction markets are legal
          where you are.
        </Step>
        <Step n={5} title="Watch it land">
          Hunch submits your signed bet and pays the gas. Bets are matched in batches of about 12 seconds, so your position
          appears within about 15 seconds, with what it would be paid right now.
        </Step>
      </OL>
      <Callout title="Prefer to pay the gas yourself?">
        <p>
          Every bet can also be sent as a normal transaction: switch to Robinhood Chain, approve USDG once, then place the
          bet. It costs well under a cent of ETH.
        </p>
      </Callout>

      <H2 id="after-the-bell">After the bell</H2>
      <P>
        Bets close at the closing bell. The market is then settled from the two Chainlink prices, and payouts are pushed to
        every winner automatically; you do not need to come back and claim. If the market is refunded, every stake comes
        back the same way. Your positions, open and settled, are on the Portfolio page once betting opens.
      </P>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <Table
        caption="What each problem means and what to do"
        head={['You see', 'What it means', 'What to do']}
        minWidth={600}
        rows={[
          ['“Switch to Robinhood Chain”', 'Your wallet is on another network, and it can only sign a bet on Robinhood Chain.', 'Press it. If the wallet does not know the chain, it is added first, then selected.'],
          ['The wallet will not add the network', 'Some wallets refuse programmatic network changes.', 'Add it by hand with the details above.'],
          ['“You declined in your wallet”', 'The signature or switch was cancelled. Nothing was sent.', 'Try again when ready.'],
          ['“Not available in your country”', 'Stock-price markets are not offered where you are.', 'The page stays readable; betting is off.'],
          ['“Entries paused”', 'The Safe has paused new bets, usually while a suspected problem is checked.', 'Claims, refunds and settlement keep working. Wait for the pause to lift.'],
          ['“Bets are closed”', 'The closing bell has rung.', 'Watch settlement on the market page.'],
          ['Only part of the bet was accepted', 'The other side could not cover all of it.', 'The rest comes back to you automatically, usually within minutes.'],
        ]}
      />
    </DocPage>
  );
}
