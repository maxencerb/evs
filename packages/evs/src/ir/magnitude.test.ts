/**
 * Unit tests — `ir/magnitude.ts`: the bit bounds behind `DEPLOYLESS_RESULT_PREFIX`, read off the
 * first returned value of small scripts (the diagnostic's own warn / no-warn classes are in
 * `deployless.test.ts`).
 */

import { describe, expect, test } from 'vite-plus/test';

import { evscript } from '../builder/script.js';
import { t, type Expr } from '../core/types.js';
import { magnitudeBits } from './magnitude.js';
import type { ScriptIr } from './nodes.js';

/** The bound of the script's first returned value. */
function boundOf(script: { readonly ir: ScriptIr }): number {
  const first = script.ir.returns[0];
  if (first === undefined) throw new Error('the script returns nothing');
  return magnitudeBits(script.ir)(first.value);
}

describe('magnitudeBits', () => {
  test('a literal is its own bit length; a negative int its magnitude', () => {
    expect(
      boundOf(evscript({ name: 'a', args: [] }, (s) => s.return({ x: s.lit(t.uint256, 255n) }))),
    ).toBe(8);
    expect(
      boundOf(evscript({ name: 'a', args: [] }, (s) => s.return({ x: s.lit(t.int256, -256n) }))),
    ).toBe(8);
    expect(
      boundOf(evscript({ name: 'a', args: [] }, (s) => s.return({ x: s.lit(t.int256, -257n) }))),
    ).toBe(9);
  });

  test('an argument is the full width of its type: N bits for uintN, N − 1 for intN', () => {
    expect(boundOf(evscript({ name: 'a', args: [t.uint256] }, (s, x) => s.return({ x })))).toBe(
      256,
    );
    expect(boundOf(evscript({ name: 'a', args: [t.int256] }, (s, x) => s.return({ x })))).toBe(255);
    expect(
      boundOf(
        evscript({ name: 'a', args: [t.uint64] }, (s, x) => s.return({ x: x.toUint(t.uint256) })),
      ),
    ).toBe(64);
  });

  test('an addition chain is bounded by its operands plus 64 bits, in a loop too', () => {
    const counter = evscript({ name: 'a', args: [t.array(t.address)] }, (s, xs) => {
      const n = s.let(t.uint256, 0n);
      s.forEach(xs, () => n.set(n.get().add(1n)));
      return s.return({ n: n.get() });
    });
    expect(boundOf(counter)).toBe(1 + 64);
    // a sum of two sums starts a new chain from their bounds
    const pairs = evscript({ name: 'a', args: [t.uint8, t.uint8] }, (s, a, b) => {
      const x = a.toUint(t.uint256);
      const y = b.toUint(t.uint256);
      return s.return({ z: x.add(y).add(x.add(y)) });
    });
    expect(boundOf(pairs)).toBe(8 + 64 + 64);
  });

  test('a value doubled in a loop reaches the full width', () => {
    const doubling = evscript({ name: 'a', args: [t.array(t.address)] }, (s, xs) => {
      const x = s.let(t.uint256, 1n);
      s.forEach(xs, () => x.set(x.get().add(x.get())));
      return s.return({ x: x.get() });
    });
    expect(boundOf(doubling)).toBe(256);
  });

  test('mul adds the bounds; div and shr by a literal remove bits; mod takes the smaller', () => {
    const ops = (op: (x: Expr<'uint256'>) => Expr<'uint256'>): number =>
      boundOf(
        evscript({ name: 'a', args: [t.uint64] }, (s, x) =>
          s.return({ r: op(x.toUint(t.uint256)) }),
        ),
      );
    expect(ops((x) => x.mul(x))).toBe(128);
    expect(ops((x) => x.div(256n))).toBe(56);
    expect(ops((x) => x.shr(8n))).toBe(56);
    expect(ops((x) => x.mod(1000n))).toBe(10);
    expect(ops((x) => x.pow(3n))).toBe(192);
  });

  test('a write to the leading member of any alias joins the tuple bound', () => {
    const Pair = t.struct({ a: t.uint256, b: t.address });
    const script = evscript({ name: 'a', args: [t.uint256] }, (s, big) => {
      const pair = s.tuple(Pair, { a: 1n });
      // the fn's param aliases `pair`: its write is visible through the returned tuple
      const poke = s.fn('poke', [Pair, t.uint256] as const, (p, v) => {
        p.a.set(v);
        return v;
      });
      poke(pair, big);
      return s.return({ pair });
    });
    expect(boundOf(script)).toBe(256);
  });
});
