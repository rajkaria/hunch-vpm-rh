/**
 * Wallet and contract errors in plain words, each with the next step. Matched on EIP-1193 codes
 * and on the contracts' custom error names, never shown raw.
 */

export type WalletProblemKind =
  | 'rejected'
  | 'busy'
  | 'closed'
  | 'paused'
  | 'insufficient-usdg'
  | 'insufficient-gas'
  | 'frozen-address'
  | 'too-small'
  | 'too-large'
  | 'wrong-network'
  | 'pending-request'
  | 'authorization-used'
  | 'not-paid'
  | 'unknown';

export interface WalletProblem {
  kind: WalletProblemKind;
  message: string;
}

function codeOf(error: unknown): number | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'number') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function textOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'string') {
      parts.push(current);
      break;
    }
    const e = current as { shortMessage?: string; message?: string; details?: string; name?: string; data?: { errorName?: string }; cause?: unknown };
    parts.push(e.shortMessage ?? '', e.message ?? '', e.details ?? '', e.name ?? '', e.data?.errorName ?? '');
    current = e.cause;
  }
  return parts.join(' ');
}

export function isUserRejection(error: unknown): boolean {
  return codeOf(error) === 4001 || /user (rejected|denied)|rejected the request|request rejected|UserRejectedRequestError|cancel+ed by user/i.test(textOf(error));
}

export function isUnknownChain(error: unknown): boolean {
  const code = codeOf(error);
  return code === 4902 || /unrecognized chain|unknown chain|chain .*not (been )?added|4902/i.test(textOf(error));
}

export function describeWalletError(error: unknown): WalletProblem {
  const text = textOf(error);
  if (isUserRejection(error)) return { kind: 'rejected', message: 'You declined in your wallet. Nothing was sent; you can try again.' };
  if (codeOf(error) === -32002) return { kind: 'pending-request', message: 'Your wallet already has a request open. Check it, then try again.' };
  if (/VintageFull/.test(text)) return { kind: 'busy', message: 'Busy: many bets landed in the last few seconds. Retrying in a few seconds.' };
  if (/EntriesArePaused/.test(text)) return { kind: 'paused', message: 'New bets are paused right now. Claims and payouts are not affected.' };
  if (/AuthorizationUsed|AuthorizationAlreadyUsed/.test(text)) return { kind: 'authorization-used', message: 'This signed bet was already used or cancelled. Sign a new bet.' };
  if (/NotPaid/.test(text)) return { kind: 'not-paid', message: 'USDG did not move for this bet, so it was not placed. Check your balance and try again.' };
  if (/\bFrozen\b|NotOpen|market is no longer/i.test(text)) return { kind: 'closed', message: 'This market is no longer taking bets.' };
  if (/AddressFrozen|account is frozen|frozen address/i.test(text)) return { kind: 'frozen-address', message: 'USDG has frozen this wallet, so it cannot bet.' };
  if (/EntryTooSmall/.test(text)) return { kind: 'too-small', message: 'This bet is below the market minimum.' };
  if (/EntryTooLarge|AmountTooLarge/.test(text)) return { kind: 'too-large', message: 'This bet is above the market maximum.' };
  if (/insufficient funds|gas required exceeds|exceeds the balance of the account/i.test(text)) {
    return { kind: 'insufficient-gas', message: 'Paying gas yourself needs a little ETH on Robinhood Chain. The gasless bet needs none.' };
  }
  if (/InsufficientBalance|transfer amount exceeds balance|exceeds balance|insufficient balance|ERC20InsufficientBalance/i.test(text)) {
    return { kind: 'insufficient-usdg', message: 'Not enough USDG in this wallet on Robinhood Chain.' };
  }
  if (/chain mismatch|does not match the target chain|ChainMismatch|chainId should be same|switch.*chain/i.test(text)) {
    return { kind: 'wrong-network', message: 'Switch your wallet to Robinhood Chain, then try again.' };
  }
  const first = (text.trim().split('\n')[0] ?? '').replace(/\s+/g, ' ').slice(0, 140);
  return { kind: 'unknown', message: `Something went wrong${first === '' ? '' : `: ${first}`}. Nothing was sent unless your wallet shows a transaction; you can try again.` };
}
