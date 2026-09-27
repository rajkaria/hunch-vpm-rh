import { describe, expect, it } from 'vitest';

import { friendlyError } from '@/components/market/EntryFlow';
import { settlerAbi, erc20Abi } from '@/lib/wallet/abi';

describe('the Entered event, as this surface reads it', () => {
  const entered = settlerAbi.find((entry) => entry.type === 'event' && entry.name === 'Entered');

  it('exists, and carries `offered` — never `accepted`', () => {
    // This is the whole of D7 in one assertion. `enter` buffers the position
    // with accepted = 0 and rations it when the vintage finalizes in a LATER
    // block, so there is no acceptance figure in this receipt to read. If a
    // future ABI ever grows one, this test should fail and the buffered-result
    // screen should be revisited rather than quietly left in place.
    expect(entered).toBeDefined();
    const names = entered?.inputs.map((input) => input.name) ?? [];
    expect(names).toContain('offered');
    expect(names).not.toContain('accepted');
  });

  it('carries the vintage, which is what the buffered screen keys off', () => {
    expect(entered?.inputs.map((input) => input.name)).toContain('vintage');
  });
});

describe('finalizeVintage', () => {
  it('is present and takes only a market id, because anyone may call it', () => {
    const fn = settlerAbi.find((entry) => entry.type === 'function' && entry.name === 'finalizeVintage');
    expect(fn).toBeDefined();
    expect(fn?.inputs.map((input) => input.name)).toEqual(['marketId']);
  });
});

describe('the ERC-20 slice', () => {
  it('has exactly what an approval flow needs and nothing more', () => {
    expect(erc20Abi.map((entry) => entry.name).sort()).toEqual(['allowance', 'approve', 'balanceOf']);
  });
});

describe('friendlyError', () => {
  it('treats a rejection as a decision, not a failure', () => {
    expect(friendlyError({ message: 'User rejected the request.' })).toMatch(/dismissed the request/);
    expect(friendlyError({ message: 'user rejected' })).not.toMatch(/error/i);
  });

  it('explains an empty wallet in terms of Arc, where USDC is also the gas', () => {
    expect(friendlyError({ message: 'insufficient funds for gas' })).toMatch(/gas token on Arc/);
  });

  it('translates the two settler reverts a user can actually hit', () => {
    expect(friendlyError({ message: 'reverted with Frozen()' })).toMatch(/froze before/);
    expect(friendlyError({ message: 'reverted with NotOpen()' })).toMatch(/no longer open/);
  });

  it('keeps an unknown error to its first line rather than dumping a stack', () => {
    expect(friendlyError({ message: 'Boom.\nat somewhere\nat elsewhere' })).toBe('Boom.');
  });

  it('says something rather than nothing when there is no message', () => {
    expect(friendlyError(null)).toBe('Something went wrong.');
  });
});
