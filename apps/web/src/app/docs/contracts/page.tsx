import type { Metadata } from 'next';

import { DocPage } from '@/components/docs/DocPage';
import { B, C, Callout, CodeBlock, H2, H3, LI, P, Table, UL } from '@/components/docs/prose';
import { ContractTable } from '@/components/trust/ContractTable';
import { PowersTable } from '@/components/trust/PowersTable';
import { TextLink } from '@/components/ui/primitives';
import { readDeployment } from '@/lib/deployment';
import { contractRowsSync as contractRows, feedRows } from '@/lib/server/proof';
import { LINKS } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Contracts',
  description:
    'Hunch on Robinhood Chain contracts: addresses, the powers table, invariants, the seven changes from the reference contract and how to verify them.',
  alternates: { canonical: '/docs/contracts' },
};

const TOC = [
  { id: 'addresses', label: 'Addresses' },
  { id: 'map', label: 'How they fit together' },
  { id: 'powers', label: 'Powers' },
  { id: 'invariants', label: 'Invariants' },
  { id: 'diff', label: 'Changes from the reference' },
  { id: 'resolver', label: 'The settlement contract' },
  { id: 'factory', label: 'The market factory' },
  { id: 'verify', label: 'Verify them yourself' },
] as const;

const MAP = `                    Safe (owner / guardian / treasury)
                      │ setFeed, setOpener        │ setEntriesPaused (enter only)
                      ▼                           ▼
 keeper (opener) ─► HunchMarketFactory ──create──► HunchVPM  ◄── bettors: enter / (relayed) enterWithAuthorization
                      │                 (seed legs    │           claim / withdrawRefund
                      │ register spec    handed back  │ ◄── anyone: claimFor / withdrawRefundFor
                      ▼                  to opener)   │            finalizeVintage / sweepFees
               StockRoundResolver ──resolve / void────┘
                      │ getRoundData / latestRoundData
                      ▼
          Chainlink stock feed proxies (NVDA/USD, TSLA/USD, …) on Robinhood Chain`;

export default function ContractsDoc() {
  const deployment = readDeployment();
  const deployed = deployment.status === 'deployed';

  return (
    <DocPage slug="contracts" toc={TOC}>
      <H2 id="addresses">Addresses</H2>
      <P>
        Every address the venue uses comes from one file, <C>deployments/robinhood-mainnet.json</C>, which the site, the
        keeper and the README all read.{' '}
        {deployed
          ? 'Each links to Blockscout.'
          : 'Our three contracts are not deployed yet; their rows fill in, linked to Blockscout, the moment they are.'}
      </P>
      <div className="mt-5">
        <ContractTable rows={contractRows(deployment)} />
      </div>
      <H3 id="feed-addresses">Price feeds</H3>
      <div className="mt-4">
        <ContractTable rows={feedRows(deployment)} />
      </div>

      <H2 id="map">How they fit together</H2>
      <CodeBlock label="Contract map">{MAP}</CodeBlock>
      <UL>
        <LI>
          <B>HunchVPM</B> holds every stake, books every bet and pays every winner. It has no owner, no upgrade and no price
          input.
        </LI>
        <LI>
          <B>StockRoundResolver</B> settles each market from two proven Chainlink rounds. It has no owner and no admin.
        </LI>
        <LI>
          <B>HunchMarketFactory</B> lists a market in one transaction: it takes the opening seed from the lister, creates the
          market, registers its settlement spec, hands the seed positions to the lister and keeps nothing.
        </LI>
      </UL>
      <P>
        Solidity 0.8.28, optimizer at 200 runs, EVM version cancun, no via-IR, and no upgradeable proxies. Production
        contracts use no external libraries beyond minimal local interfaces.
      </P>

      <H2 id="powers">Powers</H2>
      <P>Stated once, verbatim, the same table the README carries:</P>
      <div className="mt-5">
        <PowersTable />
      </div>

      <H2 id="invariants">Invariants</H2>
      <P>Properties the contracts are built to keep, checked by the test suite over random sequences of bets, settlements and payouts:</P>
      <Table
        caption="Invariants"
        head={['Id', 'Property', 'In plain words']}
        minWidth={600}
        rows={[
          ['INV-1', 'Solvency', 'The contract always holds at least everything it owes: open stakes, unclaimed payouts and refunds, leftovers and fees.'],
          ['INV-2', 'Conservation', 'A settled market pays out exactly its pool (plus a rounding leftover); a refunded one returns exactly what was accepted.'],
          ['INV-3', 'Exits', 'Money leaves only as a payout or refund to its owner, a leftover to its named owner, or fees to the treasury.'],
          ['INV-4', 'Pause scope', 'While new bets are paused, only new bets fail.'],
          ['INV-5', 'Only goes up', "An open position's win payout never decreases, whatever comes after it."],
          ['INV-6', 'Reference equivalence', 'With the fee and limits switched off, it behaves exactly like the reference contract.'],
          ['INV-7', 'Settlement soundness', 'Only the one valid pair of rounds can settle a market; any other pair is rejected.'],
          ['INV-8', 'Signed bets', 'A signed bet with a different market, side, amount or salt fails, and a used signature cannot be replayed.'],
        ]}
      />

      <H2 id="diff">Changes from the reference</H2>
      <P>
        HunchVPM is the paper&rsquo;s reference contract, <C>VestedParimutuel.sol</C>, changed by these seven diffs and
        nothing else. The literal diff against the reference is kept with the source as <C>contracts/DIFF.md</C>. The
        payout arithmetic, the batching, the settlement semantics and the storage layout are untouched.
      </P>
      <Table
        caption="The seven changes"
        head={['', 'Change', 'Why']}
        minWidth={600}
        rows={[
          ['D1', "A fee on winners' gains (at most 5%, 2% on this venue), taken at claim; swept to the treasury separately.", 'The business model, with no fee on stakes, refunds or losses.'],
          ['D2', 'claimFor and withdrawRefundFor: anyone can deliver a payout or refund, always to its owner.', 'The keeper pushes every payout, so nobody has to come back to claim.'],
          ['D3', 'Minimum and maximum bet per market, fixed at listing.', 'A guarded beta that bounds the damage of any bug.'],
          ['D4', 'The guardian can pause new bets. Nothing else is pausable.', 'An emergency brake that cannot trap anyone’s money.'],
          ['D5', 'enterWithAuthorization: a bet from a signed USDG transfer bound to market, side and amount.', 'Gasless bets; the bettor needs no ETH.'],
          ['D6', 'Read views: accrued, marketPositions, previewFee (and marketTerms).', 'What the site needs to show a position and a book.'],
          ['D7', 'Events: FeeAccrued, FeesSwept, EntriesPaused.', 'So indexers and the Proof page can follow fees and pauses.'],
        ]}
      />

      <H2 id="resolver">The settlement contract</H2>
      <P>
        <C>StockRoundResolver</C> settles on the Chainlink price in effect at each bell, proven by round id, so neither the
        time of the call nor who makes it can change the answer. Its functions:
      </P>
      <UL>
        <LI>
          <C>resolve(specId, strikeRound, finalRound)</C>: anyone, after the bell. Verifies both proofs, then settles UP,
          DOWN, or refunds on a flat price. Never refunds for staleness.
        </LI>
        <LI>
          <C>voidStale(specId, strikeRound, finalRound)</C>: anyone, after the bell, only if the proven rounds break an age
          limit. A market with a good answer cannot be refunded this way.
        </LI>
        <LI>
          <C>voidPaused(specId)</C>: anyone, 24 hours after the bell, if Robinhood&rsquo;s corporate-action flag on the token
          is still set.
        </LI>
        <LI>
          <C>preview(specId, strikeRound, finalRound)</C>: read-only; the status and both prices, for the keeper and for you.
        </LI>
      </UL>
      <P>
        Each market&rsquo;s spec (settler, market id, feed, Stock Token, both bell times, both age limits) is hashed into its{' '}
        <C>specId</C> when it is registered, and cannot change. Details: <TextLink href="/docs/markets#round-proofs">round proofs</TextLink>.
      </P>

      <H2 id="factory">The market factory</H2>
      <P>
        <C>openUpDown</C> can be called only by an allowed lister (the keeper&rsquo;s wallet). It checks the feed is
        allow-listed, the window is at most 8 days, the seed is at least 1 USDG per side and any age limit asked for is
        tighter than the feed&rsquo;s own, never looser. It lists every market with the same constants: capacity 30, fee 2%
        of gains, refund timeout 72 hours, and leftovers and fees to the treasury Safe. The Safe, as owner, can only
        allow-list feeds (with their Stock Token and age limits) and listers; it cannot change a listed market.
      </P>

      <H2 id="verify">Verify them yourself</H2>
      <P>Each contract is verified on Blockscout, with Sourcify as the fallback:</P>
      <CodeBlock label="Blockscout verification (Robinhood's documented command)">{`forge verify-contract <address> src/HunchVPM.sol:HunchVPM \\
  --chain-id 4663 --rpc-url $RH_RPC_URL \\
  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/`}</CodeBlock>
      <Callout title="What to check">
        <p>
          That the Safe owns the factory and is the guardian and treasury of HunchVPM; that the Safe needs more than one
          signature (its threshold is read on-chain on the <TextLink href="/proof#safe">Proof</TextLink> page); and that the
          source on Blockscout matches the repository.
        </p>
      </Callout>
      <P>
        The reference contract and the paper: <TextLink href={LINKS.paper}>The Vested Parimutuel</TextLink>, 2nd edition,
        conformance suite 1.2.0 with 118 vectors.
      </P>
    </DocPage>
  );
}
