/* oxlint-disable vitest/expect-expect --
 * the rejection tests assert through their `@ts-expect-error` lines, which the rule cannot see. */
/**
 * Call parameter type tests: what the six call verbs require of `args` and accept for `struct`,
 * and what they give for an ABI with no literal type. Every call refused here is one the
 * recorder refuses too (`call-params.test.ts` records the same calls). Typecheck only.
 */
import { parseAbi, type Abi } from 'viem';
import { expectTypeOf, test } from 'vite-plus/test';

import { t, type Expr, type TupleType } from '../core/types.js';
import {
  evscript,
  type ResolvedSubcallParams,
  type ScriptBuilder,
  type StructFlag,
  type SubcallFunctionName,
  type SubcallInputs,
  type SubcallParams,
  type Tuple,
  type ViewMutability,
  type WideSubcallResult,
  type WriteMutability,
} from './script.js';

const abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  // every overload takes an argument
  'function rate(uint256 id) view returns (uint256)',
  'function rate(uint256 id, uint256 at) view returns (uint256)',
  // one overload takes none
  'function total() view returns (uint256)',
  'function total(address asset) view returns (uint256 amount, uint256 shares)',
  'function poke()',
  'function deposit(uint256 amount) returns (uint256 shares)',
  'function quote(uint256 amountIn) returns (uint256)',
]);

const WHO = '0x00000000000000000000000000000000000000aa';

// a host boolean the types cannot see through (not a constant expression)
const flag = Math.random() > 0.5;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

test('args is required by every verb when the function takes arguments', () => {
  evscript({ name: 'required', args: [t.address] }, (s, token) => {
    // @ts-expect-error — balanceOf takes one argument: `args` is required
    s.read({ address: token, abi, functionName: 'balanceOf' });
    // @ts-expect-error — allowance takes two
    s.tryRead({ address: token, abi, functionName: 'allowance' });
    // @ts-expect-error — deposit takes one
    s.call({ address: token, abi, functionName: 'deposit' });
    // @ts-expect-error — deposit takes one
    s.tryCall({ address: token, abi, functionName: 'deposit' });
    // @ts-expect-error — deposit takes one
    s.simulate({ address: token, abi, functionName: 'deposit' });
    // @ts-expect-error — deposit takes one
    s.trySimulate({ address: token, abi, functionName: 'deposit' });

    const balance = s.read({ address: token, abi, functionName: 'balanceOf', args: [WHO] });
    expectTypeOf(balance).toEqualTypeOf<Expr<'uint256'>>();
    const allowance = s.tryRead({
      address: token,
      abi,
      functionName: 'allowance',
      args: [WHO, token],
    });
    expectTypeOf(allowance.value).toEqualTypeOf<Expr<'uint256'>>();
    const a = s.call({ address: token, abi, functionName: 'deposit', args: [1n] });
    const b = s.tryCall({ address: token, abi, functionName: 'deposit', args: [1n] });
    const c = s.simulate({ address: token, abi, functionName: 'deposit', args: [1n] });
    const d = s.trySimulate({ address: token, abi, functionName: 'deposit', args: [1n] });
    expectTypeOf(a).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(b.value).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(c).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(d.value).toEqualTypeOf<Expr<'uint256'>>();
    return s.return({ balance, a, c });
  });
});

test('args: undefined does not stand for a missing args', () => {
  evscript({ name: 'undef', args: [t.address] }, (s, token) => {
    // @ts-expect-error — undefined is no argument list for a function that takes one
    s.read({ address: token, abi, functionName: 'balanceOf', args: undefined });
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

test('args stays optional when the function takes none, and [] is accepted', () => {
  evscript({ name: 'nullary', args: [t.address] }, (s, token) => {
    const omitted = s.read({ address: token, abi, functionName: 'decimals' });
    const empty = s.read({ address: token, abi, functionName: 'decimals', args: [] });
    expectTypeOf(omitted).toEqualTypeOf<Expr<'uint8'>>();
    expectTypeOf(empty).toEqualTypeOf<Expr<'uint8'>>();
    expectTypeOf(s.call({ address: token, abi, functionName: 'poke' })).toEqualTypeOf<void>();
    expectTypeOf(
      s.simulate({ address: token, abi, functionName: 'poke', args: [] }),
    ).toEqualTypeOf<void>();
    // @ts-expect-error — decimals takes no argument
    s.read({ address: token, abi, functionName: 'decimals', args: [1n] });
    return s.return({ omitted, empty });
  });
});

test('an overloaded name requires args unless one overload takes none', () => {
  evscript({ name: 'overloads', args: [t.address] }, (s, token) => {
    // @ts-expect-error — both overloads of rate take arguments
    s.read({ address: token, abi, functionName: 'rate' });
    // args select the overload, as before
    const one = s.read({ address: token, abi, functionName: 'rate', args: [1n] });
    const two = s.read({ address: token, abi, functionName: 'rate', args: [1n, 2n] });
    expectTypeOf(one).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(two).toEqualTypeOf<Expr<'uint256'>>();
    // a signature names one overload: its inputs decide
    // @ts-expect-error — rate(uint256) takes one argument
    s.read({ address: token, abi, functionName: 'rate(uint256)' });
    s.read({ address: token, abi, functionName: 'rate(uint256)', args: [1n] });

    // total() exists: a call without args is that overload
    const nullary = s.read({ address: token, abi, functionName: 'total' });
    expectTypeOf(nullary).toEqualTypeOf<Expr<'uint256'>>();
    const [amount, shares] = s.read({
      address: token,
      abi,
      functionName: 'total',
      args: [token],
    });
    expectTypeOf(amount).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(shares).toEqualTypeOf<Expr<'uint256'>>();
    // @ts-expect-error — total(address) takes one argument
    s.read({ address: token, abi, functionName: 'total(address)' });
    return s.return({ one, two, nullary, amount, shares });
  });
});

test('the revertReturns form requires args too', () => {
  evscript({ name: 'rr', args: [t.address] }, (s, quoter) => {
    // @ts-expect-error — quote takes one argument
    s.call({ address: quoter, abi, functionName: 'quote', revertReturns: [t.uint256] });
    // @ts-expect-error — quote takes one argument
    s.tryCall({ address: quoter, abi, functionName: 'quote', revertReturns: [t.uint256] });
    const out = s.call({
      address: quoter,
      abi,
      functionName: 'quote',
      args: [1n],
      revertReturns: [t.uint256],
    });
    expectTypeOf(out).toEqualTypeOf<Expr<'uint256'>>();
    return s.return({ out });
  });
});

test('a params object built apart is held to the same rule', () => {
  evscript({ name: 'apart', args: [t.address] }, (s, token) => {
    const partial = { address: token, abi, functionName: 'balanceOf' } as const;
    // @ts-expect-error — nothing gives args
    s.read(partial);
    const balance = s.read({ ...partial, args: [WHO] });
    expectTypeOf(balance).toEqualTypeOf<Expr<'uint256'>>();
    return s.return({ balance });
  });
});

test('a widened ABI leaves args optional: its inputs are not known', () => {
  const wideAbi: Abi = [];
  evscript({ name: 'wideArgs', args: [t.address] }, (s, token) => {
    s.read({ address: token, abi: wideAbi, functionName: 'balanceOf' });
    s.call({ address: token, abi: wideAbi, functionName: 'deposit', args: [1n] });
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

// ---------------------------------------------------------------------------
// struct
// ---------------------------------------------------------------------------

const outputsAbi = parseAbi([
  // a getter that returns a struct: ONE unnamed tuple output
  'function getConfig(uint8 id) view returns ((uint16 ltv, uint16 liquidationThreshold))',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick)',
  'function pair() view returns (uint256 a, uint256)',
  'function nothing() view',
  'function swap(uint256 amountIn) returns (uint256 amountOut, uint256 fee)',
  'function burn(uint256 amount) returns (uint256)',
  // the overload the args resolve to decides
  'function reserves() view returns (uint256, uint256)',
  'function reserves(address asset) view returns (uint256 supplied, uint256 borrowed)',
]);

test('struct: true is refused when an output is unnamed', () => {
  evscript({ name: 'unnamed', args: [t.address, t.uint8] }, (s, pool, id) => {
    const p = { address: pool, abi: outputsAbi, functionName: 'getConfig', args: [id] } as const;
    // @ts-expect-error — the one output of getConfig (the struct) is unnamed
    s.read({ ...p, struct: true });
    // @ts-expect-error — the same under the try verb
    s.tryRead({ ...p, struct: true });
    // @ts-expect-error — a boolean may be true
    s.read({ ...p, struct: flag });
    // the default result is the named Tuple already
    const config = s.read(p);
    expectTypeOf(config.liquidationThreshold.get()).toEqualTypeOf<Expr<'uint16'>>();
    const same = s.read({ ...p, struct: false });
    expectTypeOf(same.ltv.get()).toEqualTypeOf<Expr<'uint16'>>();

    // @ts-expect-error — the second output of pair is unnamed
    s.read({ address: pool, abi: outputsAbi, functionName: 'pair', struct: true });
    const burn = { address: pool, abi: outputsAbi, functionName: 'burn', args: [1n] } as const;
    // @ts-expect-error — the output of burn is unnamed
    s.call({ ...burn, struct: true });
    // @ts-expect-error — the output of burn is unnamed
    s.tryCall({ ...burn, struct: true });
    // @ts-expect-error — the output of burn is unnamed
    s.simulate({ ...burn, struct: true });
    // @ts-expect-error — the output of burn is unnamed
    s.trySimulate({ ...burn, struct: true });
    return s.return({ ltv: config.ltv.get() });
  });
});

test('struct: true is refused when the function returns nothing', () => {
  evscript({ name: 'noOutputs', args: [t.address] }, (s, pool) => {
    // @ts-expect-error — nothing has no output to build a struct from
    s.read({ address: pool, abi: outputsAbi, functionName: 'nothing', struct: true });
    expectTypeOf(
      s.read({ address: pool, abi: outputsAbi, functionName: 'nothing' }),
    ).toEqualTypeOf<void>();
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

test('struct: true is accepted when every output is named', () => {
  evscript({ name: 'named', args: [t.address] }, (s, pool) => {
    const slot0 = s.read({ address: pool, abi: outputsAbi, functionName: 'slot0', struct: true });
    expectTypeOf(slot0.tick.get()).toEqualTypeOf<Expr<'int24'>>();
    const tried = s.tryRead({
      address: pool,
      abi: outputsAbi,
      functionName: 'slot0',
      struct: true,
    });
    expectTypeOf(tried.value.sqrtPriceX96.get()).toEqualTypeOf<Expr<'uint160'>>();
    const swap = { address: pool, abi: outputsAbi, functionName: 'swap', args: [1n] } as const;
    expectTypeOf(s.call({ ...swap, struct: true }).fee.get()).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(s.simulate({ ...swap, struct: true }).amountOut.get()).toEqualTypeOf<
      Expr<'uint256'>
    >();
    // a boolean is accepted: every value of it is
    s.read({ address: pool, abi: outputsAbi, functionName: 'slot0', struct: flag });
    return s.return({ tick: slot0.tick.get() });
  });
});

test('struct: true follows the overload the args resolve to', () => {
  evscript({ name: 'structOverload', args: [t.address] }, (s, pool) => {
    const named = s.read({
      address: pool,
      abi: outputsAbi,
      functionName: 'reserves',
      args: [pool],
      struct: true,
    });
    expectTypeOf(named.borrowed.get()).toEqualTypeOf<Expr<'uint256'>>();
    // @ts-expect-error — reserves() has unnamed outputs
    s.read({ address: pool, abi: outputsAbi, functionName: 'reserves', struct: true });
    return s.return({ supplied: named.supplied.get() });
  });
});

test('the refusal is a type whose text says why', () => {
  expectTypeOf<
    StructFlag<typeof outputsAbi, 'getConfig', ViewMutability, readonly [number]>
  >().toEqualTypeOf<{
    readonly 'evs: struct: true needs every output named': 'an output of getConfig is unnamed — use the default positional result (omit struct)';
  }>();
  expectTypeOf<
    StructFlag<typeof outputsAbi, 'nothing', ViewMutability, readonly []>
  >().toEqualTypeOf<{
    readonly 'evs: struct: true needs outputs': 'nothing returns nothing — remove struct: true';
  }>();
  expectTypeOf<
    StructFlag<typeof outputsAbi, 'slot0', ViewMutability, readonly []>
  >().toEqualTypeOf<true>();
  // the overload the args resolve to
  expectTypeOf<
    StructFlag<typeof outputsAbi, 'reserves', ViewMutability, readonly [`0x${string}`]>
  >().toEqualTypeOf<true>();
  expectTypeOf<
    StructFlag<typeof outputsAbi, 'reserves', ViewMutability, readonly []>
  >().not.toEqualTypeOf<true>();
  // a widened ABI: nothing to look at
  expectTypeOf<StructFlag<Abi, 'slot0', ViewMutability, readonly []>>().toEqualTypeOf<true>();
});

test('a widened ABI accepts struct: true: its outputs are not known', () => {
  const wideAbi: Abi = [];
  evscript({ name: 'wideStruct', args: [t.address] }, (s, pool) => {
    expectTypeOf(
      s.read({ address: pool, abi: wideAbi, functionName: 'slot0', struct: true }),
    ).toEqualTypeOf<Tuple<TupleType>>();
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

// ---------------------------------------------------------------------------
// an ABI with no literal type
// ---------------------------------------------------------------------------

/* oxlint-disable typescript/no-unsafe-type-assertion -- the narrowing cast is the documented way
 * to use the result of an ABI with no literal type */
test('an ABI declared without as const gives the untyped result, which holds no undefined', () => {
  const inlineAbi = [
    {
      type: 'function',
      name: 'decimals',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'uint8' }],
    },
  ];
  evscript({ name: 'inline', args: [t.address] }, (s, token) => {
    const decimals = s.read({ address: token, abi: inlineAbi, functionName: 'decimals' });
    expectTypeOf(decimals).toEqualTypeOf<WideSubcallResult>();
    // no `undefined` member: the first error on a use names the result type, not a null check
    expectTypeOf<Extract<WideSubcallResult, undefined>>().toBeNever();
    // @ts-expect-error — Property 'toUint' does not exist on type 'TypedResultRequiresAbiAsConst'
    decimals.toUint(t.uint256);
    // @ts-expect-error — Type 'TypedResultRequiresAbiAsConst' is not assignable to 'ReturnValue'
    s.return({ decimals });
    const typed = (decimals as Expr<'uint8'>).toUint(t.uint256);
    expectTypeOf(typed).toEqualTypeOf<Expr<'uint256'>>();
    const tried = s.tryRead({ address: token, abi: inlineAbi, functionName: 'decimals' });
    expectTypeOf(tried.value).toEqualTypeOf<WideSubcallResult>();
    return s.return({ typed });
  });
});

test('a params object the types cannot read takes the first overload: the untyped result', () => {
  evscript({ name: 'opaque', args: [t.address] }, (s) => {
    // the overload without `struct` comes first, so nothing claims a Tuple it cannot know of
    expectTypeOf(s.read({} as never)).toEqualTypeOf<WideSubcallResult>();
    expectTypeOf(s.trySimulate({} as never).value).toEqualTypeOf<WideSubcallResult>();
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

test('an ABI entry without stateMutability is accepted, as an ABI with no literal type', () => {
  // the shape solc gave before 0.4.16: `constant` and `payable`, no `stateMutability`
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
  // abitype's `Abi` requires `stateMutability`: the legacy ABI is not one
  expectTypeOf(legacyAbi).not.toMatchTypeOf<Abi>();
  evscript({ name: 'legacy', args: [t.address] }, (s, punks) => {
    const supply = s.read({ address: punks, abi: legacyAbi, functionName: 'totalSupply' });
    expectTypeOf(supply).toEqualTypeOf<WideSubcallResult>();
    // nothing is known of its functions: any name, unchecked args
    s.simulate({ address: punks, abi: legacyAbi, functionName: 'transferPunk', args: [WHO, 1n] });
    s.tryCall({ address: punks, abi: legacyAbi, functionName: 'transferPunk', args: [WHO, 1n] });
    return s.return({ supply: supply as Expr<'uint256'> });
  });

  // with `stateMutability` added the entry is an `Abi` one (the flags may stay) and is typed
  const typedAbi = [
    {
      constant: true,
      inputs: [],
      name: 'totalSupply',
      outputs: [{ name: '', type: 'uint256' }],
      payable: false,
      stateMutability: 'view',
      type: 'function',
    },
  ] as const satisfies Abi;
  evscript({ name: 'legacyTyped', args: [t.address] }, (s, punks) => {
    const supply = s.read({ address: punks, abi: typedAbi, functionName: 'totalSupply' });
    expectTypeOf(supply).toEqualTypeOf<Expr<'uint256'>>();
    return s.return({ supply });
  });
});
/* oxlint-enable typescript/no-unsafe-type-assertion */

// ---------------------------------------------------------------------------
// the exported parameter types, in a wrapper
// ---------------------------------------------------------------------------

test('a wrapper typed with ResolvedSubcallParams passes its object on, generic or not', () => {
  const readVia = <
    const a extends Abi,
    name extends SubcallFunctionName<a>,
    const args extends SubcallInputs<a, name>,
  >(
    s: ScriptBuilder,
    p: ResolvedSubcallParams<a, name, ViewMutability, args>,
  ) => s.read(p);
  type BalanceParams = ResolvedSubcallParams<
    typeof abi,
    'balanceOf',
    ViewMutability,
    readonly [Expr<'address'>]
  >;
  const balanceVia = (s: ScriptBuilder, p: BalanceParams) => s.read(p);
  const tryBalanceVia = (s: ScriptBuilder, p: BalanceParams) => s.tryRead(p);
  evscript({ name: 'via', args: [t.address, t.address] }, (s, token, who) => {
    const viaGeneric = readVia(s, { address: token, abi, functionName: 'balanceOf', args: [who] });
    const viaConcrete = balanceVia(s, {
      address: token,
      abi,
      functionName: 'balanceOf',
      args: [who],
    });
    const tried = tryBalanceVia(s, { address: token, abi, functionName: 'balanceOf', args: [who] });
    // a `struct` the wrapper's type cannot see through: the positional result or the struct one
    expectTypeOf<Extract<typeof viaGeneric, Expr>>().toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf<Extract<typeof viaConcrete, Expr>>().toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf<Extract<typeof tried.value, Expr>>().toEqualTypeOf<Expr<'uint256'>>();
    // the wrapper's type still requires args
    // @ts-expect-error — balanceOf takes one argument
    readVia(s, { address: token, abi, functionName: 'balanceOf' });
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

test('a wrapper typed with SubcallParams passes its object on', () => {
  const slot0Via = (s: ScriptBuilder, p: SubcallParams<typeof outputsAbi, 'slot0'>) => s.read(p);
  // `SubcallParams` leaves `args` optional: for a function that takes arguments, the wrapper's
  // object may lack them, which recording refuses (`ResolvedSubcallParams` requires them)
  const swapVia = (
    s: ScriptBuilder,
    p: SubcallParams<typeof outputsAbi, 'swap', WriteMutability>,
  ) =>
    // @ts-expect-error — Property 'args' is optional in type 'SubcallParams<…>'
    s.simulate(p);
  void swapVia;
  // the `struct` key holds what the verbs take: `true` only for outputs that are all named
  expectTypeOf<SubcallParams<typeof outputsAbi, 'slot0'>['struct']>().toEqualTypeOf<
    boolean | undefined
  >();
  expectTypeOf<SubcallParams<typeof outputsAbi, 'getConfig'>['struct']>().toEqualTypeOf<
    false | StructFlag<typeof outputsAbi, 'getConfig'> | undefined
  >();
  evscript({ name: 'viaParams', args: [t.address] }, (s, pool) => {
    const slot0 = slot0Via(s, { address: pool, abi: outputsAbi, functionName: 'slot0' });
    // either result: the positional one or the struct one
    expectTypeOf<Extract<typeof slot0, readonly unknown[]>[1]>().toEqualTypeOf<Expr<'int24'>>();
    expectTypeOf<
      ReturnType<Exclude<typeof slot0, readonly unknown[]>['tick']['get']>
    >().toEqualTypeOf<Expr<'int24'>>();
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

test('the parameter of a verb, as Parameters<> reads it, is its parameter object', () => {
  type Wide<mut extends ViewMutability | WriteMutability> = ResolvedSubcallParams<
    Abi | readonly unknown[],
    string,
    mut,
    readonly unknown[]
  >;
  expectTypeOf<Parameters<ScriptBuilder['read']>[0]>().toEqualTypeOf<Wide<ViewMutability>>();
  expectTypeOf<Parameters<ScriptBuilder['tryRead']>[0]>().toEqualTypeOf<Wide<ViewMutability>>();
  expectTypeOf<Parameters<ScriptBuilder['call']>[0]>().toEqualTypeOf<Wide<WriteMutability>>();
  expectTypeOf<Parameters<ScriptBuilder['tryCall']>[0]>().toEqualTypeOf<Wide<WriteMutability>>();
  expectTypeOf<Parameters<ScriptBuilder['simulate']>[0]>().toEqualTypeOf<Wide<WriteMutability>>();
  expectTypeOf<Parameters<ScriptBuilder['trySimulate']>[0]>().toEqualTypeOf<
    Wide<WriteMutability>
  >();
  // a forwarding wrapper typed that way takes any call, as on an ABI with no literal type
  const readLogged = (s: ScriptBuilder, p: Parameters<ScriptBuilder['read']>[0]) => s.read(p);
  const simulateLogged = (s: ScriptBuilder, p: Parameters<ScriptBuilder['simulate']>[0]) =>
    s.simulate(p);
  evscript({ name: 'logged', args: [t.address] }, (s, token) => {
    const balance = readLogged(s, { address: token, abi, functionName: 'balanceOf', args: [WHO] });
    simulateLogged(s, { address: token, abi, functionName: 'deposit', args: [1n] });
    expectTypeOf(balance).toEqualTypeOf<WideSubcallResult | Tuple<TupleType>>();
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

test('a verb whose bucket holds no function of a literal ABI: one error, on the call', () => {
  // only write functions: s.read has no name to resolve, s.simulate none on a view-only ABI
  const writeOnly = parseAbi(['function quote(uint256 amountIn) returns (uint256 amountOut)']);
  const viewOnly = parseAbi(['function price(uint256 id) view returns (uint256)']);
  evscript({ name: 'wrongVerb', args: [t.address] }, (s, target) => {
    // @ts-expect-error — quote is not a view function: s.read cannot call it
    const quoted = s.read({ address: target, abi: writeOnly, functionName: 'quote', args: [1n] });
    const priced = s.simulate({
      address: target,
      abi: viewOnly,
      // @ts-expect-error — price is a view function: s.simulate cannot call it
      functionName: 'price',
      args: [1n],
    });
    // nothing more where a result is used: the result of an ABI with no literal type would add
    // an error naming a missing `as const`
    expectTypeOf(quoted).toBeNever();
    expectTypeOf(priced).toBeNever();
    return s.return({ quoted, priced });
  });
});
