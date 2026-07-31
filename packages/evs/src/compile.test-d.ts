/**
 * M9 type tests — both `toViem()` shapes spread into viem's `readContract` and typecheck
 * under tsc --strict; the generated literal ABI flows through `readContract` inference for
 * the flagship script; omitting both `address` and `code` is a type error
 * (testing.md §5 "compile/viem").
 */

import type { Abi, Address } from 'abitype';
import type {
  PublicClient,
  ReadContractParameters,
  ReadContractReturnType,
  StateOverride,
} from 'viem';
import { expectTypeOf, test } from 'vitest';

import { evscript, type EvsScript } from './builder/script.js';
import { compile, type CompiledEvsScript } from './compile.js';
import { namedArg, t, type Hex } from './core/types.js';
import {
  decodeScriptError,
  matchScriptError,
  toCreationBytecode,
  toViemDeployless,
  toViemStateOverride,
} from './viem.js';

// ---------------------------------------------------------------------------
// the flagship-shaped script (api.md E1, trimmed): full inference end to end
// ---------------------------------------------------------------------------

const poolAbi = [
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const satisfies Abi;

const erc20Abi = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

const poolMeta = evscript({ name: 'poolMeta', args: [t.address, t.address] }, (s, pool, user) => {
  const token0 = s.read({ address: pool, abi: poolAbi, functionName: 'token0' });
  const symbol0 = s.read({ address: token0, abi: erc20Abi, functionName: 'symbol' });
  const dec = s.tryRead({ address: token0, abi: erc20Abi, functionName: 'decimals' });
  const decimals0 = s.select(dec.success, dec.value, 18);
  const bal0 = s.read({
    address: token0,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [user],
  });
  return s.return({ token0, symbol0, decimals0, bal0 });
});
const compiled = compile(poolMeta);

declare const client: PublicClient;
declare const pool: Address;
declare const user: Address;

type ExpectedOut = {
  token0: `0x${string}`;
  symbol0: string;
  decimals0: number; // uint8 → number (abitype ≤ 48 bits)
  bal0: bigint;
};

test('compile() and the .compile() sugar agree, with exact literal generics', () => {
  expectTypeOf(poolMeta.compile()).toEqualTypeOf(compiled);
  expectTypeOf(compiled.abi).toEqualTypeOf(poolMeta.abi);
  expectTypeOf(compiled.abi[0]['name']).toEqualTypeOf<'poolMeta'>();
  expectTypeOf(compiled.runtimeBytecode).toEqualTypeOf<Hex>();
  expectTypeOf(compiled.initBytecode).toEqualTypeOf<Hex>();
});

test('deployless toViem() spreads into readContract — full return inference', async () => {
  const shape = compiled.toViem();
  expectTypeOf(shape).toEqualTypeOf<{ abi: typeof compiled.abi; code: Hex }>();
  expectTypeOf(compiled.toViem({ mode: 'deployless' })).toEqualTypeOf(shape);

  const out = await client.readContract({
    ...compiled.toViem(),
    functionName: 'poolMeta',
    args: [pool, user],
  });
  expectTypeOf(out).toEqualTypeOf<ExpectedOut>();
});

test('stateOverride toViem() spreads into readContract (composable with account/block)', async () => {
  const shape = compiled.toViem({ mode: 'stateOverride' });
  expectTypeOf(shape.abi).toEqualTypeOf(compiled.abi);
  expectTypeOf(shape.address).toEqualTypeOf<Address>();
  expectTypeOf(shape.stateOverride).toEqualTypeOf<[{ address: Address; code: Hex }]>();
  // the tuple is assignable to viem's mutable StateOverride array type
  expectTypeOf(shape.stateOverride).toMatchTypeOf<StateOverride>();

  const out = await client.readContract({
    ...compiled.toViem({ mode: 'stateOverride' }),
    functionName: 'poolMeta',
    args: [pool, user],
    account: user, // msg.sender seen by the script
    blockNumber: 22_000_000n, // historical reads — it is just eth_call
  });
  expectTypeOf(out).toEqualTypeOf<ExpectedOut>();

  // custom address mode
  void compiled.toViem({ mode: 'stateOverride', address: pool });
});

test('omitting both address and code is a type error', () => {
  // @ts-expect-error — readContract needs either `address` (deployed/override) or `code` (deployless)
  void client.readContract({
    abi: compiled.abi,
    functionName: 'poolMeta',
    args: [pool, user],
  });
  expectTypeOf(compiled.abi).toMatchTypeOf<Abi>();
});

test('args is the labeled positional tuple in declaration order (auto-named arg0/arg1)', () => {
  type P = ReadContractParameters<typeof compiled.abi, 'poolMeta'>;
  expectTypeOf<P['args']>().toEqualTypeOf<readonly [arg0: `0x${string}`, arg1: `0x${string}`]>();
  expectTypeOf<P['functionName']>().toEqualTypeOf<'poolMeta'>();
});

// ---------------------------------------------------------------------------
// viem.ts helper shapes (frozen signatures)
// ---------------------------------------------------------------------------

test('toViemDeployless preserves the literal abi and yields { abi, code }', () => {
  const shape = toViemDeployless({
    abi: compiled.abi,
    initBytecode: toCreationBytecode('0x60016000f3', 'cancun'),
  });
  expectTypeOf(shape).toEqualTypeOf<{ abi: typeof compiled.abi; code: Hex }>();
});

test('toViemStateOverride yields { abi, address, stateOverride: StateOverride }', () => {
  const shape = toViemStateOverride(
    { abi: compiled.abi, runtimeBytecode: '0x60016000f3' },
    { address: '0x1000000000000000000000000000000000000001' },
  );
  expectTypeOf(shape).toEqualTypeOf<{
    abi: typeof compiled.abi;
    address: Address;
    stateOverride: StateOverride;
  }>();
});

// ---------------------------------------------------------------------------
// default instantiations are proper supertypes — the ScriptAbi default no longer
// collapses Record<string, Expr> components to a UnionToTuple 1-tuple (abi/artifact.ts)
// ---------------------------------------------------------------------------

test('a concrete multi-return script is assignable to default-instantiated EvsScript / CompiledEvsScript', () => {
  // poolMeta returns FOUR components — exactly the case the 1-tuple collapse used to reject
  const script = poolMeta satisfies EvsScript;
  void script;
  const artifact = compiled satisfies CompiledEvsScript;
  void artifact;
  expectTypeOf(poolMeta).toMatchTypeOf<EvsScript>();
  expectTypeOf(compiled).toMatchTypeOf<CompiledEvsScript>();
});

// ---------------------------------------------------------------------------
// returning a Tuple handle DIRECTLY (no .expr()) — the struct component still resolves
// to the named object, identical to the `.expr()` form (composite types §6/§8)
// ---------------------------------------------------------------------------

const slot0Abi = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'sqrtPriceX96', type: 'uint160' },
          { name: 'tick', type: 'int24' },
          { name: 'unlocked', type: 'bool' },
        ],
      },
    ],
  },
] as const satisfies Abi;

// the struct object viem must infer for the `slot0` component (uint160 → bigint, int24 → number)
type Slot0Struct = {
  sqrtPriceX96: bigint;
  tick: number;
  unlocked: boolean;
};

// bare handle: `slot0` is the Tuple itself (no `.expr()`)
const poolSlot0Direct = evscript({ name: 'poolSlot0', args: t.address }, (s, poolAddr) => {
  const slot0 = s.read({ address: poolAddr, abi: slot0Abi, functionName: 'slot0' });
  return s.return({ tick: slot0.tick.get(), slot0 });
});
// the legacy `.expr()` form — must remain valid and infer identically
const poolSlot0Expr = evscript({ name: 'poolSlot0', args: t.address }, (s, poolAddr) => {
  const slot0 = s.read({ address: poolAddr, abi: slot0Abi, functionName: 'slot0' });
  return s.return({ tick: slot0.tick.get(), slot0: slot0.expr() });
});

test('a Tuple handle returned directly infers the struct object (not unknown), same as .expr()', () => {
  type Direct = ReadContractReturnType<typeof poolSlot0Direct.abi, 'poolSlot0'>;
  type ViaExpr = ReadContractReturnType<typeof poolSlot0Expr.abi, 'poolSlot0'>;
  // the `slot0` component is the fully-decoded struct OBJECT, never `unknown`
  expectTypeOf<Direct>().toEqualTypeOf<{ tick: number; slot0: Slot0Struct }>();
  // the direct form and the `.expr()` form infer the SAME return type
  expectTypeOf<Direct>().toEqualTypeOf<ViaExpr>();
});

// ---------------------------------------------------------------------------
// custom errors — ABI literal + decode utilities typing (issue #15)
// ---------------------------------------------------------------------------

const NoBalanceE = t.error('NoBalance', [namedArg('balance', t.uint256)]);
const NotOwnerE = t.error('NotOwner');

const guardScript = evscript(
  { name: 'guard', args: [t.uint256], errors: [NoBalanceE, NotOwnerE] },
  (s, x) => {
    s.if(x.lt(10n), () => {
      s.throw(NoBalanceE, { balance: x });
    });
    return s.return({ doubled: x.mul(2n) });
  },
);

test('the declared error entries appear literally in the script ABI', () => {
  type ErrorNames = Extract<(typeof guardScript.abi)[number], { type: 'error' }>['name'];
  expectTypeOf<ErrorNames>().toEqualTypeOf<
    'EvsInvalidCalldata' | 'EvsDecodeError' | 'NoBalance' | 'NotOwner'
  >();
});

test('a script WITH errors is still assignable to the default-instantiated types', () => {
  const script = guardScript satisfies EvsScript;
  void script;
  const artifact = compile(guardScript) satisfies CompiledEvsScript;
  void artifact;
  expectTypeOf(guardScript).toMatchTypeOf<EvsScript>();
});

test('decodeScriptError yields a name-discriminated union with typed args', () => {
  const decoded = decodeScriptError(guardScript, undefined as unknown);
  if (decoded !== undefined && decoded.name === 'NoBalance') {
    expectTypeOf(decoded.args).toEqualTypeOf<{ readonly balance: bigint }>();
  }
  if (decoded !== undefined && decoded.name === 'Panic') {
    expectTypeOf(decoded.code).toEqualTypeOf<bigint>();
  }
  if (decoded !== undefined && decoded.name === 'EvsDecodeError') {
    expectTypeOf(decoded.args).toEqualTypeOf<{ readonly site: bigint }>();
  }
});

test('matchScriptError requires every declared handler plus _, and types the args', () => {
  const out = matchScriptError(guardScript, undefined as unknown, {
    NoBalance: ({ balance }) => {
      expectTypeOf(balance).toEqualTypeOf<bigint>();
      return balance;
    },
    NotOwner: () => 'owner' as const,
    _: (other) => {
      // declared arms are excluded from the default union
      expectTypeOf(other.name).toEqualTypeOf<
        'EvsInvalidCalldata' | 'EvsDecodeError' | 'Panic' | 'Error' | 'unknown' | 'empty'
      >();
      return null;
    },
  });
  expectTypeOf<bigint | 'owner' | null>(out);

  // @ts-expect-error — missing the NotOwner handler (exhaustiveness over declared errors)
  matchScriptError(guardScript, undefined as unknown, {
    NoBalance: () => 0,
    _: () => 0,
  });

  // @ts-expect-error — the `_` default arm is always required
  matchScriptError(guardScript, undefined as unknown, {
    NoBalance: () => 0,
    NotOwner: () => 0,
  });
});
