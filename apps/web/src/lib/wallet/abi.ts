/*
 * The slices of each ABI this surface encodes against.
 *
 * Copied from `contracts/src` the same way `@hunch-vpm/client` copies them, and
 * for the same reason `lib/chain.ts` duplicates the chain facts: this app has to
 * typecheck and build before that package has been compiled, which is the state
 * on a fresh clone and in CI. `as const` so viem infers argument types.
 */

export const erc20Abi = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export const settlerAbi = [
  {
    type: 'function',
    name: 'enter',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'marketId', type: 'uint256' },
      { name: 'outcome', type: 'uint8' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: 'positionId', type: 'uint256' }],
  },
  /*
   * Anyone may poke this. It is not an administrative call — a buffered vintage
   * that nobody finalizes is a set of positions nobody can claim or refund, so
   * the surface offers it to whoever is looking.
   */
  {
    type: 'function',
    name: 'finalizeVintage',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'positionId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdrawRefund',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'positionId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claimResidue',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [],
  },
  /*
   * NOTE the payload: `offered`, not `accepted`. Nothing is accepted at entry
   * time — the position is buffered into this block's vintage and rationed when
   * that vintage finalizes, which is a later block and possibly a stranger's
   * transaction. A UI that reads `offered` here and calls it "accepted" tells
   * the user their whole stake was taken and is then contradicted by a refund.
   */
  {
    type: 'event',
    name: 'Entered',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'positionId', type: 'uint256', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'outcome', type: 'uint8', indexed: false },
      { name: 'offered', type: 'uint256', indexed: false },
      { name: 'vintage', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'VintageFinalized',
    inputs: [
      { name: 'marketId', type: 'uint256', indexed: true },
      { name: 'vintage', type: 'uint64', indexed: false },
      { name: 'count', type: 'uint256', indexed: false },
    ],
  },
] as const;
