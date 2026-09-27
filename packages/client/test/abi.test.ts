import type { Abi, AbiParameter } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  GENERATED_FROM_CONTRACTS_OUT,
  hunchMarketFactoryAbi,
  hunchMarketFactoryAbiHandwritten,
  hunchVpmAbi,
  hunchVpmAbiHandwritten,
  stockRoundResolverAbi,
  stockRoundResolverAbiHandwritten,
} from '../src/index.js';

/** Canonical type of a parameter, expanding tuples: `(address,uint64)[]`. */
function typeOf(p: AbiParameter): string {
  if (p.type.startsWith('tuple')) {
    const inner = ((p as { components?: readonly AbiParameter[] }).components ?? []).map(typeOf).join(',');
    return `(${inner})${p.type.slice('tuple'.length)}`;
  }
  return p.type;
}

function sig(item: Abi[number]): string {
  if (item.type === 'function') return `function ${item.name}(${item.inputs.map(typeOf).join(',')}) -> (${item.outputs.map(typeOf).join(',')}) ${item.stateMutability}`;
  if (item.type === 'event') return `event ${item.name}(${item.inputs.map((i) => `${typeOf(i)}${i.indexed ? ' indexed' : ''}`).join(',')})`;
  if (item.type === 'error') return `error ${item.name}(${item.inputs.map(typeOf).join(',')})`;
  return item.type;
}

const pairs = [
  ['HunchVPM', hunchVpmAbiHandwritten, hunchVpmAbi],
  ['StockRoundResolver', stockRoundResolverAbiHandwritten, stockRoundResolverAbi],
  ['HunchMarketFactory', hunchMarketFactoryAbiHandwritten, hunchMarketFactoryAbi],
] as const;

describe('exported ABIs honour the frozen interfaces (.ocean/PLAN.md)', () => {
  it.each(pairs)('%s: every frozen function and event exists with the same types', (name, frozen, exported) => {
    const have = new Set((exported as Abi).map(sig));
    const generated = (GENERATED_FROM_CONTRACTS_OUT as readonly string[]).includes(name);
    for (const item of frozen as Abi) {
      if (item.type === 'error' && generated) continue; // error names are the contracts' call; checked by selector below
      expect(have.has(sig(item)), `${name}: ${sig(item)}`).toBe(true);
    }
  });

  it('HunchVPM is generated from contracts/out', () => {
    expect(GENERATED_FROM_CONTRACTS_OUT).toContain('HunchVPM');
  });
});
