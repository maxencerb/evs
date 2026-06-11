/* oxlint-disable typescript/no-unsafe-type-assertion --
 * type-level tests conjure phantom values via assertions; nothing here runs. */
/**
 * M3 type tests — `ScriptAbi` literal shape, viem `readContract` inference over it, and the
 * abitype §4.2 interning regression (docs/research/abitype-typing.md).
 *
 * ORDER OF DECLARATIONS IN THIS FILE IS LOAD-BEARING: `realisticPoolAbi` below deliberately
 * interns the string literal types `'tick'`, `'fee'`, and `'owner'` BEFORE any `ScriptAbi`
 * instantiation uses them, reproducing the conditions under which `UnionToTuple<keyof ret>`
 * emits components out of declaration order. The assertions then prove that order instability
 * is harmless: viem infers an *object* from the fully-named single tuple output, and script
 * inputs come from the ArgSpec tuple (order-preserving by construction).
 */
import type { Abi } from 'abitype';
import type { ReadContractParameters, ReadContractReturnType } from 'viem';
import { expectTypeOf, test } from 'vitest';

import type { ArgSpec, Expr } from '../core/types.js';
import {
  buildScriptAbi,
  EVS_ERROR_ABI,
  type ReturnSpecToComponents,
  type ScriptAbi,
} from './artifact.js';

// ---------------------------------------------------------------------------
// §4.2 trap setup — intern 'tick' / 'fee' / 'owner' early (as output/input names of an
// unrelated ABI, exactly the research repro) before the script types reference them.
// ---------------------------------------------------------------------------

const realisticPoolAbi = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
    ],
  },
  {
    type: 'function',
    name: 'feeOf',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: '', type: 'uint24' }],
  },
] as const satisfies Abi;
type _Interned = typeof realisticPoolAbi; // force instantiation of the literal types above

// ---------------------------------------------------------------------------
// the flagship-shaped script ABI: one return key ('tick') collides with the
// earlier-interned literal
// ---------------------------------------------------------------------------

type PoolMetaRet = {
  token0: Expr<'address'>;
  symbol0: Expr<'string'>;
  tick: Expr<'int24'>;
};
type PoolMetaAbi = ScriptAbi<'poolMeta', readonly [ArgSpec<'pool', 'address'>], PoolMetaRet>;

test('ScriptAbi satisfies Abi (declaration-emit safe, no widening)', () => {
  expectTypeOf<PoolMetaAbi>().toMatchTypeOf<Abi>();
  expectTypeOf<PoolMetaAbi[0]['type']>().toEqualTypeOf<'function'>();
  expectTypeOf<PoolMetaAbi[0]['name']>().toEqualTypeOf<'poolMeta'>();
  expectTypeOf<PoolMetaAbi[0]['stateMutability']>().toEqualTypeOf<'view'>();
});

test('inputs are the exact ArgSpec tuple mapping (order-preserving by construction)', () => {
  expectTypeOf<PoolMetaAbi[0]['inputs']>().toEqualTypeOf<
    readonly [{ readonly name: 'pool'; readonly type: 'address' }]
  >();
});

test('outputs: single named tuple; components carry every (name, type) pair — order-free', () => {
  type Output = PoolMetaAbi[0]['outputs'][0];
  expectTypeOf<Output['name']>().toEqualTypeOf<'result'>();
  expectTypeOf<Output['type']>().toEqualTypeOf<'tuple'>();
  // assert the component SET (union) — never the tuple order, which §4.2 makes unstable
  expectTypeOf<Output['components'][number]>().toEqualTypeOf<
    | { readonly name: 'token0'; readonly type: 'address' }
    | { readonly name: 'symbol0'; readonly type: 'string' }
    | { readonly name: 'tick'; readonly type: 'int24' }
  >();
  expectTypeOf<ReturnSpecToComponents<PoolMetaRet>['length']>().toEqualTypeOf<3>();
});

test('§4.2 interning regression: viem still infers the correct OBJECT (incl. int24 → number)', () => {
  // 'tick' was interned by realisticPoolAbi long before PoolMetaRet declared it last —
  // whatever order UnionToTuple produces, the single named-tuple output yields an object.
  expectTypeOf<ReadContractReturnType<PoolMetaAbi, 'poolMeta'>>().toEqualTypeOf<{
    token0: `0x${string}`;
    symbol0: string;
    tick: number; // abitype: int/uint ≤ 48 bits → number
  }>();
});

test('errors ride along as the literal EVS_ERROR_ABI items', () => {
  expectTypeOf<PoolMetaAbi[1]>().toEqualTypeOf<(typeof EVS_ERROR_ABI)[0]>();
  expectTypeOf<PoolMetaAbi[2]>().toEqualTypeOf<(typeof EVS_ERROR_ABI)[1]>();
  expectTypeOf<(typeof EVS_ERROR_ABI)[1]['inputs'][0]>().toEqualTypeOf<{
    readonly name: 'site';
    readonly type: 'uint256';
  }>();
});

// ---------------------------------------------------------------------------
// readContract parameter inference — declaration order of the ArgSpec tuple
// ---------------------------------------------------------------------------

test('args is the labeled positional tuple in DECLARATION order (3 pre-interned names)', () => {
  // 'owner' and 'fee' were interned above in the opposite order to this tuple; inputs map
  // over the ArgSpec tuple, so type-level order cannot diverge from runtime encode order.
  type ThreeArgAbi = ScriptAbi<
    'threeArg',
    readonly [ArgSpec<'pool', 'address'>, ArgSpec<'fee', 'uint24'>, ArgSpec<'owner', 'address'>],
    { ok: Expr<'bool'> }
  >;
  expectTypeOf<ReadContractParameters<ThreeArgAbi, 'threeArg'>['args']>().toEqualTypeOf<
    readonly [pool: `0x${string}`, fee: number, owner: `0x${string}`]
  >();
  expectTypeOf<
    ReadContractParameters<ThreeArgAbi, 'threeArg'>['functionName']
  >().toEqualTypeOf<'threeArg'>();
});

test('zero-arg script: args is the (optional) empty tuple', () => {
  type NoArgAbi = ScriptAbi<'pulse', readonly [], { ts: Expr<'uint256'> }>;
  expectTypeOf<ReadContractParameters<NoArgAbi, 'pulse'>['args']>().toEqualTypeOf<
    readonly [] | undefined
  >();
  expectTypeOf<ReadContractReturnType<NoArgAbi, 'pulse'>>().toEqualTypeOf<{ ts: bigint }>();
});

test('dynamic returns flow through viem: string / bytes / T[]', () => {
  type DynAbi = ScriptAbi<
    'dyn',
    readonly [ArgSpec<'who', 'address'>],
    { name: Expr<'string'>; raw: Expr<'bytes'>; balances: Expr<'uint256[]'> }
  >;
  expectTypeOf<ReadContractReturnType<DynAbi, 'dyn'>>().toEqualTypeOf<{
    name: string;
    raw: `0x${string}`;
    balances: readonly bigint[];
  }>();
});

// ---------------------------------------------------------------------------
// runtime ↔ type agreement
// ---------------------------------------------------------------------------

test('buildScriptAbi returns Abi, and a ScriptAbi value satisfies it', () => {
  expectTypeOf(buildScriptAbi).returns.toEqualTypeOf<Abi>();
  const phantom = {} as PoolMetaAbi;
  const asAbi: Abi = phantom; // assignability, not just matching
  expectTypeOf(asAbi).toEqualTypeOf<Abi>();
});
