import type { Metadata } from 'next';

import { DocPage } from '@/components/docs/DocPage';
import { B, C, Callout, H2, LI, P, Table, UL } from '@/components/docs/prose';
import { TextLink } from '@/components/ui/primitives';

export const metadata: Metadata = {
  title: 'Keeper and operations',
  description:
    "Hunch's keeper lists, settles and pays out markets on a schedule. Every job it does, anyone can do. Jobs, the refund policy, wallets and health checks.",
  alternates: { canonical: '/docs/keeper' },
};

const TOC = [
  { id: 'not-an-authority', label: 'A convenience, not an authority' },
  { id: 'jobs', label: 'The jobs' },
  { id: 'refund-policy', label: 'The refund policy' },
  { id: 'wallets', label: 'Wallets and funds' },
  { id: 'health', label: 'Health checks' },
  { id: 'anyone', label: 'Anyone can do it' },
  { id: 'runbook', label: 'When something goes wrong' },
] as const;

export default function KeeperDoc() {
  return (
    <DocPage slug="keeper" toc={TOC}>
      <H2 id="not-an-authority">A convenience, not an authority</H2>
      <P>
        The keeper is a small program that lists markets before the opening bell, settles them after the closing bell and
        pushes payouts to winners. Every action it takes, anyone can take: settle with the proven rounds, refund on a proven
        stale price, deliver a payout. If it stops, markets still settle, just later; after 72 hours anyone can refund a
        market outright.
      </P>
      <P>
        It runs as scheduled route handlers on Vercel, each protected by a secret, and every job is <B>idempotent</B>: it
        reads the chain, decides, acts, and can run twice without harm.
      </P>

      <H2 id="jobs">The jobs</H2>
      <Table
        caption="Keeper jobs and schedules"
        head={['Job', 'When (UTC, weekdays unless noted)', 'What it does']}
        minWidth={640}
        rows={[
          [
            <C key="open">open</C>,
            'Every 10 minutes, 12:00 to 13:59',
            "Makes sure today's daily markets exist for every allowed ticker (and the week's weekly markets), listed before 9:30 am ET, using the NYSE calendar. Skips a ticker with a corporate action in the window.",
          ],
          [
            <C key="resolve">resolve</C>,
            'Every 2 minutes, 20:00 to 21:59; and hourly at :07 every day',
            'For every market past its bell and not settled: finds both rounds, previews, then settles or refunds per the policy below.',
          ],
          [
            <C key="deliver">deliver</C>,
            'Every 5 minutes, every day',
            'Pushes every unclaimed payout and refund to its owner, one call per position; returns refused parts of bets; sweeps fees to the treasury when more than 5 USDG has built up.',
          ],
          [
            <C key="relay">relay</C>,
            'On request',
            "Checks a bettor's signed bet, simulates it and sends it, paying the gas. See Gasless betting.",
          ],
          [<C key="health">health</C>, 'On request', 'Reports whether every job is keeping up (below).'],
        ]}
      />
      <P>
        Market hours are computed in New York time with a time-zone library, never a fixed offset. The bells are 13:30 and
        20:00 UTC until November 1, 2026, and 14:30 and 21:00 UTC after it.
      </P>
      <Callout title="One call per position">
        <p>
          Paxos can freeze any USDG address. If a winner&rsquo;s address is frozen, only that one payout fails; everyone
          else is still paid, because payouts are never batched into one all-or-nothing call.
        </p>
      </Callout>

      <H2 id="refund-policy">The refund policy</H2>
      <P>
        The keeper may refund a market automatically, because a refund here is based on proof, not on a timeout: the rounds
        in effect at the bells either break the market&rsquo;s age limit or they do not, and an RPC outage cannot change
        that. It still waits:
      </P>
      <UL>
        <LI>
          <B>Stale price:</B> only after the bell plus 15 minutes, and only when two independent reads both say STALE.
        </LI>
        <LI>
          <B>Corporate-action pause:</B> retried every 10 minutes; refunded only 24 hours after the bell if still paused.
        </LI>
        <LI>
          <B>Phase change on a feed</B> (<C>PhaseBoundary</C>): never refunded automatically. The operator is alerted, and
          the 72-hour timeout remains the backstop.
        </LI>
      </UL>

      <H2 id="wallets">Wallets and funds</H2>
      <Table
        caption="Operational wallets"
        head={['Wallet', 'Holds', 'Rule']}
        minWidth={560}
        rows={[
          [
            'Keeper (lister and relayer), a hot wallet',
            'ETH for gas (its own calls, relayed bets, payout deliveries); the USDG float for opening seeds',
            'Keeps at least 0.001 ETH, and enough USDG (in its wallet plus the seeds in its open markets) for every market it is set to list, all open at once. Seeds come back to it at each settlement. Its key lives only in the hosting environment.',
          ],
          ['Treasury Safe', 'Fees and rounding leftovers', 'Swept automatically; nothing to spend.'],
          ['Guardian Safe (the same Safe)', 'Nothing', 'Only signs: pause or resume new bets and new markets, name the pauser, allow-list feeds, allow listers.'],
          ['Pauser, one key kept offline', 'A little ETH for gas', 'Can pause new bets and new markets in one transaction; cannot resume them or do anything else.'],
        ]}
      />
      <P>
        The keeper&rsquo;s wallet can list markets with its own money and holds the seed float. It cannot touch anyone
        else&rsquo;s position; if its key leaked, the Safe removes it as a lister and a new key takes over.
      </P>

      <H2 id="health">Health checks</H2>
      <P>
        <C>GET /api/health</C> answers 200 only if all of these hold, and 503 listing the ones that failed:
      </P>
      <UL>
        <LI>the last successful listing run is less than 26 hours old on a trading day, and today&rsquo;s markets exist after 13:25 UTC;</LI>
        <LI>no market is more than 30 minutes past its bell without being settled (unless it is waiting on a phase change);</LI>
        <LI>no settled market has an undelivered payout older than 20 minutes;</LI>
        <LI>the keeper holds at least 0.001 ETH, and its wallet plus the seeds in its open markets reach its USDG floor;</LI>
        <LI>the Safe owns the factory (ownership accepted), HunchVPM&rsquo;s only creator is the factory, the keeper is a lister, and new bets are not paused;</LI>
        <LI>the RPC&rsquo;s latest block is less than 60 seconds old;</LI>
        <LI>every allowed feed has updated within 26 hours on a trading day;</LI>
        <LI>the relayer has sent a bet successfully in the last trading day, or none was requested;</LI>
        <LI>every open market&rsquo;s page reads current numbers, through the same cache the page uses (<C>market-reads</C>);</LI>
        <LI>the newest market&rsquo;s entry times and transaction links can be read from the chain&rsquo;s logs (<C>market-logs</C>).</LI>
      </UL>
      <P>An external monitor polls it every 5 minutes and alerts the operator.</P>

      <H2 id="anyone">Anyone can do it</H2>
      <Table
        caption="Keeper jobs anyone can do"
        head={['Job', 'Call', 'Who receives the money']}
        minWidth={560}
        rows={[
          ['Settle a market', <C key="r">resolve(specId, strikeRound, finalRound)</C>, 'Nobody; it records the result'],
          ['Refund on a stale price', <C key="v">voidStale(specId, strikeRound, finalRound)</C>, 'Nobody; it records the refund'],
          ['Refund on an out-of-range price', <C key="b">voidBadAnswer(specId, strikeRound, finalRound)</C>, 'Nobody; it records the refund'],
          ['Refund after a long pause', <C key="p">voidPaused(specId)</C>, 'Nobody; it records the refund'],
          ['Deliver a payout', <C key="c">claimFor(positionId)</C>, "The position's owner, always"],
          ['Deliver a refund', <C key="w">withdrawRefundFor(positionId)</C>, "The position's owner, always"],
          ['Sweep fees', <C key="s">sweepFees(usdg)</C>, 'The treasury Safe, always'],
        ]}
      />
      <P>
        Step by step, with commands: <TextLink href="/docs/markets#resolve-it-yourself">resolve it yourself</TextLink>.
      </P>

      <H2 id="runbook">When something goes wrong</H2>
      <UL>
        <LI>
          <B>A bug is suspected:</B> the pauser (or the Safe) pauses new bets and new markets. Payouts, refunds and
          settlement keep working; only the Safe can resume.
        </LI>
        <LI>
          <B>A price feed misbehaves:</B> the Safe removes it from the allow-list, so no new market uses it; existing markets
          settle or refund on their own proofs.
        </LI>
        <LI>
          <B>The keeper&rsquo;s key leaks:</B> the Safe removes it as a lister and allows a new one; the float moves first.
        </LI>
        <LI>
          <B>The keeper is down:</B> anyone settles and delivers; the operator can also run the keeper by hand.
        </LI>
      </UL>
    </DocPage>
  );
}
