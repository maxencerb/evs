/* oxlint-disable typescript/no-unsafe-type-assertion --
 * type-level tests conjure phantom Expr handles via assertions; nothing here runs. */
import { expectTypeOf, test } from 'vite-plus/test';

import { namedArg, t } from './types.js';
import type {
  ArgSpec,
  ArrayElemOf,
  ArrayType,
  EvsType,
  Expr,
  FixedLengthOf,
  IntoExpr,
  LitOf,
  PeelArraySuffix,
  TupleType,
} from './types.js';

const takeU8 = (_x: IntoExpr<'uint8'>): void => undefined;
const takeExprU8 = (_x: Expr<'uint8'>): void => undefined;
const e8 = {} as Expr<'uint8'>;
const e16 = {} as Expr<'uint16'>;

test('ArgSpec inference: namedArg(name, type) is exactly ArgSpec<name, type>', () => {
  expectTypeOf(namedArg('pool', t.address)).toEqualTypeOf<ArgSpec<'pool', 'address'>>();
  expectTypeOf(namedArg('fee', 'uint24')).toEqualTypeOf<ArgSpec<'fee', 'uint24'>>();
  expectTypeOf(namedArg('tokens', t.array(t.address))).toEqualTypeOf<
    ArgSpec<'tokens', 'address[]'>
  >();
});

test('namedArg accepts every EvsType — composite types included (issue #25)', () => {
  const MarketParams = t.struct({ loanToken: t.address, lltv: t.uint256 });
  expectTypeOf(namedArg('marketParams', MarketParams)).toEqualTypeOf<
    ArgSpec<'marketParams', typeof MarketParams>
  >();
  const pair = t.tuple(t.address, t.uint24);
  expectTypeOf(namedArg('pair', pair)).toEqualTypeOf<ArgSpec<'pair', typeof pair>>();
  const markets = t.array(MarketParams);
  expectTypeOf(namedArg('markets', markets)).toEqualTypeOf<ArgSpec<'markets', typeof markets>>();
  // still rejects non-types
  // @ts-expect-error — a number is not an EvsType
  namedArg('x', 42);
});

test('t namespace literal types', () => {
  expectTypeOf(t.uint256).toEqualTypeOf<'uint256'>();
  expectTypeOf(t.bytes32).toEqualTypeOf<'bytes32'>();
  expectTypeOf(t.array(t.uint24)).toEqualTypeOf<'uint24[]'>();
});

test("IntoExpr<'uint8'> accepts 5, 5n, Expr<'uint8'>", () => {
  takeU8(5);
  takeU8(5n);
  takeU8(e8);
  expectTypeOf<IntoExpr<'uint8'>>().toEqualTypeOf<Expr<'uint8'> | bigint | number>();
});

test("IntoExpr<'uint8'> rejects '0x' and Expr<'uint16'>", () => {
  // @ts-expect-error — hex strings are not uint8 literals
  takeU8('0x');
  // @ts-expect-error — Expr<'uint16'> is not Expr<'uint8'> (brand is exact)
  takeU8(e16);
  expectTypeOf<'0x'>().not.toEqualTypeOf<LitOf<'uint8'>>();
});

test('LitOf maps every kind to its host literal type', () => {
  expectTypeOf<LitOf<'uint256'>>().toEqualTypeOf<bigint | number>();
  expectTypeOf<LitOf<'int24'>>().toEqualTypeOf<bigint | number>();
  expectTypeOf<LitOf<'address'>>().toEqualTypeOf<`0x${string}`>();
  expectTypeOf<LitOf<'bool'>>().toEqualTypeOf<boolean>();
  expectTypeOf<LitOf<'bytes4'>>().toEqualTypeOf<`0x${string}`>();
  expectTypeOf<LitOf<'string'>>().toEqualTypeOf<string>();
  expectTypeOf<LitOf<'bytes'>>().toEqualTypeOf<`0x${string}`>();
  // an array literal's elements may be host literals or staged Exprs of the element type (#4)
  expectTypeOf<LitOf<'uint24[]'>>().toEqualTypeOf<readonly (bigint | number | Expr<'uint24'>)[]>();
  expectTypeOf<LitOf<'uint24[2]'>>().toEqualTypeOf<readonly (bigint | number | Expr<'uint24'>)[]>();
  expectTypeOf<LitOf<'string[][]'>>().toEqualTypeOf<
    readonly (readonly (string | Expr<'string'>)[] | Expr<'string[]'>)[]
  >();
});

test('#4 array vocabulary: exact literals + one catch-all; suffix parsing at any depth', () => {
  // the dynamic forms are exact members; every other chain is admitted by the catch-all
  expectTypeOf<'uint256[]'>().toMatchTypeOf<ArrayType>();
  expectTypeOf<'uint256[2]'>().toMatchTypeOf<ArrayType>();
  expectTypeOf<'bytes[][3][]'>().toMatchTypeOf<ArrayType>();
  expectTypeOf<'uint256[][][][]'>().toMatchTypeOf<ArrayType>();
  expectTypeOf<'uint256'>().not.toMatchTypeOf<ArrayType>();
  expectTypeOf<'foo'>().not.toMatchTypeOf<EvsType>();
  // documented widening: the catch-all does not check the LEAF of a fixed-size / deep string —
  // `'foo[2]'` type-checks as an ArrayType (its element is `never`); recording rejects it
  expectTypeOf<'foo[2]'>().toMatchTypeOf<ArrayType>();
  expectTypeOf<ArrayElemOf<'foo[2]'>>().toEqualTypeOf<never>();

  // ArrayElemOf: the OUTERMOST suffix peeled, fixed or dynamic, at any depth
  expectTypeOf<ArrayElemOf<'uint256[]'>>().toEqualTypeOf<'uint256'>();
  expectTypeOf<ArrayElemOf<'address[3]'>>().toEqualTypeOf<'address'>();
  expectTypeOf<ArrayElemOf<'uint256[2][]'>>().toEqualTypeOf<'uint256[2]'>();
  expectTypeOf<ArrayElemOf<'uint256[][2]'>>().toEqualTypeOf<'uint256[]'>();
  expectTypeOf<ArrayElemOf<'bytes[][3][]'>>().toEqualTypeOf<'bytes[][3]'>();
  expectTypeOf<ArrayElemOf<'uint256[][][][]'>>().toEqualTypeOf<'uint256[][][]'>();
  expectTypeOf<ArrayElemOf<'uint256[]' | 'address[2]'>>().toEqualTypeOf<'uint256' | 'address'>();
  expectTypeOf<ArrayElemOf<'uint256'>>().toEqualTypeOf<never>();
  expectTypeOf<ArrayElemOf<EvsType>>().toEqualTypeOf<never>(); // wide receiver: no huge union

  // FixedLengthOf: the outermost suffix's size, any positive literal (not capped at 99)
  expectTypeOf<FixedLengthOf<'uint256[3]'>>().toEqualTypeOf<3>();
  expectTypeOf<FixedLengthOf<'uint256[][2]'>>().toEqualTypeOf<2>();
  expectTypeOf<FixedLengthOf<'uint256[300]'>>().toEqualTypeOf<300>();
  expectTypeOf<FixedLengthOf<'uint256[2][]'>>().toEqualTypeOf<null>();
  expectTypeOf<FixedLengthOf<'uint256'>>().toEqualTypeOf<null>();
  // malformed sizes (what the runtime rejects) are `null`, not a widened `number`
  expectTypeOf<FixedLengthOf<'uint256[01]'>>().toEqualTypeOf<null>();
  expectTypeOf<FixedLengthOf<'uint256[0]'>>().toEqualTypeOf<null>();
  expectTypeOf<FixedLengthOf<'uint256[1e3]'>>().toEqualTypeOf<null>();
  expectTypeOf<FixedLengthOf<'uint256[-1]'>>().toEqualTypeOf<null>();

  // PeelArraySuffix: the shared parser, tuple tags included
  expectTypeOf<PeelArraySuffix<'tuple[]'>>().toEqualTypeOf<'tuple'>();
  expectTypeOf<PeelArraySuffix<'tuple[2][]'>>().toEqualTypeOf<'tuple[2]'>();
  expectTypeOf<PeelArraySuffix<'tuple'>>().toEqualTypeOf<never>();
  expectTypeOf<PeelArraySuffix<'uint256[2'>>().toEqualTypeOf<never>(); // malformed chain
});

test('Expr brand is nominal: structurally-similar objects are not assignable', () => {
  // @ts-expect-error — missing the exprBrand phantom
  takeExprU8({ type: 'uint8' } as const);
  expectTypeOf<{ type: 'uint8' }>().not.toEqualTypeOf<Expr<'uint8'>>();
});

test('Expr this-parameter constraints', () => {
  const u8 = {} as Expr<'uint8'>;
  const str = {} as Expr<'string'>;
  const arr = {} as Expr<'address[]'>;

  expectTypeOf(u8.add(1)).toEqualTypeOf<Expr<'uint8'>>();
  expectTypeOf(u8.eq(5)).toEqualTypeOf<Expr<'bool'>>();
  expectTypeOf(str.length()).toEqualTypeOf<Expr<'uint256'>>();
  expectTypeOf(arr.at(0)).toEqualTypeOf<Expr<'address'>>();

  // eq/neq on a memref type is hash equality (#38): same-typed handle or literal rhs
  expectTypeOf(str.eq('x')).toEqualTypeOf<Expr<'bool'>>();
  expectTypeOf(arr.neq(arr)).toEqualTypeOf<Expr<'bool'>>();
  // @ts-expect-error — operand types must match (string vs address[])
  str.eq(arr);
  // @ts-expect-error — arithmetic on a non-numeric type
  arr.add(1);
});

// ---------------------------------------------------------------------------
// composite types (t.struct / t.tuple) — issue #2
// ---------------------------------------------------------------------------

test('t.struct infers a named-component TupleType; t.tuple a positional one', () => {
  const pos = t.struct({ liquidity: t.uint128, owner: t.address });
  expectTypeOf(pos).toMatchTypeOf<TupleType>();
  expectTypeOf(pos.type).toEqualTypeOf<'tuple'>();
  // A `t.struct`'s component ORDER is `UnionToTuple`'s TS-internal-id order — explicitly UNSTABLE
  // (it can flip when unrelated types are added). Assert the component SET (the
  // `[number]` element union, order-insensitive), which is the property the design actually
  // guarantees — viem infers an order-insensitive object from the named tuple either way.
  expectTypeOf<(typeof pos.components)[number]>().toEqualTypeOf<
    | { readonly name: 'liquidity'; readonly type: 'uint128' }
    | { readonly name: 'owner'; readonly type: 'address' }
  >();

  const tup = t.tuple(t.uint256, t.bool);
  expectTypeOf(tup.components).toMatchTypeOf<
    readonly [
      { readonly name: ''; readonly type: 'uint256' },
      { readonly name: ''; readonly type: 'bool' },
    ]
  >();
});

test('LitOf of a fully-named struct is the named object; positional tuple is a tuple', () => {
  const pos = t.struct({ liquidity: t.uint128, owner: t.address });
  expectTypeOf<LitOf<typeof pos>>().toEqualTypeOf<{ liquidity: bigint; owner: `0x${string}` }>();

  const tup = t.tuple(t.uint256, t.bool);
  expectTypeOf<LitOf<typeof tup>>().toMatchTypeOf<readonly [bigint, boolean]>();
});
