/**
 * Wallet errors are long and mostly for us. A rejection is the common case and
 * is not an error at all — it is someone changing their mind, and it should not
 * be shouted at them.
 */
export function friendlyError(error: { message?: string } | null | undefined): string {
  const message = error?.message ?? 'Something went wrong.';
  if (/user rejected|denied transaction|rejected the request/i.test(message)) {
    return 'You dismissed the request in your wallet. Nothing was sent.';
  }
  if (/insufficient funds/i.test(message)) {
    return 'Not enough USDC to cover the stake and its gas. USDC is the gas token on Arc.';
  }
  if (/Frozen\(\)/.test(message)) {
    return 'This market froze before the transaction landed. No entry can be accepted now.';
  }
  if (/NotOpen\(\)/.test(message)) {
    return 'This market is no longer open.';
  }
  return message.split('\n')[0] ?? message;
}
