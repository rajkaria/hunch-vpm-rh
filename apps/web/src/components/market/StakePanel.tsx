'use client';

import { useMemo, useState } from 'react';

import { EntryFlow } from '@/components/market/EntryFlow';
import { Amount, Badge, Panel, PanelHeader } from '@/components/ui/primitives';
import type { MarketDetail, OutcomeTone } from '@/lib/data/types';
import { formatAmount, parseUsdcAmount } from '@/lib/units';
import { simulateEntry, type Acceptance, type BookMath } from '@/lib/vpm';

const TONE_TEXT: Record<OutcomeTone, string> = {
  up: 'text-lime',
  down: 'text-coral',
  neutral: 'text-paper',
};

const TONE_SELECTED: Record<OutcomeTone, string> = {
  up: 'border-lime/45 bg-lime/10 text-lime',
  down: 'border-coral/45 bg-coral/10 text-coral',
  neutral: 'border-paper/30 bg-paper/8 text-paper',
};

/**
 * Where a stake is composed.
 *
 * The panel exists to answer one question before a wallet is ever involved: of
 * what you are about to offer, how much will actually be accepted, and how much
 * comes straight back. That is not a warning and not an error state — under
 * this rule a partial acceptance is the ordinary case, and the only way to make
 * a refund read as intended rather than as a bug is to have shown it before the
 * user signed anything.
 *
 * This component computes nothing. `simulateEntry` is the settler's own rule
 * and lives in `lib/vpm.ts`; putting a second copy of that arithmetic here is
 * exactly how the two would drift.
 */
export function StakePanel({
  market,
  action,
}: {
  market: MarketDetail;
  /**
   * Override what renders under the estimate. Defaults to the signing flow.
   *
   * This exists so the estimate can be tested without mounting a wallet
   * provider — it is **not** a seam for the page to use: the market page is a
   * server component, and a function prop cannot cross that boundary. It passes
   * nothing and gets `EntryFlow`.
   */
  action?: (entry: { outcome: number; offered: bigint; acceptance: Acceptance }) => React.ReactNode;
}) {
  const [outcome, setOutcome] = useState(market.outcomes[0]?.outcome ?? 0);
  const [raw, setRaw] = useState('');

  const books: BookMath[] = useMemo(
    () =>
      market.outcomes.map((view) => ({
        outcome: view.outcome,
        principal: view.principal,
        vested: view.vested,
        capacity: view.capacity,
        acc: view.acc,
        demand: view.demand,
      })),
    [market.outcomes],
  );

  const parsed = parseUsdcAmount(raw);
  const offered = parsed.value ?? 0n;
  const acceptance = useMemo(() => simulateEntry(books, outcome, offered), [books, outcome, offered]);

  const selected = market.outcomes.find((view) => view.outcome === outcome);
  const binding =
    acceptance.bindingOutcome === null
      ? null
      : (market.outcomes.find((view) => view.outcome === acceptance.bindingOutcome) ?? null);

  const closed = market.frozen || market.status !== 'Open';

  return (
    <Panel>
      <PanelHeader
        title="Take a side"
        hint="Stake vests into the opposing books as it lands, and is accepted only up to the room they have. What they cannot cover comes straight back."
      />

      <div className="space-y-5 px-4 py-5 sm:px-5">
        {closed ? (
          <p className="rounded-control border border-edge bg-ghost px-3 py-2.5 text-sm text-muted">
            {market.status === 'Open'
              ? 'This market has frozen. No entry can be accepted, and the book is fixed until it resolves.'
              : 'This market has settled. Nothing more can be staked.'}
          </p>
        ) : null}

        <fieldset disabled={closed} className="disabled:opacity-50">
          <legend className="text-xs tracking-[0.12em] text-faint uppercase">Outcome</legend>
          <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
            {market.outcomes.map((view) => {
              const active = view.outcome === outcome;
              return (
                <button
                  key={view.outcome}
                  type="button"
                  onClick={() => setOutcome(view.outcome)}
                  aria-pressed={active}
                  className={`rounded-control border px-3 py-2.5 text-left text-sm font-semibold transition-colors ${
                    active
                      ? TONE_SELECTED[view.tone]
                      : 'border-edge bg-ghost text-muted hover:border-edge-strong hover:text-paper'
                  }`}
                >
                  {view.label}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div>
          <label htmlFor="stake" className="text-xs tracking-[0.12em] text-faint uppercase">
            Amount
          </label>
          <div className="mt-2.5 flex items-center rounded-control border border-edge bg-ink focus-within:border-paper/40">
            <input
              id="stake"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={raw}
              disabled={closed}
              onChange={(event) => setRaw(event.target.value)}
              aria-invalid={parsed.problem !== null}
              aria-describedby={parsed.problem === null ? undefined : 'stake-problem'}
              className="num w-full bg-transparent px-3 py-2.5 text-base outline-none disabled:opacity-50"
            />
            <span className="num shrink-0 pr-3 text-sm text-faint">USDC</span>
          </div>
          {parsed.problem === null ? null : (
            <p id="stake-problem" className="mt-2 text-sm text-coral">
              {parsed.problem}
            </p>
          )}
        </div>

        {offered > 0n && selected !== undefined ? (
          <AcceptanceEstimate
            acceptance={acceptance}
            outcomeLabel={selected.label}
            tone={selected.tone}
            bindingLabel={binding?.label ?? null}
          />
        ) : (
          <p className="text-sm leading-relaxed text-muted">
            Enter an amount to see what the books would accept of it right now.
          </p>
        )}

        {offered <= 0n || closed ? null : (
          <div className="border-t border-edge pt-5">
            {action === undefined ? (
              <EntryFlow market={market} outcome={outcome} offered={offered} acceptance={acceptance} />
            ) : (
              action({ outcome, offered, acceptance })
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

/**
 * The estimate itself.
 *
 * Accepted and refused are given equal visual weight on purpose. Styling the
 * refusal as a warning would teach the user that the mechanism is
 * malfunctioning, when it is doing the exact thing the market exists to do.
 */
export function AcceptanceEstimate({
  acceptance,
  outcomeLabel,
  tone,
  bindingLabel,
}: {
  acceptance: Acceptance;
  outcomeLabel: string;
  tone: OutcomeTone;
  bindingLabel: string | null;
}) {
  const partial = acceptance.refused > 0n;
  const nothing = acceptance.accepted === 0n;

  return (
    <div className="rounded-control border border-edge bg-raised-2 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs tracking-[0.12em] text-faint uppercase">If you entered now</span>
        {nothing ? (
          <Badge tone="down">Nothing would be accepted</Badge>
        ) : partial ? (
          <Badge tone="note">Partly accepted</Badge>
        ) : (
          <Badge tone="up">Accepted in full</Badge>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4">
        <div>
          <dt className="text-xs tracking-[0.12em] text-faint uppercase">Accepted</dt>
          <dd className={`mt-1.5 text-lg leading-none ${nothing ? 'text-muted' : TONE_TEXT[tone]}`}>
            <Amount value={acceptance.accepted} />
          </dd>
          <p className="mt-1.5 text-xs leading-snug text-muted">
            goes on {outcomeLabel} and starts earning as the other side arrives
          </p>
        </div>
        <div>
          <dt className="text-xs tracking-[0.12em] text-faint uppercase">Refused</dt>
          <dd className="mt-1.5 text-lg leading-none">
            <Amount value={acceptance.refused} className={partial ? 'text-paper' : 'text-muted'} />
          </dd>
          <p className="mt-1.5 text-xs leading-snug text-muted">
            {partial ? 'refundable the moment the entry lands — it is never at risk' : 'nothing comes back'}
          </p>
        </div>
      </dl>

      <p className="mt-4 border-t border-edge pt-3.5 text-xs leading-relaxed text-faint">
        An estimate, not a quote. Entries landing in the same block are rationed together when
        that block&rsquo;s vintage closes, so someone else arriving alongside you takes room you
        were counting on.
      </p>

      {partial ? (
        <p className="mt-3 text-xs leading-relaxed text-muted">
          {bindingLabel === null ? (
            <>There is no opposing book to cover this stake, so none of it can be accepted.</>
          ) : (
            <>
              <span className="text-paper">{bindingLabel}</span> is the book that binds it: stake on{' '}
              {outcomeLabel} vests into it, and it has{' '}
              {acceptance.maxFullyAccepted === null ? (
                'no ceiling'
              ) : (
                <span className="num text-paper">
                  {formatAmount(acceptance.maxFullyAccepted, { fractionDigits: 2 })}
                </span>
              )}{' '}
              of room left for an offer to be taken whole. Offer more and the books take what they
              can and hand back the rest.
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}
