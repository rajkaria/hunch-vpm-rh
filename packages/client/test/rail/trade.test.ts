import { decodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';
import { TradeRefusedError } from '../../src/rail/errors.js';
import { isUnsignedTrade } from '../../src/rail/types.js';
import { erc20Abi, settlerAbi } from '../../src/writes/abi.js';
import marketFull from './fixtures/market-full.json';
import marketHeadroom from './fixtures/market-headroom.json';
import { ALICE, everyKey, MARKET_FULL, MARKET_HEADROOM, SETTLER, testRail, USDC } from './support.js';

const headroomRail = () => testRail({ market: marketHeadroom });

/**
 * Anything that would let a caller believe this rail had signed, broadcast, or
 * could sign something. `signed` is deliberately not in the list: it is on the
 * object on purpose, as the literal `false`.
 */
const FORBIDDEN_KEY = /signature|privatekey|mnemonic|rawtransaction|serialized|txhash|transactionhash|receipt/i;
const FORBIDDEN_EXACT = new Set([
  'sign',
  'send',
  'sendTransaction',
  'submit',
  'broadcast',
  'execute',
  'hash',
  'key',
  'account',
  'signer',
  'wallet',
  'v',
  'r',
  's',
]);

/** The refusal a call raised, or a failed expectation if it did not raise one. */
async function refusalOf(promise: Promise<unknown>): Promise<TradeRefusedError> {
  const outcome = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(outcome).toBeInstanceOf(TradeRefusedError);
  return outcome as TradeRefusedError;
}

describe('trade: unsigned calldata, never a signed transaction', () => {
  it('hands back calldata and says so three times over', async () => {
    const { rail } = headroomRail();
    const trade = await rail.trade(MARKET_HEADROOM, 'no', 10_000000n, { wallet: ALICE });

    expect(trade.kind).toBe('unsigned-calldata');
    expect(trade.signed).toBe(false);
    expect(trade.custody).toBe('self');
    expect(isUnsignedTrade(trade)).toBe(true);
    expect(trade.from).toBe('0x4444444444444444444444444444444444444444');
  });

  it('carries nothing signable, at any depth', async () => {
    const { rail } = headroomRail();
    const trade = await rail.trade(MARKET_HEADROOM, 'no', 10_000000n, { wallet: ALICE });

    for (const { path, value } of everyKey(trade)) {
      const key = path.split('.').at(-1) ?? '';
      expect(FORBIDDEN_KEY.test(key), `unexpected key on a trade result: ${path}`).toBe(false);
      expect(FORBIDDEN_EXACT.has(key), `unexpected key on a trade result: ${path}`).toBe(false);
      // No method could produce a signature or send anything either.
      expect(typeof value, `unexpected callable on a trade result: ${path}`).not.toBe('function');
    }
  });

  it('carries no hex long enough to be a signed payload except the calldata itself', async () => {
    const { rail } = headroomRail();
    const trade = await rail.trade(MARKET_HEADROOM, 'no', 10_000000n);

    const longHex = everyKey(trade).filter(
      (entry) => typeof entry.value === 'string' && entry.value.startsWith('0x') && entry.value.length > 66,
    );
    expect(longHex.length).toBeGreaterThan(0);
    for (const entry of longHex) {
      expect(entry.path, 'only step calldata may be a long hex blob').toMatch(/^steps\.\d+\.call\.data$/);
    }
  });

  it('cannot be decorated with a signature after the fact', async () => {
    const { rail } = headroomRail();
    const trade = await rail.trade(MARKET_HEADROOM, 'no', 10_000000n);
    const mutable = trade as unknown as Record<string, unknown>;

    expect(() => {
      mutable['signature'] = '0xdeadbeef';
    }).toThrow(TypeError);
    expect(() => {
      mutable['signed'] = true;
    }).toThrow(TypeError);
    expect(Object.isFrozen(trade)).toBe(true);
    expect(Object.isFrozen(trade.steps[0]?.call)).toBe(true);
  });

  it('builds an allowance step and an entry step, in that order', async () => {
    const { rail } = headroomRail();
    const trade = await rail.trade(MARKET_HEADROOM, 'no', 10_000000n);

    expect(trade.steps.map((step) => step.id)).toEqual(['approve', 'enter']);
    // The allowance cannot be read from the index, so the step states its
    // condition rather than claiming to be necessary.
    expect(trade.steps[0]?.when).toBe('if-allowance-below-amount');
    expect(trade.steps[1]?.when).toBe('always');
    for (const step of trade.steps) {
      expect(Object.keys(step.call).sort()).toEqual(['data', 'to', 'value']);
      expect(step.call.value).toBe(0n);
      expect(step.chainId).toBe(5042002);
    }
  });

  it('offers the whole stake, not the part that would be accepted', async () => {
    const { rail } = headroomRail();
    const trade = await rail.trade(MARKET_HEADROOM, 'no', 20_000000n);
    const enter = trade.steps.find((step) => step.id === 'enter');

    const decoded = decodeFunctionData({ abi: settlerAbi, data: enter?.call.data ?? '0x' });
    expect(decoded.functionName).toBe('enter');
    // 14 would be accepted, but the settler pulls the whole 20 and refunds the
    // rest by pull. Offering only 14 would be a different trade.
    expect(decoded.args).toEqual([7n, 1, 20_000000n]);
    expect(trade.quote.accepted).toBe(14_000000n);
    expect(trade.quote.escrowed).toBe(20_000000n);
  });

  it('targets the settler and asset the index reports, not a configured default', async () => {
    // Nothing is set in `addresses`, so the configured settler is the network
    // default — a different contract from the one this market's index row names.
    // The rail uses the market's own settler, so a stale or unconfigured default
    // never redirects a trade.
    const { rail } = headroomRail();
    expect(rail.client.config.addresses.vestedParimutuel.toLowerCase()).not.toBe(SETTLER.toLowerCase());

    const trade = await rail.trade(MARKET_HEADROOM, 'no', 10_000000n);
    expect(trade.steps.find((step) => step.id === 'enter')?.call.to).toBe(SETTLER);

    const approve = trade.steps.find((step) => step.id === 'approve');
    expect(approve?.call.to).toBe(USDC);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approve?.call.data ?? '0x' });
    expect(decoded.functionName).toBe('approve');
    expect(decoded.args).toEqual([SETTLER, 10_000000n]);
  });

  it('can leave the allowance step out', async () => {
    const { rail } = headroomRail();
    const trade = await rail.trade(MARKET_HEADROOM, 'no', 10_000000n, { includeApproval: false });
    expect(trade.steps.map((step) => step.id)).toEqual(['enter']);
  });

  it('warns about a partial fill instead of burying it in the quote', async () => {
    const { rail } = headroomRail();
    const trade = await rail.trade(MARKET_HEADROOM, 'no', 20_000000n);

    expect(trade.quote.acceptance).toBe('partial');
    expect(trade.warnings.join(' ')).toContain('Partial fill');
    expect(trade.warnings.join(' ')).toContain('withdrawRefund');
    expect(trade.warnings.join(' ')).toContain('Nothing here is signed');
  });

  it('refuses to build calldata for a market past its freeze', async () => {
    const { rail } = headroomRail();
    await expect(
      rail.trade(MARKET_HEADROOM, 'no', 10_000000n, { now: 2_000_000_000n }),
    ).rejects.toThrow(TradeRefusedError);

    const error = await refusalOf(rail.trade(MARKET_HEADROOM, 'no', 10_000000n, { now: 2_000_000_000n }));
    expect(error.message).toContain('Frozen');
    expect(error.quote.acceptance).toBe('none');
  });

  it('refuses a stake the books would take nothing of, unless asked twice', async () => {
    const { rail } = testRail({ market: marketFull });
    await expect(rail.trade(MARKET_FULL, 'yes', 5_000000n)).rejects.toThrow(TradeRefusedError);

    const anyway = await rail.trade(MARKET_FULL, 'yes', 5_000000n, { acceptTotalRefusal: true });
    expect(anyway.quote.accepted).toBe(0n);
    expect(anyway.warnings.join(' ')).toContain('Nothing would be accepted');
  });

  it('honours all-or-nothing, and says how large a stake would have been taken whole', async () => {
    const { rail } = headroomRail();
    const error = await refusalOf(rail.trade(MARKET_HEADROOM, 'no', 20_000000n, { requireFullAcceptance: true }));
    expect(error.message).toContain('14');
    expect(error.quote.accepted).toBe(14_000000n);

    // The same stake at the size the books can take goes through.
    const ok = await rail.trade(MARKET_HEADROOM, 'no', 14_000000n, { requireFullAcceptance: true });
    expect(ok.quote.acceptance).toBe('full');
  });
});
