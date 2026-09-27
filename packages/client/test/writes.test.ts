import { decodeFunctionData, getAddress, toFunctionSelector, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  DOWN,
  UP,
  approveUsdgCall,
  claimCall,
  claimForCall,
  enterCall,
  enterWithAuthorizationCall,
  finalizeVintageCall,
  hunchMarketFactoryAbi,
  hunchVpmAbi,
  openUpDownCall,
  resolveCall,
  stockRoundResolverAbi,
  sweepFeesCall,
  toTransaction,
  usdgAbi,
  voidMarketCall,
  voidPausedCall,
  voidStaleCall,
  withdrawRefundCall,
  withdrawRefundForCall,
} from '../src/index.js';
import { FACTORY, RESOLVER, VPM, deployedDeployment } from './support/fakeChain.js';

const d = deployedDeployment();
const specId = `0x${'ab'.repeat(32)}` as Hex;

describe('write builders encode the frozen interfaces', () => {
  it('bettor calls', () => {
    const tx = toTransaction(enterCall(d, { marketId: 3n, outcome: DOWN, amount: 5_000_000n }));
    expect(tx.to).toBe(VPM);
    expect(tx.data.slice(0, 10)).toBe(toFunctionSelector('enter(uint256,uint8,uint256)'));
    expect(decodeFunctionData({ abi: hunchVpmAbi, data: tx.data }).args).toEqual([3n, DOWN, 5_000_000n]);

    const sig = `0x${'11'.repeat(65)}` as Hex;
    const auth = toTransaction(
      enterWithAuthorizationCall(d, {
        from: getAddress('0x000000000000000000000000000000000000a11c'),
        marketId: 3n,
        outcome: UP,
        amount: 2_000_000n,
        validAfter: 0n,
        validBefore: 1_790_000_000n,
        salt: specId,
        signature: sig,
      }),
    );
    expect(auth.data.slice(0, 10)).toBe(
      toFunctionSelector('enterWithAuthorization(address,uint256,uint8,uint256,uint256,uint256,bytes32,bytes)'),
    );
    const approve = toTransaction(approveUsdgCall(d, { amount: 10n }));
    expect(approve.to).toBe(d.usdg);
    expect(decodeFunctionData({ abi: usdgAbi, data: approve.data }).args).toEqual([VPM, 10n]);
    expect(toTransaction(claimCall(d, 9n)).data.slice(0, 10)).toBe(toFunctionSelector('claim(uint256)'));
    expect(toTransaction(withdrawRefundCall(d, 9n)).data.slice(0, 10)).toBe(toFunctionSelector('withdrawRefund(uint256)'));
  });

  it('delivery and settlement calls', () => {
    expect(toTransaction(claimForCall(d, 1n)).data.slice(0, 10)).toBe(toFunctionSelector('claimFor(uint256)'));
    expect(toTransaction(withdrawRefundForCall(d, 1n)).data.slice(0, 10)).toBe(toFunctionSelector('withdrawRefundFor(uint256)'));
    expect(toTransaction(finalizeVintageCall(d, 1n)).data.slice(0, 10)).toBe(toFunctionSelector('finalizeVintage(uint256)'));
    expect(toTransaction(sweepFeesCall(d)).data.slice(0, 10)).toBe(toFunctionSelector('sweepFees(address)'));
    expect(toTransaction(voidMarketCall(d, 1n)).data.slice(0, 10)).toBe(toFunctionSelector('voidMarket(uint256)'));
    const r = toTransaction(resolveCall(d, { specId, strikeRound: 18446744073709552000n, finalRound: 18446744073709552010n }));
    expect(r.to).toBe(RESOLVER);
    expect(r.data.slice(0, 10)).toBe(toFunctionSelector('resolve(bytes32,uint80,uint80)'));
    expect(decodeFunctionData({ abi: stockRoundResolverAbi, data: r.data }).args).toEqual([specId, 18446744073709552000n, 18446744073709552010n]);
    expect(toTransaction(voidStaleCall(d, { specId, strikeRound: 1n, finalRound: 2n })).data.slice(0, 10)).toBe(
      toFunctionSelector('voidStale(bytes32,uint80,uint80)'),
    );
    expect(toTransaction(voidPausedCall(d, specId)).data.slice(0, 10)).toBe(toFunctionSelector('voidPaused(bytes32)'));
  });

  it('opener call', () => {
    const tx = toTransaction(
      openUpDownCall(d, {
        feed: d.feeds[0]!.feed,
        strikeTime: 1_790_602_200n,
        finalTime: 1_790_625_600n,
        maxStrikeAge: 0,
        maxFinalAge: 0,
        seedPerLeg: 10_000_000n,
        minEntry: 1_000_000n,
        maxEntry: 100_000_000n,
      }),
    );
    expect(tx.to).toBe(FACTORY);
    expect(tx.data.slice(0, 10)).toBe(toFunctionSelector('openUpDown((address,uint64,uint64,uint32,uint32,uint128,uint128,uint128))'));
    const decoded = decodeFunctionData({ abi: hunchMarketFactoryAbi, data: tx.data });
    expect(decoded.args[0]).toMatchObject({ feed: d.feeds[0]!.feed, seedPerLeg: 10_000_000n });
  });
});
