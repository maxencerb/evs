/**
 * The operators of the builder, as an app writes them: `s.add(a, b)` and the other two-operand
 * functions take their type from the operand that is an `Expr` and check the other against it.
 * Two `Expr`s of different types are an error on the second operand, under every checker: a
 * `@ts-expect-error` covers the next line only, so each of those calls is spread over several
 * lines with the directive on the operand the error belongs to.
 *
 * Also here: the bitwise operators on `intN`, and the receivers `toUint` / `toInt` refuse.
 */
import {
  evscript,
  t,
  type Cell,
  type EvsScript,
  type Expr,
  type IntoExpr,
  type NumericType,
  type ScriptBuilder,
  type Tuple,
} from '@maxencerb/evs';

import { expectType, type Same } from './assert.js';

const Pair = t.struct({ fee: t.uint24, pool: t.address });
const ONE = '0x0000000000000000000000000000000000000001';

/** A literal on either side: the type is the `Expr` operand's. */
export const eitherSide = evscript(
  { name: 'eitherSide', args: [t.uint256, t.uint8, t.int24, t.address, t.bool, t.string] },
  (s, u256, u8, i24, who, flag, str) => {
    const sum = s.add(u256, 1n);
    const left = s.sub(100, u8);
    const both = s.mul(i24, i24);
    const wrapped = s.wrappingSub(0n, u256);
    const picked = s.select(flag, u8, 18);
    const pickedLeft = s.select(flag, 18, u8);
    expectType<Same<typeof sum, Expr<'uint256'>>>();
    expectType<Same<typeof left, Expr<'uint8'>>>();
    expectType<Same<typeof both, Expr<'int24'>>>();
    expectType<Same<typeof wrapped, Expr<'uint256'>>>();
    expectType<Same<typeof picked, Expr<'uint8'>>>();
    expectType<Same<typeof pickedLeft, Expr<'uint8'>>>();
    const checks = [
      s.lt(u256, 10n),
      s.gte(0, i24),
      s.eq(str, 'WETH'),
      s.neq('WETH', str),
      s.eq(ONE, who),
      s.and(flag, true),
      s.or(false, flag),
    ];
    expectType<Same<typeof checks, Expr<'bool'>[]>>();
    return s.return({ sum, left, both, wrapped, picked, pickedLeft, ok: s.and(flag, true) });
  },
);

/** Two `Expr`s of different types: the error is on the second operand. */
export const mixedOperands = evscript(
  { name: 'mixedOperands', args: [t.uint256, t.uint8, t.int256, t.address, t.bool, t.string] },
  (s, u256, u8, i256, who, flag, str) => {
    s.add(
      u256,
      // @ts-expect-error -- uint8 is not uint256: widths never match implicitly
      u8,
    );
    s.sub(
      u8,
      // @ts-expect-error -- nor the other way round
      u256,
    );
    s.mul(
      u256,
      // @ts-expect-error -- signedness
      i256,
    );
    s.lt(
      u256,
      // @ts-expect-error -- an address does not order against a number
      who,
    );
    s.eq(
      u256,
      // @ts-expect-error -- a word against a string
      str,
    );
    s.bitAnd(
      u256,
      // @ts-expect-error -- uint8 is not uint256
      u8,
    );
    s.select(
      flag,
      u256,
      // @ts-expect-error -- the branches have one type
      u8,
    );
    return s.return({ ok: flag });
  },
);

/** No `Expr` operand: nothing types the operation. */
export const untyped = evscript({ name: 'untyped', args: [t.bool] }, (s, flag) => {
  // @ts-expect-error -- the type comes from an Expr operand
  s.add(1n, 2n);
  // @ts-expect-error -- even for strings
  s.eq('a', 'b');
  // @ts-expect-error -- and for bools
  s.and(true, false);
  // @ts-expect-error -- two literal branches
  s.select(flag, 1n, 2n);
  // typing one side is enough
  const typed = s.add(s.lit(t.uint8, 1), 2);
  expectType<Same<typeof typed, Expr<'uint8'>>>();
  return s.return({ typed });
});

/** `s.eq` / `s.neq` and `s.select`'s branches take a bare handle for its memref, and the others
 *  do not. */
export const handles = evscript(
  { name: 'handles', args: [Pair, t.array(t.uint256)] },
  (s, pair, arr) => {
    const mut = s.newArray(t.uint256, 2n);
    const cell = s.let(t.uint256, 1n);
    const same = [
      s.eq(pair, pair),
      s.eq(pair, pair.expr()),
      s.neq(pair.expr(), pair),
      s.eq(pair, { fee: 500, pool: ONE }),
      s.eq({ fee: 500, pool: ONE }, pair),
      s.eq(arr, mut),
      s.neq(mut, [1n, 2n]),
    ];
    expectType<Same<typeof same, Expr<'bool'>[]>>();
    s.eq(
      pair,
      // @ts-expect-error -- a struct against an array
      mut,
    );
    s.eq(
      // @ts-expect-error -- a Cell is not a value: read it with .get()
      cell,
      1n,
    );
    const picked = s.select(true, pair, pair);
    expectType<Same<typeof picked, Tuple<typeof Pair>>>();
    s.add(
      // @ts-expect-error -- a bare handle is not an operand
      mut,
      1n,
    );
    return s.return({ ok: s.eq(pair, pair) });
  },
);

/** The bitwise operators take `intN`, and the result is of the operand type. */
export const signedBits = evscript(
  { name: 'signedBits', args: [t.int24, t.int256, t.int8, t.address] },
  (s, i24, i256, i8, who) => {
    const and = i24.bitAnd(0xff);
    const or = s.bitOr(1, i8);
    const xor = i256.bitXor(-1n);
    const not = i8.bitNot();
    const staticNot = s.bitNot(i24);
    expectType<Same<typeof and, Expr<'int24'>>>();
    expectType<Same<typeof or, Expr<'int8'>>>();
    expectType<Same<typeof xor, Expr<'int256'>>>();
    expectType<Same<typeof not, Expr<'int8'>>>();
    expectType<Same<typeof staticNot, Expr<'int24'>>>();
    // @ts-expect-error -- widths still never match implicitly
    i24.bitAnd(i8);
    // @ts-expect-error -- an address has no bit operation
    who.bitAnd(who);
    return s.return({ and, or, xor, not });
  },
);

/** `s.let(type, init)` and a typed `s.for`: the declared type is the one checked. */
export const declaredTypes = evscript(
  { name: 'declaredTypes', args: [t.uint256, t.uint8] },
  (s, u256, u8) => {
    const cell = s.let(t.int8, -1);
    expectType<Same<typeof cell, Cell<'int8'>>>();
    s.let(
      t.int8,
      // @ts-expect-error -- a uint256 does not initialize an int8 cell
      u256,
    );
    s.for({ type: t.uint8, from: 0, until: u8 }, (i) => {
      expectType<Same<typeof i, Expr<'uint8'>>>();
    });
    // @ts-expect-error -- a uint256 bound on a uint8 counter
    s.for({ type: t.uint8, from: 0, until: u256 }, () => {});
    return s.return({ u256 });
  },
);

/** A value typed `IntoExpr` works next to an `Expr`; a generic helper keeps its parameter. */
export function scale(s: ScriptBuilder, x: IntoExpr<'uint256'>, by: Expr<'uint256'>) {
  const product = s.mul(x, by);
  expectType<Same<typeof product, Expr<'uint256'>>>();
  // @ts-expect-error -- `x` may be a literal, and then nothing types the product
  s.mul(x, 2n);
  return product;
}
export const sum = <n extends NumericType>(s: ScriptBuilder, a: Expr<n>, b: Expr<n>): Expr<n> =>
  s.add(a, b);

/** A generic helper forwards an `IntoExpr` operand of its type parameter next to an `Expr`, on
 *  either side, as the method form does; next to a literal it is refused, as for a concrete
 *  type. */
export function isAbove<n extends NumericType>(
  s: ScriptBuilder,
  x: Expr<n>,
  threshold: IntoExpr<n>,
): Expr<'bool'> {
  return s.gt(x, threshold);
}
export function offset<n extends NumericType>(
  s: ScriptBuilder,
  x: Expr<n>,
  by: IntoExpr<n>,
): Expr<n> {
  return s.add(x, by);
}
export function isBelow<n extends NumericType>(
  s: ScriptBuilder,
  limit: IntoExpr<n>,
  x: Expr<n>,
): Expr<'bool'> {
  return s.gt(limit, x);
}
export function twice<n extends NumericType>(s: ScriptBuilder, x: IntoExpr<n>) {
  // @ts-expect-error -- `x` may be a literal, and then nothing types the product
  return s.mul(x, 2n);
}
export const generic = evscript(
  { name: 'generic', args: [t.uint256, t.int24] },
  (s, amount, tick) => {
    const above = isAbove(s, amount, 10n);
    const shifted = offset(s, tick, -60);
    const below = isBelow(s, tick, tick);
    expectType<Same<typeof shifted, Expr<'int24'>>>();
    return s.return({ above, shifted, below });
  },
);

/** The type expected of a result never types an operand: the literal branch stays a uint8. */
export const contextual: readonly (() => EvsScript)[] = [
  () =>
    evscript({ name: 'contextual', args: [t.bool, t.uint8] }, (s, ok, decimals) =>
      s.return({ decimals: s.select(ok, decimals, 18), next: s.add(1, decimals) }),
    ),
];

/** `toUint` / `toInt` convert between numeric types: any other receiver is an error. */
export const receivers = evscript(
  { name: 'receivers', args: [t.address, t.bytes4, t.bool, t.uint64] },
  (s, who, selector, flag, n) => {
    // @ts-expect-error -- an address converts through .asUint160() first
    who.toUint(t.uint256);
    // @ts-expect-error -- a bytesN through .asUint() first
    selector.toInt(t.int64);
    // @ts-expect-error -- a bool through s.select(flag, s.lit(type, 1), 0)
    flag.toUint(t.uint8);
    const asNumber = s.select(flag, s.lit(t.uint8, 1), 0);
    expectType<Same<typeof asNumber, Expr<'uint8'>>>();
    return s.return({ narrowed: n.toUint(t.uint8), asNumber });
  },
);
