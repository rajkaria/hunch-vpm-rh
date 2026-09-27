import type { Metadata } from 'next';

import { DocPage } from '@/components/docs/DocPage';
import { B, C, Callout, H2, LI, P, Table, UL } from '@/components/docs/prose';
import { AccruedSteps } from '@/components/mechanism/AccruedSteps';
import { WorkedExampleBets, WorkedExamplePayouts } from '@/components/mechanism/WorkedExampleTable';
import { TextLink } from '@/components/ui/primitives';
import { WORKED, exampleRow } from '@/content/worked-example';
import { readDeployment } from '@/lib/live/deployment';
import { LATE_RULE } from '@/lib/site';
import { formatAmount, formatAmountExact } from '@/lib/units';

export const metadata: Metadata = {
  title: 'How payouts work',
  description: 'Why an early call is paid more on Hunch, the 1.00× late rule, partial fills, the 2% fee on winnings and rounding.',
  alternates: { canonical: '/docs/payouts' },
};

const TOC = [
  { id: 'plain-words', label: 'In plain words' },
  { id: 'worked-example', label: 'The worked example' },
  { id: 'only-goes-up', label: 'It only goes up' },
  { id: 'late-rule', label: 'The late bet: 1.00×' },
  { id: 'partial-fills', label: 'Partial fills' },
  { id: 'fee', label: 'The fee' },
  { id: 'rounding', label: 'Rounding and leftovers' },
  { id: 'seed', label: "Hunch's opening seed" },
  { id: 'ordinary-pool', label: 'The ordinary-pool comparison' },
] as const;

function net(payout: bigint, stake: bigint, feeBps: bigint): { gain: bigint; fee: bigint; net: bigint } {
  const gain = payout - stake;
  const fee = (gain * feeBps) / 10_000n;
  return { gain, fee, net: payout - fee };
}

export default function PayoutsDoc() {
  const { params } = readDeployment();
  const feeBps = BigInt(params.feeBps);
  const mei = exampleRow('Mei');
  const ben = exampleRow('Ben');
  const meiNet = net(mei.payout, mei.stake, feeBps);
  const benNet = net(ben.payout, ben.stake, feeBps);
  const residue = WORKED.pool - WORKED.rows.reduce((sum, row) => sum + row.payout, 0n) - WORKED.seedUp.payout;

  return (
    <DocPage slug="payouts" toc={TOC}>
      <H2 id="plain-words">In plain words</H2>
      <P>
        Everyone&rsquo;s stake goes into one pool; there is no bookmaker. Two rules decide who gets what:
      </P>
      <UL>
        <LI>
          <B>The moment a bet lands, it is paid to the people already on the other side,</B> in proportion to their stakes.
          That money is theirs if their side wins, and nothing that happens later can take it back.
        </LI>
        <LI>
          <B>A bet is accepted only up to what the other side can cover.</B> The other side can take in at most{' '}
          {params.kappa} times its own stake in total. Anything beyond that comes back to you.
        </LI>
      </UL>
      <P>
        So if your side wins, you are paid <B>your accepted stake plus your share of every opposing dollar that arrived after
        you</B>, shared with the people who were already on your side when it arrived, in proportion to stake. Losing bets
        are paid nothing. {LATE_RULE}
      </P>
      <P>
        The arithmetic is one running total per side; the <TextLink href="/how-it-works#for-the-curious">For the curious</TextLink>{' '}
        section of How it works has it in full, including the formula <C>s · (1 + A(T) − A(entry))</C>.
      </P>

      <H2 id="worked-example">The worked example</H2>
      <P>
        A weekly NVDA market with made-up bettors, replayed with the contract&rsquo;s own arithmetic. Hunch lists it with 10
        USDG on each side, and NVDA closes up. The fee is left out here.
      </P>
      <div className="mt-5">
        <WorkedExampleBets />
      </div>
      <div className="mt-5">
        <WorkedExamplePayouts />
      </div>

      <H2 id="only-goes-up">It only goes up</H2>
      <P>
        What a bet would be paid if its side won right now can only rise while the market is open. A later bet on your side
        does not dilute you (it shares only in what arrives after it), and a later bet on the other side adds to you. The
        market page shows this number for every position: &ldquo;If UP wins now: 23.40 USDG · was 20.00 when you
        bet.&rdquo;
      </P>
      <div className="mt-5">
        <AccruedSteps />
      </div>
      <Callout title="The pool split is not a probability">
        <p>
          Late in a market, the share of money on UP is not the chance of UP, so this site never shows it as odds. It shows
          what each position would be paid if the market settled now, which is exact.
        </p>
      </Callout>

      <H2 id="late-rule">The late bet: 1.00×</H2>
      <P>
        A bet placed a moment before the bell, with nothing arriving after it, wins exactly its stake back: 1.00×. That is
        the design. It is what lets a market stay open until the closing bell instead of locking early to stop sniping:
        sniping pays nothing. A late bet is not harmed either; it is simply not paid for information everyone already had.
      </P>
      <P>
        In the example, Ben bet <span className="num text-paper">{formatAmount(ben.stake)}</span> UP five minutes before the
        bell. One DOWN bet came after him, so he is paid{' '}
        <span className="num text-paper">{formatAmount(ben.payout)}</span>. In an ordinary pool he would have taken{' '}
        <span className="num text-paper">{formatAmount(ben.classic)}</span>, most of it from people who called it days
        earlier.
      </P>

      <H2 id="partial-fills">Partial fills</H2>
      <P>
        Each side can take in at most {params.kappa} times its own stake from the other side, in total. Right after listing,
        the DOWN side holds the 10 USDG seed, so it can absorb 300, of which 10 is already used by the seed&rsquo;s own UP
        half: the first UP bet can be accepted up to 290. A bet of 400 would be accepted 290 and 110 would be returned.
        With the beta limit of {formatAmount(BigInt(params.maxEntry), { fractionDigits: 0 })} USDG per bet and a limit of{' '}
        {params.kappa}× this should be rare, but the bet panel always quotes &ldquo;Accepted now&rdquo; before you sign.
      </P>
      <P>
        Bets that land within the same Ethereum block (about 12 seconds on Robinhood Chain) are matched together as one
        batch: they are rationed pro rata on the amounts offered, against the room as it stood when the batch began, and
        they never pay each other. So the order of transactions inside a batch buys nothing.
      </P>
      <P>
        The returned part can be withdrawn from the next block on. You do not have to: Hunch&rsquo;s keeper sends it back
        automatically, usually within minutes, and anyone can send it sooner. It always goes to you. The position shows it
        plainly, for example &ldquo;110 USDG returned (the other side could only cover 290)&rdquo;.
      </P>

      <H2 id="fee">The fee</H2>
      <P>
        Hunch keeps <B>{params.feeBps / 100}% of a winner&rsquo;s gain</B>, the payout minus the stake, taken when the payout is
        sent. There is no fee on your stake, on refunds, on refunded markets, on losing bets, or on any part of a bet that
        was returned.
      </P>
      <Table
        caption="The fee on the worked example's winners"
        head={['Winner', 'Paid', 'Gain', 'Fee', 'Received']}
        numeric={[1, 2, 3, 4]}
        minWidth={460}
        rows={[
          ['Mei', formatAmount(mei.payout), formatAmount(meiNet.gain), formatAmount(meiNet.fee), formatAmount(meiNet.net)],
          ['Ben', formatAmount(ben.payout), formatAmount(benNet.gain), formatAmount(benNet.fee), formatAmount(benNet.net)],
        ]}
      />
      <P>
        Fees collect inside the contract and anyone can sweep them to the treasury Safe. The sweep is separate from payouts
        on purpose: a transfer to the treasury can never make a payout fail.
      </P>

      <H2 id="rounding">Rounding and leftovers</H2>
      <P>
        The contract divides with floor rounding, in USDG&rsquo;s 6 decimals, so nobody is ever paid a fraction more than the
        pool holds. This site shows money to the cent and never rounds a payout up: the contract pays Mei{' '}
        <span className="num text-paper">{formatAmountExact(mei.payout)}</span> USDG and the site shows <span className="num text-paper">{formatAmount(mei.payout)}</span>.
      </P>
      <P>
        Every dollar in is paid out: payouts add up to the pool. The rounding leaves a few millionths of a USDG at most
        (<span className="num text-paper">{residue.toString()}</span> millionth in the example), which goes to the treasury
        Safe.
      </P>

      <H2 id="seed">Hunch&rsquo;s opening seed</H2>
      <P>
        Hunch lists every market with {formatAmount(BigInt(params.seedPerLeg), { fractionDigits: 0 })} USDG on each side. The
        two halves are each other&rsquo;s first counterparties, so the seed gets back at least what it put in whichever side
        wins; that is why Hunch can open every ticker every day. The seed is small on purpose, so that bettors, not the
        seed, earn most of the early money. It appears in every book as &ldquo;Hunch opening seed&rdquo;, and Hunch&rsquo;s
        wallets are never counted as bettors.
      </P>

      <H2 id="ordinary-pool">The ordinary-pool comparison</H2>
      <P>
        After a market settles, its book shows one more column: what an ordinary pool would have paid each winner, which is
        the pool divided by the winning side&rsquo;s stakes, times your stake. It is worked out off-chain from the same
        bets, for comparison only; the contract pays by the rule above.
      </P>
    </DocPage>
  );
}
