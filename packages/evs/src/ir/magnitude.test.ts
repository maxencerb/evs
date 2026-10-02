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

  test('growth reaches a value through a chain of cells written backwards', () => {
    // each loop pass moves a bound one cell down the chain: the worklist must re-run the
    // readers of every cell that grows, not stop after one pass over the statements
    const chain = (grow: (x: Expr<'uint256'>) => Expr<'uint256'>): number =>
      boundOf(
        evscript({ name: 'a', args: [t.array(t.address)] }, (s, xs) => {
          const cells = Array.from({ length: 40 }, () => s.let(t.uint256, 1n));
          const last = cells[cells.length - 1];
          if (last === undefined) throw new Error('no cells');
          s.forEach(xs, () => {
            cells.forEach((cell, i) => {
              const next = cells[i + 1];
              if (next !== undefined) cell.set(next.get());
            });
            last.set(grow(last.get()));
          });
          const first = cells[0];
          if (first === undefined) throw new Error('no cells');
          return s.return({ x: first.get() });
        }),
      );
    expect(chain((x) => x.mul(2n))).toBe(256);
    expect(chain((x) => x.add(1n))).toBe(1 + 64);
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

  test('shr by a runtime amount keeps the bound; shl by one is the full width', () => {
    const shifted = (op: 'shl' | 'shr'): number =>
      boundOf(
        evscript({ name: 'a', args: [t.uint64, t.uint8] }, (s, x, k) =>
          s.return({ r: s[op](x.toUint(t.uint256), k.toUint(t.uint256)) }),
        ),
      );
    expect(shifted('shr')).toBe(64);
    expect(shifted('shl')).toBe(256);
  });

  test('pow by a runtime exponent is the full width (a base of 0 or 1 excepted)', () => {
    expect(
      boundOf(
        evscript({ name: 'a', args: [t.uint8, t.uint8] }, (s, x, e) =>
          s.return({ r: x.toUint(t.uint256).pow(e.toUint(t.uint256)) }),
        ),
      ),
    ).toBe(256);
    expect(
      boundOf(
        evscript({ name: 'a', args: [t.bool, t.uint8] }, (s, b, e) =>
          s.return({ r: s.select(b, s.lit(t.uint256, 1n), 0n).pow(e.toUint(t.uint256)) }),
        ),
      ),
    ).toBe(1);
  });

  test('select joins both branches', () => {
    const picked = (bigFirst: boolean): number =>
      boundOf(
        evscript({ name: 'a', args: [t.bool, t.uint256] }, (s, flag, big) =>
          s.return({ r: bigFirst ? s.select(flag, big, 1n) : s.select(flag, 1n, big) }),
        ),
      );
    expect(picked(true)).toBe(256);
    expect(picked(false)).toBe(256);
  });

  test('mulDiv is bounded by the product, addmod and mulmod by the modulus', () => {
    const modArith = (op: (x: Expr<'uint256'>, big: Expr<'uint256'>) => Expr<'uint256'>): number =>
      boundOf(
        evscript({ name: 'a', args: [t.uint64, t.uint256] }, (s, x, big) =>
          s.return({ r: op(x.toUint(t.uint256), big) }),
        ),
      );
    expect(modArith((x) => x.mulDiv(x, 1n))).toBe(128);
    expect(modArith((x) => x.mulDiv(x, x))).toBe(128);
    expect(modArith((_, big) => big.addmod(big, 1000n))).toBe(10);
    expect(modArith((_, big) => big.mulmod(big, 1000n))).toBe(10);
  });

  test('unsigned bit operations are bounded by their operands; signed ones are not', () => {
    const unsigned = (op: 'bitAnd' | 'bitOr' | 'bitXor'): number =>
      boundOf(
        evscript({ name: 'a', args: [t.uint8, t.uint64] }, (s, a, b) =>
          s.return({ r: s[op](a.toUint(t.uint256), b.toUint(t.uint256)) }),
        ),
      );
    expect(unsigned('bitAnd')).toBe(8);
    expect(unsigned('bitOr')).toBe(64);
    expect(unsigned('bitXor')).toBe(64);
    // -1 has a 0-bit magnitude, yet -1 & x is x: a signed bit op is the full width (the typed
    // API takes uintN/bytesN only, but untyped JS reaches the recorder, and the IR allows intN)
    const signed = (op: 'bitAnd' | 'bitOr' | 'bitXor'): number =>
      boundOf(
        evscript({ name: 'a', args: [t.int8] }, (s, x) => {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped caller input
          const bit = s[op] as unknown as (a: Expr<'int256'>, b: Expr<'int256'>) => Expr<'int256'>;
          return s.return({ r: bit(s.lit(t.int256, -1n), x.toInt(t.int256)) });
        }),
      );
    expect(signed('bitAnd')).toBe(255);
    expect(signed('bitOr')).toBe(255);
    expect(signed('bitXor')).toBe(255);
  });

  test('a member other than the leading one is the full width, whatever its init', () => {
    const Pair = t.struct({ a: t.uint256, b: t.uint256 });
    const script = evscript({ name: 'a', args: [] }, (s) => {
      const pair = s.tuple(Pair, { a: 1n, b: 2n });
      return s.return({ b: pair.b.get() });
    });
    expect(boundOf(script)).toBe(256);
  });

  test('a write to any element of a fixed array joins the array bound', () => {
    const write = (index: bigint): number =>
      boundOf(
        evscript({ name: 'a', args: [t.uint256] }, (s, big) => {
          const xs = s.newArray(t.uint256, 2, { fixed: true });
          xs.set(index, big);
          return s.return({ xs: xs.expr() });
        }),
      );
    expect(write(0n)).toBe(256);
    expect(write(1n)).toBe(256); // the index is not tracked: any write may be element 0
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
