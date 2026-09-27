import { decodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';
import { arcMainnet } from '../src/chains.js';
import { ARC_USDC } from '../src/addresses.js';
import { createHunchClient } from '../src/client.js';
import { KAPPA_UNBOUNDED } from '../src/units.js';
import { marketFactoryAbi, settlerAbi } from '../src/writes/abi.js';
import type { OpenMarketParams } from '../src/writes/calldata.js';
import { TEST_SETTLER, testClient } from './support/client.js';

const FACTORY = '0x9999999999999999999999999999999999999999';
const RESIDUE_OWNER = '0x2222222222222222222222222222222222222222';
const ORACLE = '0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62';
const FEED_KEY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function client() {
  return testClient({}).client;
}

describe('enterCalldata', () => {
  it('encodes enter(marketId, outcome, amount) to the settler', () => {
    const call = client().enterCalldata({ marketId: 0n, outcome: 1, amount: 25_000000n });

    expect(call.to).toBe(TEST_SETTLER);
    expect(call.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: settlerAbi, data: call.data });
    expect(decoded.functionName).toBe('enter');
    expect(decoded.args).toEqual([0n, 1, 25_000000n]);
  });

  it('refuses a stake of zero, which the settler would revert on', () => {
    expect(() => client().enterCalldata({ marketId: 0n, outcome: 0, amount: 0n })).toThrow(/must be positive/);
  });

  it('refuses an amount the settler could not pack into uint128', () => {
    expect(() => client().enterCalldata({ marketId: 0n, outcome: 0, amount: 2n ** 128n })).toThrow(
      /stake out of range/,
    );
  });

  it('refuses an outcome index the settler has no room for', () => {
    expect(() => client().enterCalldata({ marketId: 0n, outcome: 255, amount: 1n })).toThrow(/outcome must be/);
    expect(() => client().enterCalldata({ marketId: 0n, outcome: -1, amount: 1n })).toThrow(/outcome must be/);
  });

  it('can target the other settler for a side-by-side comparison', () => {
    const classic = '0x7777777777777777777777777777777777777777';
    const call = client().enterCalldata({ marketId: 0n, outcome: 0, amount: 1n, settler: classic });
    expect(call.to).toBe(classic);
  });
});

describe('claimCalldata and withdrawRefundCalldata', () => {
  it('encode their position id', () => {
    const claim = decodeFunctionData({ abi: settlerAbi, data: client().claimCalldata({ positionId: 12n }).data });
    expect(claim.functionName).toBe('claim');
    expect(claim.args).toEqual([12n]);

    const refund = decodeFunctionData({
      abi: settlerAbi,
      data: client().withdrawRefundCalldata({ positionId: 12n }).data,
    });
    expect(refund.functionName).toBe('withdrawRefund');
    expect(refund.args).toEqual([12n]);
  });

  it('encodes claimResidue against a market id, not a position id', () => {
    const residue = decodeFunctionData({
      abi: settlerAbi,
      data: client().claimResidueCalldata({ marketId: 6n }).data,
    });
    expect(residue.functionName).toBe('claimResidue');
    expect(residue.args).toEqual([6n]);
  });
});

describe('openMarketCalldata', () => {
  const base: Omit<OpenMarketParams, 'settler' | 'token' | 'factory'> = {
    seed: [1_000000n, 1_000000n],
    kappa: 30n,
    resolutionTime: 2_000_000_000n,
    voidTimeout: 86_400n,
    residueOwner: RESIDUE_OWNER,
    feed: {
      oracle: ORACLE,
      feedKey: FEED_KEY,
      strike: 300_000000000n,
      direction: 'above',
      maxStaleness: 300n,
    },
  };

  it('encodes the terms and the feed into one factory call', () => {
    const call = client().openMarketCalldata({ ...base });

    expect(call.to).toBe(FACTORY);
    const decoded = decodeFunctionData({ abi: marketFactoryAbi, data: call.data });
    expect(decoded.functionName).toBe('open');
    const [terms, feed] = decoded.args;
    expect(terms.settler).toBe(TEST_SETTLER);
    expect(terms.token).toBe(ARC_USDC);
    expect(terms.seed).toEqual([1_000000n, 1_000000n]);
    expect(terms.kappa).toBe(30n);
    expect(feed.direction).toBe(0);
    expect(feed.strike).toBe(300_000000000n);
  });

  it('turns unbounded kappa into the settler sentinel', () => {
    const call = client().openMarketCalldata({ ...base, kappa: null });
    const decoded = decodeFunctionData({ abi: marketFactoryAbi, data: call.data });
    expect(decoded.args[0].kappa).toBe(KAPPA_UNBOUNDED);
  });

  it('encodes "below" as direction 1', () => {
    const call = client().openMarketCalldata({ ...base, feed: { ...base.feed, direction: 'below' } });
    const decoded = decodeFunctionData({ abi: marketFactoryAbi, data: call.data });
    expect(decoded.args[1].direction).toBe(1);
  });

  it('refuses a market with fewer than two outcomes', () => {
    expect(() => client().openMarketCalldata({ ...base, seed: [1_000000n] })).toThrow(/at least 2 outcomes/);
  });

  it('refuses a zero seed leg, which would void creation outright', () => {
    expect(() => client().openMarketCalldata({ ...base, seed: [1_000000n, 0n] })).toThrow(/seed leg 1 must be/);
  });

  it('refuses kappa below one', () => {
    expect(() => client().openMarketCalldata({ ...base, kappa: 0n })).toThrow(/kappa must be at least 1/);
  });

  it('refuses a feed key that is not 32 bytes', () => {
    expect(() => client().openMarketCalldata({ ...base, feed: { ...base.feed, feedKey: '0xbb' } })).toThrow(
      /feedKey must be 32 bytes/,
    );
  });
});

describe('approveCalldata', () => {
  it('targets the settlement asset by default', () => {
    const call = client().approveCalldata({ spender: TEST_SETTLER, amount: 25_000000n });
    expect(call.to).toBe(ARC_USDC);
    expect(call.value).toBe(0n);
  });
});

describe('placeholder addresses', () => {
  it('refuse to build calldata rather than sending to the zero address', () => {
    // Mainnet: the one network where every one of ours is still the zero placeholder.
    const undeployed = createHunchClient({ subgraphUrl: 'https://subgraph.invalid/x', chain: arcMainnet });
    expect(() => undeployed.enterCalldata({ marketId: 0n, outcome: 0, amount: 1n })).toThrow(
      /settler is not deployed yet/,
    );
    expect(() =>
      undeployed.openMarketCalldata({
        seed: [1n, 1n],
        kappa: 30n,
        resolutionTime: 2_000_000_000n,
        voidTimeout: 1n,
        residueOwner: RESIDUE_OWNER,
        feed: { oracle: ORACLE, feedKey: FEED_KEY, strike: 0n, direction: 'above', maxStaleness: 1n },
      }),
    ).toThrow(/market factory is not deployed yet/);
  });
});
