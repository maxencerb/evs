/** A contract ABI as an app declares it: `as const`, members in Solidity's order. */

const position = [
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' },
] as const;

const leg = [
  { name: 'zeta', type: 'uint256' },
  { name: 'alpha', type: 'address' },
  { name: 'mid', type: 'bool' },
] as const;

const total = [{ name: '', type: 'uint256' }] as const;

export const vaultAbi = [
  {
    type: 'function',
    name: 'valueOf',
    stateMutability: 'view',
    inputs: [{ name: 'positions', type: 'tuple[]', components: position }],
    outputs: total,
  },
  {
    type: 'function',
    name: 'valueOfPair',
    stateMutability: 'view',
    inputs: [{ name: 'pair', type: 'tuple[2]', components: position }],
    outputs: total,
  },
  {
    type: 'function',
    name: 'valueOfOne',
    stateMutability: 'view',
    inputs: [{ name: 'position', type: 'tuple', components: position }],
    outputs: total,
  },
  {
    type: 'function',
    name: 'valueOfLegs',
    stateMutability: 'view',
    inputs: [{ name: 'legs', type: 'tuple[]', components: leg }],
    outputs: total,
  },
  {
    type: 'function',
    name: 'valueOfBooks',
    stateMutability: 'view',
    inputs: [
      {
        name: 'books',
        type: 'tuple[]',
        components: [
          { name: 'owner', type: 'address' },
          { name: 'positions', type: 'tuple[]', components: position },
        ],
      },
    ],
    outputs: total,
  },
  {
    type: 'function',
    name: 'positionsOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'tuple[]', components: position }],
  },
  {
    type: 'function',
    name: 'positionOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'tuple', components: position }],
  },
] as const;
