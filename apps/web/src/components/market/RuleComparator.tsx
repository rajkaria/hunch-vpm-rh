'use client';

import { useMemo, useState } from 'react';

import { Amount } from '@/components/ui/primitives';
import type { OutcomeTone } from '@/lib/data/types';
import { formatAmount, formatMultiple, parseUsdcAmount } from '@/lib/units';
import {
  newEntryComparison,
  positionComparison,
  totalPrincipal,
  type BookMath,
  type RuleComparison,
} from '@/lib/vpm';

/**
 * Amounts cross from the server as decimal strings rather than as `bigint`,
 * which React cannot serialize. They are parsed back to `bigint` here and
 * every number below is computed on integers — the strings are transport, not
 * arithmetic.
 */
export interface WireBook {
  outcome: number;
  label: string;
  tone: OutcomeTone;
  principal: string;
  vested: string;
  capacity: string | null;
  demand: string;
  acc: string;
}

export interface WirePosition {
  positionId: string;
  outcome: number;
  offered: string;
  accepted: string;
  refused: string;
  entryAcc: string;
}

const TONE_TEXT: Record<OutcomeTone, string> = {
  up: 'text-lime',
  down: 'text-coral',
  neutral: 'text-paper',
};

type Mode = 'new' | 'position';

export function RuleComparator({
  books,
  positions,
  settlerKind,
  frozen,
}: {
  books: WireBook[];
  positions: WirePosition[];
  settlerKind: 'vested' | 'classic';
  frozen: boolean;
}) {
  const math = useMemo<BookMath[]>(
    () =>
      books.map((book) => ({
        outcome: book.outcome,
        principal: BigInt(book.principal),
        vested: BigInt(book.vested),
        capacity: book.capacity === null ? null : BigInt(book.capacity),
        demand: BigInt(book.demand),
        acc: BigInt(book.acc),
      })),
    [books],
  );

  const [mode, setMode] = useState<Mode>(positions.length > 0 ? 'position' : 'new');
  const [outcome, setOutcome] = useState(books[0]?.outcome ?? 0);
  const [amountText, setAmountText] = useState('2500');
  const [positionId, setPositionId] = useState(positions[0]?.positionId ?? '');

  const parsed = parseAmount(amountText);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-3 sm:px-5">
        <Segmented
          options={[
            { value: 'new', label: 'A stake placed now' },
            { value: 'position', label: 'Your position', disabled: positions.length === 0 },
          ]}
          value={mode}
          onChange={setMode}
        />
      </div>

      {mode === 'new' ? (
        <NewEntry
          books={books}
          math={math}
          outcome={outcome}
          onOutcome={setOutcome}
          amountText={amountText}
          onAmount={setAmountText}
          parsed={parsed}
          settlerKind={settlerKind}
          frozen={frozen}
        />
      ) : (
        <ExistingPosition
          books={books}
          math={math}
          positions={positions}
          positionId={positionId}
          onPosition={setPositionId}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- a stake placed now

function NewEntry({
  books,
  math,
  outcome,
  onOutcome,
  amountText,
  onAmount,
  parsed,
  settlerKind,
  frozen,
}: {
  books: WireBook[];
  math: BookMath[];
  outcome: number;
  onOutcome: (value: number) => void;
  amountText: string;
  onAmount: (value: string) => void;
  parsed: ParsedAmount;
  settlerKind: 'vested' | 'classic';
  frozen: boolean;
}) {
  const book = books.find((entry) => entry.outcome === outcome) ?? books[0];
  const offered = parsed.value ?? 0n;
  const result = useMemo(() => newEntryComparison(math, outcome, offered), [math, outcome, offered]);
  const acceptance = result.acceptance;

  return (
    <div className="px-4 py-5 sm:px-5">
      <div className="flex flex-wrap items-end gap-4">
        <label className="min-w-[9rem] flex-1">
          <span className="mb-1.5 block text-xs uppercase tracking-[0.12em] text-faint">Stake</span>
          <div className="flex items-center rounded-control border border-edge bg-ink focus-within:border-paper/40">
            <input
              inputMode="decimal"
              value={amountText}
              onChange={(event) => onAmount(event.target.value)}
              aria-invalid={parsed.error !== null}
              aria-describedby={parsed.error === null ? undefined : 'stake-error'}
              className="num w-full bg-transparent px-3 py-2.5 text-base outline-none"
            />
            <span className="px-3 text-sm text-muted">USDC</span>
          </div>
        </label>

        <label className="min-w-[11rem] flex-1">
          <span className="mb-1.5 block text-xs uppercase tracking-[0.12em] text-faint">On</span>
          <select
            value={outcome}
            onChange={(event) => onOutcome(Number(event.target.value))}
            className="w-full appearance-none rounded-control border border-edge bg-ink px-3 py-2.5 text-base outline-none focus:border-paper/40"
          >
            {books.map((entry) => (
              <option key={entry.outcome} value={entry.outcome}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {parsed.error === null ? null : (
        <p id="stake-error" className="mt-2 text-sm text-coral">
          {parsed.error}
        </p>
      )}

      {settlerKind === 'classic' ? (
        <p className="mt-4 rounded-control border border-edge px-3 py-2 text-sm text-muted">
          This market settles under the classic rule, so the vested column is what the same stake would have
          earned had it been opened on the vested settler with the same books.
        </p>
      ) : null}

      {frozen ? (
        <p className="mt-4 border border-edge px-3 py-2 text-sm text-muted">
          This market has frozen, so no further stake can be accepted. The numbers below are what the rules
          would have done with it while it was open.
        </p>
      ) : null}

      <Acceptance
        offered={acceptance.offered}
        accepted={acceptance.accepted}
        refused={acceptance.refused}
        bindingLabel={
          acceptance.bindingOutcome === null
            ? null
            : (books.find((entry) => entry.outcome === acceptance.bindingOutcome)?.label ?? null)
        }
        maxFullyAccepted={acceptance.maxFullyAccepted}
      />

      <Columns
        comparison={result.comparison}
        tone={book?.tone ?? 'neutral'}
        vpmNote="Accepted principal back, plus whatever vests in after you."
        classicNote="A share of a pool your own stake has just enlarged."
      />

      <Verdict comparison={result.comparison} />

      {result.incumbentMultipleBeforePpm !== null && result.incumbentClassicMultipleAfterPpm !== null &&
      offered > 0n ? (
        <p className="mt-4 border-t border-edge pt-4 text-sm leading-relaxed text-muted">
          Under the classic rule this stake also moves everyone already on {book?.label ?? 'this outcome'} from{' '}
          <span className="num text-paper">{formatMultiple(result.incumbentMultipleBeforePpm)}</span> to{' '}
          <span className="num text-paper">{formatMultiple(result.incumbentClassicMultipleAfterPpm)}</span> — the
          money it earns comes out of theirs. Under the vested rule their multiple cannot fall, because nothing
          that arrives after them vests to them.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- an existing position

function ExistingPosition({
  books,
  math,
  positions,
  positionId,
  onPosition,
}: {
  books: WireBook[];
  math: BookMath[];
  positions: WirePosition[];
  positionId: string;
  onPosition: (value: string) => void;
}) {
  const position = positions.find((entry) => entry.positionId === positionId) ?? positions[0];
  const book = position === undefined ? undefined : books.find((entry) => entry.outcome === position.outcome);

  const comparison = useMemo<RuleComparison | null>(() => {
    if (position === undefined || book === undefined) return null;
    return positionComparison({
      accepted: BigInt(position.accepted),
      entryAcc: BigInt(position.entryAcc),
      currentAcc: BigInt(book.acc),
      outcomePrincipal: BigInt(book.principal),
      acceptedPool: totalPrincipal(math),
    });
  }, [position, book, math]);

  if (position === undefined || book === undefined || comparison === null) {
    return <p className="px-4 py-6 text-sm text-muted sm:px-5">You hold no position in this market.</p>;
  }

  return (
    <div className="px-4 py-5 sm:px-5">
      {positions.length > 1 ? (
        <label className="mb-4 block max-w-sm">
          <span className="mb-1.5 block text-xs uppercase tracking-[0.12em] text-faint">Position</span>
          <select
            value={position.positionId}
            onChange={(event) => onPosition(event.target.value)}
            className="num w-full appearance-none rounded-control border border-edge bg-ink px-3 py-2.5 text-base outline-none focus:border-paper/40"
          >
            {positions.map((entry) => {
              const label = books.find((candidate) => candidate.outcome === entry.outcome)?.label ?? '';
              return (
                <option key={entry.positionId} value={entry.positionId}>
                  #{entry.positionId} · {label} · {formatAmount(BigInt(entry.accepted))} accepted
                </option>
              );
            })}
          </select>
        </label>
      ) : null}

      <p className="text-sm text-muted">
        Position <span className="num text-paper">#{position.positionId}</span> on{' '}
        <span className={TONE_TEXT[book.tone]}>{book.label}</span>, with{' '}
        <Amount value={BigInt(position.accepted)} className="text-paper" /> accepted. Both columns settle the
        same accepted principal on the same books, so the only thing that differs between them is the rule.
      </p>

      <Columns
        comparison={comparison}
        tone={book.tone}
        vpmNote="Principal, plus everything that vested to it since it entered."
        classicNote="Its share of the whole pool, whenever it arrived."
      />

      <Verdict comparison={comparison} />
    </div>
  );
}

// ---------------------------------------------------------------- shared pieces

function Acceptance({
  offered,
  accepted,
  refused,
  bindingLabel,
  maxFullyAccepted,
}: {
  offered: bigint;
  accepted: bigint;
  refused: bigint;
  bindingLabel: string | null;
  maxFullyAccepted: bigint | null;
}) {
  if (offered === 0n) return null;

  if (refused === 0n) {
    return (
      <p className="mt-5 rounded-control border border-edge px-3 py-2.5 text-sm text-muted">
        All <Amount value={accepted} className="text-paper" /> accepted.
        {maxFullyAccepted === null ? (
          <> Capacity is unbounded here, so nothing is refused for want of room.</>
        ) : (
          <>
            {' '}
            The opposing books would take up to <Amount value={maxFullyAccepted} className="text-paper" /> in full
            right now.
          </>
        )}
      </p>
    );
  }

  return (
    <div className="mt-5 rounded-control border border-edge px-3 py-2.5 text-sm">
      {/* Refusal is not an error and is not written as one. The stake did not
          fail; the opposing book did not have the room to cover it, and the
          rest comes straight back. */}
      <p className="text-paper">
        Capacity reached — <Amount value={accepted} className="text-paper" /> accepted,{' '}
        <Amount value={refused} className="text-paper" /> refunded.
      </p>
      <p className="mt-1.5 leading-relaxed text-muted">
        Stake on this outcome vests into {bindingLabel === null ? 'the opposing book' : bindingLabel}, and that
        book can only take so much: capacity is kappa times its own principal. Anything beyond it is refused and
        pulled back with <span className="num">withdrawRefund</span>. Nothing is lost and the transaction does
        not fail.
      </p>
    </div>
  );
}

function Columns({
  comparison,
  tone,
  vpmNote,
  classicNote,
}: {
  comparison: RuleComparison;
  tone: OutcomeTone;
  vpmNote: string;
  classicNote: string;
}) {
  return (
    <div className="mt-5 grid gap-px overflow-hidden rounded-card border border-edge bg-edge sm:grid-cols-2">
      <Column
        title="Vested"
        amount={comparison.vpm}
        multiplePpm={comparison.vpmMultiplePpm}
        note={vpmNote}
        accent={tone}
        leading={comparison.delta > 0n}
      />
      <Column
        title="Classic pool"
        amount={comparison.classic}
        multiplePpm={comparison.classicMultiplePpm}
        note={classicNote}
        accent="neutral"
        leading={comparison.delta < 0n}
      />
    </div>
  );
}

function Column({
  title,
  amount,
  multiplePpm,
  note,
  accent,
  leading,
}: {
  title: string;
  amount: bigint;
  multiplePpm: bigint | null;
  note: string;
  accent: OutcomeTone;
  leading: boolean;
}) {
  return (
    <div className="bg-raised px-4 py-4">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs uppercase tracking-[0.12em] text-faint">{title}</h4>
        {leading ? (
          <span className="num text-[10px] uppercase tracking-[0.12em] text-muted">pays more</span>
        ) : null}
      </div>
      <p className={`mt-2 text-2xl leading-none ${leading ? TONE_TEXT[accent] : ''}`}>
        <Amount value={amount} />
      </p>
      <p className="num mt-2 text-sm text-muted">{formatMultiple(multiplePpm)} of stake</p>
      <p className="mt-2 text-xs leading-relaxed text-faint">{note}</p>
    </div>
  );
}

function Verdict({ comparison }: { comparison: RuleComparison }) {
  if (comparison.stake === 0n) return null;
  if (comparison.delta === 0n) {
    return <p className="mt-4 text-sm text-muted">The two rules pay this stake exactly the same.</p>;
  }
  const vestedAhead = comparison.delta > 0n;
  const magnitude = vestedAhead ? comparison.delta : -comparison.delta;
  const share = comparison.deltaOfStakePpm ?? 0n;
  const sharePercent = (share < 0n ? -share : share) / 10_000n;

  return (
    <p className="mt-4 text-sm leading-relaxed">
      <span className={vestedAhead ? 'text-lime' : 'text-coral'}>
        {vestedAhead ? 'The vested rule pays' : 'The classic rule would pay'}{' '}
        <Amount value={magnitude} className="font-medium" /> more
      </span>
      <span className="text-muted">
        {' '}
        — <span className="num">{sharePercent.toString()}%</span> of the stake.
      </span>
    </p>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; disabled?: boolean }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-control border border-edge" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={option.disabled}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={`px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:text-faint ${
            option.value === value ? 'bg-paper text-ink font-semibold' : 'text-muted hover:text-paper'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface ParsedAmount {
  value: bigint | null;
  error: string | null;
}

/**
 * Amounts are parsed, not coerced — see `parseUsdcAmount`, which is shared with
 * the stake panel so the two cannot disagree about what a valid amount is.
 */
function parseAmount(text: string): ParsedAmount {
  const { value, problem } = parseUsdcAmount(text);
  return { value, error: problem };
}
