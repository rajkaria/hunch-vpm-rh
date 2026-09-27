/**
 * The bet panel's state machine, as pure functions: what the one primary button says and does
 * for a given wallet, market and form, and the phases a bet goes through on each path.
 *
 * Gasless (default): connect → switch (add, then switch) → sign one USDG authorization → the
 * relayer sends it → receipt → confirmed.
 * Pay gas yourself: connect → switch → approve the exact amount (if the allowance is short) →
 * enter → receipt → confirmed.
 */

import { CHAIN_ID, formatUsdg, type Quote } from '@hunch-rh/client';
import type { Hex } from 'viem';

import type { RelayNext } from '@/lib/api/relay';
import type { WalletStatus } from '@/lib/wallet/bridge';

export type BetPath = 'gasless' | 'pay-gas';
export type BetSide = 'UP' | 'DOWN';

export type Phase =
  | { kind: 'idle' }
  | { kind: 'switching' }
  | { kind: 'signing' }
  | { kind: 'relaying' }
  | { kind: 'busy'; attempt: number }
  | { kind: 'checking' }
  | { kind: 'approving' }
  | { kind: 'approve-pending'; hash: Hex }
  | { kind: 'entering' }
  | { kind: 'confirming'; hash: Hex; path: BetPath }
  | { kind: 'confirmed'; hash: Hex; path: BetPath; amount: bigint; side: BetSide }
  | { kind: 'error'; message: string; next: RelayNext };

export const IN_FLIGHT: ReadonlySet<Phase['kind']> = new Set(['switching', 'signing', 'relaying', 'busy', 'checking', 'approving', 'approve-pending', 'entering', 'confirming']);

export interface Blocked {
  /** The disabled button's words. */
  short: string;
  /** The sentence under it. */
  long: string;
}

export interface GateInput {
  region: 'restricted' | 'open';
  deployed: boolean;
  entriesPaused: boolean;
  phase: 'opens' | 'live' | 'frozen' | 'resolved' | 'void';
  acceptingBets: boolean;
  finalTime: number;
  nowSec: number;
}

/** Seconds before the bell after which the relayer refuses a bet (it must land before the bell). */
export const CLOSE_MARGIN_SEC = 20;

/** Why this panel cannot take a bet right now, or null. */
export function blockedReason(input: GateInput): Blocked | null {
  if (input.region === 'restricted') {
    return {
      short: 'Not available in your country',
      long: 'Stock-price markets are not offered to persons in the United States, Canada, the United Kingdom or Switzerland.',
    };
  }
  if (!input.deployed) return { short: 'Opens with the venue launch', long: 'Hunch is not deployed on Robinhood Chain yet. Nothing here takes a bet.' };
  if (input.phase === 'resolved' || input.phase === 'void') return { short: 'This market has settled', long: 'Betting is over. Every payout and refund is shown below.' };
  if (input.phase === 'frozen' || input.nowSec >= input.finalTime) {
    return { short: 'Bets closed at the bell', long: 'This market stopped taking bets at the closing bell and is waiting to settle.' };
  }
  if (input.entriesPaused) return { short: 'New bets are paused', long: 'New bets are paused right now. Claims and payouts are not affected.' };
  if (!input.acceptingBets) return { short: 'Not taking bets', long: 'This market is not taking bets right now.' };
  if (input.finalTime - input.nowSec < CLOSE_MARGIN_SEC) return { short: 'Bets close at the bell', long: 'The closing bell is seconds away; a bet sent now could not land in time.' };
  return null;
}

export type Primary =
  | { kind: 'blocked'; label: string; reason: string }
  | { kind: 'connect'; label: string }
  | { kind: 'switch'; label: string }
  | { kind: 'bet'; label: string; disabledReason: string | null }
  | { kind: 'progress'; label: string };

export interface PrimaryInput {
  blocked: Blocked | null;
  walletStatus: WalletStatus;
  chainId: number | null;
  phase: Phase;
  path: BetPath;
  /** Why the form cannot be sent (amount, quote, balance, eligibility), or null. */
  formProblem: string | null;
}

const PROGRESS: Partial<Record<Phase['kind'], string>> = {
  switching: 'Check your wallet',
  signing: 'Sign in your wallet',
  relaying: 'Sending your bet',
  busy: 'Busy, retrying in a few seconds',
  checking: 'Checking your USDG',
  approving: 'Approve in your wallet',
  'approve-pending': 'Waiting for the approval',
  entering: 'Confirm in your wallet',
  confirming: 'Waiting for the chain',
};

export function primaryAction(input: PrimaryInput): Primary {
  if (input.blocked !== null) return { kind: 'blocked', label: input.blocked.short, reason: input.blocked.long };
  const progress = PROGRESS[input.phase.kind];
  if (progress !== undefined) return { kind: 'progress', label: progress };
  if (input.walletStatus !== 'connected') {
    return { kind: 'connect', label: input.walletStatus === 'connecting' || input.walletStatus === 'reconnecting' ? 'Connecting' : 'Connect' };
  }
  if (input.chainId !== CHAIN_ID) return { kind: 'switch', label: 'Switch to Robinhood Chain' };
  return { kind: 'bet', label: input.path === 'gasless' ? 'Place bet' : 'Place bet, paying gas', disabledReason: input.formProblem };
}

/** The quote's problem in words, or null. */
export function quoteProblem(quote: Quote | null, limits: { minEntry: bigint; maxEntry: bigint }): string | null {
  if (quote === null || quote.problem === null) return null;
  switch (quote.problem) {
    case 'zero':
      return 'Enter an amount in USDG.';
    case 'below-min':
      return `The smallest bet is ${formatUsdg(limits.minEntry)} USDG.`;
    case 'above-max':
      return `The largest bet is ${formatUsdg(limits.maxEntry)} USDG.`;
    case 'no-room':
      return 'The other side has no room for this bet right now; all of it would come straight back.';
    case 'vintage-full':
      return 'Many bets just landed. Try again in a few seconds.';
  }
}

/** Relay `validBefore`: about ten minutes (the relayer accepts up to an hour, and needs 30 s left). */
export const VALIDITY_SEC = 600;
/** How many times a bet that hit a full batch is retried automatically. */
export const BUSY_RETRIES = 5;
export const BUSY_WAIT_MS = 3000;
