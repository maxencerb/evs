import { parseAbi } from 'viem';

/**
 * Struct values as an app reads them: a struct out of `Cell.get()`, `s.select()` and `s.lit()`
 * is a `Tuple` handle with its members, and the positions that take a value of a type
 * (`s.lit`, `s.let`, `Cell.set`, `s.select`, `eq`, the struct slots) take what recording
 * coerces. Also here: the length of a fixed-size array literal, `s.tuple`'s type,
 * `s.encodePacked`'s values, and the callbacks the builder runs while it records, which must be
 * synchronous. A `@ts-expect-error` covers the next line only, so each refused call is on one.
 */
import {
  evscript,
  t,
  type Cell,
  type Expr,
  type NumericType,
  type ScriptBuilder,
  type Tuple,
} from '@maxencerb/evs';

import { expectType, type Same } from './assert.js';

const Position = t.struct({ owner: t.address, amount: t.uint256 });
const Nest = t.struct({ inner: Position, n: t.uint256 });
const OWNER = '0x00000000000000000000000000000000000000aa';
const abi = parseAbi([
  'struct Pos { address owner; uint256 amount; }',
  'function take(Pos[] ps) view returns (uint256)',
  'function fixed3(uint8[3] xs) view returns (uint256)',
]);

/** A struct kept in a cell and picked with `s.select`: members are read on each. */
export const kept = evscript(
  { name: 'kept', args: [t.bool, Position, Position, t.address] },
  (s, first, a, b, target) => {
    const cell = s.let(Position, b);
    s.if(first, () => cell.set(a));
    const fromCell = cell.get();
    const picked = s.select(first, a, b);
    const pickedExpr = s.select(first, a.expr(), b.expr());
    const lit = s.lit(Position, { owner: a.owner.get(), amount: 1n });
    expectType<Same<typeof fromCell, Tuple<typeof Position>>>();
    expectType<Same<typeof picked, Tuple<typeof Position>>>();
    expectType<Same<typeof lit, Tuple<typeof Position>>>();
    const amount = fromCell.amount.get();
    const owner = pickedExpr.owner.get();
    expectType<Same<typeof amount, Expr<'uint256'>>>();
    expectType<Same<typeof owner, Expr<'address'>>>();
    // an Expr of the struct fits a struct slot
    s.tuple(Nest, { inner: lit.expr() });
    s.read({ address: target, abi, functionName: 'take', args: [[a.expr(), lit, cell.get()]] });
    // a struct literal with staged members, and bare handles, where the coercion takes them
    s.let(Position, { owner: a.owner.get(), amount });
    cell.set({ owner, amount: 2n });
    s.select(first, a.expr(), { owner, amount });
    const same = a.expr().eq(b);
    expectType<Same<typeof same, Expr<'bool'>>>();
    return s.return({ amount, owner, picked, same: s.eq(fromCell, picked) });
  },
);

/** A cell of a type parameter keeps an `Expr` snapshot. */
export function bump<n extends NumericType>(cell: Cell<n>): Expr<n> {
  cell.set(cell.get().add(cell.get()));
  return cell.get();
}

/** `s.let(type, init)` of a type parameter takes an `Expr` of it. */
export function keep<n extends NumericType>(s: ScriptBuilder, type: n, init: Expr<n>): Cell<n> {
  return s.let(type, init);
}

/** What the types refuse in those positions, as recording does. */
export const refused = evscript(
  { name: 'refused', args: [t.bool, Position, t.array(t.string), t.address] },
  (s, flag, a, strs, target) => {
    // @ts-expect-error -- a fixed-size literal of the wrong length
    s.lit(t.array(t.uint256, 3), [1n]);
    // @ts-expect-error -- an argument too
    s.read({ address: target, abi, functionName: 'fixed3', args: [[1, 2]] });
    // @ts-expect-error -- a tuple array is not a tuple
    s.tuple(t.array(Position));
    // @ts-expect-error -- abi.encodePacked takes no string[]
    s.encodePacked(strs);
    // @ts-expect-error -- nor a struct
    s.encodePacked(a.expr());
    // @ts-expect-error -- a struct literal names every member
    s.let(Position, { amount: 1n });
    // @ts-expect-error -- a word literal is a constant
    s.lit(t.uint256, a.amount.get());
    return s.return({ ok: flag });
  },
);

/** The callbacks the builder runs must be synchronous. */
export const callbacks = evscript(
  { name: 'callbacks', args: [t.bool, t.array(t.uint256), t.array(Position)] },
  (s, flag, xs, positions) => {
    const c = s.let(t.uint256, 0n);
    s.if(flag, () => c.set(1n));
    s.if(
      flag,
      () => c.get(),
      () => undefined,
    );
    s.while(
      () => c.get().lt(2n),
      () => c.set(c.get().add(1n)),
    );
    s.for({ from: 0n, until: 2n }, (i) => c.set(i));
    s.forEach(xs, (x) => c.set(x));
    s.forEach(positions, (p) => c.set(p.amount.get()));
    // @ts-expect-error -- an async branch
    s.if(flag, async () => c.set(2n));
    s.while(
      () => flag,
      // @ts-expect-error -- an async loop body
      async () => {},
    );
    // @ts-expect-error -- an async counter body
    s.for({ from: 0n, until: 2n }, async () => {});
    // @ts-expect-error -- an async counter body, typed range
    s.for({ type: t.uint8, from: 0, until: 2 }, async () => {});
    // @ts-expect-error -- an async element body
    s.forEach(xs, async () => {});
    // @ts-expect-error -- an async element body, over a struct array
    s.forEach(positions, async () => {});
    // @ts-expect-error -- a generator branch
    s.if(flag, function* () {});
    return s.return({ c: c.get() });
  },
);

void OWNER;
