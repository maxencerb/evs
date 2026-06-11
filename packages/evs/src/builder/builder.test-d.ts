/**
 * M5 type tests — `s.args` record from the ArgSpec tuple, `IntoExpr` coercions at the builder
 * surface, `s.call`/`s.tryCall` output inference (0/1/n unwrap, mutability filtering, graceful
 * widening) against viem-shaped const ABI fixtures, and `ScriptReturn` inference through
 * `evscript`. Runs under the vitest `types` project (typecheck only — nothing executes).
 */
import type { Abi } from 'abitype';
import type { ReadContractReturnType } from 'viem';
import { expectTypeOf, test } from 'vitest';

import { arg, t, type ArgSpec, type Expr } from '../core/types.js';
import {
  evscript,
  type Cell,
  type EvsFn,
  type EvsScript,
  type LoopCtl,
  type MutArray,
  type ScriptReturn,
} from './script.js';

// ---------------------------------------------------------------------------
// viem-shaped const ABI fixtures
// ---------------------------------------------------------------------------

const erc20Fixture = [
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
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi;

const poolFixture = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'poke',
    stateMutability: 'view',
    inputs: [],
    outputs: [],
  },
] as const satisfies Abi;

// ---------------------------------------------------------------------------
// s.args: ArgSpec tuple → named record (the safe tuple→record direction)
// ---------------------------------------------------------------------------

test('s.args is the exact name→Expr record derived from the args tuple', () => {
  evscript({ name: 'argsRecord', args: [arg('pool', t.address), arg('fee', t.uint24)] }, (s) => {
    expectTypeOf(s.args).toEqualTypeOf<{
      readonly pool: Expr<'address'>;
      readonly fee: Expr<'uint24'>;
    }>();
    expectTypeOf(s.args.pool).toEqualTypeOf<Expr<'address'>>();
    // @ts-expect-error — no such argument
    void s.args.nope;
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

test('dynamic arg types flow through (string/bytes/T[])', () => {
  evscript(
    { name: 'dynArgs', args: [arg('tokens', t.array(t.address)), arg('blob', t.bytes)] },
    (s) => {
      expectTypeOf(s.args.tokens).toEqualTypeOf<Expr<'address[]'>>();
      expectTypeOf(s.args.tokens.at(0n)).toEqualTypeOf<Expr<'address'>>();
      expectTypeOf(s.args.tokens.length()).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(s.args.blob.length()).toEqualTypeOf<Expr<'uint256'>>();
      return s.return({ n: s.args.tokens.length() });
    },
  );
});

// ---------------------------------------------------------------------------
// IntoExpr coercions at the op surface
// ---------------------------------------------------------------------------

test('IntoExpr accepts literals of the right shape and rejects the wrong ones', () => {
  evscript({ name: 'coerce', args: [arg('x', t.uint256), arg('s8', t.int8)] }, (s) => {
    expectTypeOf(s.add(s.args.x, 5n)).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(s.add(s.args.x, 5)).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(s.sub(100n, s.args.x)).toEqualTypeOf<Expr<'uint256'>>(); // literal-left
    expectTypeOf(s.args.s8.add(-1n)).toEqualTypeOf<Expr<'int8'>>();
    expectTypeOf(s.args.x.lt(10n)).toEqualTypeOf<Expr<'bool'>>();

    // @ts-expect-error — hex string is not a numeric literal
    s.add(s.args.x, '0x12');
    // @ts-expect-error — boolean is not a numeric literal
    s.args.x.add(true);

    const u8 = s.lit(t.uint8, 1);
    const u16 = s.lit(t.uint16, 1);
    // @ts-expect-error — width mismatch between Expr operands (method form pins t)
    u8.add(u16);

    return s.return({ ok: s.lit(t.bool, true) });
  });
});

test('this-parameter constraints: arithmetic on address / eq on memref are type errors', () => {
  evscript({ name: 'thisParam', args: [arg('who', t.address)] }, (s) => {
    // @ts-expect-error — address is not numeric (this: Expr<t & NumericType> = never)
    s.args.who.add(1n);
    const str = s.call({ address: s.args.who, abi: erc20Fixture, functionName: 'symbol' });
    // @ts-expect-error — eq is word-types-only (this: Expr<t & WordType> = never for 'string')
    str.eq(str);
    // address equality IS a word comparison — fine:
    expectTypeOf(s.args.who.eq('0x0000000000000000000000000000000000000000')).toEqualTypeOf<
      Expr<'bool'>
    >();
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

// ---------------------------------------------------------------------------
// s.call inference (viem patterns)
// ---------------------------------------------------------------------------

test('s.call unwraps outputs: [] → void, [one] → Expr, [many] → labeled tuple of Exprs', () => {
  evscript({ name: 'unwrap', args: [arg('pool', t.address)] }, (s) => {
    const sym = s.call({ address: s.args.pool, abi: erc20Fixture, functionName: 'symbol' });
    expectTypeOf(sym).toEqualTypeOf<Expr<'string'>>();

    const slot0 = s.call({ address: s.args.pool, abi: poolFixture, functionName: 'slot0' });
    expectTypeOf(slot0).toEqualTypeOf<readonly [Expr<'uint160'>, Expr<'int24'>, Expr<'bool'>]>();
    expectTypeOf(slot0[1]).toEqualTypeOf<Expr<'int24'>>();

    const nothing = s.call({ address: s.args.pool, abi: poolFixture, functionName: 'poke' });
    expectTypeOf(nothing).toBeVoid();

    return s.return({ sym, tick: slot0[1] });
  });
});

test('args are per-parameter unions: abitype primitive OR Expr of that type', () => {
  evscript({ name: 'callArgs', args: [arg('token', t.address), arg('user', t.address)] }, (s) => {
    const a = s.call({
      address: s.args.token,
      abi: erc20Fixture,
      functionName: 'balanceOf',
      args: [s.args.user], // Expr<'address'>
    });
    const b = s.call({
      address: s.args.token,
      abi: erc20Fixture,
      functionName: 'balanceOf',
      args: ['0x0000000000000000000000000000000000000001'], // literal primitive
    });
    expectTypeOf(a).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(b).toEqualTypeOf<Expr<'uint256'>>();

    s.call({
      address: s.args.token,
      abi: erc20Fixture,
      functionName: 'balanceOf',
      // @ts-expect-error — number is neither `0x…` nor Expr<'address'>
      args: [123],
    });
    s.call({
      address: s.args.token,
      abi: erc20Fixture,
      functionName: 'balanceOf',
      // @ts-expect-error — Expr of the wrong word type
      args: [s.lit(t.uint256, 1n)],
    });
    return s.return({ a, b });
  });
});

test('mutability is filtered at the name level: nonpayable functionName is a type error', () => {
  evscript({ name: 'mut', args: [arg('token', t.address)] }, (s) => {
    s.call({
      address: s.args.token,
      abi: erc20Fixture,
      // @ts-expect-error — 'transfer' is nonpayable, not in ContractFunctionName<…, 'pure'|'view'>
      functionName: 'transfer',
    });
    // the view/pure name union is exactly the callable surface
    expectTypeOf<'symbol' | 'decimals' | 'balanceOf'>().toMatchTypeOf<
      Parameters<typeof s.call<typeof erc20Fixture, 'symbol'>>[0]['functionName']
    >();
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

test('tryCall: success Expr<bool> + the same unwrapped value shape', () => {
  evscript({ name: 'tryc', args: [arg('token', t.address)] }, (s) => {
    const d = s.tryCall({ address: s.args.token, abi: erc20Fixture, functionName: 'decimals' });
    expectTypeOf(d.success).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(d.value).toEqualTypeOf<Expr<'uint8'>>();
    const defaulted = s.select(d.success, d.value, 18);
    expectTypeOf(defaulted).toEqualTypeOf<Expr<'uint8'>>();
    return s.return({ decimals: defaulted });
  });
});

test('graceful widening: a non-const ABI degrades, never hard-errors', () => {
  const wideAbi: Abi = [];
  evscript({ name: 'wide', args: [arg('target', t.address)] }, (s) => {
    const res = s.call({
      address: s.args.target,
      abi: wideAbi,
      functionName: 'anythingGoes', // functionName: string
      args: [1n, 'two', false], // readonly unknown[]
    });
    expectTypeOf(res).toEqualTypeOf<readonly Expr[]>(); // outputs widen to Expr<EvsType>[]
    const tre = s.tryCall({ address: s.args.target, abi: wideAbi, functionName: 'x' });
    expectTypeOf(tre.success).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(tre.value).toEqualTypeOf<readonly Expr[]>();
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

// ---------------------------------------------------------------------------
// cells, arrays, env, control flow
// ---------------------------------------------------------------------------

test('Cell / MutArray / env / for typing', () => {
  evscript({ name: 'state', args: [arg('n', t.uint256)] }, (s) => {
    const c = s.let(t.uint64, 0n);
    expectTypeOf(c).toEqualTypeOf<Cell<'uint64'>>();
    expectTypeOf(c.get()).toEqualTypeOf<Expr<'uint64'>>();
    // @ts-expect-error — wrong width literal-free Expr
    c.set(s.args.n);

    const inferred = s.let(s.args.n);
    expectTypeOf(inferred).toEqualTypeOf<Cell<'uint256'>>();

    const out = s.newArray(t.uint128, s.args.n);
    expectTypeOf(out).toEqualTypeOf<MutArray<'uint128'>>();
    expectTypeOf(out.length).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(out.get(0n)).toEqualTypeOf<Expr<'uint128'>>();
    expectTypeOf(out.expr()).toEqualTypeOf<Expr<'uint128[]'>>();
    // @ts-expect-error — element type mismatch
    out.set(0n, s.args.n);

    expectTypeOf(s.env('caller')).toEqualTypeOf<Expr<'address'>>();
    expectTypeOf(s.env('chainid')).toEqualTypeOf<Expr<'uint256'>>();

    s.for({ type: t.int24, from: -1n, until: 5n }, (i, loop) => {
      expectTypeOf(i).toEqualTypeOf<Expr<'int24'>>();
      expectTypeOf(loop).toEqualTypeOf<LoopCtl>();
    });

    s.while(
      () => c.get().lt(5n),
      (loop) => {
        expectTypeOf(loop).toEqualTypeOf<LoopCtl>();
        expectTypeOf<LoopCtl['break']>().toEqualTypeOf<() => void>();
      },
    );

    return s.return({ n: s.args.n });
  });
});

// ---------------------------------------------------------------------------
// s.fn typing
// ---------------------------------------------------------------------------

test('EvsFn: params map to IntoExpr, results are rebuilt fresh Exprs', () => {
  evscript({ name: 'fns', args: [arg('x', t.uint256)] }, (s) => {
    const inc = s.fn('inc', [arg('a', t.uint256)] as const, (a) => {
      expectTypeOf(a).toEqualTypeOf<Expr<'uint256'>>();
      return a.add(1n);
    });
    expectTypeOf(inc).toEqualTypeOf<EvsFn<readonly [ArgSpec<'a', 'uint256'>], Expr<'uint256'>>>();
    expectTypeOf(inc(1n)).toEqualTypeOf<Expr<'uint256'>>(); // literal coerces
    expectTypeOf(inc(s.args.x)).toEqualTypeOf<Expr<'uint256'>>();
    // @ts-expect-error — wrong literal shape for uint256
    inc('0x00');

    const pair = s.fn('pair', [arg('a', t.uint8)] as const, (a) => [a, a.eq(0n)] as const);
    expectTypeOf(pair(3n)).toEqualTypeOf<readonly [Expr<'uint8'>, Expr<'bool'>]>();

    const noop = s.fn('noop', [] as const, () => {});
    expectTypeOf(noop()).toBeVoid();

    return s.return({ x: s.args.x });
  });
});

// ---------------------------------------------------------------------------
// ScriptReturn inference through evscript → literal-typed artifact
// ---------------------------------------------------------------------------

test('ScriptReturn flows through evscript into EvsScript / ScriptAbi / viem return types', () => {
  const script = evscript(
    { name: 'meta', args: [arg('pool', t.address), arg('user', t.address)] },
    (s) => {
      const symbol = s.call({ address: s.args.pool, abi: erc20Fixture, functionName: 'symbol' });
      const bal = s.call({
        address: s.args.pool,
        abi: erc20Fixture,
        functionName: 'balanceOf',
        args: [s.args.user],
      });
      const slot0 = s.call({ address: s.args.pool, abi: poolFixture, functionName: 'slot0' });
      return s.return({ symbol, bal, tick: slot0[1] });
    },
  );

  expectTypeOf(script).toMatchTypeOf<
    EvsScript<
      'meta',
      readonly [ArgSpec<'pool', 'address'>, ArgSpec<'user', 'address'>],
      { symbol: Expr<'string'>; bal: Expr<'uint256'>; tick: Expr<'int24'> }
    >
  >();
  expectTypeOf(script.name).toEqualTypeOf<'meta'>();
  expectTypeOf(script.abi[0].name).toEqualTypeOf<'meta'>();
  expectTypeOf(script.abi[0].inputs).toEqualTypeOf<
    readonly [
      { readonly name: 'pool'; readonly type: 'address' },
      { readonly name: 'user'; readonly type: 'address' },
    ]
  >();
  // the consumer-visible shape: viem infers an object from the named single-tuple output
  expectTypeOf<ReadContractReturnType<typeof script.abi, 'meta'>>().toEqualTypeOf<{
    symbol: string;
    bal: bigint;
    tick: number; // int24 → number (abitype)
  }>();
});

test('the body callback must return a ScriptReturn (not a bare record)', () => {
  // @ts-expect-error — returning the record directly is not a ScriptReturn
  evscript({ name: 'bad', args: [] }, (s) => ({ x: s.lit(t.uint256, 1n) }));

  evscript({ name: 'ok', args: [] }, (s) => {
    const token = s.return({ x: s.lit(t.uint256, 1n) });
    // `const ret` inference marks the record readonly
    expectTypeOf(token).toEqualTypeOf<ScriptReturn<{ readonly x: Expr<'uint256'> }>>();
    return token;
  });
});
