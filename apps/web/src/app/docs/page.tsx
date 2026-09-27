import type { Metadata } from 'next';
import Link from 'next/link';

import { Panel, PanelHeader } from '@/components/ui/primitives';
import { WHITEPAPER_URL } from '@/lib/links';

export const metadata: Metadata = {
  title: 'How it works',
  description:
    'Flow vesting, capacity matching, block vintages, the accumulator and the residue — the mechanism this venue settles under, in the paper’s language.',
};

export default function DocsPage() {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,14rem)] lg:items-start">
      <article className="min-w-0 max-w-2xl">
        <header className="mb-8">
          <h1 className="text-2xl sm:text-3xl">How the vested parimutuel works</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            This is the mechanism of{' '}
            <a
              href={WHITEPAPER_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="text-paper underline decoration-lime decoration-2 underline-offset-4"
            >
              The Vested Parimutuel
            </a>
            , as the contracts in this repository implement it. Nothing below is a simplification of the paper
            for a website; where a number is floored the text says so, because the settler floors there too.
          </p>
        </header>

        <Section id="the-problem" title="What a classic pool gets wrong">
          <p>
            In a classic pool the payout is{' '}
            <Mono>floor(pool × stake / winningPrincipal)</Mono>. Every winning unit takes the same share of the
            same pool, and the pool does not remember when any of it arrived. A unit staked one second before
            the freeze is worth exactly as much as a unit staked at the open.
          </p>
          <p>
            That is not a rounding detail. The people who staked first are the ones who moved the price to
            somewhere worth betting into, and the classic rule pays them for it with a multiple that falls every
            time somebody else agrees with them. Late money is not just cheap: it is paid out of the early
            money&rsquo;s return.
          </p>
        </Section>

        <Section id="rule-1" title="Rule 1 — stake vests into the opposing books">
          <p>
            A stake on an outcome is assigned, in full, to every opposing branch the moment it lands. Stake on{' '}
            <em>above</em> vests into the <em>below</em> book; in an n-way market it vests into all of the other
            books at once.
          </p>
          <p>
            Vesting is what makes timing matter. What a position is paid is its own accepted principal plus what
            vested to it from stake that arrived <em>after</em> it. Nothing that was already down can take from
            it, and nothing it does can take from anyone who was there first.
          </p>
        </Section>

        <Section id="rule-2" title="Rule 2 — a book can only accept what the other side can cover">
          <p>
            Each book carries a capacity <Mono>C_w = κ · P_w</Mono>: kappa times its own accepted principal.
            What it has already absorbed is <Mono>V_w</Mono>, and the difference is its headroom:
          </p>
          <Formula>H_w = C_w − V_w</Formula>
          <p>
            Because a stake vests into the opposing books, the room it needs is <em>their</em> headroom, not its
            own. The tightest opposing book decides, and a stake larger than that room is accepted only in part:
          </p>
          <Formula>accepted = D_w &gt; H_w ? floor(c × H_w / D_w) : c</Formula>
          <p>
            <Mono>D_w</Mono> is the whole vintage&rsquo;s offered demand against that book, this entry&rsquo;s own{' '}
            <Mono>c</Mono> included: <Mono>enter</Mono> adds <Mono>c</Mono> to every opposing book&rsquo;s demand
            the moment the entry lands, and the vintage is finalized against that. So <Mono>c</Mono> is on both
            sides of the test and in the denominator — an offer of 20,000 into 15,000 of headroom with nothing
            else queued is accepted at 15,000, not refused and not taken whole. What the entry actually takes is
            the smallest of these caps across the opposing books, computed in one pass.
          </p>
          <p>
            The remainder is <strong className="font-semibold text-paper">refused, not failed</strong>. The
            transaction succeeds, the escrow holds the offer, and the part the books could not cover is pulled
            back with <Mono>withdrawRefund</Mono> — or paid alongside the settlement by <Mono>claim</Mono>,
            whichever comes first. Nowhere on this surface is a refusal drawn as an error, because it is not one.
          </p>
          <p>
            Kappa is 30 for binary markets and unbounded for n-way ones. A consequence worth seeing: with κ = 30
            a book cannot get more than about 30 to 1 against the other side, because long before that the
            opposing book has run out of capacity to accept the flow. The market&rsquo;s own capacity is what
            stops the price running away.
          </p>
        </Section>

        <Section id="vintages" title="Vintages — everything in one block arrives at once">
          <p>
            Entries in the same block form one vintage, and entries in the same vintage never vest to each other.
            Without that, the order of two transactions inside a block — which is not something either sender
            chose — would decide which of them was paid by the other.
          </p>
          <p>
            A vintage is rationed against the headroom as it stood when the vintage opened, with the whole
            vintage&rsquo;s demand in the denominator. Headroom that one entry leaves unused because a different
            book cut it is not handed back round within the vintage. The vintage is finalized lazily, by the
            first transaction of a later block that touches the market, which is why an entry&rsquo;s accepted
            amount is not knowable in the transaction that made it.
          </p>
        </Section>

        <Section id="settlement" title="Settlement">
          <p>
            Each book keeps a reward-per-share accumulator <Mono>A_w</Mono> in fixed point at{' '}
            <Mono>S = 1e18</Mono>. A position records the accumulator of its outcome at entry, and what it is
            paid if its outcome happens is:
          </p>
          <Formula>payout = floor(s × (S + A_ω(T) − A_ω(τ)) / S)</Formula>
          <p>
            which is its accepted principal plus <Mono>floor(s × ΔA / S)</Mono> — the two are the same integer,
            and the split is how this surface shows it. Claims are independent: what one position is paid does
            not depend on whether any other has claimed.
          </p>
          <p>
            Flooring each payout separately guarantees the distributed total never exceeds the pool. What is left
            is the <strong className="font-semibold text-paper">residue</strong>: typically a few millionths of a
            USDC, swept by an owner named at the market&rsquo;s creation and not before every winning position
            has claimed, because the sum of the floors is not known until the last one does.
          </p>
        </Section>

        <Section id="resolution" title="Resolution, and what happens if the feed goes quiet">
          <p>
            The freeze is fixed when the market is created and never moves. Entries at or after it are refused
            outright, which means the accumulator is frozen at the freeze by construction: a resolver that is
            slow costs nobody anything, because there is nothing left that could change the answer.
          </p>
          <p>
            Resolution is permissionless. Anyone may call the resolver once the freeze has passed; the caller has
            no say in the answer and earns nothing for making the call. The resolver reads a price feed through
            an <Mono>IPriceOracle</Mono> adapter and compares it against a strike registered in the same
            transaction that opened the market, so there is no window in which stake can land against rules
            nobody has committed to.
          </p>
          <p>
            If the last reading is older than the market&rsquo;s staleness bound, resolution <em>reverts</em>
            rather than settling — a keeper retrying through a brief outage cannot void a good market by
            accident. Voiding on a stale feed is a separate, deliberate call, and it refunds every position at
            its accepted principal. After the market&rsquo;s void timeout, anyone may void it.
          </p>
        </Section>

        <Section id="glossary" title="Glossary">
          <dl className="space-y-4">
            <Term term="book">
              A single outcome&rsquo;s accepted principal, <Mono>P_w</Mono>, and the scalars that govern whether
              it can take more.
            </Term>
            <Term term="headroom">
              <Mono>H_w = C_w − V_w</Mono>. The room a book still has to accept stake. When it runs out a stake
              is refused and refunded.
            </Term>
            <Term term="vintage">
              The entries of one block. They are rationed together and never vest to each other. Vintage 0 is the
              creator&rsquo;s seed.
            </Term>
            <Term term="kappa">
              The capacity coefficient. 30 for binary markets, unbounded for n-way ones.
            </Term>
            <Term term="residue">
              What per-position flooring leaves behind, swept by an owner fixed at creation.
            </Term>
            <Term term="accepted against offered">
              An entry <em>offers</em> c and has <em>accepted</em> s ≤ c. The difference is refused for want of
              headroom and refunds. Every amount on this surface says which of the two it is.
            </Term>
          </dl>
        </Section>

        <div className="lift mt-10 rounded-card border border-edge bg-raised px-5 py-6">
          <p className="font-display text-lg">Read the paper</p>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            The proofs, the fixed-point argument for the seed clamp, and the full treatment of the exit and void
            cases are in the paper this implementation follows.
          </p>
          <a
            href={WHITEPAPER_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-4 inline-block border border-lime px-4 py-2.5 text-sm font-semibold text-lime transition-colors hover:bg-lime hover:text-ink"
          >
            The Vested Parimutuel
          </a>
        </div>
      </article>

      <nav aria-label="On this page" className="hidden lg:sticky lg:top-24 lg:block">
        <Panel>
          <PanelHeader title="On this page" />
          <ul className="space-y-2 px-4 py-4 text-sm sm:px-5">
            {[
              ['the-problem', 'What a classic pool gets wrong'],
              ['rule-1', 'Rule 1 — vesting'],
              ['rule-2', 'Rule 2 — capacity'],
              ['vintages', 'Vintages'],
              ['settlement', 'Settlement'],
              ['resolution', 'Resolution'],
              ['glossary', 'Glossary'],
            ].map(([id, label]) => (
              <li key={id}>
                <Link href={`#${id}`} className="text-muted hover:text-paper">
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      </nav>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mb-10 scroll-mt-24">
      <h2 className="text-lg">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted [&_strong]:text-paper">{children}</div>
    </section>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="num text-[0.92em] text-paper">{children}</code>;
}

function Formula({ children }: { children: React.ReactNode }) {
  return (
    <p className="scroll-x rounded-control border border-edge bg-raised px-4 py-3">
      <code className="num whitespace-nowrap text-sm text-paper">{children}</code>
    </p>
  );
}

function Term({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="num text-sm text-paper">{term}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}
