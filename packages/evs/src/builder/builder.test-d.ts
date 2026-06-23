/**
 * M5 type tests — positional arg handles spread into the body callback after `s`, `IntoExpr`
 * coercions at the builder surface, `s.call`/`s.tryCall` output inference (0/1/n unwrap,
 * mutability filtering, graceful widening) against viem-shaped const ABI fixtures, and
 * `ScriptReturn` inference through `evscript`. Runs under the vitest `types` project (typecheck
 * only — nothing executes).
 */
import type { Abi } from 'abitype';
import type { ReadContractReturnType } from 'viem';
import { expectTypeOf, test } from 'vitest';

import { arg, t, type ArgSpec, type Expr, type TupleType } from '../core/types.js';
import {
  evscript,
  type Cell,
  type EvsFn,
  type EvsScript,
  type LoopCtl,
  type MutArray,
  type ScriptReturn,
  type Tuple,
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

// composite-array OUTPUT fixtures (§12 read path)
const arraysFixture = [
  {
    type: 'function',
    name: 'positionsBatch',
    stateMutability: 'view',
    inputs: [{ name: 'n', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        components: [
          { name: 'nonce', type: 'uint96' },
          { name: 'liquidity', type: 'uint128' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'matrix',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256[][]' }],
  },
  {
    type: 'function',
    name: 'names',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string[]' }],
  },
] as const satisfies Abi;

// ---------------------------------------------------------------------------
// args arrive as positional handles after `s` (a lone type ≡ a one-element list)
// ---------------------------------------------------------------------------

test('scalar args are positional Expr handles in declaration order', () => {
  evscript({ name: 'argsRecord', args: [t.address, t.uint24] }, (s, pool, fee) => {
    expectTypeOf(pool).toEqualTypeOf<Expr<'address'>>();
    expectTypeOf(fee).toEqualTypeOf<Expr<'uint24'>>();
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

test('a lone arg type normalizes to a single positional handle', () => {
  evscript({ name: 'lone', args: t.uint256 }, (s, n) => {
    expectTypeOf(n).toEqualTypeOf<Expr<'uint256'>>();
    return s.return({ n });
  });
});

test('a tuple arg arrives as a Tuple handle; scalar args as Expr', () => {
  const Params = t.struct({ tokenIn: t.address, fee: t.uint24 });
  evscript({ name: 'tupleArg', args: [Params, t.uint256] }, (s, p, amount) => {
    expectTypeOf(p).toEqualTypeOf<Tuple<typeof Params>>();
    expectTypeOf(p.tokenIn.get()).toEqualTypeOf<Expr<'address'>>();
    expectTypeOf(p.fee.get()).toEqualTypeOf<Expr<'uint24'>>();
    expectTypeOf(amount).toEqualTypeOf<Expr<'uint256'>>();
    return s.return({ fee: p.fee.get(), amount });
  });
});

test('dynamic arg types flow through (string/bytes/T[])', () => {
  evscript({ name: 'dynArgs', args: [t.array(t.address), t.bytes] }, (s, tokens, blob) => {
    expectTypeOf(tokens).toEqualTypeOf<Expr<'address[]'>>();
    expectTypeOf(tokens.at(0n)).toEqualTypeOf<Expr<'address'>>();
    expectTypeOf(tokens.length()).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(blob.length()).toEqualTypeOf<Expr<'uint256'>>();
    return s.return({ n: tokens.length() });
  });
});

// ---------------------------------------------------------------------------
// IntoExpr coercions at the op surface
// ---------------------------------------------------------------------------

test('IntoExpr accepts literals of the right shape and rejects the wrong ones', () => {
  evscript({ name: 'coerce', args: [t.uint256, t.int8] }, (s, x, s8) => {
    expectTypeOf(s.add(x, 5n)).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(s.add(x, 5)).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(s.sub(100n, x)).toEqualTypeOf<Expr<'uint256'>>(); // literal-left
    expectTypeOf(s8.add(-1n)).toEqualTypeOf<Expr<'int8'>>();
    expectTypeOf(x.lt(10n)).toEqualTypeOf<Expr<'bool'>>();

    // @ts-expect-error — hex string is not a numeric literal
    s.add(x, '0x12');
    // @ts-expect-error — boolean is not a numeric literal
    x.add(true);

    const u8 = s.lit(t.uint8, 1);
    const u16 = s.lit(t.uint16, 1);
    // @ts-expect-error — width mismatch between Expr operands (method form pins t)
    u8.add(u16);

    return s.return({ ok: s.lit(t.bool, true) });
  });
});

test('this-parameter constraints: arithmetic on address / eq on memref are type errors', () => {
  evscript({ name: 'thisParam', args: [t.address] }, (s, who) => {
    // @ts-expect-error — address is not numeric (this: Expr<t & NumericType> = never)
    who.add(1n);
    const str = s.call({ address: who, abi: erc20Fixture, functionName: 'symbol' });
    // @ts-expect-error — eq is word-types-only (this: Expr<t & WordType> = never for 'string')
    str.eq(str);
    // address equality IS a word comparison — fine:
    expectTypeOf(who.eq('0x0000000000000000000000000000000000000000')).toEqualTypeOf<
      Expr<'bool'>
    >();
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

// ---------------------------------------------------------------------------
// s.call inference (viem patterns)
// ---------------------------------------------------------------------------

test('s.call unwraps outputs: [] → void, [one] → Expr, [many] → labeled tuple of Exprs', () => {
  evscript({ name: 'unwrap', args: [t.address] }, (s, pool) => {
    const sym = s.call({ address: pool, abi: erc20Fixture, functionName: 'symbol' });
    expectTypeOf(sym).toEqualTypeOf<Expr<'string'>>();

    const slot0 = s.call({ address: pool, abi: poolFixture, functionName: 'slot0' });
    expectTypeOf(slot0).toEqualTypeOf<readonly [Expr<'uint160'>, Expr<'int24'>, Expr<'bool'>]>();
    expectTypeOf(slot0[1]).toEqualTypeOf<Expr<'int24'>>();

    const nothing = s.call({ address: pool, abi: poolFixture, functionName: 'poke' });
    expectTypeOf(nothing).toBeVoid();

    return s.return({ sym, tick: slot0[1] });
  });
});

test('composite-array outputs: nested word arrays and string arrays index to typed Exprs (§12)', () => {
  evscript({ name: 'rdArrays', args: [t.address] }, (s, target) => {
    // uint256[][] → an array Expr; .at(i) peels one [] (Expr<'uint256[]'>), .at(i).at(j) → word.
    const m = s.call({ address: target, abi: arraysFixture, functionName: 'matrix' });
    expectTypeOf(m).toEqualTypeOf<Expr<'uint256[][]'>>();
    expectTypeOf(m.at(0n)).toEqualTypeOf<Expr<'uint256[]'>>();
    expectTypeOf(m.at(0n).at(0n)).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(m.length()).toEqualTypeOf<Expr<'uint256'>>();

    // string[] → an array Expr; .at(i) → Expr<'string'>, .at(i).length() → a word.
    const ns = s.call({ address: target, abi: arraysFixture, functionName: 'names' });
    expectTypeOf(ns).toEqualTypeOf<Expr<'string[]'>>();
    expectTypeOf(ns.at(1n)).toEqualTypeOf<Expr<'string'>>();
    expectTypeOf(ns.at(1n).length()).toEqualTypeOf<Expr<'uint256'>>();

    return s.return({ rows: m.length(), first: m.at(0n).at(0n), n2len: ns.at(2n).length() });
  });
});

test('args are per-parameter unions: abitype primitive OR Expr of that type', () => {
  evscript({ name: 'callArgs', args: [t.address, t.address] }, (s, token, user) => {
    const a = s.call({
      address: token,
      abi: erc20Fixture,
      functionName: 'balanceOf',
      args: [user], // Expr<'address'>
    });
    const b = s.call({
      address: token,
      abi: erc20Fixture,
      functionName: 'balanceOf',
      args: ['0x0000000000000000000000000000000000000001'], // literal primitive
    });
    expectTypeOf(a).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(b).toEqualTypeOf<Expr<'uint256'>>();

    s.call({
      address: token,
      abi: erc20Fixture,
      functionName: 'balanceOf',
      // @ts-expect-error — number is neither `0x…` nor Expr<'address'>
      args: [123],
    });
    s.call({
      address: token,
      abi: erc20Fixture,
      functionName: 'balanceOf',
      // @ts-expect-error — Expr of the wrong word type
      args: [s.lit(t.uint256, 1n)],
    });
    return s.return({ a, b });
  });
});

test('mutability is filtered at the name level: nonpayable functionName is a type error', () => {
  evscript({ name: 'mut', args: [t.address] }, (s, token) => {
    s.call({
      address: token,
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
  evscript({ name: 'tryc', args: [t.address] }, (s, token) => {
    const d = s.tryCall({ address: token, abi: erc20Fixture, functionName: 'decimals' });
    expectTypeOf(d.success).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(d.value).toEqualTypeOf<Expr<'uint8'>>();
    const defaulted = s.select(d.success, d.value, 18);
    expectTypeOf(defaulted).toEqualTypeOf<Expr<'uint8'>>();
    return s.return({ decimals: defaulted });
  });
});

test('graceful widening: a non-const ABI degrades, never hard-errors', () => {
  const wideAbi: Abi = [];
  evscript({ name: 'wide', args: [t.address] }, (s, target) => {
    const res = s.call({
      address: target,
      abi: wideAbi,
      functionName: 'anythingGoes', // functionName: string
      args: [1n, 'two', false], // readonly unknown[]
    });
    // a non-const ABI widens outputs to a list of (Expr | Tuple) handles
    expectTypeOf(res).toEqualTypeOf<readonly (Expr | Tuple<TupleType>)[]>();
    const tre = s.tryCall({ address: target, abi: wideAbi, functionName: 'x' });
    expectTypeOf(tre.success).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(tre.value).toEqualTypeOf<readonly (Expr | Tuple<TupleType>)[]>();
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

// ---------------------------------------------------------------------------
// cells, arrays, env, control flow
// ---------------------------------------------------------------------------

test('Cell / MutArray / env / for typing', () => {
  evscript({ name: 'state', args: [t.uint256] }, (s, n) => {
    const c = s.let(t.uint64, 0n);
    expectTypeOf(c).toEqualTypeOf<Cell<'uint64'>>();
    expectTypeOf(c.get()).toEqualTypeOf<Expr<'uint64'>>();
    // @ts-expect-error — wrong width literal-free Expr
    c.set(n);

    const inferred = s.let(n);
    expectTypeOf(inferred).toEqualTypeOf<Cell<'uint256'>>();

    const out = s.newArray(t.uint128, n);
    expectTypeOf(out).toEqualTypeOf<MutArray<'uint128'>>();
    expectTypeOf(out.length).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(out.get(0n)).toEqualTypeOf<Expr<'uint128'>>();
    expectTypeOf(out.expr()).toEqualTypeOf<Expr<'uint128[]'>>();
    // @ts-expect-error — element type mismatch
    out.set(0n, n);

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

    return s.return({ n });
  });
});

// ---------------------------------------------------------------------------
// s.fn typing
// ---------------------------------------------------------------------------

test('EvsFn: params map to IntoExpr, results are rebuilt fresh Exprs', () => {
  evscript({ name: 'fns', args: [t.uint256] }, (s, x) => {
    const inc = s.fn('inc', [arg('a', t.uint256)] as const, (a) => {
      expectTypeOf(a).toEqualTypeOf<Expr<'uint256'>>();
      return a.add(1n);
    });
    expectTypeOf(inc).toEqualTypeOf<EvsFn<readonly [ArgSpec<'a', 'uint256'>], Expr<'uint256'>>>();
    expectTypeOf(inc(1n)).toEqualTypeOf<Expr<'uint256'>>(); // literal coerces
    expectTypeOf(inc(x)).toEqualTypeOf<Expr<'uint256'>>();
    // @ts-expect-error — wrong literal shape for uint256
    inc('0x00');

    const pair = s.fn('pair', [arg('a', t.uint8)] as const, (a) => [a, a.eq(0n)] as const);
    expectTypeOf(pair(3n)).toEqualTypeOf<readonly [Expr<'uint8'>, Expr<'bool'>]>();

    const noop = s.fn('noop', [] as const, () => {});
    expectTypeOf(noop()).toBeVoid();

    return s.return({ x });
  });
});

// ---------------------------------------------------------------------------
// ScriptReturn inference through evscript → literal-typed artifact
// ---------------------------------------------------------------------------

test('ScriptReturn flows through evscript into EvsScript / ScriptAbi / viem return types', () => {
  const script = evscript({ name: 'meta', args: [t.address, t.address] }, (s, pool, user) => {
    const symbol = s.call({ address: pool, abi: erc20Fixture, functionName: 'symbol' });
    const bal = s.call({
      address: pool,
      abi: erc20Fixture,
      functionName: 'balanceOf',
      args: [user],
    });
    const slot0 = s.call({ address: pool, abi: poolFixture, functionName: 'slot0' });
    return s.return({ symbol, bal, tick: slot0[1] });
  });

  expectTypeOf(script).toMatchTypeOf<
    EvsScript<
      'meta',
      readonly ['address', 'address'],
      { symbol: Expr<'string'>; bal: Expr<'uint256'>; tick: Expr<'int24'> }
    >
  >();
  expectTypeOf(script.name).toEqualTypeOf<'meta'>();
  expectTypeOf(script.abi[0].name).toEqualTypeOf<'meta'>();
  expectTypeOf(script.abi[0].inputs).toEqualTypeOf<
    readonly [
      { readonly name: 'arg0'; readonly type: 'address' },
      { readonly name: 'arg1'; readonly type: 'address' },
    ]
  >();
  // the consumer-visible shape: viem infers an object from the named single-tuple output
  expectTypeOf<ReadContractReturnType<typeof script.abi, 'meta'>>().toEqualTypeOf<{
    symbol: string;
    bal: bigint;
    tick: number; // int24 → number (abitype)
  }>();
});

test('abitype infers composite-array outputs: tuple[] → readonly Struct[], uint256[][], string[]', () => {
  // The callee ABI's composite-array outputs infer the shapes evs decodes into (§12.8): a
  // `tuple[]` → `readonly Struct[]`, `uint256[][]` → `readonly (readonly bigint[])[]`,
  // `string[]` → `readonly string[]`. (The runtime decode is proven byte-exact in the differential
  // + integration tiers; this pins the type-level shape evs targets.)
  expectTypeOf<ReadContractReturnType<typeof arraysFixture, 'positionsBatch'>>().toEqualTypeOf<
    readonly { nonce: bigint; liquidity: bigint }[]
  >();
  expectTypeOf<ReadContractReturnType<typeof arraysFixture, 'matrix'>>().toEqualTypeOf<
    readonly (readonly bigint[])[]
  >();
  expectTypeOf<ReadContractReturnType<typeof arraysFixture, 'names'>>().toEqualTypeOf<
    readonly string[]
  >();
});

test('returning a whole composite array infers an abitype-typed script output (§12.8 return side)', () => {
  // s.return of a decoded composite array widens the script's own ScriptAbi output so a viem read
  // of the compiled script infers the precise shape: `tuple[]` → `readonly Struct[]`, `uint256[][]`
  // → `readonly (readonly bigint[])[]`, `string[]` → `readonly string[]`.
  const script = evscript({ name: 'arrs', args: [t.uint256] }, (s, n) => {
    const ps = s.call({
      address: '0x0000000000000000000000000000000000000001',
      abi: arraysFixture,
      functionName: 'positionsBatch',
      args: [n],
    });
    const m = s.call({
      address: '0x0000000000000000000000000000000000000001',
      abi: arraysFixture,
      functionName: 'matrix',
    });
    const ns = s.call({
      address: '0x0000000000000000000000000000000000000001',
      abi: arraysFixture,
      functionName: 'names',
    });
    return s.return({ ps, m, ns });
  });
  expectTypeOf<ReadContractReturnType<typeof script.abi, 'arrs'>>().toEqualTypeOf<{
    ps: readonly { nonce: bigint; liquidity: bigint }[];
    m: readonly (readonly bigint[])[];
    ns: readonly string[];
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

// ---------------------------------------------------------------------------
// composite-type ergonomics — issue #5 (s.fn struct returns, struct: true,
// call/constructed tuple unification, t.fromOutputs, bare MutArray return)
// ---------------------------------------------------------------------------

const positionFixture = [
  {
    type: 'function',
    name: 'positions',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'liquidity', type: 'uint128' },
          { name: 'owner', type: 'address' },
        ],
      },
    ],
  },
] as const satisfies Abi;

// view functions taking composite INPUTS (for the call-arg widening, #3/#5)
const consumerFixture = [
  {
    type: 'function',
    name: 'useStruct',
    stateMutability: 'view',
    inputs: [
      {
        name: 'p',
        type: 'tuple',
        components: [
          { name: 'liquidity', type: 'uint128' },
          { name: 'owner', type: 'address' },
        ],
      },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'useStructs',
    stateMutability: 'view',
    inputs: [
      {
        name: 'ps',
        type: 'tuple[]',
        components: [
          { name: 'liquidity', type: 'uint128' },
          { name: 'owner', type: 'address' },
        ],
      },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

test('#1 s.fn returns a struct directly; the call site receives a Tuple handle', () => {
  const Meta = t.struct({ symbol: t.string, decimals: t.uint8 });
  evscript({ name: 'fnstruct', args: [t.address] }, (s, token) => {
    const getMeta = s.fn('getMeta', [arg('tok', t.address)] as const, (tok) =>
      s.tuple(Meta, {
        symbol: s.call({ address: tok, abi: erc20Fixture, functionName: 'symbol' }),
        decimals: s.call({ address: tok, abi: erc20Fixture, functionName: 'decimals' }),
      }),
    );
    const m = getMeta(token);
    // the result is a usable Tuple — field reads are member-typed (was `readonly [Expr,…]` before).
    expectTypeOf(m.symbol.get()).toEqualTypeOf<Expr<'string'>>();
    expectTypeOf(m.decimals.get()).toEqualTypeOf<Expr<'uint8'>>();
    return s.return({ meta: m });
  });
});

test('#1 s.fn returns a MutArray; the call site receives an array Expr', () => {
  evscript({ name: 'fnarr', args: [t.uint256] }, (s, n) => {
    const build = s.fn('build', [arg('len', t.uint256)] as const, (len) =>
      s.newArray(t.uint256, len),
    );
    const a = build(n);
    expectTypeOf(a).toEqualTypeOf<Expr<'uint256[]'>>();
    expectTypeOf(a.at(0n)).toEqualTypeOf<Expr<'uint256'>>();
    return s.return({ all: a });
  });
});

test('#1 scalar / [many] fn returns are unchanged (regression pin)', () => {
  evscript({ name: 'fnscalar', args: [t.uint256] }, (s, x) => {
    const inc = s.fn('inc', [arg('a', t.uint256)] as const, (a) => a.add(1n));
    expectTypeOf(inc).toEqualTypeOf<EvsFn<readonly [ArgSpec<'a', 'uint256'>], Expr<'uint256'>>>();
    const pair = s.fn('pair', [arg('a', t.uint8)] as const, (a) => [a, a.eq(0n)] as const);
    expectTypeOf(pair(3n)).toEqualTypeOf<readonly [Expr<'uint8'>, Expr<'bool'>]>();
    return s.return({ x: inc(x) });
  });
});

test('#2 s.call({ struct: true }) returns ONE named Tuple over the outputs (opt-in)', () => {
  evscript({ name: 'structcall', args: [t.address] }, (s, pool) => {
    const slot0 = s.call({
      address: pool,
      abi: poolFixture,
      functionName: 'slot0',
      struct: true,
    });
    expectTypeOf(slot0.sqrtPriceX96.get()).toEqualTypeOf<Expr<'uint160'>>();
    expectTypeOf(slot0.tick.get()).toEqualTypeOf<Expr<'int24'>>();
    expectTypeOf(slot0.unlocked.get()).toEqualTypeOf<Expr<'bool'>>();

    // the DEFAULT (no struct) keeps the frozen positional `[many]` shape — unchanged.
    const positional = s.call({ address: pool, abi: poolFixture, functionName: 'slot0' });
    expectTypeOf(positional).toEqualTypeOf<
      readonly [Expr<'uint160'>, Expr<'int24'>, Expr<'bool'>]
    >();
    // a literal `struct: false` is also the positional shape.
    const falseStruct = s.call({
      address: pool,
      abi: poolFixture,
      functionName: 'slot0',
      struct: false,
    });
    expectTypeOf(falseStruct).toEqualTypeOf<
      readonly [Expr<'uint160'>, Expr<'int24'>, Expr<'bool'>]
    >();

    // a NON-LITERAL boolean `struct` is the UNION of both shapes — the runtime decides on the value
    // (`wantStruct = struct === true`), so the caller must NARROW. This is the soundness fix for the
    // literal-vs-boolean gap: neither a positional index nor a struct field works un-narrowed.
    const flag = (1 as number) > 0; // a non-literal boolean
    const maybe = s.call({ address: pool, abi: poolFixture, functionName: 'slot0', struct: flag });
    // @ts-expect-error — `maybe` may be a Tuple, so a positional index is not available un-narrowed.
    expectTypeOf(maybe[0]);
    // @ts-expect-error — `maybe` may be the positional array, so a struct field is not available.
    expectTypeOf(maybe.sqrtPriceX96);

    // tryCall + struct: true wraps the value, keeps success.
    const tried = s.tryCall({
      address: pool,
      abi: poolFixture,
      functionName: 'slot0',
      struct: true,
    });
    expectTypeOf(tried.success).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(tried.value.tick.get()).toEqualTypeOf<Expr<'int24'>>();
    return s.return({ tick: slot0.tick.get() });
  });
});

test('#3 a call-decoded Tuple flows into a hand-written t.struct slot (cross-order assignable)', () => {
  const Pos = t.struct({ liquidity: t.uint128, owner: t.address });
  evscript({ name: 'nest', args: [t.address, t.uint256] }, (s, mgr, id) => {
    const pos = s.call({
      address: mgr,
      abi: positionFixture,
      functionName: 'positions',
      args: [id],
    });
    // the decoded handle is a precise Tuple (named field reads are member-typed) …
    expectTypeOf(pos.liquidity.get()).toEqualTypeOf<Expr<'uint128'>>();
    // … and `pos` (a Tuple<C_abi>) is assignable into a member typed by the `t.struct` `Pos`
    // (C_struct) even though abitype-order and UnionToTuple-order may differ (runtime `typesEqual`
    // is the guard). The assignment below only typechecks because of the #3 loosening.
    const Outer = t.struct({ pos: Pos, tag: t.uint256 });
    const outer = s.tuple(Outer, { pos, tag: id });
    // and MutArray.set / IntoMember accept it too.
    const arr = s.newArray(Pos, id);
    arr.set(0n, pos);
    return s.return({ outer });
  });
});

test('#3/#5 call ARGS accept a bare MutArray (tuple[] input) and any Tuple (tuple input)', () => {
  const Pos = t.struct({ liquidity: t.uint128, owner: t.address });
  evscript({ name: 'callargs', args: [t.address, t.uint256] }, (s, addr, n) => {
    // a bare MutArray<tuple> is accepted for a `tuple[]` input (the AnyMutArray arm, #5).
    const arr = s.newArray(Pos, n);
    const r1 = s.call({
      address: addr,
      abi: consumerFixture,
      functionName: 'useStructs',
      args: [arr],
    });
    expectTypeOf(r1).toEqualTypeOf<Expr<'uint256'>>();
    // a built Tuple handle is accepted for a `tuple` input (the AnyTuple arm, #3 — cross-shape
    // assignability; the runtime `typesEqual` is the order/shape guard).
    const p = s.tuple(Pos, { liquidity: 1n, owner: addr });
    const r2 = s.call({
      address: addr,
      abi: consumerFixture,
      functionName: 'useStruct',
      args: [p],
    });
    expectTypeOf(r2).toEqualTypeOf<Expr<'uint256'>>();
    return s.return({ r1, r2 });
  });
});

test('#4 t.fromOutputs / t.fromAbiParameter derive a t.* type from an ABI', () => {
  // a single scalar output → its type string; a single tuple → the tuple type.
  expectTypeOf(t.fromOutputs(erc20Fixture, 'decimals')).toEqualTypeOf<'uint8'>();
  expectTypeOf(t.fromOutputs(erc20Fixture, 'symbol')).toEqualTypeOf<'string'>();
  expectTypeOf(
    t.fromAbiParameter({ name: 'x', type: 'uint256' } as const),
  ).toEqualTypeOf<'uint256'>();

  // a multi-named-output function → a struct usable wherever a t.* type is (and unifies with
  // `s.call({ struct: true })` of the SAME function — same ABI order).
  const Slot0 = t.fromOutputs(poolFixture, 'slot0');
  expectTypeOf<typeof Slot0>().toMatchTypeOf<TupleType>();
  evscript({ name: 'derive', args: [t.address] }, (s, pool) => {
    const slot0 = s.call({
      address: pool,
      abi: poolFixture,
      functionName: 'slot0',
      struct: true,
    });
    const Wrapped = t.struct({ slot0: Slot0, label: t.uint256 });
    const wrapped = s.tuple(Wrapped, { slot0, label: 1n });
    return s.return({ wrapped });
  });
});

test('#5 a bare MutArray is returnable; the script output infers the array shape', () => {
  const words = evscript({ name: 'words', args: [t.uint256] }, (s, n) => {
    const xs = s.newArray(t.uint256, n);
    return s.return({ xs }); // bare MutArray — no `.expr()`
  });
  expectTypeOf<ReadContractReturnType<typeof words.abi, 'words'>>().toEqualTypeOf<{
    xs: readonly bigint[];
  }>();

  const Item = t.struct({ a: t.uint256, b: t.bool });
  const items = evscript({ name: 'items', args: [t.uint256] }, (s, n) => {
    const metadata = s.newArray(Item, n);
    return s.return({ metadata }); // a bare tuple[] MutArray — the flagship shape
  });
  expectTypeOf<ReadContractReturnType<typeof items.abi, 'items'>>().toEqualTypeOf<{
    metadata: readonly { a: bigint; b: boolean }[];
  }>();
});
