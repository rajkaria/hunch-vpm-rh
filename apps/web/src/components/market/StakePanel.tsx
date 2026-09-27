'use client';

import {
  CHAIN_ID,
  DOWN,
  ELIGIBILITY_STATEMENT,
  LATE_BETTOR_RULE,
  UP,
  approveUsdgCall,
  buildEnterAuthorization,
  enterCall,
  formatBps,
  formatUsdg,
  parseUsdgInput,
  randomSalt,
  type Deployment,
} from '@hunch-rh/client';
import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';

import { buttonClass } from '@/components/ui/primitives';
import type { RelayErrorBody, RelaySuccessBody } from '@/lib/api/relay';
import {
  BUSY_RETRIES,
  BUSY_WAIT_MS,
  IN_FLIGHT,
  VALIDITY_SEC,
  blockedReason,
  primaryAction,
  quoteProblem,
  type BetPath,
  type BetSide,
  type Phase,
} from '@/lib/market/bet-flow';
import { quoteFor, type LiveMarket } from '@/lib/market/model';
import { trackEvent } from '@/lib/wallet/analytics';
import { readEligible, writeEligible } from '@/lib/wallet/eligibility';
import { describeWalletError } from '@/lib/wallet/errors';
import { useWalletPort } from '@/lib/wallet/port';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface StakePanelProps {
  market: LiveMarket;
  deployment: Deployment;
  region: 'restricted' | 'open';
  nowSec: number;
  /** Called after a confirmed bet: refresh the market, positions and balance. */
  onConfirmed?: () => Promise<void> | void;
  relayUrl?: string;
  /** Wait between automatic retries of a bet that hit a full batch (tests shorten it). */
  retryWaitMs?: number;
}

function txUrl(explorer: string, hash: string): string {
  return `${explorer.replace(/\/$/, '')}/tx/${hash}`;
}

/**
 * The bet panel: UP or DOWN as words, an amount in USDG, the exact quote as you type, the
 * late-bettor rule before the bet, and one primary button that walks connect → switch → sign
 * (gasless, the default) or approve → enter (paying gas yourself). Errors are sentences with the
 * next step. Disabled, with the reason, whenever a bet could not be taken.
 */
export function StakePanel({ market, deployment, region, nowSec, onConfirmed, relayUrl = '/api/relay/enter', retryWaitMs = BUSY_WAIT_MS }: StakePanelProps) {
  const wallet = useWalletPort({ autoload: true });
  const json = market.json;
  const [side, setSide] = useState<BetSide>('UP');
  const [amountText, setAmountText] = useState('10');
  const [path, setPath] = useState<BetPath>('gasless');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [eligible, setEligible] = useState(false);
  const [remembered, setRemembered] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const quoteSeen = useRef(false);
  const ids = { amount: useId(), eligibility: useId(), quote: useId() };

  useEffect(() => {
    const stored = readEligible();
    setRemembered(stored);
    setEligible(stored);
  }, []);

  const address = wallet.status === 'connected' ? wallet.address : null;
  const refreshBalance = useCallback(async (): Promise<void> => {
    if (address === null) {
      setBalance(null);
      return;
    }
    try {
      setBalance(await wallet.usdgBalance(address));
    } catch {
      setBalance(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the port object changes with every wallet event
  }, [address]);
  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  const outcome = side === 'UP' ? UP : DOWN;
  const parsed = parseUsdgInput(amountText);
  const amount = parsed.ok ? parsed.amount : null;
  const quote = useMemo(() => (amount === null ? null : quoteFor(market, amount, outcome)), [market, amount, outcome]);

  const blocked = blockedReason({
    region,
    deployed: deployment.status === 'deployed',
    entriesPaused: json.entriesPaused,
    phase: json.market.phase,
    acceptingBets: json.market.acceptingBets,
    finalTime: json.market.finalTime,
    nowSec,
  });

  let formProblem: string | null = null;
  if (!parsed.ok) {
    formProblem =
      parsed.reason === 'too-many-decimals'
        ? 'USDG has 6 decimal places at most.'
        : parsed.reason === 'invalid'
          ? 'Enter an amount like 25 or 25.50.'
          : 'Enter an amount in USDG.';
  } else {
    formProblem = quoteProblem(quote, market);
  }
  if (formProblem === null && balance !== null && amount !== null && amount > balance) {
    formProblem = `You have ${formatUsdg(balance)} USDG on Robinhood Chain.`;
  }
  if (formProblem === null && !eligible) formProblem = 'Confirm where you live, above, to bet.';

  const primary = primaryAction({ blocked, walletStatus: wallet.status, chainId: wallet.chainId, phase, path, formProblem });

  // quote_shown: once per page view, when a real quote has stayed on screen for a moment.
  useEffect(() => {
    if (quoteSeen.current || blocked !== null || quote === null || quote.problem !== null) return;
    const timer = window.setTimeout(() => {
      quoteSeen.current = true;
      trackEvent('quote_shown', { side, family: json.market.family, ticker: json.market.ticker });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [quote, blocked, side, json.market.family, json.market.ticker]);

  const inFlight = IN_FLIGHT.has(phase.kind);

  const finish = async (hash: Hex, betPath: BetPath, betAmount: bigint, betSide: BetSide): Promise<void> => {
    setPhase({ kind: 'confirming', hash, path: betPath });
    let status: 'success' | 'reverted';
    try {
      status = await wallet.waitForReceipt(hash);
    } catch {
      setPhase({
        kind: 'error',
        message: 'Your bet was sent, but the chain has not confirmed it yet. It will appear under your positions once it does.',
        next: 'none',
      });
      return;
    }
    if (status !== 'success') {
      setPhase({ kind: 'error', message: 'The bet transaction failed on chain, so no USDG moved. Try again.', next: 'retry' });
      return;
    }
    setPhase({ kind: 'confirmed', hash, path: betPath, amount: betAmount, side: betSide });
    trackEvent('bet_confirmed', { path: betPath, side: betSide });
    await onConfirmed?.();
    void refreshBalance();
  };

  const placeGasless = async (from: Address, betAmount: bigint): Promise<void> => {
    const salt = randomSalt();
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + VALIDITY_SEC);
    const authorization = buildEnterAuthorization({
      from,
      hunchVpm: deployment.contracts.HunchVPM.address,
      marketId: market.id,
      outcome,
      amount: betAmount,
      validAfter: 0n,
      validBefore,
      salt,
    });
    setPhase({ kind: 'signing' });
    let signature: Hex;
    try {
      signature = await wallet.signTypedData(authorization);
    } catch (error) {
      setPhase({ kind: 'error', message: describeWalletError(error).message, next: 'none' });
      return;
    }
    trackEvent('bet_submitted', { path: 'gasless', side });
    const body = JSON.stringify({
      from,
      marketId: market.id.toString(),
      outcome,
      amount: betAmount.toString(),
      validAfter: '0',
      validBefore: validBefore.toString(),
      salt,
      signature,
      chainId: CHAIN_ID,
      hunchVpm: deployment.contracts.HunchVPM.address,
    });
    for (let attempt = 0; ; attempt += 1) {
      setPhase(attempt === 0 ? { kind: 'relaying' } : { kind: 'busy', attempt });
      let response: Response;
      try {
        response = await fetch(relayUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      } catch {
        setPhase({ kind: 'error', message: 'The relayer could not be reached. Try again, or pay gas yourself.', next: 'pay-gas' });
        return;
      }
      const result = (await response.json().catch(() => null)) as RelaySuccessBody | RelayErrorBody | null;
      if (response.ok && result !== null && result.ok) {
        await finish(result.txHash as Hex, 'gasless', betAmount, side);
        return;
      }
      if (result !== null && !result.ok && result.error === 'busy' && attempt < BUSY_RETRIES) {
        setPhase({ kind: 'busy', attempt: attempt + 1 });
        await sleep(result.retryAfter === undefined ? retryWaitMs : Math.min(retryWaitMs, result.retryAfter * 1000));
        continue;
      }
      setPhase({
        kind: 'error',
        message: result !== null && !result.ok ? result.message : 'The relayer did not answer. Try again, or pay gas yourself.',
        next: result !== null && !result.ok ? result.next : 'pay-gas',
      });
      return;
    }
  };

  const placePayingGas = async (from: Address, betAmount: bigint): Promise<void> => {
    const spender = deployment.contracts.HunchVPM.address;
    try {
      setPhase({ kind: 'checking' });
      const allowance = await wallet.usdgAllowance(from, spender);
      if (allowance < betAmount) {
        setPhase({ kind: 'approving' });
        const approval = await wallet.write(approveUsdgCall(deployment, { amount: betAmount }));
        setPhase({ kind: 'approve-pending', hash: approval });
        if ((await wallet.waitForReceipt(approval)) !== 'success') {
          setPhase({ kind: 'error', message: 'The approval failed on chain. Nothing was spent; try again.', next: 'retry' });
          return;
        }
      }
    } catch (error) {
      setPhase({ kind: 'error', message: describeWalletError(error).message, next: 'none' });
      return;
    }
    trackEvent('bet_submitted', { path: 'pay-gas', side });
    for (let attempt = 0; ; attempt += 1) {
      setPhase(attempt === 0 ? { kind: 'entering' } : { kind: 'busy', attempt });
      try {
        const hash = await wallet.write(enterCall(deployment, { marketId: market.id, outcome, amount: betAmount }));
        await finish(hash, 'pay-gas', betAmount, side);
        return;
      } catch (error) {
        const problem = describeWalletError(error);
        if (problem.kind === 'busy' && attempt < BUSY_RETRIES) {
          setPhase({ kind: 'busy', attempt: attempt + 1 });
          await sleep(retryWaitMs);
          continue;
        }
        setPhase({ kind: 'error', message: problem.message, next: problem.kind === 'insufficient-usdg' ? 'get-usdg' : 'none' });
        return;
      }
    }
  };

  const onPrimary = async (): Promise<void> => {
    if (primary.kind === 'connect') {
      wallet.openConnect();
      return;
    }
    if (primary.kind === 'switch') {
      setPhase({ kind: 'switching' });
      try {
        await wallet.switchToRobinhood();
        trackEvent('switch_chain', { from: 'bet' });
        setPhase({ kind: 'idle' });
      } catch (error) {
        setPhase({ kind: 'error', message: describeWalletError(error).message, next: 'none' });
      }
      return;
    }
    if (primary.kind !== 'bet' || primary.disabledReason !== null || amount === null || wallet.address === null) return;
    try {
      if (path === 'gasless') await placeGasless(wallet.address, amount);
      else await placePayingGas(wallet.address, amount);
    } catch (error) {
      // Anything unexpected still ends in words and a way back, never a stuck button.
      setPhase({ kind: 'error', message: describeWalletError(error).message, next: 'none' });
    }
  };

  const setMax = (): void => {
    if (balance === null) return;
    const max = balance < market.maxEntry ? balance : market.maxEntry;
    setAmountText(formatUsdg(max, { grouping: false }));
    if (phase.kind === 'error' || phase.kind === 'confirmed') setPhase({ kind: 'idle' });
  };

  const opposite: BetSide = side === 'UP' ? 'DOWN' : 'UP';
  const fee = formatBps(json.market.limits.feeBps);
  const showForm = blocked === null || blocked.short !== 'This market has settled';

  return (
    <section aria-labelledby={`${ids.amount}-title`} className="lift rounded-card border border-edge bg-raised p-4 sm:p-5" data-testid="stake-panel">
      <h2 id={`${ids.amount}-title`} className="font-body text-[15px] font-semibold tracking-normal text-paper">
        Place a bet
      </h2>

      {showForm ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2" role="group" aria-label="Your call">
            {(['UP', 'DOWN'] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                aria-pressed={side === choice}
                disabled={inFlight}
                onClick={() => setSide(choice)}
                className={`min-h-12 rounded-control border text-[15px] font-semibold tracking-[0.02em] transition-colors ${
                  side === choice
                    ? choice === 'UP'
                      ? 'border-lime/60 bg-lime/10 text-lime'
                      : 'border-coral/60 bg-coral/10 text-coral'
                    : 'border-edge bg-ghost text-muted hover:text-paper'
                }`}
              >
                {choice}
              </button>
            ))}
          </div>

          <div className="mt-4">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor={ids.amount} className="text-[11px] text-faint">
                Amount
              </label>
              <span className="text-[11px] text-faint">
                <span className="num">{formatUsdg(market.minEntry)}</span> to <span className="num">{formatUsdg(market.maxEntry)}</span> USDG
              </span>
            </div>
            <div className="mt-1.5 flex items-stretch gap-2">
              <div className="flex min-w-0 flex-1 items-center rounded-control border border-edge-strong bg-ghost px-3 focus-within:border-paper/30">
                <input
                  id={ids.amount}
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  value={amountText}
                  disabled={inFlight}
                  onChange={(event) => {
                    setAmountText(event.target.value);
                    if (phase.kind === 'error' || phase.kind === 'confirmed') setPhase({ kind: 'idle' });
                  }}
                  aria-describedby={ids.quote}
                  className="num min-h-12 w-full min-w-0 bg-transparent text-lg text-paper outline-none"
                />
                <span className="pl-2 text-sm text-faint">USDG</span>
              </div>
              <button type="button" onClick={setMax} disabled={balance === null || inFlight} className={buttonClass('secondary', 'sm', 'min-h-12 disabled:opacity-50')}>
                Max
              </button>
            </div>
            <p className="mt-1.5 text-xs text-faint">
              {address === null ? (
                'Connect to see your USDG balance on Robinhood Chain.'
              ) : balance === null ? (
                'Reading your USDG balance…'
              ) : (
                <>
                  Balance <span className="num text-muted">{formatUsdg(balance)}</span> USDG on Robinhood Chain.{' '}
                  {balance === 0n ? (
                    <Link href="/start" className="text-muted underline decoration-edge-strong underline-offset-2 hover:text-paper">
                      Get USDG
                    </Link>
                  ) : null}
                </>
              )}
            </p>
          </div>

          <dl id={ids.quote} aria-live="polite" className="mt-4 grid gap-2 rounded-control border border-edge bg-ghost p-3 text-sm" data-testid="quote">
            {quote === null || quote.problem === 'zero' ? (
              <p className="text-muted">Enter an amount to see exactly what you would be paid.</p>
            ) : quote.problem !== null && quote.problem !== 'no-room' ? (
              <p className="text-muted">{quoteProblem(quote, market)}</p>
            ) : (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted">Accepted now</dt>
                  <dd className="num text-paper" data-testid="quote-accepted">
                    {formatUsdg(quote.accepted)} USDG
                  </dd>
                </div>
                {quote.refused > 0n ? (
                  <p className="text-xs text-muted" data-testid="quote-refused">
                    <span className="num text-paper">{formatUsdg(quote.refused)}</span> USDG comes straight back.
                  </p>
                ) : null}
                <p className="leading-relaxed text-muted" data-testid="quote-floor">
                  If <span className={`font-semibold ${side === 'UP' ? 'text-lime' : 'text-coral'}`}>{side}</span> wins, you&rsquo;re paid at least{' '}
                  <span className="num text-paper">{formatUsdg(quote.floorIfWin)}</span> USDG, and this only goes up as people bet{' '}
                  <span className={`font-semibold ${opposite === 'UP' ? 'text-lime' : 'text-coral'}`}>{opposite}</span>.
                </p>
                <p className="text-xs text-faint">
                  Fee: <span className="num">{fee}</span> of winnings only · {path === 'gasless' ? 'No ETH needed' : 'You pay a little ETH for gas'}
                </p>
              </>
            )}
          </dl>

          <p className="mt-4 text-sm leading-relaxed text-muted">{LATE_BETTOR_RULE}</p>

          {remembered ? null : (
            <label htmlFor={ids.eligibility} className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-relaxed text-muted">
              <input
                id={ids.eligibility}
                type="checkbox"
                checked={eligible}
                disabled={blocked !== null}
                onChange={(event) => {
                  setEligible(event.target.checked);
                  writeEligible(event.target.checked);
                }}
                className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-lime)]"
              />
              <span>{ELIGIBILITY_STATEMENT}</span>
            </label>
          )}
        </>
      ) : null}

      <div className="mt-4">
        {phase.kind === 'confirmed' ? (
          <div className="rounded-control border border-lime/35 bg-lime/10 p-3" role="status" data-testid="bet-confirmed">
            <p className="text-sm font-semibold text-paper">
              Bet placed: <span className="num">{formatUsdg(phase.amount)}</span> USDG on{' '}
              <span className={phase.side === 'UP' ? 'text-lime' : 'text-coral'}>{phase.side}</span>.
            </p>
            <p className="mt-1 text-xs text-muted">It is matched against the other side within about 15 seconds; it shows under your positions.</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-4">
              <a href={txUrl(deployment.explorer, phase.hash)} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-11 items-center text-sm text-muted underline decoration-edge-strong underline-offset-2 hover:text-paper">
                View the transaction
              </a>
              <button type="button" onClick={() => setPhase({ kind: 'idle' })} className="inline-flex min-h-11 items-center text-sm font-semibold text-paper underline decoration-paper/25 underline-offset-4 hover:decoration-lime">
                Place another bet
              </button>
            </div>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void onPrimary()}
              disabled={primary.kind === 'blocked' || primary.kind === 'progress' || (primary.kind === 'bet' && primary.disabledReason !== null)}
              aria-busy={primary.kind === 'progress' || undefined}
              className={buttonClass('primary', 'md', 'w-full disabled:cursor-not-allowed disabled:bg-paper/10 disabled:text-muted')}
              data-testid="primary-action"
            >
              {primary.label}
            </button>
            <p className="mt-2 min-h-5 text-xs leading-relaxed text-muted" data-testid="primary-reason">
              {primary.kind === 'blocked' ? primary.reason : primary.kind === 'bet' ? primary.disabledReason : null}
              {primary.kind === 'switch' ? 'Bets are signed on Robinhood Chain. Switching is free and sends nothing.' : null}
            </p>
          </>
        )}

        {phase.kind === 'error' ? (
          <div className="mt-2 rounded-control border border-coral/35 bg-coral/10 p-3" role="alert" data-testid="bet-error">
            <p className="text-sm text-paper">{phase.message}</p>
            {phase.next === 'pay-gas' && path === 'gasless' ? (
              <button
                type="button"
                onClick={() => {
                  setPath('pay-gas');
                  setPhase({ kind: 'idle' });
                }}
                className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-paper underline decoration-paper/25 underline-offset-4 hover:decoration-lime"
              >
                Pay gas yourself instead
              </button>
            ) : null}
            {phase.next === 'get-usdg' ? (
              <Link href="/start" className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-paper underline decoration-paper/25 underline-offset-4 hover:decoration-lime">
                Get USDG on Robinhood Chain
              </Link>
            ) : null}
          </div>
        ) : null}

        {blocked === null && phase.kind !== 'confirmed' ? (
          <>
            <p className="mt-3 text-xs leading-relaxed text-faint">
              Your bet is matched against the other side within ~15 seconds. Any part that does not fit comes straight back.
            </p>
            <button
              type="button"
              disabled={inFlight}
              onClick={() => {
                setPath(path === 'gasless' ? 'pay-gas' : 'gasless');
                if (phase.kind === 'error') setPhase({ kind: 'idle' });
              }}
              className="mt-1 inline-flex min-h-11 items-center text-xs font-semibold text-muted underline decoration-edge-strong underline-offset-4 hover:text-paper disabled:opacity-50"
            >
              {path === 'gasless' ? 'Pay gas yourself instead' : 'Use the gasless bet instead (no ETH)'}
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}
