/**
 * Type tests of struct values and of the positions that take a value of a given type: what a
 * struct comes back as out of `Cell.get()`, `s.select()` and `s.lit()` (a `Tuple` handle, like
 * every other struct value), what `s.lit`, `s.let`, `Cell.set`, `s.select`, `eq` and the struct
 * slots accept (what the recorder's coercion takes), the length of a fixed-size array literal,
 * `s.tuple`'s type, `s.encodePacked`'s values, and the callbacks the builder runs while it
 * records. Typecheck only: `struct-values.test.ts` holds the recording side.
 */
import { parseAbi } from 'viem';
import { expectTypeOf, test } from 'vite-plus/test';

import { t, type Expr, type NumericType } from '../core/types.js';
import { evscript, type Cell, type ScriptBuilder, type Tuple } from './script.js';

const S = t.struct({ a: t.uint256, b: t.address });
const N = t.struct({ inner: S, n: t.uint256 });
const ADDR = '0x00000000000000000000000000000000000000aa';
const abi = parseAbi([
  'struct In { uint256 a; address b; }',
  'struct Nest { In inner; uint256 n; }',
  'function nest(Nest n) view returns (uint256)',
  'function arr(In[] ps) view returns (uint256)',
  'function fixed3(uint8[3] xs) view returns (uint256)',
]);

test('a struct out of Cell.get, s.select and s.lit is a Tuple handle with its members', () => {
  evscript({ name: 'p', args: [t.bool, S, S] }, (s, flag, x, y) => {
    const cell = s.let(S, x.expr());
    expectTypeOf(cell.get()).toEqualTypeOf<Tuple<typeof S>>();
    expectTypeOf(cell.get().a.get()).toEqualTypeOf<Expr<'uint256'>>();
    const picked = s.select(flag, x, y);
    expectTypeOf(picked).toEqualTypeOf<Tuple<typeof S>>();
    expectTypeOf(s.select(flag, x.expr(), y.expr()).b.get()).toEqualTypeOf<Expr<'address'>>();
    // a selected struct is selected again
    expectTypeOf(s.select(flag, picked, cell.get()).a.get()).toEqualTypeOf<Expr<'uint256'>>();
    const lit = s.lit(S, { a: 1n, b: ADDR });
    expectTypeOf(lit).toEqualTypeOf<Tuple<typeof S>>();
    // anything else stays an Expr: a word, a string, an array, a tuple array
    expectTypeOf(s.let(t.uint256, 1n).get()).toEqualTypeOf<Expr<'uint256'>>();
    expectTypeOf(s.select(flag, s.lit(t.string, 'a'), 'b')).toEqualTypeOf<Expr<'string'>>();
    const List = t.array(S);
    expectTypeOf(s.lit(List, [x])).toEqualTypeOf<Expr<typeof List>>();
    expectTypeOf(s.let(t.array(t.uint8), [1]).get()).toEqualTypeOf<Expr<'uint8[]'>>();
    // a cell of a struct also takes one back through its one-argument form
    expectTypeOf(s.let(cell.get())).toEqualTypeOf<Cell<typeof S>>();
    return s.return({ a: picked.a.get(), lit });
  });
});

test('a cell of a type parameter keeps an Expr snapshot, and takes an Expr of that type', () => {
  const inc = <n extends NumericType>(c: Cell<n>): void => {
    c.set(c.get().add(c.get()));
  };
  const make = <n extends NumericType>(s: ScriptBuilder, type: n, init: Expr<n>): Expr<n> =>
    s.let(type, init).get();
  expectTypeOf(inc).parameter(0).toEqualTypeOf<Cell<NumericType>>();
  expectTypeOf(make<'uint8'>).returns.toEqualTypeOf<Expr<'uint8'>>();
});

test('an Expr of a struct fits wherever a struct value of its type is taken', () => {
  evscript({ name: 'p', args: [S, t.address] }, (s, x, target) => {
    const e = x.expr();
    s.read({ address: target, abi, functionName: 'nest', args: [{ inner: e, n: 1n }] });
    s.read({ address: target, abi, functionName: 'arr', args: [[e, x, { a: 1n, b: ADDR }]] });
    const n = s.tuple(N, { inner: e });
    n.inner.set(e);
    s.newArray(S, 1n).set(0n, e);
    const same = s.fn('same', [S], (p) => p);
    expectTypeOf(same(e)).toEqualTypeOf<Tuple<typeof S>>();
    // an Expr of another struct does not
    const O = t.struct({ z: t.bool });
    // @ts-expect-error — Expr<O> is not a value of S
    n.inner.set(s.lit(O, { z: true }).expr());
    return s.return({ n });
  });
});

test('s.lit, s.let, Cell.set and s.select take a struct or array as the coercion does', () => {
  evscript(
    { name: 'p', args: [t.uint256, t.address, S, t.array(S), t.array(t.uint256), t.bool] },
    (s, u256, addr, tup, tarr, arr, flag) => {
      const marr = s.newArray(t.uint256, 2n);
      const smarr = s.newArray(S, 1n);
      s.lit(S, { a: u256, b: ADDR });
      s.lit(t.array(S), [tup, { a: u256, b: addr }]);
      s.let(S, tup);
      s.let(S, { a: u256, b: addr });
      s.let(t.array(S), [tup]);
      s.let(t.array(S), smarr);
      s.let(t.array(t.uint256), marr);
      const sc = s.let(S, tup.expr());
      expectTypeOf(sc).toEqualTypeOf<Cell<typeof S>>();
      sc.set(tup);
      sc.set({ a: u256, b: ADDR });
      const ac = s.let(t.array(t.uint256), arr);
      ac.set(marr);
      s.select(flag, tup.expr(), { a: u256, b: ADDR });
      s.select(flag, { a: 1n, b: addr }, tup);
      s.select(flag, tarr, [tup]);
      // a word, string or bytes literal stays a constant
      // @ts-expect-error — s.lit of a word takes a literal, not an Expr
      s.lit(t.uint256, u256);
      // @ts-expect-error — a struct literal names every member
      s.let(S, { a: u256 });
      // @ts-expect-error — a member of the wrong type
      sc.set({ a: addr, b: ADDR });
      return s.return({ ok: flag });
    },
  );
});

test('the method form of eq takes what s.eq takes', () => {
  evscript(
    { name: 'p', args: [S, t.array(t.uint256), t.string, t.uint256] },
    (s, tup, arr, str, n) => {
      const marr = s.newArray(t.uint256, 2n);
      expectTypeOf(tup.expr().eq(tup)).toEqualTypeOf<Expr<'bool'>>();
      expectTypeOf(tup.expr().neq({ a: n, b: ADDR })).toEqualTypeOf<Expr<'bool'>>();
      expectTypeOf(arr.eq(marr)).toEqualTypeOf<Expr<'bool'>>();
      expectTypeOf(arr.eq([n, 1n])).toEqualTypeOf<Expr<'bool'>>();
      expectTypeOf(str.eq('WETH')).toEqualTypeOf<Expr<'bool'>>();
      expectTypeOf(n.eq(1n)).toEqualTypeOf<Expr<'bool'>>();
      // @ts-expect-error — a MutArray of another type
      arr.eq(s.newArray(t.uint8, 2n));
      // @ts-expect-error — a string against an array
      str.eq(arr);
      // @ts-expect-error — a word against a handle
      n.eq(tup);
      return s.return({ ok: s.eq(tup, tup) });
    },
  );
});

test('a fixed-size array literal has exactly N elements, up to 99', () => {
  evscript({ name: 'p', args: [t.address, t.uint256] }, (s, target, x) => {
    expectTypeOf(s.lit(t.array(t.uint256, 3), [1n, x, 3n])).toEqualTypeOf<Expr<'uint256[3]'>>();
    // @ts-expect-error — one element for three
    s.lit(t.array(t.uint256, 3), [1n]);
    s.read({ address: target, abi, functionName: 'fixed3', args: [[1, 2, 3]] });
    // @ts-expect-error — two elements for three
    s.read({ address: target, abi, functionName: 'fixed3', args: [[1, 2]] });
    s.lit(t.array(t.array(t.bool, 2), 2), [
      [true, false],
      [false, true],
    ]);
    // @ts-expect-error — the outer size of a nested fixed array too
    s.lit(t.array(t.array(t.bool, 2), 2), [[true, false]]);
    // past 99 the length is checked at recording only
    s.lit(t.array(t.uint256, 100), [1n]);
    return s.return({ x });
  });
});

test('s.tuple takes a struct or tuple type, not a tuple array', () => {
  evscript({ name: 'p', args: [t.uint256] }, (s, x) => {
    expectTypeOf(s.tuple(S, { a: x })).toEqualTypeOf<Tuple<typeof S>>();
    s.tuple(t.tuple(t.uint256, t.bool), [x, true]);
    // @ts-expect-error — a tuple ARRAY is built with s.newArray or given as a literal
    s.tuple(t.array(S));
    return s.return({ x });
  });
});

test('s.encodePacked takes what abi.encodePacked takes', () => {
  evscript(
    {
      name: 'p',
      args: [t.uint256, t.string, t.array(t.address), t.array(t.string), S, t.array(S)],
    },
    (s, n, str, addrs, strs, tup, tarr) => {
      expectTypeOf(
        s.encodePacked(
          n,
          str,
          addrs,
          s.newArray(t.bytes32, 2n),
          s.lit(t.array(t.uint8, 2), [1, 2]),
        ),
      ).toEqualTypeOf<Expr<'bytes'>>();
      // @ts-expect-error — a string[]
      s.encodePacked(strs);
      // @ts-expect-error — a tuple[]
      s.encodePacked(tarr);
      // @ts-expect-error — a struct, as a handle or its memref
      s.encodePacked(tup.expr());
      // @ts-expect-error — a MutArray of strings
      s.encodePacked(s.newArray(t.string, 1n));
      // @ts-expect-error — a nested array
      s.encodePacked(s.lit(t.array(t.array(t.uint256)), [[1n]]));
      return s.return({ ok: s.encode(strs, tup, tarr) });
    },
  );
});

test('a callback the builder runs must be synchronous', () => {
  evscript({ name: 'p', args: [t.bool, t.array(t.uint256), S] }, (s, flag, xs, tup) => {
    const c = s.let(t.uint256, 0n);
    // any synchronous result is accepted: nothing, an Expr, a handle, undefined, a number
    s.if(flag, () => c.set(1n));
    s.if(
      flag,
      () => c.get(),
      () => tup,
    );
    s.if(
      flag,
      () => undefined,
      () => 42,
    );
    s.while(
      () => c.get().lt(3n),
      (loop) => {
        c.set(c.get().add(1n));
        loop.break();
      },
    );
    s.for({ from: 0n, until: 2n }, (i) => c.set(i));
    s.for({ type: t.uint8, from: 0, until: 2 }, (i) => i);
    s.forEach(xs, (x, i) => {
      expectTypeOf(x).toEqualTypeOf<Expr<'uint256'>>();
      expectTypeOf(i).toEqualTypeOf<Expr<'uint256'>>();
    });
    // an async callback or a generator is refused
    // @ts-expect-error — async
    s.if(flag, async () => c.set(2n));
    s.if(
      flag,
      () => c.set(2n),
      // @ts-expect-error — async in the else branch
      async () => {},
    );
    // @ts-expect-error — a generator
    s.if(flag, function* () {
      yield 1;
    });
    s.while(
      () => flag,
      // @ts-expect-error — async loop body
      async () => {},
    );
    // @ts-expect-error — async counter body
    s.for({ from: 0n, until: 2n }, async () => {});
    // @ts-expect-error — async counter body, typed range
    s.for({ type: t.uint8, from: 0, until: 2 }, async () => {});
    // @ts-expect-error — async element body
    s.forEach(xs, async () => {});
    return s.return({ c: c.get() });
  });
});
