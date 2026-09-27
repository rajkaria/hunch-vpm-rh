'use client';

import Link from 'next/link';

import { Amount, Badge, EmptyState, Panel, PanelHeader, Stat } from '@/components/ui/primitives';
import { awaitingVintage } from '@/lib/data/position-wire';
import { formatUtcDate } from '@/lib/time';
import { useWalletPositions } from '@/lib/wallet/positions';
import { truncateAddress, useWallet } from '@/lib/wallet/useWallet';

const TONE: Record<'up' | 'down' | 'neutral', string> = {
  up: 'text-lime',
  down: 'text-coral',
  neutral: 'text-paper',
};

/**
 * Everything an address holds, open or not.
 *
 * This exists because `/claim` answers a narrower question than people assume:
 * it lists what can be *pulled right now*. A holder with three live positions
 * and nothing settled sees an empty claim page, and the reasonable conclusion
 * from an empty page is that the money is gone. Open stake needs somewhere to
 * be visible while it is still open.
 */
export function Portfolio() {
  const wallet = useWallet();
  // The same read, and the same cache entry, as the market page's position panel.
  const positions = useWalletPositions();

  if (wallet.address === null) {
    return (
      <EmptyState title="No wallet connected.">
        A position belongs to an address. Connect one and everything it holds — open, frozen and
        settled — is listed here.
      </EmptyState>
    );
  }

  if (positions.isPending) {
    return <EmptyState title="Reading your positions…">For {truncateAddress(wallet.address)}.</EmptyState>;
  }

  if (positions.isError || positions.data === undefined) {
    return (
      <EmptyState title="The index could not be reached.">
        Nothing is wrong with your positions — this page could not read them.
      </EmptyState>
    );
  }

  const { entries, source } = positions.data;

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No positions."
        action={
          <Link
            href="/"
            className="rounded-control bg-lime px-4 py-2.5 text-sm font-semibold text-ink hover:bg-lime/90"
          >
            Find a market
          </Link>
        }
      >
        {source === 'live'
          ? `${truncateAddress(wallet.address)} holds nothing on this network. Stake on a market and it is listed here as soon as the index sees the entry, before the vintage even closes.`
          : `${truncateAddress(wallet.address)} holds nothing. Stake on a market and it appears here the moment the entry lands, before the vintage even closes.`}
      </EmptyState>
    );
  }

  const offered = entries.reduce((total, entry) => total + BigInt(entry.position.offered), 0n);
  const accepted = entries.reduce((total, entry) => total + BigInt(entry.position.accepted), 0n);
  const refused = entries.reduce((total, entry) => total + BigInt(entry.position.refused), 0n);

  return (
    <>
      <Panel className="mb-6">
        <PanelHeader title="Across every market" hint="What you offered, what the books took." />
        <dl className="grid grid-cols-2 gap-x-6 gap-y-6 px-4 py-5 sm:grid-cols-4 sm:px-5">
          <Stat label="Positions">
            <span className="num">{entries.length}</span>
          </Stat>
          <Stat label="Offered">
            <Amount value={offered} />
          </Stat>
          <Stat label="Accepted">
            <Amount value={accepted} />
          </Stat>
          <Stat label="Refused" hint="refundable, and never at risk">
            <Amount value={refused} className={refused > 0n ? '' : 'text-muted'} />
          </Stat>
        </dl>
      </Panel>

      <Panel>
        <PanelHeader title="Positions" hint="Newest first." />
        <ul className="divide-y divide-edge">
          {entries.map((entry) => {
            const outcome = entry.market.outcomes.find(
              (candidate) => candidate.outcome === entry.position.outcome,
            );
            const refusedHere = BigInt(entry.position.refused);
            const won =
              entry.market.winner !== null && entry.market.winner === entry.position.outcome;

            return (
              <li key={entry.position.id} className="px-4 py-4 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`/m/${entry.market.id}`} className="text-sm hover:underline">
                      {entry.market.question}
                    </Link>
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                      <span className={outcome === undefined ? '' : TONE[outcome.tone]}>
                        {outcome?.label ?? `Outcome ${entry.position.outcome}`}
                      </span>
                      <span>entered {formatUtcDate(BigInt(entry.position.enteredAt))}</span>
                      <span className="num text-faint">#{entry.position.positionId}</span>
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {awaitingVintage(entry.position) ? <Badge tone="note">Vintage open</Badge> : null}
                    {entry.market.status !== 'Open' ? (
                      <Badge tone={won ? 'up' : 'quiet'}>{won ? 'Won' : entry.market.status}</Badge>
                    ) : entry.market.frozen ? (
                      <Badge tone="note">Frozen</Badge>
                    ) : (
                      <Badge tone="up">Open</Badge>
                    )}
                  </div>
                </div>

                <dl className="mt-3 grid grid-cols-3 gap-x-4 rounded-control border border-edge bg-raised-2 px-3 py-2.5">
                  <div>
                    <dt className="text-[11px] tracking-[0.1em] text-faint uppercase">Offered</dt>
                    <dd className="mt-0.5 text-sm">
                      <Amount value={BigInt(entry.position.offered)} className="text-muted" />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] tracking-[0.1em] text-faint uppercase">Accepted</dt>
                    <dd className="mt-0.5 text-sm">
                      {awaitingVintage(entry.position) ? (
                        <span className="num text-muted">pending</span>
                      ) : (
                        <Amount value={BigInt(entry.position.accepted)} />
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] tracking-[0.1em] text-faint uppercase">Refused</dt>
                    <dd className="mt-0.5 text-sm">
                      {awaitingVintage(entry.position) ? (
                        <span className="num text-muted">pending</span>
                      ) : (
                        <Amount
                          value={refusedHere}
                          className={refusedHere > 0n ? 'text-paper' : 'text-muted'}
                        />
                      )}
                    </dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ul>
      </Panel>
    </>
  );
}
