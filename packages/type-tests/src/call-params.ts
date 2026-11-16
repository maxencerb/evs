import { parseAbi, type Abi } from 'viem';

/**
 * What the call verbs require of `args` and accept for `struct`, and what they give for an ABI
 * with no literal type: every type checker has to refuse the same calls.
 */
import { evscript, t, type Expr, type WideSubcallResult } from '@maxencerb/evs';

import { expectType, type Same } from './assert.js';

const abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function rate(uint256 id) view returns (uint256)',
  'function rate(uint256 id, uint256 at) view returns (uint256)',
  'function total() view returns (uint256)',
  'function total(address asset) view returns (uint256 amount, uint256 shares)',
  'function poke()',
  'function deposit(uint256 amount) returns (uint256 shares)',
  'function quote(uint256 amountIn) returns (uint256)',
  'function getConfig(uint8 id) view returns ((uint16 ltv, uint16 liquidationThreshold))',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick)',
  'function nothing() view',
]);

const WHO = '0x00000000000000000000000000000000000000aa';

/** `args` is required when the function takes arguments, by each of the six verbs. */
export const requiredArgs = evscript({ name: 'requiredArgs', args: [t.address] }, (s, token) => {
  // @ts-expect-error — balanceOf takes one argument
  s.read({ address: token, abi, functionName: 'balanceOf' });
  // @ts-expect-error — balanceOf takes one argument
  s.tryRead({ address: token, abi, functionName: 'balanceOf' });
  // @ts-expect-error — deposit takes one argument
  s.call({ address: token, abi, functionName: 'deposit' });
  // @ts-expect-error — deposit takes one argument
  s.tryCall({ address: token, abi, functionName: 'deposit' });
  // @ts-expect-error — deposit takes one argument
  s.simulate({ address: token, abi, functionName: 'deposit' });
  // @ts-expect-error — deposit takes one argument
  s.trySimulate({ address: token, abi, functionName: 'deposit' });
  // @ts-expect-error — quote takes one argument, under revertReturns too
  s.call({ address: token, abi, functionName: 'quote', revertReturns: [t.uint256] });
  // @ts-expect-error — both overloads of rate take arguments
  s.read({ address: token, abi, functionName: 'rate' });

  const balance = s.read({ address: token, abi, functionName: 'balanceOf', args: [WHO] });
  const shares = s.simulate({ address: token, abi, functionName: 'deposit', args: [1n] });
  const rate = s.read({ address: token, abi, functionName: 'rate', args: [1n, 2n] });
  expectType<Same<typeof balance, Expr<'uint256'>>>();
  expectType<Same<typeof shares, Expr<'uint256'>>>();
  expectType<Same<typeof rate, Expr<'uint256'>>>();
  return s.return({ balance, shares, rate });
});

/** `args` stays optional when the function, or one overload of the name, takes none. */
export const optionalArgs = evscript({ name: 'optionalArgs', args: [t.address] }, (s, token) => {
  const omitted = s.read({ address: token, abi, functionName: 'decimals' });
  const empty = s.read({ address: token, abi, functionName: 'decimals', args: [] });
  const nullary = s.read({ address: token, abi, functionName: 'total' });
  s.call({ address: token, abi, functionName: 'poke' });
  expectType<Same<typeof omitted, Expr<'uint8'>>>();
  expectType<Same<typeof empty, Expr<'uint8'>>>();
  expectType<Same<typeof nullary, Expr<'uint256'>>>();
  return s.return({ omitted, empty, nullary });
});

/** `struct: true` needs every output named. */
export const structFlag = evscript(
  { name: 'structFlag', args: [t.address, t.uint8] },
  (s, pool, id) => {
    // @ts-expect-error — the one output of getConfig (the struct) is unnamed
    s.read({ address: pool, abi, functionName: 'getConfig', args: [id], struct: true });
    // @ts-expect-error — the output of quote is unnamed
    s.simulate({ address: pool, abi, functionName: 'quote', args: [1n], struct: true });
    // @ts-expect-error — nothing returns nothing
    s.read({ address: pool, abi, functionName: 'nothing', struct: true });

    // the default result of a struct getter is the named Tuple
    const config = s.read({ address: pool, abi, functionName: 'getConfig', args: [id] });
    const threshold = config.liquidationThreshold.get();
    expectType<Same<typeof threshold, Expr<'uint16'>>>();
    const slot0 = s.read({ address: pool, abi, functionName: 'slot0', struct: true });
    const tick = slot0.tick.get();
    expectType<Same<typeof tick, Expr<'int24'>>>();
    return s.return({ threshold, tick });
  },
);

// solc wrote `constant` and `payable`, and no `stateMutability`, before 0.4.16
const legacyAbi = [
  {
    constant: true,
    inputs: [],
    name: 'totalSupply',
    outputs: [{ name: '', type: 'uint256' }],
    payable: false,
    type: 'function',
  },
  {
    constant: false,
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'punkIndex', type: 'uint256' },
    ],
    name: 'transferPunk',
    outputs: [],
    payable: false,
    type: 'function',
  },
] as const;

// the same entry with `stateMutability` added: an `Abi` one, the flags may stay
const typedLegacyAbi = [{ ...legacyAbi[0], stateMutability: 'view' }] as const satisfies Abi;

const untypedAbi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
];

/* oxlint-disable typescript/no-unsafe-type-assertion -- the narrowing cast is the documented way
 * to use the result of an ABI with no literal type */
/** An ABI with no literal type is accepted, and its results are the untyped one, to cast. */
export const untyped = evscript({ name: 'untyped', args: [t.address] }, (s, token) => {
  const decimals = s.read({ address: token, abi: untypedAbi, functionName: 'decimals' });
  expectType<Same<typeof decimals, WideSubcallResult>>();
  // no `undefined` member: a use reports the result type by name, not a null check
  expectType<Same<Extract<WideSubcallResult, undefined>, never>>();
  // @ts-expect-error — the untyped result has no toUint
  decimals.toUint(t.uint256);
  const wide = (decimals as Expr<'uint8'>).toUint(t.uint256);

  // a legacy ABI is one more ABI with no literal type: any name, unchecked args
  const supply = s.read({ address: token, abi: legacyAbi, functionName: 'totalSupply' });
  expectType<Same<typeof supply, WideSubcallResult>>();
  s.simulate({ address: token, abi: legacyAbi, functionName: 'transferPunk', args: [WHO, 1n] });

  const typed = s.read({ address: token, abi: typedLegacyAbi, functionName: 'totalSupply' });
  expectType<Same<typeof typed, Expr<'uint256'>>>();
  return s.return({ wide, supply: supply as Expr<'uint256'>, typed });
});
/* oxlint-enable typescript/no-unsafe-type-assertion */
