import type { Metadata } from 'next';

import { DocPage } from '@/components/docs/DocPage';
import { B, C, Callout, CodeBlock, H2, H3, LI, OL, P, Step, Table, UL } from '@/components/docs/prose';
import { AddressLink } from '@/components/market/AddressLink';
import { RulesBox } from '@/components/market/RulesBox';
import { TextLink } from '@/components/ui/primitives';
import { TICKERS } from '@/content/tickers';
import { readDeployment } from '@/lib/deployment';
import { ROBINHOOD_CHAIN } from '@/lib/site';
import { formatDuration } from '@/lib/time';

export const metadata: Metadata = {
  title: 'Markets and settlement',
  description:
    'Daily and weekly markets on Robinhood Stock Tokens, trading sessions, the Chainlink price in effect at the bell, refunds, round proofs and how to settle a market yourself.',
  alternates: { canonical: '/docs/markets' },
};

const TOC = [
  { id: 'families', label: 'Daily and weekly' },
  { id: 'sessions', label: 'Sessions and times' },
  { id: 'feeds', label: 'The price feeds' },
  { id: 'price-in-effect', label: 'The price in effect at the bell' },
  { id: 'tickers', label: 'Tickers' },
  { id: 'outcomes', label: 'UP, DOWN and refunds' },
  { id: 'rules-box', label: 'The rules box' },
  { id: 'round-proofs', label: 'Round proofs' },
  { id: 'resolve-it-yourself', label: 'Resolve it yourself' },
  { id: 'refund-drill', label: 'The refund drill' },
] as const;

export default function MarketsDoc() {
  const deployment = readDeployment();
  const bound = formatDuration(deployment.feeds[0]?.maxFinalAge ?? 93_600);

  return (
    <DocPage slug="markets" toc={TOC}>
      <H2 id="families">Daily and weekly</H2>
      <P>Two kinds of market, both UP or DOWN on one Stock Token:</P>
      <UL>
        <LI>
          <B>Daily:</B> &ldquo;Will TSLA close UP today? · Wed Sep 30&rdquo;. Opening price at 9:30 am ET, closing price at
          4:00 pm ET, the same trading day. Listed before 9:30 am ET for every allowed ticker, every trading day.
        </LI>
        <LI>
          <B>Weekly:</B> &ldquo;Will NVDA finish the week UP? · Tue Sep 29 → Fri Oct 2&rdquo;. Opening price at the
          week&rsquo;s first opening bell, closing price at Friday&rsquo;s closing bell.
        </LI>
      </UL>
      <P>
        Question text is generated from the market&rsquo;s spec, never written by hand, and bets are accepted from listing
        until the closing bell. The spec (feed, times, age limits, seed, limits, fee) is fixed when the market is listed and
        cannot be changed afterwards by anyone.
      </P>

      <H2 id="sessions">Sessions and times</H2>
      <P>
        All times are New York time. The opening bell is 9:30 am ET on a NYSE trading day; the closing bell is 4:00 pm ET,
        or 1:00 pm ET on an early-close day. New York is on EDT (UTC−4) until Sunday November 1, 2026 at 2:00 am, then EST
        (UTC−5): the opening bell is 13:30 UTC until then and 14:30 UTC after.
      </P>
      <Table
        caption="NYSE closures and early closes in 2026"
        head={['2026', 'Dates']}
        minWidth={320}
        rows={[
          ['Closed', 'Jan 1, Jan 19, Feb 16, Apr 3, May 25, Jun 19, Jul 3, Sep 7, Nov 26, Dec 25'],
          ['Early close (1:00 pm ET)', 'Nov 27, Dec 24'],
        ]}
      />
      <P>No market is listed for a day the exchange is closed, or for a ticker with an announced split inside the window.</P>

      <H2 id="feeds">The price feeds</H2>
      <P>
        Robinhood Chain&rsquo;s stock prices are Chainlink US equity feeds. They take in overnight, pre-market, regular and
        after-hours trading, and they do not update on weekends or US market holidays: on chain they run from Sunday 8:00 pm
        ET to Friday about 8:00 pm ET. Each feed updates when the price moves <B>0.5%</B> from its last update, or once every
        <B> 24 hours</B>, with 8 decimals.
      </P>
      <P>
        The price is the <B>Stock Token&rsquo;s</B>: the share price times the token&rsquo;s multiplier, which Robinhood
        adjusts for dividends and splits. So the series stays continuous through a split, and UP or DOWN keeps its meaning.
      </P>

      <H2 id="price-in-effect">The price in effect at the bell</H2>
      <P>
        There is almost never a Chainlink update exactly at 9:30 or 4:00 pm. So every reading here is <B>the price in effect
        at that moment: the answer of the last update at or before it</B>. It is Chainlink&rsquo;s attestation of the price
        at that time, within its 0.5% band, which means it can differ from the exchange&rsquo;s official print by up to
        about 0.5%.
      </P>
      <Callout title="Why not the official close?">
        <p>
          Nobody on-chain can prove what the exchange printed at 4:00 pm. The Chainlink round can be proven, by anyone,
          forever, and nobody (Hunch included) can type it in. The rules box says so on every market.
        </p>
      </Callout>

      <H2 id="tickers">Tickers</H2>
      <P>
        Standard Chainlink proxies on chain {ROBINHOOD_CHAIN.id} (not the SVR proxies). Addresses are taken from Robinhood&rsquo;s
        contract list and checked on-chain; look-alike tokens with the same names exist, so never pick a token by its
        symbol.
      </P>
      <div className="scroll-x mt-5 rounded-card border border-edge">
        <table className="data-table min-w-[560px]">
          <caption className="sr-only">Tickers, their Stock Tokens and their Chainlink feeds</caption>
          <thead>
            <tr>
              <th scope="col">Ticker</th>
              <th scope="col">Stock Token</th>
              <th scope="col">Chainlink feed</th>
              <th scope="col">Listed</th>
            </tr>
          </thead>
          <tbody>
            {TICKERS.map((ticker) => (
              <tr key={ticker.ticker}>
                <td className="font-semibold text-paper">
                  {ticker.ticker}
                  <span className="block text-xs font-normal text-faint">{ticker.name}</span>
                </td>
                <td>
                  <AddressLink address={ticker.stockToken} />
                </td>
                <td>
                  <AddressLink address={ticker.feed} />
                </td>
                <td className="text-muted">{ticker.v1 === 'yes' ? 'Yes' : 'If its feed passes the flat-rate check'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <P>
        Before a ticker is allowed, its feed is checked: the right description and 8 decimals, the longest gap between
        updates within a week, and how often a whole session passes without a single update (a session like that ends
        FLAT and refunds). Daily markets need that to happen on at most 25% of sessions; weekly markets on at most 10% of
        weeks. SPY is left out: its feed has gone up to a day without an update mid-week, and a calm index would refund too
        often.
      </P>

      <H2 id="outcomes">UP, DOWN and refunds</H2>
      <Table
        caption="How a market ends"
        head={['What happened', 'Result', 'Fee']}
        minWidth={480}
        rows={[
          ['Closing price higher than opening price', 'UP wins', '2% of winners’ gains'],
          ['Closing price lower', 'DOWN wins', '2% of winners’ gains'],
          ['Same price (often the same Chainlink update)', 'FLAT: every bet refunded in full', 'None'],
          [`A price more than ${bound} old at its bell`, 'Refunded in full, once proven stale', 'None'],
          ["Robinhood pauses the token's price for a corporate action", 'Settlement waits; refunded if still paused 24 hours after the bell', 'None'],
          ['Nobody settles or refunds it', 'Anyone can refund it 72 hours after the bell', 'None'],
        ]}
      />
      <P>
        The age limit ({bound}: the 24-hour heartbeat plus 2 hours) catches a feed that missed its daily update. A market
        can be refunded for staleness only when the proven rounds actually break the limit; a good market cannot be
        refunded by mistake, and settlement itself never refunds for staleness.
      </P>

      <H2 id="rules-box">The rules box</H2>
      <P>Every market page opens with this, with its own ticker, dates and limit filled in. Never shortened, never hidden.</P>
      <div className="mt-5">
        <RulesBox ticker="NVDA" strikeDate="the market's first trading day" finalDate="its last trading day" maxAge="26 hours" label="Template" />
      </div>

      <H2 id="round-proofs">Round proofs</H2>
      <P>
        Settlement names two Chainlink rounds by id, one for each bell, and the settlement contract checks that each is
        really <B>the last update at or before its bell</B>:
      </P>
      <UL>
        <LI>
          the round&rsquo;s time is at or before the bell, and its answer is positive and inside a sanity band (older rounds
          of some feeds hold garbage, so no historical round is trusted blindly);
        </LI>
        <LI>
          and either the next round&rsquo;s time is after the bell, or there is no next round yet and this is the
          feed&rsquo;s latest (possible only because settlement runs after the bell).
        </LI>
      </UL>
      <P>
        Round ids carry a phase (Chainlink&rsquo;s aggregator version) in their top bits. If a feed switched phase between a
        round and the bell, settlement stops with <C>PhaseBoundary</C> rather than guess; the operator is alerted, and the
        72-hour refund remains the backstop. Any other pair of rounds is rejected with <C>BadProof</C>, so there is exactly
        one valid answer for every market, whoever submits it.
      </P>

      <H2 id="resolve-it-yourself">Resolve it yourself</H2>
      <P>
        Hunch&rsquo;s keeper settles every market within minutes of the bell, but it is a convenience, not an authority.
        Anyone can do it, with the same result:
      </P>
      <OL>
        <Step n={1} title="Wait for the bell">
          Settlement is accepted from the closing bell on. The keeper waits a further 60 seconds.
        </Step>
        <Step n={2} title="Find the two rounds">
          For the opening and the closing bell, the last round of the market&rsquo;s feed at or before each. Walk back from
          <C> latestRoundData</C> with <C>getRoundData</C>; the public RPC keeps little history, but past rounds are
          current-state reads and always work.
        </Step>
        <Step n={3} title="Preview">
          <C>preview(specId, strikeRound, finalRound)</C> on the settlement contract returns the status (1 UP, 2 DOWN, 3
          FLAT, 4 STALE, 5 BADPROOF, 6 PAUSED, 7 BADANSWER) and both prices, without sending anything.
        </Step>
        <Step n={4} title="Settle">
          UP, DOWN or FLAT: call <C>resolve(specId, strikeRound, finalRound)</C>. STALE: call{' '}
          <C>voidStale(specId, strikeRound, finalRound)</C>. BADANSWER (a price out of range): call{' '}
          <C>voidBadAnswer(specId, strikeRound, finalRound)</C>. Any wallet can; the gas is well under a cent. Once betting
          opens, each market page has a &ldquo;Resolve it yourself&rdquo; button that does this for you.
        </Step>
      </OL>
      <CodeBlock label="With Foundry's cast (addresses from the Contracts page)">{`RPC=https://rpc.mainnet.chain.robinhood.com

# The market's spec id
cast call $RESOLVER "specIdOf(address,uint256)(bytes32)" $HUNCH_VPM $MARKET_ID --rpc-url $RPC

# Check the two rounds (status, strike price, strike time, final price, final time)
cast call $RESOLVER "preview(bytes32,uint80,uint80)(uint8,int256,uint256,int256,uint256)" \\
  $SPEC_ID $STRIKE_ROUND $FINAL_ROUND --rpc-url $RPC

# Settle it (any wallet)
cast send $RESOLVER "resolve(bytes32,uint80,uint80)" $SPEC_ID $STRIKE_ROUND $FINAL_ROUND \\
  --rpc-url $RPC --account <your-keystore>`}</CodeBlock>
      <P>
        After settlement, payouts and refunds are delivered to owners with <C>claimFor(positionId)</C> and{' '}
        <C>withdrawRefundFor(positionId)</C>, which anyone may call; the money always goes to the position&rsquo;s owner.
      </P>

      <H2 id="refund-drill">The refund drill</H2>
      <P>
        To show a refund happening for real, one labelled market is built to fail its price check: it takes Friday&rsquo;s
        opening price and a closing time of 2:00 am ET on Saturday, with a one-hour age limit. Chainlink&rsquo;s stock
        prices do not update on Saturdays (the last update is Friday around 8:00 pm ET), so at 2:00 am the price in effect is
        at least six hours old. That is provably stale, anyone can refund it, and every bet, Hunch&rsquo;s seed included,
        comes back in full. A lister may only tighten a feed&rsquo;s age limit, never loosen it. The result, with every
        refund transaction, goes on the <TextLink href="/proof#refund-drill">Proof</TextLink> page.
      </P>
      <H3 id="weekends">Weekends and holidays</H3>
      <P>
        Because the feeds pause, a price on a Saturday morning is Friday evening&rsquo;s, and this site shows its age
        (&ldquo;updated Fri 3:56 pm ET&rdquo;) rather than pretending it is live. Weekend markets, Friday close to Monday
        open with an 80-hour limit, are on the roadmap.
      </P>
    </DocPage>
  );
}
