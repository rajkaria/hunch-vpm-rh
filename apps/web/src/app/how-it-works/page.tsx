import type { Metadata } from 'next';

import { B, C, Callout, H2, H3, LI, Lead, P, Table, Terms, Toc, UL } from '@/components/docs/prose';
import { RulesBox } from '@/components/market/RulesBox';
import { AccruedSteps } from '@/components/mechanism/AccruedSteps';
import { HowItWorksSteps } from '@/components/mechanism/HowItWorksSteps';
import {
  WorkedExampleAccumulators,
  WorkedExampleBets,
  WorkedExamplePayouts,
} from '@/components/mechanism/WorkedExampleTable';
import { Container } from '@/components/ui/Container';
import { ButtonLink, SectionHeading, TextLink } from '@/components/ui/primitives';
import { GLOSSARY } from '@/content/glossary';
import { WORKED, exampleRow } from '@/content/worked-example';
import { readDeployment } from '@/lib/deployment';
import { LINKS } from '@/lib/site';
import { formatAmount, formatAmountExact } from '@/lib/units';

export const metadata: Metadata = {
  title: 'How it works',
  description:
    'How Hunch pays an early call more than a late one: what happens to your bet, a worked example, how the bell settles it, and what the rule does not do.',
  alternates: { canonical: '/how-it-works' },
};

const SECTIONS = [
  { id: 'short-version', label: 'The short version' },
  { id: 'your-bet', label: 'What happens to your bet' },
  { id: 'worked-example', label: 'A week, worked through' },
  { id: 'settlement', label: 'How the bell settles it' },
  { id: 'what-it-does-not-do', label: 'What it does not do' },
  { id: 'for-the-curious', label: 'For the curious' },
  { id: 'provenance', label: 'The paper and what came before' },
] as const;

export default function HowItWorksPage() {
  const deployment = readDeployment();
  const feeBps = BigInt(deployment.params.feeBps);
  const mei = exampleRow('Mei');
  const ben = exampleRow('Ben');
  const meiGain = mei.payout - mei.stake;
  const meiFee = (meiGain * feeBps) / 10_000n;

  return (
    <Container className="pb-24 pt-12 sm:pt-16">
      <SectionHeading
        as="h1"
        eyebrow="How it works"
        title="Pool betting that pays for being early"
        lead="Hunch runs UP or DOWN markets on Robinhood Stock Tokens, in USDG, open until the closing bell. Here is the whole thing in plain words, then the arithmetic, then the vocabulary for anyone who wants it."
      />

      <div className="mt-12 grid gap-12 lg:grid-cols-[minmax(0,1fr)_220px] lg:gap-16">
        <article className="min-w-0 max-w-3xl">
          <div className="mb-10 rounded-card border border-edge p-4 lg:hidden">
            <Toc items={SECTIONS} />
          </div>

          <H2 id="short-version">The short version</H2>
          <div className="mt-6">
            <HowItWorksSteps />
          </div>

          <H2 id="your-bet">What happens to your bet</H2>
          <P>
            There is no bookmaker. Everyone&rsquo;s stake goes into one pool, and bettors pay each other. What makes this
            pool different is <B>when</B> money changes hands.
          </P>
          <P>
            The moment your bet lands, it is paid to the people already standing on the other side, in proportion to their
            stakes. It is accepted only up to what they can cover; anything beyond that comes straight back to you. Then,
            from that moment on, every bet against you that arrives is paid, in part, to you.
          </P>
          <P>If your side wins, you are paid your stake plus every opposing dollar that arrived after you. So:</P>
          <UL>
            <LI>
              <B>The earlier you call it, the more you earn.</B> More of the other side&rsquo;s money arrives after an
              early bet than after a late one.
            </LI>
            <LI>
              <B>Your win payout can only go up after you bet.</B> Nobody arriving later can dilute you; what you have
              earned is yours.
            </LI>
            <LI>
              <B>A last-second bet gets its stake back and nothing more (1.00×).</B> Sniping pays nothing, so the market
              can stay open until the bell instead of locking early.
            </LI>
            <LI>
              <B>Big late bets can be partly filled.</B> The part the other side cannot cover comes straight back to you.
            </LI>
            <LI>
              <B>Every dollar in is paid out.</B> Payouts add up to the pool, minus a 2% fee on winners&rsquo; gains.
            </LI>
            <LI>
              <B>Hunch&rsquo;s opening seed cannot lose.</B> Hunch puts a small stake on both sides of every market when it
              lists it; the two halves pay each other first, so the seed comes back whichever side wins. That is why Hunch
              can open every ticker every day.
            </LI>
          </UL>
          <Callout title="Said before you bet, not after">
            <p>
              Bet late and you get your stake back plus whatever the other side adds after you. Bet early and you collect
              more. The bet screen shows what you would be paid at least if your side wins, and that number only goes up.
            </p>
          </Callout>

          <H2 id="worked-example">A week, worked through</H2>
          <P>
            One weekly market, five made-up bettors, and the exact arithmetic the contract runs. Hunch opens it with 10 USDG
            on each side. NVDA closes up, so UP wins. The fee is left out here to keep the numbers clean.
          </P>
          <p className="mt-5 inline-flex items-center rounded-tag border border-paper/25 bg-paper/8 px-2 py-1 text-[11px] leading-none font-semibold tracking-[0.05em] text-paper uppercase">
            Illustration
          </p>
          <H3 id="worked-example-bets">&ldquo;Will NVDA finish the week UP?&rdquo; The bets</H3>
          <div className="mt-4">
            <WorkedExampleBets />
          </div>
          <H3 id="worked-example-payouts">NVDA closes up. What each winner is paid</H3>
          <P>
            The pool is <span className="num text-paper">{formatAmount(WORKED.pool)}</span> USDG. In an ordinary pool every
            winner would be paid the same multiple: the pool over the{' '}
            <span className="num text-paper">{formatAmount(WORKED.winningPrincipal)}</span> USDG staked on UP.
          </P>
          <div className="mt-4">
            <WorkedExamplePayouts />
          </div>
          <P>
            Mei called it on Tuesday and carried the risk through two days of people betting against her: she is paid{' '}
            <span className="num text-paper">{formatAmount(mei.payout)}</span>. Ben bet the obvious side five minutes before
            the bell: he gets his stake back plus a share of the one bet against him that came after. In an ordinary pool
            Ben would have taken <span className="num text-paper">{formatAmount(ben.classic)}</span> of the pool and Mei{' '}
            <span className="num text-paper">{formatAmount(mei.classic)}</span>.
          </P>
          <P>
            Payouts are shown to the cent and never rounded up: the contract pays Mei{' '}
            <span className="num text-paper">{formatAmountExact(mei.payout)}</span> USDG, shown as{' '}
            <span className="num text-paper">{formatAmount(mei.payout)}</span>. With the venue&rsquo;s fee of 2% of the
            gain, Mei&rsquo;s <span className="num text-paper">{formatAmount(meiGain)}</span> gain would carry a fee of{' '}
            <span className="num text-paper">{formatAmount(meiFee)}</span>, and nothing is taken from her stake.
          </P>
          <div className="mt-8">
            <AccruedSteps />
          </div>

          <H2 id="settlement">How the bell settles it</H2>
          <P>
            Each market is decided by two Chainlink prices on Robinhood Chain: the price in effect at the opening bell (9:30
            am ET) and the price in effect at the closing bell (4:00 pm ET, or 1:00 pm on an early-close day). &ldquo;In
            effect&rdquo; means the last Chainlink update at or before that moment. Chainlink updates these stock prices
            whenever the price moves 0.5% or once a day, so there is almost never an update exactly at the bell.
          </P>
          <UL>
            <LI>
              <B>UP</B> wins if the closing price is higher, <B>DOWN</B> if it is lower.
            </LI>
            <LI>
              <B>Same price at both bells:</B> every bet is refunded in full, no fee.
            </LI>
            <LI>
              <B>A price more than 26 hours old at its bell</B> (the feed missed its daily update): refunded in full.
            </LI>
            <LI>
              <B>Robinhood pauses the token&rsquo;s price for a corporate action</B> for more than a day: refunded in full.
            </LI>
            <LI>
              <B>Nobody settles it within 72 hours</B> of the bell: anyone can refund it.
            </LI>
          </UL>
          <P>
            The settlement names the two Chainlink updates by their round ids, and the contract checks on-chain that each
            was really the last update before its bell. Anyone can submit it; the result is the same whoever does. Nobody at
            Hunch can type in or change a price. After settlement, payouts are pushed to every winner automatically.
          </P>
          <P>Every market page carries its own version of this box, with its ticker and dates filled in:</P>
          <div className="mt-5">
            <RulesBox
              label="The rules box, as a weekly NVDA market shows it"
              ticker="NVDA"
              strikeDate="the market's first trading day"
              finalDate="its last trading day"
              maxAge="26 hours"
            />
          </div>

          <H2 id="what-it-does-not-do">What it does not do</H2>
          <UL>
            <LI>
              <B>It pays for taking risk early, not for being right as such.</B> Knowing something pays only if you bet on
              it early.
            </LI>
            <LI>
              <B>The pool split is not a probability.</B> Late in a market, the ratio of UP money to DOWN money is not the
              odds of UP, so this site never shows it as odds. It shows what you would be paid if the market settled now,
              which is exact.
            </LI>
            <LI>
              <B>A late bettor who is right earns about 1×.</B> That is the design, and the bet screen says so before you
              bet.
            </LI>
            <LI>
              <B>Hedging near the close is unattractive.</B> A late bet on the other side earns little even if it wins.
            </LI>
            <LI>
              <B>No order book, no cash-out before the bell, no leverage.</B> A position can be transferred on-chain; a
              buy-back desk is on the roadmap.
            </LI>
          </UL>

          <H2 id="for-the-curious">For the curious</H2>
          <P>
            The design is the <B>Vested Parimutuel</B>. Its vocabulary, one term at a time, in the order the ideas build on
            each other:
          </P>
          <Terms items={GLOSSARY.map((entry) => ({ id: `term-${entry.id}`, term: entry.term, definition: entry.definition }))} />

          <H3 id="the-two-rules">The two rules, precisely</H3>
          <P>
            <B>Rule 1, flow vesting.</B> When a stake lands on one outcome, it is paid, immediately and irrevocably, to the
            positions already standing on the other outcome, pro rata to their accepted principal.
          </P>
          <P>
            <B>Rule 2, capacity matching.</B> A stake is accepted only up to the room the opposing book has to cover it: a
            book may absorb at most κ times its accepted principal in total. Anything beyond that is refused and returned.
          </P>
          <P>
            Bets in the same block form one vintage: they are rationed together against the room as of the vintage start,
            and never pay each other, so transaction ordering inside a block buys nothing. On Robinhood Chain a vintage is
            every bet within one Ethereum block estimate, about 12 seconds.
          </P>
          <P>
            Settlement uses a per-side accumulator <C>A</C>: a winning position with accepted principal <C>s</C> is paid{' '}
            <C>s · (1 + A(T) − A(entry))</C>, where <C>A(entry)</C> is its side&rsquo;s accumulator when it landed and{' '}
            <C>A(T)</C> the value at the bell. Losing positions get 0; on a refund every position gets its accepted principal
            back. The worked example&rsquo;s accumulators, in the contract&rsquo;s 18-decimal arithmetic, truncated to four
            places:
          </P>
          <div className="mt-5">
            <WorkedExampleAccumulators />
          </div>

          <H3 id="parameters">The venue&rsquo;s parameters</H3>
          <Table
            caption="Venue parameters"
            head={['Parameter', 'Value', 'Why']}
            minWidth={560}
            rows={[
              ['Outcomes', 'UP and DOWN', 'Binary only in this version.'],
              ['Late-entry weight', '1', 'A bet at the buzzer is paid exactly its stake back.'],
              ['κ (capacity)', String(deployment.params.kappa), 'On real, bursty flow, 30 refused almost nothing; 9 refused about half.'],
              ['Opening seed', `${formatAmount(BigInt(deployment.params.seedPerLeg), { fractionDigits: 0 })} USDG per side`, 'Small enough that bettors, not the seed, earn most of the early money.'],
              [
                'Bet size',
                `${formatAmount(BigInt(deployment.params.minEntry), { fractionDigits: 0 })} to ${formatAmount(BigInt(deployment.params.maxEntry), { fractionDigits: 0 })} USDG`,
                'Beta limits, fixed per market when it is listed.',
              ],
              ['Fee', `${deployment.params.feeBps / 100}% of a winner's gain`, 'Nothing on stakes, refunds or losing bets.'],
              ['Refund timeout', `${deployment.params.voidTimeoutSec / 3600} hours after the bell`, 'After this anyone can refund an unsettled market.'],
            ]}
          />

          <H2 id="provenance">The paper and what came before</H2>
          <P>
            The rule is specified in <B>The Vested Parimutuel: Settling prediction markets by time priority of capital at
            risk</B> (Karia, Hunch Research, 2nd edition, September 2026), with a conformance suite of 118 test vectors. If
            this page and the paper disagree, the paper wins.
          </P>
          <P>
            Measured on Hunch&rsquo;s four-week paper-money tournament, where most traders were agents deployed by the
            participants (779,549 trades across 5,291 resolved markets): under the ordinary pool rule, winners who arrived in
            the last 10% of a market&rsquo;s life took a median 70.1% of the losing pool, and the last winning-side trade in
            the final 5% earned a median 1.487×. Source: the paper, §13.4.
          </P>
          <Callout title="Pre-event provenance">
            <p>
              The mechanism, the paper, the reference contract, the conformance vectors and the tape replay all predate this
              build (paper 2nd edition 2026-09-02; the Arc testnet venue 2026-09-13).
            </p>
            <p>
              New in this build: the product contract (the reference plus a fee on winnings, delivery of payouts by anyone,
              beta limits, a pause on new bets only, signed gasless bets and read views), the settlement contract that
              proves Chainlink rounds at each bell, the market factory for USDG, the Robinhood Chain deployment, the keeper
              and this site.
            </p>
          </Callout>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href={LINKS.paper} variant="secondary">
              Read the paper
            </ButtonLink>
            <ButtonLink href="/docs/payouts" variant="ghost">
              Payouts in the docs
            </ButtonLink>
          </div>
          <p className="mt-6 text-sm text-muted">
            Ready? <TextLink href="/start">Get set up in 2 minutes</TextLink>.
          </p>
        </article>

        <aside className="hidden lg:block">
          <div className="sticky top-24">
            <Toc items={SECTIONS} />
          </div>
        </aside>
      </div>
    </Container>
  );
}
