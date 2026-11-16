/* oxlint-disable vitest/expect-expect --
 * a rejection test asserts through `@ts-expect-error`: the directive fails the type check when
 * the line below it compiles. */
/**
 * Type tests of the two-operand operators on `s` (`s.add(a, b)`, …, `s.select`), of
 * `s.let(type, init)` and of the typed `s.for` range: one operand gives the operation its type
 * and the other is checked against it, so what recording refuses is a type error first, on the
 * operand that is wrong. Runs under the vitest `types` project (typecheck only).
 *
 * A call is spread over several lines where the test is about which operand the error is on: a
 * `@ts-expect-error` covers the next line only.
 */
import { expectTypeOf, test } from 'vite-plus/test';

import { t, type Expr, type IntoExpr, type NumericType } from '../core/types.js';
import { evscript, type Cell, type EvsScript, type ScriptBuilder, type Tuple } from './script.js';
import type { ExprNeeded, FirstOperand, SecondOperand } from './script/builder.js';

const Pair = t.struct({ fee: t.uint24, pool: t.address });
const ONE = '0x0000000000000000000000000000000000000001';

test('the operation takes the type of the operand that is an Expr, on either side', () => {
  evscript(
    { name: 'sides', args: [t.uint256, t.uint8, t.int24, t.address, t.bytes4, t.bool, t.string] },
    (s, u256, u8, i24, who, b4, flag, str) => {
      expectTypeOf(s.add(u256, 1n)).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(s.add(1, u8)).toEqualTypeOf<Expr<'uint8'>>();
      expectTypeOf(s.sub(100n, u256)).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(s.mul(i24, i24)).toEqualTypeOf<Expr<'int24'>>();
      expectTypeOf(s.div(-1, i24)).toEqualTypeOf<Expr<'int24'>>();
      expectTypeOf(s.mod(u8, 7)).toEqualTypeOf<Expr<'uint8'>>();
      expectTypeOf(s.wrappingAdd(u8, u8)).toEqualTypeOf<Expr<'uint8'>>();
      expectTypeOf(s.wrappingSub(0n, u256)).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(s.wrappingMul(i24, -1)).toEqualTypeOf<Expr<'int24'>>();
      expectTypeOf(s.lt(u256, 10n)).toEqualTypeOf<Expr<'bool'>>();
      expectTypeOf(s.gt(ONE, who)).toEqualTypeOf<Expr<'bool'>>();
      expectTypeOf(s.lte(b4, b4)).toEqualTypeOf<Expr<'bool'>>();
      expectTypeOf(s.gte(0, i24)).toEqualTypeOf<Expr<'bool'>>();
      expectTypeOf(s.eq(str, 'WETH')).toEqualTypeOf<Expr<'bool'>>();
      expectTypeOf(s.neq('WETH', str)).toEqualTypeOf<Expr<'bool'>>();
      expectTypeOf(s.eq(who, ONE)).toEqualTypeOf<Expr<'bool'>>();
      expectTypeOf(s.and(flag, true)).toEqualTypeOf<Expr<'bool'>>();
      expectTypeOf(s.or(false, flag)).toEqualTypeOf<Expr<'bool'>>();
      expectTypeOf(s.bitAnd(u256, 0xffn)).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(s.bitOr('0x000000ff', b4)).toEqualTypeOf<Expr<'bytes4'>>();
      expectTypeOf(s.bitXor(u8, u8)).toEqualTypeOf<Expr<'uint8'>>();
      expectTypeOf(s.select(flag, u8, 18)).toEqualTypeOf<Expr<'uint8'>>();
      expectTypeOf(s.select(flag, 18, u8)).toEqualTypeOf<Expr<'uint8'>>();
      expectTypeOf(s.select(true, str, 'none')).toEqualTypeOf<Expr<'string'>>();
      return s.return({ ok: flag });
    },
  );
});

test('two Exprs of different types: the error is on the second operand', () => {
  evscript(
    { name: 'mixed', args: [t.uint256, t.uint8, t.int256, t.address, t.bytes32, t.bool, t.string] },
    (s, u256, u8, i256, who, b32, flag, str) => {
      s.add(
        u256,
        // @ts-expect-error — uint8 is not uint256: widths never match implicitly
        u8,
      );
      s.sub(
        u8,
        // @ts-expect-error — nor the other way round
        u256,
      );
      s.mul(
        u256,
        // @ts-expect-error — signedness
        i256,
      );
      s.wrappingAdd(
        u256,
        // @ts-expect-error — the wrapping forms too
        u8,
      );
      s.lt(
        u256,
        // @ts-expect-error — an address does not order against a number
        who,
      );
      s.gte(
        who,
        // @ts-expect-error — nor against a bytes32
        b32,
      );
      s.eq(
        u256,
        // @ts-expect-error — a word against a string
        str,
      );
      s.neq(
        flag,
        // @ts-expect-error — a bool against a number
        u8,
      );
      s.bitAnd(
        u256,
        // @ts-expect-error — uint8 is not uint256
        u8,
      );
      s.bitXor(
        b32,
        // @ts-expect-error — a bytes32 against a uint256
        u256,
      );
      s.select(
        flag,
        u256,
        // @ts-expect-error — the branches have one type
        u8,
      );
      return s.return({ ok: flag });
    },
  );
});

test('a literal is checked against the type of the Expr operand', () => {
  evscript(
    { name: 'literals', args: [t.uint256, t.address, t.bool, t.string] },
    (s, u256, who, flag, str) => {
      s.add(
        u256,
        // @ts-expect-error — a hex string is not a number
        '0x12',
      );
      s.add(
        // @ts-expect-error — in first position either
        '0x12',
        u256,
      );
      s.eq(
        who,
        // @ts-expect-error — an address literal is a hex string
        1n,
      );
      s.and(
        flag,
        // @ts-expect-error — a bool literal is a boolean
        1,
      );
      s.select(
        flag,
        str,
        // @ts-expect-error — a string branch takes a string
        0n,
      );
      return s.return({ ok: flag });
    },
  );
});

test('two literals: no operand types the operation, and the error says what to write', () => {
  evscript({ name: 'untyped', args: [t.bool] }, (s, flag) => {
    // @ts-expect-error — the type comes from an Expr operand
    s.add(1n, 2n);
    // @ts-expect-error — s.lt too
    s.lt(1n, 2n);
    // @ts-expect-error — even for strings, whose literal has one type
    s.eq('a', 'b');
    // @ts-expect-error — and for bools
    s.and(true, false);
    // @ts-expect-error — s.bitAnd
    s.bitAnd(1n, 2n);
    // @ts-expect-error — two literal branches
    s.select(flag, 1n, 2n);
    // typing one side is enough
    expectTypeOf(s.add(s.lit(t.uint8, 1), 2)).toEqualTypeOf<Expr<'uint8'>>();
    expectTypeOf(s.select(flag, s.lit(t.uint256, 1n), 0n)).toEqualTypeOf<Expr<'uint256'>>();
    return s.return({ ok: flag });
  });
  // what the operands meet then is the recorder's message
  type Hint = 'at least one operand must be an Expr — type a literal with s.lit(type, value)';
  expectTypeOf<ExprNeeded<'operand'>>().toEqualTypeOf<Hint>();
  expectTypeOf<ExprNeeded<'equality'>>().toEqualTypeOf<Hint>();
  expectTypeOf<
    ExprNeeded<'branch'>
  >().toEqualTypeOf<'at least one branch must be an Expr — type a literal with s.lit(type, value)'>();
  expectTypeOf<FirstOperand<never, never>>().toEqualTypeOf<Expr<never> | Hint>();
  expectTypeOf<SecondOperand<never, never>>().toEqualTypeOf<Expr<never> | Hint>();
  // and nothing more once an operand gave a type
  expectTypeOf<FirstOperand<'uint8', never>>().toEqualTypeOf<Expr<'uint8'>>();
  expectTypeOf<FirstOperand<never, 'uint8'>>().toEqualTypeOf<Expr<never> | bigint | number>();
  expectTypeOf<SecondOperand<'uint8', never>>().toEqualTypeOf<IntoExpr<'uint8'>>();
  expectTypeOf<SecondOperand<never, 'uint8'>>().toEqualTypeOf<Expr<'uint8'>>();
});

test('the operator domains: numeric, ordered, bool, bits', () => {
  evscript(
    { name: 'domains', args: [t.address, t.bool, t.string, t.uint256] },
    (s, who, flag, str, u256) => {
      s.add(
        // @ts-expect-error — arithmetic is numeric
        who,
        1n,
      );
      s.add(
        1n,
        // @ts-expect-error — whichever side the Expr is on
        who,
      );
      s.lt(
        // @ts-expect-error — a bool has no order
        flag,
        true,
      );
      s.and(
        // @ts-expect-error — logic is on bools
        u256,
        u256,
      );
      s.bitOr(
        // @ts-expect-error — no bit operation on an address
        who,
        who,
      );
      s.bitAnd(
        // @ts-expect-error — nor on a string
        str,
        str,
      );
      return s.return({ ok: flag });
    },
  );
});

test('s.eq / s.neq take a bare Tuple or MutArray handle for its memref, like the recorder', () => {
  evscript({ name: 'handles', args: [Pair, t.array(t.uint256), t.uint256] }, (s, pair, arr, n) => {
    const mut = s.newArray(t.uint256, 2n);
    const cell = s.let(t.uint256, 1n);
    expectTypeOf(s.eq(pair, pair)).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(s.eq(pair, pair.expr())).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(s.neq(pair.expr(), pair)).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(s.eq(pair, { fee: 500, pool: ONE })).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(s.eq({ fee: 500, pool: ONE }, pair)).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(s.eq(arr, mut)).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(s.eq(mut, arr)).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(s.neq(mut, [1n, 2n])).toEqualTypeOf<Expr<'bool'>>();
    s.eq(
      pair,
      // @ts-expect-error — a struct against an array
      mut,
    );
    s.eq(
      pair,
      // @ts-expect-error — a struct literal is a record of its members
      1n,
    );
    s.eq(
      // @ts-expect-error — a Cell is not a value: read it with .get()
      cell,
      1n,
    );
    s.eq(
      // @ts-expect-error — nor is a Field
      pair.fee,
      500,
    );
    s.eq(
      n,
      // @ts-expect-error — on the second side either
      cell,
    );
    expectTypeOf(s.eq(cell.get(), 1n)).toEqualTypeOf<Expr<'bool'>>();
    expectTypeOf(s.eq(pair.fee.get(), 500)).toEqualTypeOf<Expr<'bool'>>();
    // a branch of s.select is a bare handle too, and a struct result is a Tuple handle
    expectTypeOf(s.select(true, pair, pair)).toEqualTypeOf<Tuple<typeof Pair>>();
    expectTypeOf(s.select(true, pair.expr(), pair.expr())).toEqualTypeOf<Tuple<typeof Pair>>();
    expectTypeOf(s.select(true, mut, arr)).toEqualTypeOf<Expr<'uint256[]'>>();
    // the other operators take the memref itself
    s.add(
      // @ts-expect-error — a bare handle is not an operand
      mut,
      n,
    );
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

test('bitwise operators take intN: the result is of the operand type', () => {
  evscript(
    { name: 'signedBits', args: [t.int24, t.int256, t.int8, t.address, t.bool] },
    (s, i24, i256, i8, who, flag) => {
      expectTypeOf(i24.bitAnd(0xff)).toEqualTypeOf<Expr<'int24'>>();
      expectTypeOf(i24.bitOr(i24)).toEqualTypeOf<Expr<'int24'>>();
      expectTypeOf(i256.bitXor(-1n)).toEqualTypeOf<Expr<'int256'>>();
      expectTypeOf(i8.bitNot()).toEqualTypeOf<Expr<'int8'>>();
      expectTypeOf(s.bitAnd(i24, -256)).toEqualTypeOf<Expr<'int24'>>();
      expectTypeOf(s.bitOr(1, i8)).toEqualTypeOf<Expr<'int8'>>();
      expectTypeOf(s.bitXor(i256, i256)).toEqualTypeOf<Expr<'int256'>>();
      expectTypeOf(s.bitNot(i24)).toEqualTypeOf<Expr<'int24'>>();
      // as the shifts do
      expectTypeOf(i24.shl(1n)).toEqualTypeOf<Expr<'int24'>>();
      expectTypeOf(s.shr(i256, 8n)).toEqualTypeOf<Expr<'int256'>>();
      // @ts-expect-error — widths still never match implicitly
      i24.bitAnd(i8);
      // @ts-expect-error — an address has no bit operation
      who.bitAnd(who);
      // @ts-expect-error — nor a bool
      flag.bitNot();
      // @ts-expect-error — nor a shift
      who.shl(1n);
      return s.return({ ok: flag });
    },
  );
});

test('s.let(type, init): the cell is of `type`, and `init` is checked against it', () => {
  evscript({ name: 'cells', args: [t.uint256, t.array(t.uint256)] }, (s, u256, arr) => {
    expectTypeOf(s.let(t.int8, -1)).toEqualTypeOf<Cell<'int8'>>();
    expectTypeOf(s.let(t.uint256, u256)).toEqualTypeOf<Cell<'uint256'>>();
    expectTypeOf(s.let(t.array(t.uint256), arr)).toEqualTypeOf<Cell<'uint256[]'>>();
    expectTypeOf(s.let(Pair, { fee: 500, pool: ONE })).toEqualTypeOf<Cell<typeof Pair>>();
    s.let(
      t.int8,
      // @ts-expect-error — a uint256 does not initialize an int8 cell
      u256,
    );
    s.let(
      t.address,
      // @ts-expect-error — nor an address cell
      u256,
    );
    s.let(
      t.uint256,
      // @ts-expect-error — nor an array a word cell
      arr,
    );
    // @ts-expect-error — the cell's type is not the union of the two
    const widened: Cell<'int8' | 'uint256'> = s.let(t.int8, u256);
    void widened;
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

test('s.for with a type: the bounds are checked against it', () => {
  evscript({ name: 'ranges', args: [t.uint256, t.uint8] }, (s, u256, u8) => {
    s.for({ type: t.uint8, from: 0, until: u8 }, (i) => {
      expectTypeOf(i).toEqualTypeOf<Expr<'uint8'>>();
    });
    // @ts-expect-error — a uint256 bound on a uint8 counter
    s.for({ type: t.uint8, from: 0, until: u256 }, () => {});
    // @ts-expect-error — nor a uint256 step
    s.for({ type: t.uint8, from: 0, until: 10, step: u256 }, () => {});
    return s.return({ ok: s.lit(t.bool, true) });
  });
});

test('an operand typed IntoExpr works next to an Expr, and not next to a literal', () => {
  const scale = (s: ScriptBuilder, x: IntoExpr<'uint256'>, by: Expr<'uint256'>) => {
    expectTypeOf(s.mul(x, by)).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(s.mul(by, x)).toEqualTypeOf<Expr<'uint256'>>();
    // @ts-expect-error — `x` may be a literal, and then nothing types the product
    s.mul(x, 2n);
  };
  void scale;
});

test('a generic helper keeps its type parameter', () => {
  const sum = <n extends NumericType>(s: ScriptBuilder, a: Expr<n>, b: Expr<n>): Expr<n> =>
    s.add(a, b);
  const pick = <n extends NumericType>(s: ScriptBuilder, c: Expr<'bool'>, a: Expr<n>, b: Expr<n>) =>
    s.select(c, a, b);
  expectTypeOf(sum).returns.toEqualTypeOf<Expr<NumericType>>();
  expectTypeOf(pick<'uint8'>).returns.toEqualTypeOf<Expr<'uint8'>>();
});

test('a generic helper forwards an IntoExpr operand of its type parameter next to an Expr', () => {
  // a threshold or an offset given by the caller, a literal or an Expr: the method form takes
  // it, and so does recording
  const isAbove = <n extends NumericType>(s: ScriptBuilder, x: Expr<n>, threshold: IntoExpr<n>) =>
    s.gt(x, threshold);
  const offset = <n extends NumericType>(s: ScriptBuilder, x: Expr<n>, by: IntoExpr<n>): Expr<n> =>
    s.add(x, by);
  const below = <n extends NumericType>(s: ScriptBuilder, limit: IntoExpr<n>, x: Expr<n>) =>
    s.gt(limit, x);
  const either = <n extends 'bool'>(s: ScriptBuilder, x: Expr<n>, y: IntoExpr<n>) => s.or(x, y);
  const masked = <n extends 'uint8' | 'bytes4'>(s: ScriptBuilder, x: Expr<n>, mask: IntoExpr<n>) =>
    s.bitAnd(x, mask);
  expectTypeOf(isAbove<'uint256'>).returns.toEqualTypeOf<Expr<'bool'>>();
  expectTypeOf(offset<'int24'>).returns.toEqualTypeOf<Expr<'int24'>>();
  expectTypeOf(below<'uint8'>).returns.toEqualTypeOf<Expr<'bool'>>();
  expectTypeOf(either<'bool'>).returns.toEqualTypeOf<Expr<'bool'>>();
  expectTypeOf(masked<'bytes4'>).returns.toEqualTypeOf<Expr<'bytes4'>>();
  // next to a literal it is refused, as for a concrete type: `x` may be a literal too
  const twice = <n extends NumericType>(s: ScriptBuilder, x: IntoExpr<n>) =>
    // @ts-expect-error — nothing types the product when `x` is a literal
    s.mul(x, 2n);
  // a literal of the helper's own is not: the checker cannot tell it fits `n` before `n` is known
  const plusOne = <n extends NumericType>(s: ScriptBuilder, x: Expr<n>) =>
    // @ts-expect-error — `1n` against `LitOf<n>`, a type not resolved yet
    s.add(x, 1n);
  void [twice, plusOne];
  evscript({ name: 'generic', args: [t.uint256, t.int24] }, (s, amount, tick) =>
    s.return({ above: isAbove(s, amount, 10n), shifted: offset(s, tick, -60) }),
  );
});

test('the type expected of the result never types an operand', () => {
  // the callback's return is contextually typed by EvsScript (any return record): the literal
  // branch must not take its type from there
  const corpus: readonly (() => EvsScript)[] = [
    () =>
      evscript({ name: 'ctx', args: [t.bool, t.uint8] }, (s, ok, decimals) =>
        s.return({ decimals: s.select(ok, decimals, 18), next: s.add(1, decimals) }),
      ),
  ];
  void corpus;
  evscript({ name: 'ctx2', args: [t.bool, t.uint8] }, (s, ok, decimals) => {
    const wide: Expr = s.select(ok, 18, decimals);
    expectTypeOf(s.select(ok, 18, decimals)).toEqualTypeOf<Expr<'uint8'>>();
    return s.return({ wide });
  });
});
