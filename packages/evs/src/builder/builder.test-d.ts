/**
 * Builder type tests — positional arg handles spread into the body callback after `s`, `IntoExpr`
 * coercions at the builder surface, `s.call`/`s.tryCall` output inference (0/1/n unwrap,
 * mutability filtering, graceful widening) against viem-shaped const ABI fixtures, and
 * `ScriptReturn` inference through `evscript`. Runs under the vitest `types` project (typecheck
 * only — nothing executes).
 */
import type { Abi, ContractFunctionArgs, ReadContractReturnType } from 'viem';
import { expectTypeOf, test } from 'vite-plus/test';

import { namedArg, t, type ArgSpec, type Expr, type TupleType } from '../core/types.js';
import type { TUPLE_HANDLE_MEMBERS } from './expr/handles.js';
import {
  evscript,
  type ArgHandle,
  type Cell,
  type EvsFn,
  type EvsScript,
  type Field,
  type LoopCtl,
  type MutArray,
  type ScriptReturn,
  type SubcallFunctionName,
  type Tuple,
  type WideSubcallResult,
} from './script.js';
import type { TupleHandleMember } from './script/handles.js';

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

// composite-array OUTPUT fixtures (read path)
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
// issue #9 — namedArg: names surface in the ABI inputs + the shorthand extends to named args
// (NOTE: TS tuple/param LABELS are cosmetic — `toEqualTypeOf` cannot observe them, so the surfaced
// names are pinned through the type-level ABI input `name` field and at runtime via `script.abi`;
// the body/param handle TYPES are asserted here to prove naming never disturbs inference.)
// ---------------------------------------------------------------------------

test('namedArg in evscript args: handle types preserved; ABI inputs carry the user/fallback names', () => {
  const script = evscript(
    { name: 'named', args: [namedArg('token', t.address), t.uint24] },
    (s, token, fee) => {
      // body handles keep their element types (the label is cosmetic)
      expectTypeOf(token).toEqualTypeOf<Expr<'address'>>();
      expectTypeOf(fee).toEqualTypeOf<Expr<'uint24'>>();
      return s.return({ token });
    },
  );
  // a named arg surfaces its user name; a bare arg keeps the positional `arg{i}` fallback
  expectTypeOf(script.abi[0].inputs).toEqualTypeOf<
    readonly [
      { readonly name: 'token'; readonly type: 'address' },
      { readonly name: 'arg1'; readonly type: 'uint24' },
    ]
  >();
});

test('namedArg struct arg (issue #25): Tuple handle in the body; named tuple ABI input', () => {
  const MarketParams = t.struct({ loanToken: t.address, lltv: t.uint256 });
  const script = evscript(
    { name: 'position', args: [namedArg('marketParams', MarketParams)] },
    (s, marketParams) => {
      // the named composite arg arrives as a Tuple handle, exactly like a bare one
      expectTypeOf(marketParams).toEqualTypeOf<Tuple<typeof MarketParams>>();
      expectTypeOf(marketParams.loanToken.get()).toEqualTypeOf<Expr<'address'>>();
      return s.return({ loan: marketParams.loanToken.get() });
    },
  );
  // the ABI input carries the user name + the tuple components (viem labels derive from it)
  expectTypeOf(script.abi[0].inputs).toEqualTypeOf<
    readonly [
      {
        readonly name: 'marketParams';
        readonly type: 'tuple';
        readonly components: (typeof MarketParams)['components'];
      },
    ]
  >();
  // viem's inferred args tuple is the struct object
  expectTypeOf<ContractFunctionArgs<typeof script.abi>>().toEqualTypeOf<
    readonly [{ loanToken: `0x${string}`; lltv: bigint }]
  >();
});

test('single-arg shorthand extends to a lone namedArg', () => {
  const script = evscript(
    { name: 'loneNamed', args: namedArg('amount', t.uint256) },
    (s, amount) => {
      expectTypeOf(amount).toEqualTypeOf<Expr<'uint256'>>();
      return s.return({ amount });
    },
  );
  expectTypeOf(script.abi[0].inputs).toEqualTypeOf<
    readonly [{ readonly name: 'amount'; readonly type: 'uint256' }]
  >();
});

test('s.fn: a lone bare type and a lone namedArg are accepted (shorthand); params are Exprs', () => {
  evscript({ name: 'fns' }, (s) => {
    // bare-type shorthand (no array wrapper)
    const dbl = s.fn('dbl', t.uint256, (x) => {
      expectTypeOf(x).toEqualTypeOf<Expr<'uint256'>>();
      return x.add(x);
    });
    expectTypeOf(dbl).toEqualTypeOf<EvsFn<readonly [ArgSpec<'', 'uint256'>], Expr<'uint256'>>>();
    // lone namedArg shorthand
    const inc = s.fn('inc', namedArg('a', t.uint256), (a) => {
      expectTypeOf(a).toEqualTypeOf<Expr<'uint256'>>();
      return a.add(1n);
    });
    expectTypeOf(inc).toEqualTypeOf<EvsFn<readonly [ArgSpec<'a', 'uint256'>], Expr<'uint256'>>>();
    // mixed named/bare list
    const mix = s.fn('mix', [namedArg('a', t.uint256), t.uint8] as const, (a, b) => {
      expectTypeOf(a).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(b).toEqualTypeOf<Expr<'uint8'>>();
      return a;
    });
    expectTypeOf(mix).toEqualTypeOf<
      EvsFn<readonly [ArgSpec<'a', 'uint256'>, ArgSpec<'', 'uint8'>], Expr<'uint256'>>
    >();
    return s.return({ x: dbl(2n) });
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

test('this-parameter constraints: arithmetic on address is a type error; eq on memref is hash equality', () => {
  evscript({ name: 'thisParam', args: [t.address, t.array(t.uint256)] }, (s, who, arr) => {
    // @ts-expect-error — address is not numeric (this: Expr<t & NumericType> = never)
    who.add(1n);
    const str = s.read({ address: who, abi: erc20Fixture, functionName: 'symbol' });
    // memref equality (#38): same-typed Expr or literal rhs, free-function form included
    expectTypeOf(str.eq(str)).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(str.neq('WETH')).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(arr.eq([1n, 2n])).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(s.eq(str, 'WETH')).toEqualTypeOf<Expr<'bool'>>();
    // @ts-expect-error — operand types must match (string vs uint256[])
    str.eq(arr);
    // @ts-expect-error — a word never compares with a memref
    who.eq(str);
    // address equality IS a word comparison — fine:
    expectTypeOf(who.eq('0x0000000000000000000000000000000000000000')).toEqualTypeOf<
      Expr<'bool'>
    >();
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

test('pow / addmod / mulmod / signed shifts (issue #10)', () => {
  evscript(
    { name: 'mathOps', args: [t.uint256, t.int8, t.uint8, t.bytes4, t.int256] },
    (s, x, s8, u8, b4, i256) => {
      // pow: result type is the base's; the exponent is any unsigned Expr or a literal
      expectTypeOf(x.pow(3n)).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(s8.pow(u8)).toEqualTypeOf<Expr<'int8'>>();
      expectTypeOf(s8.pow(x)).toEqualTypeOf<Expr<'int8'>>();
      expectTypeOf(s.pow(u8, 2)).toEqualTypeOf<Expr<'uint8'>>();
      expectTypeOf(s.pow(s.lit(t.uint256, 10n), u8)).toEqualTypeOf<Expr<'uint256'>>();
      // @ts-expect-error — a signed exponent (solc rejects it too)
      x.pow(s8);
      // @ts-expect-error — pow needs a numeric base
      b4.pow(2n);
      // @ts-expect-error — the free-function base must be an Expr (its type is the result type)
      s.pow(2n, x);

      // addmod / mulmod: uint256 only, literals anywhere in the free-function form
      expectTypeOf(x.mulmod(x, 7n)).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(x.addmod(1n, x)).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(s.mulmod(2n, x, 3n)).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(s.addmod(x, x, x)).toEqualTypeOf<Expr<'uint256'>>();
      // @ts-expect-error — mulmod is uint256-only (this: Expr<'uint256'>)
      u8.mulmod(1n, 3n);
      // @ts-expect-error — a narrower modulus Expr is not a uint256
      x.addmod(1n, u8);
      // @ts-expect-error — nor a signed operand
      s.mulmod(x, s8, 3n);

      // shifts now take intN (SAR for shr), not only uintN/bytesN
      expectTypeOf(s8.shr(1n)).toEqualTypeOf<Expr<'int8'>>();
      expectTypeOf(s.shl(i256, x)).toEqualTypeOf<Expr<'int256'>>();
      expectTypeOf(b4.shl(8n)).toEqualTypeOf<Expr<'bytes4'>>();
      return s.return({ ok: s.lit(t.bool, true) });
    },
  );
});

test('wrapping add / sub / mul and mulDiv / mulDivRoundingUp', () => {
  evscript(
    { name: 'wrapOps', args: [t.uint256, t.int8, t.uint8, t.bytes4, t.bool] },
    (s, x, s8, u8, b4, flag) => {
      // wrapping ops: any numeric type, same typing as the checked add / sub / mul
      expectTypeOf(x.wrappingAdd(1n)).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(s8.wrappingSub(s8)).toEqualTypeOf<Expr<'int8'>>();
      expectTypeOf(u8.wrappingMul(3)).toEqualTypeOf<Expr<'uint8'>>();
      expectTypeOf(s.wrappingSub(0n, x)).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(s.wrappingAdd(s8, -1n)).toEqualTypeOf<Expr<'int8'>>();
      expectTypeOf(s.wrappingMul(u8, u8)).toEqualTypeOf<Expr<'uint8'>>();
      // @ts-expect-error — operand types must match (no implicit widening)
      x.wrappingAdd(u8);
      // @ts-expect-error — numeric only
      b4.wrappingAdd(b4);
      // @ts-expect-error — numeric only (free-function form)
      s.wrappingMul(flag, true);

      // mulDiv: uint256 only, literals anywhere in the free-function form
      expectTypeOf(x.mulDiv(x, 7n)).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(x.mulDivRoundingUp(1n << 96n, x)).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(s.mulDiv(2n, x, 3n)).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(s.mulDivRoundingUp(x, x, x)).toEqualTypeOf<Expr<'uint256'>>();
      // @ts-expect-error — mulDiv is uint256-only (this: Expr<'uint256'>)
      u8.mulDiv(1n, 3n);
      // @ts-expect-error — a narrower denominator Expr is not a uint256
      x.mulDivRoundingUp(1n, u8);
      // @ts-expect-error — nor a signed operand
      s.mulDiv(x, s8, 3n);
      return s.return({ ok: s.lit(t.bool, true) });
    },
  );
});

// ---------------------------------------------------------------------------
// s.call inference (viem patterns)
// ---------------------------------------------------------------------------

test('s.call unwraps outputs: [] → void, [one] → Expr, [many] → labeled tuple of Exprs', () => {
  evscript({ name: 'unwrap', args: [t.address] }, (s, pool) => {
    const sym = s.read({ address: pool, abi: erc20Fixture, functionName: 'symbol' });
    expectTypeOf(sym).toEqualTypeOf<Expr<'string'>>();

    const slot0 = s.read({ address: pool, abi: poolFixture, functionName: 'slot0' });
    expectTypeOf(slot0).toEqualTypeOf<readonly [Expr<'uint160'>, Expr<'int24'>, Expr<'bool'>]>();
    expectTypeOf(slot0[1]).toEqualTypeOf<Expr<'int24'>>();

    const nothing = s.read({ address: pool, abi: poolFixture, functionName: 'poke' });
    expectTypeOf(nothing).toBeVoid();

    return s.return({ sym, tick: slot0[1] });
  });
});

test('composite-array outputs: nested word arrays and string arrays index to typed Exprs', () => {
  evscript({ name: 'rdArrays', args: [t.address] }, (s, target) => {
    // uint256[][] → an array Expr; .at(i) peels one [] (Expr<'uint256[]'>), .at(i).at(j) → word.
    const m = s.read({ address: target, abi: arraysFixture, functionName: 'matrix' });
    expectTypeOf(m).toEqualTypeOf<Expr<'uint256[][]'>>();
    expectTypeOf(m.at(0n)).toEqualTypeOf<Expr<'uint256[]'>>();
    expectTypeOf(m.at(0n).at(0n)).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(m.length()).toEqualTypeOf<Expr<'uint256'>>();

    // string[] → an array Expr; .at(i) → Expr<'string'>, .at(i).length() → a word.
    const ns = s.read({ address: target, abi: arraysFixture, functionName: 'names' });
    expectTypeOf(ns).toEqualTypeOf<Expr<'string[]'>>();
    expectTypeOf(ns.at(1n)).toEqualTypeOf<Expr<'string'>>();
    expectTypeOf(ns.at(1n).length()).toEqualTypeOf<Expr<'uint256'>>();

    return s.return({ rows: m.length(), first: m.at(0n).at(0n), n2len: ns.at(2n).length() });
  });
});

test('args are per-parameter unions: abitype primitive OR Expr of that type', () => {
  evscript({ name: 'callArgs', args: [t.address, t.address] }, (s, token, user) => {
    const a = s.read({
      address: token,
      abi: erc20Fixture,
      functionName: 'balanceOf',
      args: [user], // Expr<'address'>
    });
    const b = s.read({
      address: token,
      abi: erc20Fixture,
      functionName: 'balanceOf',
      args: ['0x0000000000000000000000000000000000000001'], // literal primitive
    });
    expectTypeOf(a).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(b).toEqualTypeOf<Expr<'uint256'>>();

    s.read({
      address: token,
      abi: erc20Fixture,
      functionName: 'balanceOf',
      // @ts-expect-error — number is neither `0x…` nor Expr<'address'>
      args: [123],
    });
    s.read({
      address: token,
      abi: erc20Fixture,
      functionName: 'balanceOf',
      // @ts-expect-error — Expr of the wrong word type
      args: [s.lit(t.uint256, 1n)],
    });
    return s.return({ a, b });
  });
});

test('mutability is filtered per verb (issue #1): read=view/pure, call/simulate=nonpayable/payable', () => {
  evscript({ name: 'mut', args: [t.address] }, (s, token) => {
    // s.read / s.tryRead run under STATICCALL → only view/pure names typecheck.
    s.read({
      address: token,
      abi: erc20Fixture,
      // @ts-expect-error — 'transfer' is nonpayable, not in ContractFunctionName<…, 'pure'|'view'>
      functionName: 'transfer',
    });
    // s.call / s.tryCall / s.simulate / s.trySimulate run under CALL → only nonpayable/payable.
    s.call({
      address: token,
      abi: erc20Fixture,
      // @ts-expect-error — 'symbol' is view, not in ContractFunctionName<…, 'nonpayable'|'payable'>
      functionName: 'symbol',
    });
    s.simulate({
      address: token,
      abi: erc20Fixture,
      // @ts-expect-error — 'balanceOf' is view, not callable under s.simulate (CALL)
      functionName: 'balanceOf',
    });
    // 'transfer' (nonpayable) IS callable under s.call/s.simulate, returning its `bool` output
    const ok = s.call({
      address: token,
      abi: erc20Fixture,
      functionName: 'transfer',
      args: ['0x0000000000000000000000000000000000000001', 1n],
    });
    expectTypeOf(ok).toEqualTypeOf<Expr<'bool'>>();
    // the view/pure name union is exactly the s.read callable surface
    expectTypeOf<'symbol' | 'decimals' | 'balanceOf'>().toMatchTypeOf<
      Parameters<typeof s.read<typeof erc20Fixture, 'symbol'>>[0]['functionName']
    >();
    return s.return({ ok });
  });
});

test('a const ABI with no function in the bucket accepts no functionName', () => {
  const nonpayableOnly = [
    {
      type: 'function',
      name: 'quote',
      stateMutability: 'nonpayable',
      inputs: [{ name: 'a', type: 'uint256' }],
      outputs: [{ name: 'b', type: 'uint256' }],
    },
  ] as const;
  const viewOnly = [
    {
      type: 'function',
      name: 'get',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'uint256' }],
    },
  ] as const;
  // the empty name set is `never`, not viem's `string` fallback
  expectTypeOf<
    SubcallFunctionName<typeof nonpayableOnly, 'view' | 'pure'>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    SubcallFunctionName<typeof viewOnly, 'nonpayable' | 'payable'>
  >().toEqualTypeOf<never>();
  expectTypeOf<SubcallFunctionName<typeof viewOnly, 'view' | 'pure'>>().toEqualTypeOf<
    'get' | 'get()'
  >();
  // a widened ABI still accepts any name
  expectTypeOf<SubcallFunctionName<Abi, 'view' | 'pure'>>().toEqualTypeOf<string>();
  expectTypeOf<SubcallFunctionName<readonly unknown[], 'view' | 'pure'>>().toEqualTypeOf<string>();

  evscript({ name: 'bucket', args: [t.address] }, (s, target) => {
    s.read({
      address: target,
      abi: nonpayableOnly,
      // @ts-expect-error — 'quote' is nonpayable and the ABI has no view/pure function
      functionName: 'quote',
      args: [1n],
    });
    s.call({
      address: target,
      abi: viewOnly,
      // @ts-expect-error — 'get' is view and the ABI has no nonpayable/payable function
      functionName: 'get',
    });
    s.tryCall({
      address: target,
      abi: viewOnly,
      // @ts-expect-error — the same under the try verb
      functionName: 'get',
    });
    // the right verb still resolves the output
    const b = s.call({ address: target, abi: nonpayableOnly, functionName: 'quote', args: [1n] });
    expectTypeOf(b).toEqualTypeOf<Expr<'uint256'>>();
    return s.return({ b });
  });
});

test('tryCall: success Expr<bool> + the same unwrapped value shape', () => {
  evscript({ name: 'tryc', args: [t.address] }, (s, token) => {
    const d = s.tryRead({ address: token, abi: erc20Fixture, functionName: 'decimals' });
    expectTypeOf(d.success).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(d.value).toEqualTypeOf<Expr<'uint8'>>();
    const defaulted = s.select(d.success, d.value, 18);
    expectTypeOf(defaulted).toEqualTypeOf<Expr<'uint8'>>();
    return s.return({ decimals: defaulted });
  });
});

type WideResult = Expr | Tuple<TupleType> | readonly (Expr | Tuple<TupleType>)[] | undefined;

test('graceful widening: a non-const ABI degrades, never hard-errors', () => {
  const wideAbi: Abi = [];
  evscript({ name: 'wide', args: [t.address] }, (s, target) => {
    const res = s.read({
      address: target,
      abi: wideAbi,
      functionName: 'anythingGoes', // functionName: string
      args: [1n, 'two', false], // readonly unknown[]
    });
    // the output count is unknown, so the result is every shape the recorder can return:
    // nothing (undefined), one handle, or an array of handles for several outputs
    expectTypeOf(res).toEqualTypeOf<WideResult>();
    const tre = s.tryRead({ address: target, abi: wideAbi, functionName: 'x' });
    expectTypeOf(tre.success).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(tre.value).toEqualTypeOf<WideResult>();
    expectTypeOf(
      s.call({ address: target, abi: wideAbi, functionName: 'quote' }),
    ).toEqualTypeOf<WideResult>();
    // struct: true always builds one Tuple
    expectTypeOf(
      s.read({ address: target, abi: wideAbi, functionName: 'slot0', struct: true }),
    ).toEqualTypeOf<Tuple<TupleType>>();
    // the same for an ABI declared without `as const` (literal names widen to string)
    const inlineAbi = [
      {
        type: 'function',
        name: 'decimals',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint8' }],
      },
    ];
    const dec = s.read({ address: target, abi: inlineAbi, functionName: 'decimals' });
    expectTypeOf(dec).toEqualTypeOf<WideResult>();
    // not an array until narrowed: a lone output is a bare handle at run time
    expectTypeOf(dec).not.toMatchTypeOf<readonly unknown[]>();
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

/* oxlint-disable typescript/no-unsafe-type-assertion -- the narrowing casts are the documented
 * migration for a widened-ABI result under test here */
test('WideSubcallResult is the exported widened result, narrowed by a cast', () => {
  expectTypeOf<WideSubcallResult>().toEqualTypeOf<WideResult>();
  const wideAbi: Abi = [];
  evscript({ name: 'wideCast', args: [t.address] }, (s, target) => {
    const slot0 = s.read({ address: target, abi: wideAbi, functionName: 'slot0' });
    // @ts-expect-error — not iterable until narrowed (it may be one handle or undefined)
    const [bad] = slot0;
    void bad;
    // the documented migration: cast to the outputs the function has, then destructure
    const [price, tick] = slot0 as readonly [Expr<'uint160'>, Expr<'int24'>, Expr<'bool'>];
    expectTypeOf(price).toEqualTypeOf<Expr<'uint160'>>();
    expectTypeOf(tick).toEqualTypeOf<Expr<'int24'>>();

    const dec = s.read({ address: target, abi: wideAbi, functionName: 'decimals' });
    // @ts-expect-error — a bare Expr is not numeric: toUint needs a numeric receiver
    (dec as Expr).toUint(t.uint256);
    // the documented migration: cast to the concrete output type
    expectTypeOf((dec as Expr<'uint8'>).toUint(t.uint256)).toEqualTypeOf<Expr<'uint256'>>();
    return s.return({ price, tick });
  });
});
/* oxlint-enable typescript/no-unsafe-type-assertion */

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

    // issue #12: `type` omitted → the counter defaults to uint256
    s.for({ from: 0n, until: n }, (i, loop) => {
      expectTypeOf(i).toEqualTypeOf<Expr<'uint256'>>();
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

test('composite s.let / s.lit: typed cells and literals of struct, tuple and tuple[] types', () => {
  const P = t.struct({ a: t.uint256, b: t.address });
  const ONE = '0x0000000000000000000000000000000000000001';
  const script = evscript({ name: 'composites', args: [t.uint256] }, (s, x) => {
    const cell = s.let(P, { a: 1n, b: ONE });
    expectTypeOf(cell).toEqualTypeOf<Cell<typeof P>>();
    expectTypeOf(cell.get()).toEqualTypeOf<Expr<typeof P>>();
    cell.set(s.tuple(P, { a: x }).expr());
    const list = s.let(t.array(P), [{ a: 2n, b: ONE }]);
    expectTypeOf(list.get().at(0n).a.get()).toEqualTypeOf<Expr<'uint256'>>();
    const pair = s.lit(t.tuple(t.uint256, t.bool), [1n, true]);
    // @ts-expect-error — a struct literal member of the wrong kind
    s.let(P, { a: 'one' });
    // @ts-expect-error — a plain tuple has no length
    pair.length();
    return s.return({ p: cell.get(), list: list.get(), pair });
  });
  type Out = ReadContractReturnType<typeof script.abi, 'composites'>;
  expectTypeOf<Out['p']>().toEqualTypeOf<{ a: bigint; b: `0x${string}` }>();
  expectTypeOf<Out['list']>().toEqualTypeOf<readonly { a: bigint; b: `0x${string}` }[]>();
  expectTypeOf<Out['pair']>().toEqualTypeOf<readonly [bigint, boolean]>();
});

test('account reads: address operand, uint256 balance / code size, bytes32 code hash', () => {
  const script = evscript({ name: 'acct', args: [t.address, t.uint256] }, (s, who, n) => {
    expectTypeOf(s.balance(who)).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(s.codeSize(who)).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(s.codeHash(who)).toEqualTypeOf<Expr<'bytes32'>>();
    // an address literal or the script's own address are operands too
    expectTypeOf(s.balance(s.env('address'))).toEqualTypeOf<Expr<'uint256'>>();
    s.codeSize('0x000000000000000000000000000000000000dEaD');
    // @ts-expect-error — the operand must be an address
    s.balance(n);
    // @ts-expect-error — not an address-typed handle either
    s.codeHash(s.env('chainid'));
    return s.return({ bal: s.balance(who), size: s.codeSize(who), hash: s.codeHash(who) });
  });
  expectTypeOf<ReadContractReturnType<typeof script.abi, 'acct'>>().toEqualTypeOf<{
    bal: bigint;
    size: bigint;
    hash: `0x${string}`;
  }>();
});

test('s.forEach: element/index/loop typing over word, nested, and tuple[] arrays (issue #12)', () => {
  const Pair = t.struct({ token: t.address, fee: t.uint24 });
  evscript(
    {
      name: 'each',
      args: [
        t.array(t.address),
        t.array(t.array(t.uint256)),
        t.array(Pair),
        t.array(t.array(Pair)),
      ],
    },
    (s, addrs, matrix, pairs, nestedPairs) => {
      s.forEach(addrs, (elem, i, loop) => {
        expectTypeOf(elem).toEqualTypeOf<Expr<'address'>>();
        expectTypeOf(i).toEqualTypeOf<Expr<'uint256'>>();
        expectTypeOf(loop).toEqualTypeOf<LoopCtl>();
      });

      // a nested word array yields the one-level-peeled element
      s.forEach(matrix, (row) => {
        expectTypeOf(row).toEqualTypeOf<Expr<'uint256[]'>>();
      });

      // a tuple[] array hands the body a Tuple element with named Fields
      s.forEach(pairs, (pair, i) => {
        expectTypeOf(pair.token.get()).toEqualTypeOf<Expr<'address'>>();
        expectTypeOf(pair.fee.get()).toEqualTypeOf<Expr<'uint24'>>();
        expectTypeOf(pair.expr()).toEqualTypeOf<Expr<typeof Pair>>();
        expectTypeOf(i).toEqualTypeOf<Expr<'uint256'>>();
      });

      // a tuple[][] array hands the body an Expr<tuple[]> element — NOT a named-field Tuple
      // (runtime parity, issue #12 follow-up); the row's own .at/.length keep working.
      s.forEach(nestedPairs, (row, i) => {
        expectTypeOf(row.length()).toEqualTypeOf<Expr<'uint256'>>();
        expectTypeOf(row.at(0n).token.get()).toEqualTypeOf<Expr<'address'>>();
        expectTypeOf(row).not.toHaveProperty('token'); // an Expr, not a Tuple: no named fields
        expectTypeOf(i).toEqualTypeOf<Expr<'uint256'>>();
      });

      const n = s.lit(t.uint256, 1n);
      // @ts-expect-error — a non-array Expr is not iterable
      s.forEach(n, () => {});
      // @ts-expect-error — a bare MutArray is not accepted; iterate via .expr()
      s.forEach(s.newArray(t.uint256, 3n), () => {});

      const pos = s.tuple(Pair);
      // @ts-expect-error — a plain tuple memref is not an array (record-time rejection mirrored)
      s.forEach(pos.expr(), () => {});
      // @ts-expect-error — .at on a plain-tuple Expr is a compile error too (issue #12 follow-up)
      pos.expr().at(0n);

      return s.return({ n });
    },
  );
});

test('a tuple[] STRUCT MEMBER .get() is an Expr, not a Tuple (issue #12 post-review)', () => {
  const Item = t.struct({ x: t.uint256 });
  const Book = t.struct({
    owner: t.address,
    meta: t.struct({ tag: t.uint8 }),
    items: t.array(Item),
  });
  evscript({ name: 'book', args: [Book] }, (s, book) => {
    // runtime `fieldGet` → `valueHandle` parity: the composite-ARRAY member arrives as an Expr
    // (no named fields), so `.length()`/`.at()`/`s.forEach` work on it directly
    const items = book.items.get();
    expectTypeOf(items).not.toHaveProperty('x');
    expectTypeOf(items.length()).toEqualTypeOf<Expr<'uint256'>>();
    s.forEach(items, (item, i) => {
      expectTypeOf(item.x.get()).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(i).toEqualTypeOf<Expr<'uint256'>>();
    });
    // a nested PLAIN-tuple member still hands back a named-field Tuple; a scalar an Expr
    expectTypeOf(book.meta.get().tag.get()).toEqualTypeOf<Expr<'uint8'>>();
    expectTypeOf(book.owner.get()).toEqualTypeOf<Expr<'address'>>();
    return s.return({ n: s.lit(t.uint256, 1n) });
  });
});

test('ArgHandle over a NON-literal TupleType tag is the honest union (issue #12 post-review)', () => {
  // a constraint-widened tag ('tuple' | 'tuple[]' | 'tuple[][]') has no single runtime answer —
  // generic consumers of the exported ArgHandle get Tuple | Expr instead of a silent wrong pick
  expectTypeOf<ArgHandle<TupleType>>().toEqualTypeOf<Tuple<TupleType> | Expr<TupleType>>();
  // literal tags stay precise
  expectTypeOf<ArgHandle<'uint256'>>().toEqualTypeOf<Expr<'uint256'>>();
});

// ---------------------------------------------------------------------------
// s.fn typing
// ---------------------------------------------------------------------------

test('EvsFn: params map to IntoExpr, results are rebuilt fresh Exprs', () => {
  evscript({ name: 'fns', args: [t.uint256] }, (s, x) => {
    const inc = s.fn('inc', [namedArg('a', t.uint256)] as const, (a) => {
      expectTypeOf(a).toEqualTypeOf<Expr<'uint256'>>();
      return a.add(1n);
    });
    expectTypeOf(inc).toEqualTypeOf<EvsFn<readonly [ArgSpec<'a', 'uint256'>], Expr<'uint256'>>>();
    expectTypeOf(inc(1n)).toEqualTypeOf<Expr<'uint256'>>(); // literal coerces
    expectTypeOf(inc(x)).toEqualTypeOf<Expr<'uint256'>>();
    // @ts-expect-error — wrong literal shape for uint256
    inc('0x00');

    const pair = s.fn('pair', [namedArg('a', t.uint8)] as const, (a) => [a, a.eq(0n)] as const);
    expectTypeOf(pair(3n)).toEqualTypeOf<readonly [Expr<'uint8'>, Expr<'bool'>]>();

    const noop = s.fn('noop', [] as const, () => {});
    expectTypeOf(noop()).toBeVoid();

    return s.return({ x });
  });
});

test('EvsFn: a t.struct / t.tuple param is a Tuple handle in the body (ArgHandle parity, #37)', () => {
  const Pair = t.struct({ token: t.address, fee: t.uint24 });
  const Pos = t.tuple(t.uint256, t.uint256);
  const Outer = t.struct({ inner: Pair, name: t.string, ids: t.array(t.uint256) });
  const Pairs = t.array(Pair);
  evscript({ name: 'fnstructparam', args: [Pair, Outer, Pairs] }, (s, pair, outer, pairs) => {
    // a named struct param → a Tuple handle with member-typed fields, exactly like the script arg.
    const feeOf = s.fn('feeOf', [namedArg('p', Pair)] as const, (p) => {
      expectTypeOf(p).toEqualTypeOf<Tuple<typeof Pair>>();
      expectTypeOf(p).toEqualTypeOf<ArgHandle<typeof Pair>>();
      expectTypeOf(p.fee.get()).toEqualTypeOf<Expr<'uint24'>>();
      return p.fee.get();
    });
    expectTypeOf(feeOf).toEqualTypeOf<
      EvsFn<readonly [ArgSpec<'p', typeof Pair>], Expr<'uint24'>>
    >();
    // the call site accepts the Tuple handle (script arg / s.tuple) and a literal object.
    expectTypeOf(feeOf(pair)).toEqualTypeOf<Expr<'uint24'>>();
    expectTypeOf(feeOf(s.tuple(Pair, { fee: 3000n }))).toEqualTypeOf<Expr<'uint24'>>();
    expectTypeOf(
      feeOf({ token: '0x0000000000000000000000000000000000000001', fee: 500 }),
    ).toEqualTypeOf<Expr<'uint24'>>();
    // @ts-expect-error — a word is not a struct
    feeOf(1n);
    // @ts-expect-error — an Expr of another type is not a struct
    feeOf(s.lit(t.uint256, 1n));

    // a bare (positional) t.tuple param → a positional Tuple handle
    const first = s.fn('first', Pos, (pos) => {
      expectTypeOf(pos).toEqualTypeOf<Tuple<typeof Pos>>();
      return pos.at(0).get(); // positional members read through `.at(i)` (a Field over the member union)
    });
    expectTypeOf(first).toEqualTypeOf<EvsFn<readonly [ArgSpec<'', typeof Pos>], Expr<'uint256'>>>();
    expectTypeOf(first([1n, 2n])).toEqualTypeOf<Expr<'uint256'>>();

    // nested composite + dynamic members: the same Field dispatch as a script arg.
    const nested = s.fn('nested', Outer, (o) => {
      expectTypeOf(o).toEqualTypeOf<Tuple<typeof Outer>>();
      expectTypeOf(o.inner.get()).toEqualTypeOf<Tuple<typeof Pair>>();
      expectTypeOf(o.name.get()).toEqualTypeOf<Expr<'string'>>();
      expectTypeOf(o.ids.get()).toEqualTypeOf<Expr<'uint256[]'>>();
      return o.inner.get().fee.get();
    });
    expectTypeOf(nested(outer)).toEqualTypeOf<Expr<'uint24'>>();

    // a composite ARRAY param stays an Expr (the runtime handle), mixing with scalar params.
    const count = s.fn('count', [namedArg('ps', Pairs), t.uint8] as const, (ps, n) => {
      expectTypeOf(ps).toEqualTypeOf<Expr<typeof Pairs>>();
      expectTypeOf(ps).toEqualTypeOf<ArgHandle<typeof Pairs>>();
      expectTypeOf(ps.at(0n)).toEqualTypeOf<Tuple<typeof Pair>>();
      expectTypeOf(n).toEqualTypeOf<Expr<'uint8'>>();
      return ps.length();
    });
    expectTypeOf(count(pairs, 1n)).toEqualTypeOf<Expr<'uint256'>>();

    // a struct fn RESULT round-trips through a struct fn PARAM (Tuple in, Tuple out).
    const echo = s.fn('echo', Pair, (p) => p);
    expectTypeOf(echo(pair)).toEqualTypeOf<Tuple<typeof Pair>>();
    expectTypeOf(feeOf(echo(pair))).toEqualTypeOf<Expr<'uint24'>>();

    return s.return({ fee: feeOf(pair) });
  });
});

// ---------------------------------------------------------------------------
// ScriptReturn inference through evscript → literal-typed artifact
// ---------------------------------------------------------------------------

test('ScriptReturn flows through evscript into EvsScript / ScriptAbi / viem return types', () => {
  const script = evscript({ name: 'meta', args: [t.address, t.address] }, (s, pool, user) => {
    const symbol = s.read({ address: pool, abi: erc20Fixture, functionName: 'symbol' });
    const bal = s.read({
      address: pool,
      abi: erc20Fixture,
      functionName: 'balanceOf',
      args: [user],
    });
    const slot0 = s.read({ address: pool, abi: poolFixture, functionName: 'slot0' });
    return s.return({ symbol, bal, tick: slot0[1] });
  });

  expectTypeOf(script).toMatchTypeOf<
    EvsScript<
      'meta',
      readonly [ArgSpec<'', 'address'>, ArgSpec<'', 'address'>],
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

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
/** 60 return keys: `k00`…`k59`. */
type WideKey = `k${'0' | '1' | '2' | '3' | '4' | '5'}${Digit}`;
/** A return record repeating one handle under every {@link WideKey} (typecheck only). */
declare function wideRecord<h>(handle: h): { [k in WideKey]: h };

test('a script with 60 return keys keeps an exact readContract result', () => {
  // past ~45 keys the return-record ordering used to exceed the instantiation depth under
  // evscript → ScriptAbi → viem, typing the readContract result `unknown`
  const script = evscript({ name: 'wide', args: [t.uint256] }, (s, x) => s.return(wideRecord(x)));
  expectTypeOf(script.abi[0].outputs[0].components.length).toEqualTypeOf<60>();
  expectTypeOf<
    ReadContractReturnType<typeof script.abi, 'wide', readonly [bigint]>
  >().toEqualTypeOf<{ [k in WideKey]: bigint }>();
});

test('abitype infers composite-array outputs: tuple[] → readonly Struct[], uint256[][], string[]', () => {
  // The callee ABI's composite-array outputs infer the shapes evs decodes into: a
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

test('returning a whole composite array infers an abitype-typed script output', () => {
  // s.return of a decoded composite array widens the script's own ScriptAbi output so a viem read
  // of the compiled script infers the precise shape: `tuple[]` → `readonly Struct[]`, `uint256[][]`
  // → `readonly (readonly bigint[])[]`, `string[]` → `readonly string[]`.
  const script = evscript({ name: 'arrs', args: [t.uint256] }, (s, n) => {
    const ps = s.read({
      address: '0x0000000000000000000000000000000000000001',
      abi: arraysFixture,
      functionName: 'positionsBatch',
      args: [n],
    });
    const m = s.read({
      address: '0x0000000000000000000000000000000000000001',
      abi: arraysFixture,
      functionName: 'matrix',
    });
    const ns = s.read({
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

test('s.return rejects an empty record at the type level (issue #66)', () => {
  evscript({ name: 'guard', args: [t.uint256] }, (s) =>
    // @ts-expect-error — an empty return record ABI-encodes to 0x ("returned no data" in viem)
    s.return({}),
  );
  // a guard-only script returns a flag instead; inference is unaffected by the guard
  evscript({ name: 'guard', args: [t.uint256] }, (s) => {
    const token = s.return({ ok: s.lit(t.bool, true) });
    expectTypeOf(token).toEqualTypeOf<ScriptReturn<{ readonly ok: Expr<'bool'> }>>();
    return token;
  });
});

test('s.return takes handles only: composite literals go through s.lit or a member slot', () => {
  const P = t.struct({ a: t.uint256 });
  evscript({ name: 'bad', args: [] }, (s) =>
    // @ts-expect-error — a tuple[] literal: s.return has no type to coerce it against
    s.return({ ps: [{ a: 1n }] }),
  );
  evscript({ name: 'bad', args: [] }, (s) =>
    // @ts-expect-error — a uint256[][] literal: type it with s.lit first
    s.return({ m: [[1n, 2n], [3n]] }),
  );
  const ok = evscript({ name: 'ok', args: [] }, (s) => {
    const m = s.lit(t.array(t.array(t.uint256)), [[1n, 2n], [3n]]);
    const holder = s.tuple(t.struct({ ps: t.array(P) }), { ps: [{ a: 1n }, { a: 2n }] });
    return s.return({ m, ps: holder.ps.get() });
  });
  expectTypeOf<ReadContractReturnType<typeof ok.abi, 'ok'>>().toEqualTypeOf<{
    m: readonly (readonly bigint[])[];
    ps: readonly { a: bigint }[];
  }>();
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
    const getMeta = s.fn('getMeta', [namedArg('tok', t.address)] as const, (tok) =>
      s.tuple(Meta, {
        symbol: s.read({ address: tok, abi: erc20Fixture, functionName: 'symbol' }),
        decimals: s.read({ address: tok, abi: erc20Fixture, functionName: 'decimals' }),
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
    const build = s.fn('build', [namedArg('len', t.uint256)] as const, (len) =>
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
    const inc = s.fn('inc', [namedArg('a', t.uint256)] as const, (a) => a.add(1n));
    expectTypeOf(inc).toEqualTypeOf<EvsFn<readonly [ArgSpec<'a', 'uint256'>], Expr<'uint256'>>>();
    const pair = s.fn('pair', [namedArg('a', t.uint8)] as const, (a) => [a, a.eq(0n)] as const);
    expectTypeOf(pair(3n)).toEqualTypeOf<readonly [Expr<'uint8'>, Expr<'bool'>]>();
    return s.return({ x: inc(x) });
  });
});

test('#2 s.read({ struct: true }) returns ONE named Tuple over the outputs (opt-in)', () => {
  evscript({ name: 'structcall', args: [t.address] }, (s, pool) => {
    const slot0 = s.read({
      address: pool,
      abi: poolFixture,
      functionName: 'slot0',
      struct: true,
    });
    expectTypeOf(slot0.sqrtPriceX96.get()).toEqualTypeOf<Expr<'uint160'>>();
    expectTypeOf(slot0.tick.get()).toEqualTypeOf<Expr<'int24'>>();
    expectTypeOf(slot0.unlocked.get()).toEqualTypeOf<Expr<'bool'>>();

    // the DEFAULT (no struct) keeps the positional `[many]` shape — unchanged.
    const positional = s.read({ address: pool, abi: poolFixture, functionName: 'slot0' });
    expectTypeOf(positional).toEqualTypeOf<
      readonly [Expr<'uint160'>, Expr<'int24'>, Expr<'bool'>]
    >();
    // a literal `struct: false` is also the positional shape.
    const falseStruct = s.read({
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
    const flag = Math.random() > 0.5; // a non-literal boolean (not a constant expression)
    const maybe = s.read({ address: pool, abi: poolFixture, functionName: 'slot0', struct: flag });
    // @ts-expect-error — `maybe` may be a Tuple, so a positional index is not available un-narrowed.
    expectTypeOf(maybe[0]);
    // @ts-expect-error — `maybe` may be the positional array, so a struct field is not available.
    expectTypeOf(maybe.sqrtPriceX96);

    // tryCall + struct: true wraps the value, keeps success.
    const tried = s.tryRead({
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
    const pos = s.read({
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
    const r1 = s.read({
      address: addr,
      abi: consumerFixture,
      functionName: 'useStructs',
      args: [arr],
    });
    expectTypeOf(r1).toEqualTypeOf<Expr<'uint256'>>();
    // a built Tuple handle is accepted for a `tuple` input (the AnyTuple arm, #3 — cross-shape
    // assignability; the runtime `typesEqual` is the order/shape guard).
    const p = s.tuple(Pos, { liquidity: 1n, owner: addr });
    const r2 = s.read({
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
  // `s.read({ struct: true })` of the SAME function — same ABI order).
  const Slot0 = t.fromOutputs(poolFixture, 'slot0');
  expectTypeOf<typeof Slot0>().toMatchTypeOf<TupleType>();
  evscript({ name: 'derive', args: [t.address] }, (s, pool) => {
    const slot0 = s.read({
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

// ---------------------------------------------------------------------------
// issue #17 — s.encode / s.encodePacked / s.keccak256
// ---------------------------------------------------------------------------

test('#17 encode/encodePacked/keccak256 result types and value bounds', () => {
  evscript({ name: 'enc17', args: [t.uint256, t.string, t.array(t.uint8)] }, (s, x, str, arr) => {
    const Pair = t.struct({ token: t.address, fee: t.uint24 });
    const pair = s.tuple(Pair, { fee: 500n });
    const words = s.newArray(t.uint256, 2n);

    // results are typed bytes / bytes32 Exprs
    expectTypeOf(s.encode(x, str, arr, pair, words)).toEqualTypeOf<Expr<'bytes'>>();
    expectTypeOf(s.encodePacked(x, str, arr)).toEqualTypeOf<Expr<'bytes'>>();
    expectTypeOf(s.keccak256(x, str)).toEqualTypeOf<Expr<'bytes32'>>();
    // s.keccak256 takes EncodeValue (#24): Tuple handles (structs) are accepted directly
    expectTypeOf(s.keccak256(pair)).toEqualTypeOf<Expr<'bytes32'>>();
    expectTypeOf(s.keccak256(x, pair, words)).toEqualTypeOf<Expr<'bytes32'>>();
    // a single bytes-typed value hashes directly; the explicit compositions typecheck too
    expectTypeOf(s.keccak256(s.encode(x, pair))).toEqualTypeOf<Expr<'bytes32'>>();
    expectTypeOf(s.keccak256(s.encodePacked(x, str))).toEqualTypeOf<Expr<'bytes32'>>();
    // the bytes32 hash chains into the existing word ops
    expectTypeOf(s.keccak256(str).asUint256()).toEqualTypeOf<Expr<'uint256'>>();

    // at least one value is required
    // @ts-expect-error — zero values
    s.encode();
    // @ts-expect-error — zero values
    s.keccak256();
    // raw literals are not staged values (lift with s.lit)
    // @ts-expect-error — bare string literal
    s.keccak256('transfer(address,uint256)');
    // @ts-expect-error — bare bigint literal
    s.encode(1n);
    // packed mode rejects Tuple handles at the type level (s.encode accepts them)
    // @ts-expect-error — a Tuple is not a PackedValue
    s.encodePacked(pair);

    return s.return({ h: s.keccak256(x) });
  });
});

// ---------------------------------------------------------------------------
// custom errors — s.throw typing (issue #15)
// ---------------------------------------------------------------------------

const NoBalanceT = t.error('NoBalance', [
  namedArg('balance', t.uint256),
  namedArg('who', t.address),
]);
const NotOwnerT = t.error('NotOwner');
const BadPairT = t.error('BadPair', [t.address, t.uint256]);
const UndeclaredT = t.error('Undeclared', [t.uint256]);

test('s.throw accepts declared errors with their exact args shapes', () => {
  evscript(
    { name: 'errs', args: [t.uint256, t.address], errors: [NoBalanceT, NotOwnerT, BadPairT] },
    (s, x, who) => {
      s.throw(NoBalanceT, { balance: x, who }); // named record — all params named
      s.throw(NoBalanceT, { balance: 5n, who: '0x0000000000000000000000000000000000000001' }); // literals coerce
      s.throw(NotOwnerT); // zero-param — no args
      s.throw(BadPairT, [who, x]); // positional tuple — bare params
      expectTypeOf(s.throw(NotOwnerT)).toBeVoid();
      return s.return({ x });
    },
  );
});

test('s.throw rejects undeclared errors and malformed args', () => {
  evscript(
    { name: 'errsBad', args: [t.uint256, t.address], errors: [NoBalanceT, NotOwnerT] },
    (s, x, who) => {
      // @ts-expect-error — Undeclared is not in the def's errors list
      s.throw(UndeclaredT, [x]);
      // @ts-expect-error — missing required member `who`
      s.throw(NoBalanceT, { balance: x });
      // @ts-expect-error — wrong member type (address expected)
      s.throw(NoBalanceT, { balance: x, who: x });
      // @ts-expect-error — a zero-param error takes no args
      s.throw(NotOwnerT, {});
      // @ts-expect-error — a named-params error takes a record, not a tuple
      s.throw(NoBalanceT, [x, who]);
      expectTypeOf(s).not.toBeNever();
      return s.return({ x });
    },
  );
});

test('a zero-errors script rejects every throw', () => {
  evscript({ name: 'noErrs', args: [t.uint256] }, (s, x) => {
    // @ts-expect-error — errs is readonly [], so errs[number] is never
    s.throw(NotOwnerT);
    expectTypeOf(s).not.toBeNever();
    return s.return({ x });
  });
});

test('the declared errors surface on the script value', () => {
  const script = evscript({ name: 'carry', args: [t.uint256], errors: [NoBalanceT] }, (s, x) =>
    s.return({ x }),
  );
  expectTypeOf(script.errors).toEqualTypeOf<readonly [typeof NoBalanceT]>();
  expectTypeOf(script.errors[0].name).toEqualTypeOf<'NoBalance'>();
});

// ---------------------------------------------------------------------------
// revertReturns (issue #35) — s.call / s.tryCall decode the REVERT payload as the result
// ---------------------------------------------------------------------------

const quoterV1Fixture = [
  {
    type: 'function',
    name: 'quoteExactInput',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amountIn', type: 'uint256' }],
    outputs: [], // QuoterV1 declares none — the amount arrives in the revert data
  },
  {
    type: 'function',
    name: 'quoteWithOutputs',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'ignored', type: 'bool' }], // ignored when revertReturns is set
  },
] as const satisfies Abi;

test('revertReturns types the result from the declared list, not the ABI outputs', () => {
  evscript({ name: 'rr', args: [t.address, t.uint256] }, (s, quoter, amountIn) => {
    // [one] → the handle of that type (an ABI with NO outputs still yields a value)
    const amountOut = s.call({
      address: quoter,
      abi: quoterV1Fixture,
      functionName: 'quoteExactInput',
      args: [amountIn],
      revertReturns: [t.uint256],
    });
    expectTypeOf(amountOut).toEqualTypeOf<Expr<'uint256'>>();

    // [many] → a readonly tuple of handles; a t.struct entry → a Tuple handle
    const Quote = t.struct({ amount: t.uint256, ok: t.bool });
    const many = s.call({
      address: quoter,
      abi: quoterV1Fixture,
      functionName: 'quoteWithOutputs',
      revertReturns: [t.uint256, t.string, Quote],
    });
    expectTypeOf(many).toEqualTypeOf<
      readonly [Expr<'uint256'>, Expr<'string'>, Tuple<typeof Quote>]
    >();
    expectTypeOf(many[2].amount.get()).toEqualTypeOf<Expr<'uint256'>>();

    // [] → void (the call must revert; nothing is decoded)
    const none = s.call({
      address: quoter,
      abi: quoterV1Fixture,
      functionName: 'quoteExactInput',
      args: [amountIn],
      revertReturns: [],
    });
    expectTypeOf(none).toBeVoid();

    // without revertReturns the ABI outputs still drive the shape (the base overloads)
    const plain = s.call({
      address: quoter,
      abi: quoterV1Fixture,
      functionName: 'quoteWithOutputs',
    });
    expectTypeOf(plain).toEqualTypeOf<Expr<'bool'>>();

    return s.return({ amountOut, first: many[0] });
  });
});

test('tryCall + revertReturns: success Expr<bool> + the revertReturns-typed value', () => {
  evscript({ name: 'rrTry', args: [t.address, t.uint256] }, (s, quoter, amountIn) => {
    const r = s.tryCall({
      address: quoter,
      abi: quoterV1Fixture,
      functionName: 'quoteExactInput',
      args: [amountIn],
      revertReturns: [t.uint256],
    });
    expectTypeOf(r.success).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(r.value).toEqualTypeOf<Expr<'uint256'>>();
    const picked = s.select(r.success, r.value, 0n);
    expectTypeOf(picked).toEqualTypeOf<Expr<'uint256'>>();
    return s.return({ ok: r.success, amountOut: picked });
  });
});

test('revertReturns is rejected on s.read / s.tryRead / s.simulate / s.trySimulate and with struct: true', () => {
  evscript({ name: 'rrNo', args: [t.address] }, (s, target) => {
    expectTypeOf(target).toEqualTypeOf<Expr<'address'>>();
    s.read({
      address: target,
      abi: erc20Fixture,
      functionName: 'decimals',
      // @ts-expect-error — revertReturns is an s.call / s.tryCall option only
      revertReturns: [t.uint256],
    });
    s.tryRead({
      address: target,
      abi: erc20Fixture,
      functionName: 'decimals',
      // @ts-expect-error — revertReturns is an s.call / s.tryCall option only
      revertReturns: [t.uint256],
    });
    s.simulate({
      address: target,
      abi: quoterV1Fixture,
      functionName: 'quoteWithOutputs',
      // @ts-expect-error — the simulate trampoline frames the target revert itself
      revertReturns: [t.uint256],
    });
    s.trySimulate({
      address: target,
      abi: quoterV1Fixture,
      functionName: 'quoteWithOutputs',
      // @ts-expect-error — the simulate trampoline frames the target revert itself
      revertReturns: [t.uint256],
    });
    s.call({
      address: target,
      abi: quoterV1Fixture,
      functionName: 'quoteWithOutputs',
      struct: true,
      // @ts-expect-error — struct: true cannot be combined with revertReturns
      revertReturns: [t.uint256],
    });
    return s.return({ x: s.lit(t.bool, true) });
  });
});

// ---------------------------------------------------------------------------
// issue #4: fixed-size arrays, tuple[][], deeper nesting
// ---------------------------------------------------------------------------

test('#4 t.array(elem, N) builds fixed-size types; ArrayElemOf/LitOf peel and pin the length', () => {
  const P = t.struct({ a: t.uint256, b: t.address });
  expectTypeOf(t.array(t.uint256, 2)).toEqualTypeOf<'uint256[2]'>();
  expectTypeOf(t.array(t.array(t.uint256, 2))).toEqualTypeOf<'uint256[2][]'>();
  expectTypeOf(t.array(t.array(t.string), 3)).toEqualTypeOf<'string[][3]'>();
  expectTypeOf(t.array(t.array(t.array(t.uint256)))).toEqualTypeOf<'uint256[][][]'>();
  expectTypeOf(t.array(P, 2).type).toEqualTypeOf<'tuple[2]'>();
  expectTypeOf(t.array(t.array(P)).type).toEqualTypeOf<'tuple[][]'>();
  expectTypeOf(t.array(t.array(P, 2)).type).toEqualTypeOf<'tuple[2][]'>();

  evscript(
    {
      name: 'fixed',
      args: [t.array(t.uint256, 2), 'string[][]', t.array(P, 2), t.array(t.array(P))],
    },
    (s, pair, grid, ps2, tuples) => {
      // `.at(i)` peels one suffix, fixed or dynamic; `.length()` is available on every array
      expectTypeOf(pair).toEqualTypeOf<Expr<'uint256[2]'>>();
      expectTypeOf(pair.at(0n)).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(pair.length()).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(grid.at(0n)).toEqualTypeOf<Expr<'string[]'>>();
      expectTypeOf(grid.at(0n).at(0n)).toEqualTypeOf<Expr<'string'>>();
      // a tuple[2] element is a named-field Tuple; a tuple[][] row is an Expr<tuple[]> whose cell is a Tuple
      expectTypeOf(ps2.at(1n).b.get()).toEqualTypeOf<Expr<'address'>>();
      expectTypeOf(tuples.at(0n)).not.toHaveProperty('a');
      expectTypeOf(tuples.at(0n).at(0n).a.get()).toEqualTypeOf<Expr<'uint256'>>();
      s.forEach(tuples, (row) => {
        s.forEach(row, (cell, i) => {
          expectTypeOf(cell.a.get()).toEqualTypeOf<Expr<'uint256'>>();
          expectTypeOf(i).toEqualTypeOf<Expr<'uint256'>>();
        });
      });
      // a fixed-size literal is typed as a readonly array of the element literal (the exact
      // length is enforced at recording, not statically — see the LitOf note in core/types/expr.ts)
      const lit = s.lit(t.array(t.uint256, 2), [1n, 2n]);
      expectTypeOf(lit).toEqualTypeOf<Expr<'uint256[2]'>>();
      // s.newArray({ fixed: true }) types the array by its literal length
      const built = s.newArray(t.uint256, 2, { fixed: true });
      expectTypeOf(built).toEqualTypeOf<MutArray<'uint256', 2>>();
      expectTypeOf(built.expr()).toEqualTypeOf<Expr<'uint256[2]'>>();
      const rows = s.newArray(t.array(P), 3n); // tuple[][]
      expectTypeOf(rows.expr().type.type).toEqualTypeOf<'tuple[][]'>();
      expectTypeOf(rows.get(0n)).toEqualTypeOf<
        Expr<{ readonly type: 'tuple[]'; readonly components: (typeof P)['components'] }>
      >();
      const pairs = s.newArray(t.array(t.uint256, 2), 2n); // uint256[2][]
      expectTypeOf(pairs.expr()).toEqualTypeOf<Expr<'uint256[2][]'>>();
      pairs.set(0n, [pair.at(0n), 7n]);
      return s.return({ pair, lit, built, grid, ps2, tuples });
    },
  );
});

test('#4 fixed-size and deep-array outputs/args flow through viem inference', () => {
  const abi = [
    {
      type: 'function',
      name: 'observe',
      stateMutability: 'view',
      inputs: [{ name: 'secondsAgos', type: 'uint32[2]' }],
      outputs: [{ name: 'ticks', type: 'int56[2]' }],
    },
    {
      type: 'function',
      name: 'grid',
      stateMutability: 'view',
      inputs: [],
      outputs: [
        { name: '', type: 'tuple[][]', components: [{ name: 'x', type: 'uint8' }] },
        { name: '', type: 'uint256[][][]' },
      ],
    },
  ] as const satisfies Abi;
  const script = evscript({ name: 'fixedOut', args: [t.address] }, (s, pool) => {
    const ticks = s.read({ address: pool, abi, functionName: 'observe', args: [[1, 2]] });
    expectTypeOf(ticks).toEqualTypeOf<Expr<'int56[2]'>>();
    const [g, cube] = s.read({ address: pool, abi, functionName: 'grid' });
    expectTypeOf(g.at(0n).at(0n).x.get()).toEqualTypeOf<Expr<'uint8'>>();
    expectTypeOf(cube.at(0n).at(0n).at(0n)).toEqualTypeOf<Expr<'uint256'>>();
    return s.return({ ticks, g, cube });
  });
  type Out = ReadContractReturnType<typeof script.abi, 'fixedOut'>;
  expectTypeOf<Out['ticks']>().toEqualTypeOf<readonly [bigint, bigint]>();
  expectTypeOf<Out['g']>().toEqualTypeOf<readonly (readonly { x: number }[])[]>();
  expectTypeOf<Out['cube']>().toEqualTypeOf<readonly (readonly (readonly bigint[])[])[]>();
});

test('a struct field named like a Tuple handle member gets no field accessor (the member wins)', () => {
  const Clash = t.struct({
    expr: t.uint256,
    at: t.address,
    toJSON: t.uint8,
    // oxlint-disable-next-line unicorn/no-thenable -- a struct FIELD named `then` is the case under test
    then: t.bool,
    value: t.uint16,
  });
  type H = Tuple<typeof Clash>;
  // only the non-colliding field is a named accessor
  expectTypeOf<Extract<keyof H, string>>().toEqualTypeOf<'value' | 'at' | 'expr'>();
  expectTypeOf<H['value']>().toEqualTypeOf<Field<'uint16'>>();
  // `at` / `expr` stay the methods (no `Field & method` intersection)
  expectTypeOf<H['expr']>().toEqualTypeOf<() => Expr<typeof Clash>>();
  expectTypeOf<ReturnType<H['at']>>().toEqualTypeOf<
    Field<'uint256' | 'address' | 'uint8' | 'bool' | 'uint16'>
  >();
  expectTypeOf<H>().not.toHaveProperty('toJSON');
  expectTypeOf<H>().not.toHaveProperty('then');

  // a third-party ABI component named `__proto__` / `constructor` is reached through .at(i) too
  const protoAbi = [
    {
      type: 'function',
      name: 'get',
      stateMutability: 'view',
      inputs: [],
      outputs: [
        {
          name: '',
          type: 'tuple',
          components: [
            { name: '__proto__', type: 'uint256' },
            { name: 'constructor', type: 'uint256' },
            { name: 'b', type: 'uint256' },
          ],
        },
      ],
    },
  ] as const satisfies Abi;
  evscript({ name: 'proto', args: [t.address] }, (s, pool) => {
    const r = s.read({ address: pool, abi: protoAbi, functionName: 'get' });
    expectTypeOf<Extract<keyof typeof r, string>>().toEqualTypeOf<'b' | 'at' | 'expr'>();
    return s.return({ p: r.at(0).get(), b: r.b.get() });
  });
});

test('TUPLE_HANDLE_MEMBERS lists exactly the TupleHandleMember names', () => {
  expectTypeOf<(typeof TUPLE_HANDLE_MEMBERS)[number]>().toEqualTypeOf<TupleHandleMember>();
});

test('`s.read({ struct: true })` over outputs named like handle members keeps the methods', () => {
  const multiAbi = [
    {
      type: 'function',
      name: 'get',
      stateMutability: 'view',
      inputs: [],
      outputs: [
        { name: 'at', type: 'uint256' },
        { name: 'expr', type: 'address' },
        { name: '__proto__', type: 'uint8' },
        { name: 'b', type: 'uint16' },
      ],
    },
  ] as const satisfies Abi;
  evscript({ name: 'multi', args: [t.address] }, (s, pool) => {
    const r = s.read({ address: pool, abi: multiAbi, functionName: 'get', struct: true });
    expectTypeOf<Extract<keyof typeof r, string>>().toEqualTypeOf<'b' | 'at' | 'expr'>();
    expectTypeOf(r.b).toEqualTypeOf<Field<'uint16'>>();
    expectTypeOf<(typeof r)['at']>().toBeFunction();
    expectTypeOf(r.at(0)).toEqualTypeOf<Field<'uint256' | 'address' | 'uint8' | 'uint16'>>();
    return s.return({ a: r.at(0).get(), b: r.b.get() });
  });
});

test('`NoProtoKey`: a literal `__proto__` key is a type error on t.struct / s.return', () => {
  // @ts-expect-error -- the key would set the prototype (or vanish), never declare a field
  t.struct({ __proto__: t.uint256, b: t.uint256 });
  // the guard is a no-op otherwise: inference is unchanged, and a widened record passes
  const S = t.struct({ a: t.uint256, b: t.address });
  expectTypeOf<(typeof S)['components'][0]['name']>().toEqualTypeOf<'a'>();
  expectTypeOf<(typeof S)['components'][1]['type']>().toEqualTypeOf<'address'>();
  const wide: Record<string, 'uint256'> = { a: t.uint256 };
  t.struct(wide);
  evscript({ name: 'r', args: [t.uint256] }, (s, x) => {
    const ok = s.return({ y: x });
    expectTypeOf(ok).toEqualTypeOf<ScriptReturn<{ readonly y: Expr<'uint256'> }>>();
    // @ts-expect-error -- `NoProtoKey`
    return s.return({ __proto__: x, y: x });
  });
});
