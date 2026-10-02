'use client';

import { CHAIN_ID, PREVIEW_STATUS, formatPrice, resolveCall, voidBadAnswerCall, voidMarketCall, voidPausedCall, voidStaleCall, type Deployment } from '@hunch-rh/client';
import { useState } from 'react';
import type { Hex } from 'viem';

import { buttonClass } from '@/components/ui/primitives';
import type { MarketDetailJson, RoundJson } from '@/lib/api/shapes';
import { formatEtDateTime } from '@/lib/et';
import { trackEvent } from '@/lib/wallet/analytics';
import { describeWalletError } from '@/lib/wallet/errors';
import type { WalletPort } from '@/lib/wallet/port';
import { feedRoundUrl } from '@/lib/view/early-vs-late';

const DAY = 86_400;

function tx(explorer: string, hash: string): string {
  return `${explorer.replace(/\/$/, '')}/tx/${hash}`;
}

function Round({ label, round, explorer, feed, bell }: { label: string; round: RoundJson | null; explorer: string; feed: string; bell: number }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-faint">{label}</p>
      {round === null ? (
        <p className="mt-1 text-sm text-muted">Not found yet</p>
      ) : (
        <>
          <p className="num mt-1 text-[15px] text-paper">{formatPrice(BigInt(round.answer))}</p>
          <a href={feedRoundUrl(explorer, feed)} target="_blank" rel="noreferrer noopener" className="num break-hash text-[11px] text-faint underline decoration-edge-strong underline-offset-2 hover:text-paper">
            round {round.roundId}
          </a>
          <p className="num text-[11px] text-faint">
            printed {formatEtDateTime(round.at)} · bell {formatEtDateTime(bell)}
          </p>
        </>
      )}
    </div>
  );
}

type Action = { kind: 'resolve' | 'void-stale' | 'void-bad-answer' | 'void-paused' | 'void-timeout'; label: string } | null;

/** What `preview` says about the two proven rounds, in words, and which call settles it. */
export function previewInWords(detail: MarketDetailJson, nowSec: number): { text: string; action: Action } {
  const m = detail.market;
  if (nowSec >= m.voidableAt) {
    return { text: 'Nobody settled this market within 72 hours of the bell, so anyone can refund every bet in full.', action: { kind: 'void-timeout', label: 'Refund everyone yourself' } };
  }
  const finder = detail.finder;
  if (finder === null) return { text: 'Finding the two Chainlink rounds that decide this market.', action: null };
  if (!finder.ok) return { text: 'The rounds that decide this market cannot be proven on chain yet. Hunch is looking at it; if nobody can settle it, anyone can refund it 72 hours after the bell.', action: null };
  const preview = detail.preview;
  const status = preview?.status ?? null;
  switch (status) {
    case PREVIEW_STATUS.UP:
    case PREVIEW_STATUS.DOWN:
      return {
        text: `The closing price is ${status === PREVIEW_STATUS.UP ? 'higher' : 'lower'} than the opening price, so it settles ${status === PREVIEW_STATUS.UP ? 'UP' : 'DOWN'}.`,
        action: { kind: 'resolve', label: 'Resolve it yourself' },
      };
    case PREVIEW_STATUS.FLAT:
      return { text: 'The price did not move between the bells, so settling refunds every bet in full.', action: { kind: 'resolve', label: 'Resolve it yourself' } };
    case PREVIEW_STATUS.STALE:
      return { text: 'A price at one of the bells was older than this market allows, so every bet is refunded in full.', action: { kind: 'void-stale', label: 'Refund everyone yourself' } };
    case PREVIEW_STATUS.BADANSWER:
      return {
        text: "Chainlink's price at one of the bells is out of range (not a real price), so every bet is refunded in full.",
        action: { kind: 'void-bad-answer', label: 'Refund everyone yourself' },
      };
    case PREVIEW_STATUS.PAUSED:
      return nowSec >= m.finalTime + DAY
        ? { text: "Robinhood paused this token's price for more than a day, so every bet is refunded in full.", action: { kind: 'void-paused', label: 'Refund everyone yourself' } }
        : { text: "Robinhood has paused this token's price. Settlement waits; after a day paused, every bet is refunded.", action: null };
    case PREVIEW_STATUS.NOT_READY:
      return { text: 'The resolver can settle this a moment after the bell.', action: null };
    case PREVIEW_STATUS.BADPROOF:
      return { text: 'These rounds do not prove the prices at the bells yet. Hunch is looking at it.', action: null };
    default:
      return { text: 'Reading what the resolver will say about these rounds.', action: null };
  }
}

const REASON: Record<string, string> = {
  flat: 'The price did not move between the bells, so every bet was refunded in full.',
  stale: 'A price at one of the bells was older than this market allows, so every bet was refunded in full.',
  'bad-answer': "Chainlink's price at one of the bells was out of range, so every bet was refunded in full.",
  paused: "Robinhood paused this token's price for more than a day, so every bet was refunded in full.",
  timeout: 'Nobody settled this market within 72 hours of the bell, so it was refunded in full.',
};

/**
 * After the bell: the two Chainlink rounds that decide the market (found by the same finder the
 * keeper uses), what the resolver's `preview` says about them, and a button any connected wallet
 * can press to settle it with those rounds. After settlement: the result, the rounds, and the
 * settlement and payout transactions.
 */
export function ResolutionPanel({
  detail,
  deployment,
  wallet,
  nowSec,
  onSettled,
}: {
  detail: MarketDetailJson;
  deployment: Deployment;
  wallet: WalletPort;
  nowSec: number;
  onSettled: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [sent, setSent] = useState<Hex | null>(null);
  const m = detail.market;
  const settled = m.phase === 'resolved' || m.phase === 'void';
  if (!settled && nowSec < m.finalTime) return null;

  const explorer = deployment.explorer;
  const resolution = detail.resolution;
  const finder = detail.finder;
  const words = settled ? null : previewInWords(detail, nowSec);
  const paid = detail.positions.filter((p) => p.payoutTx !== null);
  const owed = detail.positions.filter((p) => p.settlement.deliverable);

  const act = async (action: NonNullable<Action>): Promise<void> => {
    if (wallet.status !== 'connected') {
      wallet.openConnect();
      return;
    }
    setBusy(true);
    setMessage(null);
    trackEvent('resolve_clicked', { action: action.kind });
    try {
      if (wallet.chainId !== CHAIN_ID) await wallet.switchToRobinhood();
      const rounds = { specId: m.specId as Hex, strikeRound: BigInt(finder?.strikeRound ?? '0'), finalRound: BigInt(finder?.finalRound ?? '0') };
      const call =
        action.kind === 'resolve'
          ? resolveCall(deployment, rounds)
          : action.kind === 'void-stale'
            ? voidStaleCall(deployment, rounds)
            : action.kind === 'void-bad-answer'
              ? voidBadAnswerCall(deployment, rounds)
              : action.kind === 'void-paused'
                ? voidPausedCall(deployment, m.specId as Hex)
                : voidMarketCall(deployment, BigInt(m.id));
      const hash = await wallet.write(call);
      setSent(hash);
      const status = await wallet.waitForReceipt(hash);
      setMessage(status === 'success' ? 'Settled. Payouts go out automatically; you can also claim yours below.' : 'The transaction failed on chain. Someone may have settled it first; refreshing.');
      await onSettled();
    } catch (error) {
      setMessage(describeWalletError(error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="settlement-title" className="rounded-card border border-edge bg-raised p-4 sm:p-5" data-testid="resolution-panel">
      <h2 id="settlement-title" className="font-body text-[15px] font-semibold tracking-normal text-paper">
        Settlement
      </h2>

      {settled && resolution !== null ? (
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {resolution.outcome === 'UP' || resolution.outcome === 'DOWN' ? (
            <>
              Resolved <span className={`font-semibold ${resolution.outcome === 'UP' ? 'text-lime' : 'text-coral'}`}>{resolution.outcome}</span> from the two
              Chainlink rounds below.
            </>
          ) : (
            (REASON[resolution.reason ?? ''] ?? 'Refunded: every bet came back in full.')
          )}
        </p>
      ) : words !== null ? (
        <p className="mt-2 text-sm leading-relaxed text-muted" data-testid="preview-words">
          {words.text}
        </p>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-4 border-t border-edge pt-4 sm:grid-cols-2">
        <Round label="Opening price (round in effect at the opening bell)" round={finder?.strike ?? null} explorer={explorer} feed={m.feed} bell={m.strikeTime} />
        <Round label="Closing price (round in effect at the closing bell)" round={finder?.final ?? null} explorer={explorer} feed={m.feed} bell={m.finalTime} />
      </div>

      {!settled && words?.action != null ? (
        <div className="mt-4">
          <button type="button" onClick={() => void act(words.action!)} disabled={busy} className={buttonClass('secondary', 'md', 'w-full disabled:opacity-60')}>
            {busy ? 'Check your wallet' : wallet.status === 'connected' ? words.action.label : `Connect to ${words.action.label.toLowerCase()}`}
          </button>
          <p className="mt-2 text-xs leading-relaxed text-faint">
            Anyone can settle a market with these two rounds; the contract checks them and pays nobody for pressing. It costs a little ETH for gas. Hunch&rsquo;s keeper does it automatically within minutes.
          </p>
        </div>
      ) : null}

      {message === null ? null : (
        <p className="mt-2 text-sm text-muted" role="status">
          {message} {sent === null ? null : <a href={tx(explorer, sent)} target="_blank" rel="noreferrer noopener" className="underline decoration-edge-strong underline-offset-2 hover:text-paper">Transaction</a>}
        </p>
      )}

      {settled ? (
        <div className="mt-4 border-t border-edge pt-3 text-sm">
          {resolution?.tx != null ? (
            <a href={tx(explorer, resolution.tx)} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-11 items-center text-muted underline decoration-edge-strong underline-offset-2 hover:text-paper">
              Settlement transaction
            </a>
          ) : (
            <p className="text-faint">Settlement transaction: read from the chain logs when available.</p>
          )}
          <p className="mt-1 text-muted">
            <span className="num text-paper">{paid.length}</span> payout {paid.length === 1 ? 'transaction' : 'transactions'} delivered
            {owed.length > 0 ? (
              <>
                , <span className="num text-paper">{owed.length}</span> still to deliver (Hunch sends them within about 10 minutes)
              </>
            ) : null}
            . Each links from its amount in the list of bets.
          </p>
        </div>
      ) : null}
    </section>
  );
}
