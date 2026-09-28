import { encodeFunctionData, type Abi, type Address, type EncodeFunctionDataParameters, type Hex } from 'viem';
import { hunchMarketFactoryAbi, hunchVpmAbi, stockRoundResolverAbi, usdgAbi } from '../abi/index.js';
import type { Outcome } from '../constants.js';
import type { Deployment } from '../deployment/index.js';

/**
 * Write builders. Each returns `{ address, abi, functionName, args }`, which is what
 * viem's `simulateContract` / `writeContract` and wagmi's `useWriteContract` take;
 * `toTransaction(call)` turns one into raw `{ to, data, value }`. Nothing here signs.
 */

export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

export interface RawTransaction {
  to: Address;
  data: Hex;
  value: bigint;
}

export function toTransaction(call: { address: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] }): RawTransaction {
  return {
    to: call.address,
    data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args ?? [] } as unknown as EncodeFunctionDataParameters),
    value: 0n,
  };
}

const vpm = (d: Deployment) => d.contracts.HunchVPM.address;
const resolver = (d: Deployment) => d.contracts.StockRoundResolver.address;
const factory = (d: Deployment) => d.contracts.HunchMarketFactory.address;

// ------------------------------------------------------------------ bettor

/** Pay-gas path: `enter(marketId, outcome, amount)` (needs a USDG allowance to HunchVPM). */
export function enterCall(d: Deployment, p: { marketId: bigint; outcome: Outcome; amount: bigint }) {
  return { address: vpm(d), abi: hunchVpmAbi, functionName: 'enter', args: [p.marketId, p.outcome, p.amount] } as const;
}

/** Gasless path (relayer or anyone): `enterWithAuthorization(from, …, signature)`. */
export function enterWithAuthorizationCall(
  d: Deployment,
  p: {
    from: Address;
    marketId: bigint;
    outcome: Outcome;
    amount: bigint;
    validAfter: bigint;
    validBefore: bigint;
    salt: Hex;
    signature: Hex;
  },
) {
  return {
    address: vpm(d),
    abi: hunchVpmAbi,
    functionName: 'enterWithAuthorization',
    args: [p.from, p.marketId, p.outcome, p.amount, p.validAfter, p.validBefore, p.salt, p.signature],
  } as const;
}

/** USDG `approve(spender, amount)`; spender defaults to HunchVPM. */
export function approveUsdgCall(d: Deployment, p: { amount: bigint; spender?: Address }) {
  return { address: d.usdg, abi: usdgAbi, functionName: 'approve', args: [p.spender ?? vpm(d), p.amount] } as const;
}

export function claimCall(d: Deployment, positionId: bigint) {
  return { address: vpm(d), abi: hunchVpmAbi, functionName: 'claim', args: [positionId] } as const;
}

export function withdrawRefundCall(d: Deployment, positionId: bigint) {
  return { address: vpm(d), abi: hunchVpmAbi, functionName: 'withdrawRefund', args: [positionId] } as const;
}

// ------------------------------------------------------------------ anyone (delivery, settlement)

/** Pays the position's owner, never the caller. */
export function claimForCall(d: Deployment, positionId: bigint) {
  return { address: vpm(d), abi: hunchVpmAbi, functionName: 'claimFor', args: [positionId] } as const;
}

/** Pays the refused remainder to the position's owner, never the caller. */
export function withdrawRefundForCall(d: Deployment, positionId: bigint) {
  return { address: vpm(d), abi: hunchVpmAbi, functionName: 'withdrawRefundFor', args: [positionId] } as const;
}

export function finalizeVintageCall(d: Deployment, marketId: bigint) {
  return { address: vpm(d), abi: hunchVpmAbi, functionName: 'finalizeVintage', args: [marketId] } as const;
}

/** Sends accrued fees to the treasury Safe. */
export function sweepFeesCall(d: Deployment, token: Address = d.usdg) {
  return { address: vpm(d), abi: hunchVpmAbi, functionName: 'sweepFees', args: [token] } as const;
}

/** Settler timeout void (anyone, at ≥ resolutionTime + voidTimeout). */
export function voidMarketCall(d: Deployment, marketId: bigint) {
  return { address: vpm(d), abi: hunchVpmAbi, functionName: 'voidMarket', args: [marketId] } as const;
}

/** "Resolve it yourself": `resolve(specId, strikeRound, finalRound)` with the proven rounds. */
export function resolveCall(d: Deployment, p: { specId: Hex; strikeRound: bigint; finalRound: bigint }) {
  return { address: resolver(d), abi: stockRoundResolverAbi, functionName: 'resolve', args: [p.specId, p.strikeRound, p.finalRound] } as const;
}

export function voidStaleCall(d: Deployment, p: { specId: Hex; strikeRound: bigint; finalRound: bigint }) {
  return { address: resolver(d), abi: stockRoundResolverAbi, functionName: 'voidStale', args: [p.specId, p.strikeRound, p.finalRound] } as const;
}

/** Refund a market whose proven round at a bell carries a garbage answer (preview BADANSWER). */
export function voidBadAnswerCall(d: Deployment, p: { specId: Hex; strikeRound: bigint; finalRound: bigint }) {
  return { address: resolver(d), abi: stockRoundResolverAbi, functionName: 'voidBadAnswer', args: [p.specId, p.strikeRound, p.finalRound] } as const;
}

export function voidPausedCall(d: Deployment, specId: Hex) {
  return { address: resolver(d), abi: stockRoundResolverAbi, functionName: 'voidPaused', args: [specId] } as const;
}

// ------------------------------------------------------------------ opener (keeper)

export interface UpDownParams {
  feed: Address;
  strikeTime: bigint;
  finalTime: bigint;
  /** 0 = the feed's allow-listed bound; otherwise ≤ it. */
  maxStrikeAge: number;
  maxFinalAge: number;
  seedPerLeg: bigint;
  minEntry: bigint;
  maxEntry: bigint;
}

export function openUpDownCall(d: Deployment, p: UpDownParams) {
  return {
    address: factory(d),
    abi: hunchMarketFactoryAbi,
    functionName: 'openUpDown',
    args: [
      {
        feed: p.feed,
        strikeTime: p.strikeTime,
        finalTime: p.finalTime,
        maxStrikeAge: p.maxStrikeAge,
        maxFinalAge: p.maxFinalAge,
        seedPerLeg: p.seedPerLeg,
        minEntry: p.minEntry,
        maxEntry: p.maxEntry,
      },
    ],
  } as const;
}
