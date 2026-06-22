/* oxlint-disable typescript/no-unsafe-type-assertion --
 * type-level tests conjure phantom Expr handles via assertions; nothing here runs. */
import { expectTypeOf, test } from 'vitest';

import { arg, t } from './types.js';
import type { ArgSpec, Expr, IntoExpr, LitOf, TupleType } from './types.js';

const takeU8 = (_x: IntoExpr<'uint8'>): void => undefined;
const takeExprU8 = (_x: Expr<'uint8'>): void => undefined;
const e8 = {} as Expr<'uint8'>;
const e16 = {} as Expr<'uint16'>;

test('ArgSpec inference: arg(name, type) is exactly ArgSpec<name, type>', () => {
  expectTypeOf(arg('pool', t.address)).toEqualTypeOf<ArgSpec<'pool', 'address'>>();
  expectTypeOf(arg('fee', 'uint24')).toEqualTypeOf<ArgSpec<'fee', 'uint24'>>();
  expectTypeOf(arg('tokens', t.array(t.address))).toEqualTypeOf<ArgSpec<'tokens', 'address[]'>>();
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
  expectTypeOf<LitOf<'uint24[]'>>().toEqualTypeOf<readonly (bigint | number)[]>();
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

  // @ts-expect-error — eq on a memref type is not allowed (word types only)
  str.eq('x');
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
  expectTypeOf(pos.components).toMatchTypeOf<
    readonly [
      { readonly name: 'liquidity'; readonly type: 'uint128' },
      { readonly name: 'owner'; readonly type: 'address' },
    ]
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
