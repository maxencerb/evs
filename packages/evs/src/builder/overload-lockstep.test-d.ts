/**
 * Overload-resolution lockstep, type side: for every (overload set, args) case of the shared
 * matrix (test/harness/overload-matrix.ts), the type-level `ResolveOverload` reaches the case's
 * `expect` — the same outcome `overload-lockstep.test.ts` asserts on the recorder. Plus the
 * user-facing consequences: the typed result of a resolved call, and the compile errors that
 * mirror the recorder's ambiguous / no-match errors. Typecheck only.
 */
import { expectTypeOf, test } from 'vite-plus/test';

import { abis, ALICE, type OverloadCases } from '../../test/harness/overload-matrix.js';
import type { AbiFunctionSignature } from '../core/signature.js';
import { t, type Expr, type LitOf } from '../core/types.js';
import { evscript, type ResolveOverload, type ViewMutability } from './script.js';
import type { OverloadGuard } from './script/calls.js';

type IsUnion<u, all = u> = u extends unknown ? ([all] extends [u] ? false : true) : never;

/** The type-level outcome of one case: the chosen overload's signature, or ambiguous / none. */
type TypeOutcome<c> = c extends { readonly abi: infer abi; readonly args: infer args }
  ? ResolveOverload<abi & readonly unknown[], 'f', ViewMutability, args> extends infer r
    ? [r] extends [never]
      ? 'none'
      : true extends IsUnion<r>
        ? 'ambiguous'
        : AbiFunctionSignature<r>
    : never
  : never;

type ByName<cs extends readonly { readonly name: string }[], v extends 'outcome' | 'expect'> = {
  readonly [c in cs[number] as c['name']]: v extends 'outcome'
    ? TypeOutcome<c>
    : c extends { readonly expect: infer e }
      ? e
      : never;
};

test('the type-level resolver reaches every case of the matrix', () => {
  // a mismatch shows as a diff naming the case
  expectTypeOf<ByName<OverloadCases, 'outcome'>>().toEqualTypeOf<ByName<OverloadCases, 'expect'>>();
});

test('a resolved call is typed from the overload the recorder records', () => {
  const S = t.struct({ a: t.uint256 });
  evscript({ name: 'typed', args: [t.address, t.uint256] }, (s, target, x) => {
    // finding 6: a uint256 MutArray records f(uint256[]) -> uint256, and is typed so
    const m = s.read({
      address: target,
      abi: abis.structArrVsScalarArr,
      functionName: 'f',
      args: [s.newArray(t.uint256, 2n)],
    });
    expectTypeOf(m).toEqualTypeOf<Expr<'uint256'>>();
    // finding 13: a typed struct MutArray settles tuple[] overloads by component type
    const c = s.read({
      address: target,
      abi: abis.tupleArrByComponent,
      functionName: 'f',
      args: [s.newArray(S, 2n)],
    });
    expectTypeOf(c).toEqualTypeOf<Expr<'uint256'>>();
    // finding 7/9: a scalar literal does not fit a T[N]; an N-literal does
    const sc = s.read({ address: target, abi: abis.scalarVsFixed, functionName: 'f', args: [5n] });
    expectTypeOf(sc).toEqualTypeOf<Expr<'uint8'>>();
    const fx = s.read({
      address: target,
      abi: abis.scalarVsFixed,
      functionName: 'f',
      args: [[1n, 2n]],
    });
    expectTypeOf(fx).toEqualTypeOf<Expr<'address'>>();
    // a parseAbi tuple whose unnamed member has no `name` key is positional (the recorder agrees)
    const pa = s.read({
      address: target,
      abi: abis.mixedTupleParsed,
      functionName: 'f',
      args: [[1n, ALICE]],
    });
    expectTypeOf(pa).toEqualTypeOf<Expr<'bool'>>();
    // finding 8: tuple[N] handles, Expr-bearing literals
    const tf = s.read({
      address: target,
      abi: abis.tupleFixedVsScalar,
      functionName: 'f',
      args: [s.newArray(S, 2, { fixed: true }).expr()],
    });
    expectTypeOf(tf).toEqualTypeOf<Expr<'bool'>>();
    const el = s.read({
      address: target,
      abi: abis.scalarArrVsScalar,
      functionName: 'f',
      args: [[x, 2n]],
    });
    expectTypeOf(el).toEqualTypeOf<Expr<'bool'>>();
    // a struct literal fits only the overload that has every key it carries (positional: exactly
    // its length), so overloads differing by a trailing member are told apart
    const ab = s.read({
      address: target,
      abi: abis.structExtraMember,
      functionName: 'f',
      args: [{ a: 1n, b: 2n }],
    });
    expectTypeOf(ab).toEqualTypeOf<Expr<'uint8'>>();
    const a = s.read({
      address: target,
      abi: abis.structExtraMember,
      functionName: 'f',
      args: [{ a: 1n }],
    });
    expectTypeOf(a).toEqualTypeOf<Expr<'bool'>>();
    const pair = s.read({
      address: target,
      abi: abis.positionalExtraElem,
      functionName: 'f',
      args: [[1n, 2n]],
    });
    expectTypeOf(pair).toEqualTypeOf<Expr<'uint8'>>();
    const single = s.read({
      address: target,
      abi: abis.positionalExtraElem,
      functionName: 'f',
      args: [[1n]],
    });
    expectTypeOf(single).toEqualTypeOf<Expr<'bool'>>();
    return s.return({ m, c, sc, fx, tf, el, ab, a, pair, single });
  });
});

test('an extra key the value may not carry is a maybe-fit, not a misfit', () => {
  type Picked<args> = AbiFunctionSignature<
    ResolveOverload<typeof abis.structExtraMember, 'f', ViewMutability, args>
  >;
  // an optional `b` may be absent (fits f((uint256))) or present (fits f((uint256,uint256)))
  expectTypeOf<Picked<readonly [{ a: bigint; b?: bigint }]>>().toEqualTypeOf<
    'f((uint256))' | 'f((uint256,uint256))'
  >();
  // an index signature's keys are unknown statically
  expectTypeOf<Picked<readonly [Record<string, bigint>]>>().toEqualTypeOf<
    'f((uint256))' | 'f((uint256,uint256))'
  >();
});

test('the compile errors mirror the recorder errors', () => {
  evscript({ name: 'errors', args: [t.address] }, (s, target) => {
    s.read({
      address: target,
      abi: abis.dynVsFixed,
      functionName: 'f',
      // @ts-expect-error — a 2-element literal fits both f(uint256[]) and f(uint256[2]) (ABI_SHAPE)
      args: [[1n, 2n]],
    });
    s.read({
      address: target,
      abi: abis.scalarVsFixed,
      functionName: 'f',
      // @ts-expect-error — 3 elements fit neither f(uint256) nor f(uint256[2]) (TYPE_MISMATCH)
      args: [[1n, 2n, 3n]],
    });
    s.read({
      address: target,
      abi: abis.scalarArrByElem,
      functionName: 'f',
      // @ts-expect-error — a uint8 MutArray is neither a uint256[] nor an address[] (TYPE_MISMATCH)
      args: [s.newArray(t.uint8, 2n)],
    });
    // a signature still names one overload exactly
    const r = s.read({
      address: target,
      abi: abis.dynVsFixed,
      functionName: 'f(uint256[2])',
      args: [[1n, 2n]],
    });
    expectTypeOf(r).toEqualTypeOf<Expr<'address'>>();
    // a record fitting the address struct is not ambiguous with the uint256 one
    const a = s.read({
      address: target,
      abi: abis.structByMemberType,
      functionName: 'f',
      args: [{ a: ALICE }],
    });
    expectTypeOf(a).toEqualTypeOf<Expr<'uint8'>>();
    s.read({
      address: target,
      abi: abis.structExtraMember,
      functionName: 'f',
      // @ts-expect-error — `c` names no member of either struct (TYPE_MISMATCH)
      args: [{ a: 1n, b: 2n, c: 3n }],
    });
    return s.return({ r, a });
  });
});

test('the compile errors name the candidate signatures', () => {
  type Guard<abi extends readonly unknown[], args> = OverloadGuard<abi, 'f', ViewMutability, args>;
  type Ambiguous = Guard<typeof abis.dynVsFixed, readonly [readonly [1n, 2n]]>;
  expectTypeOf<
    Ambiguous['evs: ambiguous overload']
  >().toMatchTypeOf<`these args fit ${string}"f(uint256[])"${string}`>();
  expectTypeOf<
    Ambiguous['evs: ambiguous overload']
  >().toMatchTypeOf<`these args fit ${string}"f(uint256[2])"${string}`>();
  type NoMatch = Guard<typeof abis.structExtraMember, readonly [{ a: 1n; b: 2n; c: 3n }]>;
  expectTypeOf<
    NoMatch['evs: no overload matches']
  >().toMatchTypeOf<`${string}"f((uint256))"${string}`>();
  expectTypeOf<
    NoMatch['evs: no overload matches']
  >().toMatchTypeOf<`${string}"f((uint256,uint256))"${string}`>();
});

test('LitOf element-checks multi-level chains with a fixed outer suffix (findings 15/21)', () => {
  expectTypeOf<LitOf<'uint256[2][3]'>>().toEqualTypeOf<
    readonly (readonly (bigint | number | Expr<'uint256'>)[] | Expr<'uint256[2]'>)[]
  >();
  expectTypeOf<LitOf<'uint256[][2]'>>().toEqualTypeOf<
    readonly (readonly (bigint | number | Expr<'uint256'>)[] | Expr<'uint256[]'>)[]
  >();
  // @ts-expect-error — a string is not a uint256 element
  const bad: LitOf<'uint256[2][3]'> = [['nope']];
  // @ts-expect-error — a bigint is not a bool element
  const bad2: LitOf<'bool[2][2]'> = [[1n]];
  // @ts-expect-error — the depth is checked too
  const bad3: LitOf<'uint256[][][2]'> = [[1n]];
  void [bad, bad2, bad3];
  evscript({ name: 'lits', args: [t.uint256] }, (s, x) => {
    // backward inference still reads the type from the first argument
    const m = s.lit(t.array(t.array(t.uint256, 2), 3), [
      [1n, x],
      [3n, 4n],
      [5n, 6n],
    ]);
    expectTypeOf(m).toEqualTypeOf<Expr<'uint256[2][3]'>>();
    const d = s.lit('bool[][2]', [[true], []]);
    expectTypeOf(d).toEqualTypeOf<Expr<'bool[][2]'>>();
    // @ts-expect-error — the element is checked through s.lit as well
    s.lit('bool[2][2]', [[1n]]);
    return s.return({ m, d });
  });
});
