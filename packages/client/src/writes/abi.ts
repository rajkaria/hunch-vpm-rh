/**
 * The slices of each contract's ABI this package encodes against. Copied from
 * `contracts/src`, which is the source of truth; `IParimutuelSettler` is the
 * interface both settlers satisfy, so the same calldata works against either.
 */

export const settlerAbi = [
  {
    type: 'function',
    name: 'create',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'seed', type: 'uint256[]' },
      { name: 'kappa', type: 'uint256' },
      { name: 'resolutionTime', type: 'uint64' },
      { name: 'voidTimeout', type: 'uint64' },
      { name: 'resolver', type: 'address' },
      { name: 'residueOwner', type: 'address' },
    ],
    outputs: [{ name: 'marketId', type: 'uint256' }],
  },
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
  {
    type: 'function',
    name: 'transferPosition',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'positionId', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'finalizeVintage',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'headroom',
    stateMutability: 'view',
    inputs: [
      { name: 'marketId', type: 'uint256' },
      { name: 'outcome', type: 'uint8' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'previewPayout',
    stateMutability: 'view',
    inputs: [{ name: 'positionId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export const marketFactoryAbi = [
  {
    type: 'function',
    name: 'open',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'terms',
        type: 'tuple',
        components: [
          { name: 'settler', type: 'address' },
          { name: 'token', type: 'address' },
          { name: 'seed', type: 'uint256[]' },
          { name: 'kappa', type: 'uint256' },
          { name: 'resolutionTime', type: 'uint64' },
          { name: 'voidTimeout', type: 'uint64' },
          { name: 'residueOwner', type: 'address' },
        ],
      },
      {
        name: 'feed',
        type: 'tuple',
        components: [
          { name: 'oracle', type: 'address' },
          { name: 'feedKey', type: 'bytes32' },
          { name: 'strike', type: 'int256' },
          { name: 'direction', type: 'uint8' },
          { name: 'maxStaleness', type: 'uint64' },
        ],
      },
    ],
    outputs: [
      { name: 'marketId', type: 'uint256' },
      { name: 'specId', type: 'bytes32' },
    ],
  },
] as const;

export const feedResolverAbi = [
  {
    type: 'function',
    name: 'resolve',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'specId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'voidStale',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'specId', type: 'bytes32' }],
    outputs: [],
  },
] as const;

export const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
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
] as const;
