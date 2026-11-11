/**
 * Unit tests — the dominating guard facts (`codegen/lower/guards.ts`): which counter steps are
 * proven unable to overflow (R1) and which array reads / writes are proven in bounds (R2), on
 * recorded IR. The bytecode side (no reference to the panic tails) and the site-table lockstep
 * live in `codegen/sites.test.ts` and `compile.test.ts`; the differential suite runs the shapes.
 */

import { describe, expect, test } from 'vite-plus/test';

import { evscript } from '../../builder/script.js';
import { namedArg, t } from '../../core/types.js';
import {
  type ConstData,
  type ScriptIr,
  type Stmt,
  type ValueId,
  walkStmts,
} from '../../ir/nodes.js';
import { guardFacts } from './guards.js';

/** Runs the analysis on a script's recorded IR and lists the statements it rules on. */
function analyze(script: { readonly ir: ScriptIr }): {
  /** every checked `bin add`, body first then fn bodies, each with its verdict */
  adds: boolean[];
  /** every array `index` / `arrset` (not `.byteAt`), with its verdict */
  elems: boolean[];
  /** every `.byteAt` (`index` on string / bytes), with its verdict */
  bytes: boolean[];
} {
  const ir = script.ir;
  const consts = new Map<ValueId, ConstData>();
  const all: Stmt[] = [];
  const visit = (s: Stmt): void => {
    all.push(s);
    if (s.k === 'const') consts.set(s.out, s.data);
  };
  walkStmts(ir.body, visit);
  for (const fn of ir.fns) walkStmts(fn.body, visit);
  const g = guardFacts(ir, consts);
  const typeOf = (v: ValueId) => ir.values[v]?.type;
  const isByteAt = (s: Stmt): boolean =>
    s.k === 'index' && (typeOf(s.arr) === 'string' || typeOf(s.arr) === 'bytes');
  return {
    adds: all.filter((s) => s.k === 'bin' && s.op === 'add').map((s) => g.noOverflow.has(s)),
    elems: all
      .filter((s) => (s.k === 'index' || s.k === 'arrset') && !isByteAt(s))
      .map((s) => g.inBounds.has(s)),
    bytes: all.filter(isByteAt).map((s) => g.inBounds.has(s)),
  };
}

describe('R1: counter steps', () => {
  test('s.for with the default step: both steps (continue + natural end) are proven', () => {
    const script = evscript({ name: 'f', args: [t.uint256] }, (s, n) => {
      const last = s.let(t.uint256, 0n);
      s.for({ from: 0n, until: n }, (i, loop) => {
        s.if(i.eq(3n), () => loop.continue());
        last.set(i);
      });
      return s.return({ last: last.get() });
    });
    expect(analyze(script).adds).toEqual([true, true]);
  });

  test.each([t.uint8, t.uint256, t.int8, t.int256])('every numeric counter type: %s', (ty) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one static type for the sweep
    const type = ty as typeof t.int8;
    const script = evscript({ name: 'f', args: [] }, (s) => {
      const last = s.let(type, 0n);
      s.for({ type, from: 1n, until: 5n }, (i) => last.set(i));
      return s.return({ last: last.get() });
    });
    expect(analyze(script).adds).toEqual([true]);
  });

  test('s.forEach: the step and the element load are both proven', () => {
    const script = evscript({ name: 'f', args: [t.array(t.address)] }, (s, xs) => {
      const last = s.let(t.address, '0x0000000000000000000000000000000000000000');
      s.forEach(xs, (x) => last.set(x));
      return s.return({ last: last.get() });
    });
    expect(analyze(script)).toMatchObject({ adds: [true], elems: [true] });
  });

  test('nested loops: each step is proven by its own header', () => {
    const script = evscript({ name: 'f', args: [t.array(t.array(t.uint256))] }, (s, grid) => {
      const last = s.let(t.uint256, 0n);
      s.forEach(grid, (row) => {
        s.forEach(row, (x) => last.set(x));
      });
      return s.return({ last: last.get() });
    });
    expect(analyze(script)).toMatchObject({ adds: [true, true], elems: [true, true] });
  });

  test('step 2 and a runtime step are not proven', () => {
    const two = evscript({ name: 'f', args: [t.uint256] }, (s, n) => {
      const last = s.let(t.uint256, 0n);
      s.for({ from: 0n, until: n, step: 2n }, (i) => last.set(i));
      return s.return({ last: last.get() });
    });
    expect(analyze(two).adds).toEqual([false]);
    const runtime = evscript({ name: 'f', args: [t.uint256, t.uint256] }, (s, n, k) => {
      const last = s.let(t.uint256, 0n);
      s.for({ from: 0n, until: n, step: k }, (i) => last.set(i));
      return s.return({ last: last.get() });
    });
    expect(analyze(runtime).adds).toEqual([false]);
  });

  test('a user i + 1 under an lt guard is proven; under lte (or after the if) it is not', () => {
    const script = evscript({ name: 'f', args: [t.uint8, t.uint8] }, (s, i, n) => {
      const r = s.let(t.uint8, 0n);
      s.if(i.lt(n), () => r.set(i.add(1n))); // proven (either operand order)
      s.if(i.lt(n), () => r.set(s.lit(t.uint8, 1n).add(i))); // proven
      s.if(i.lte(n), () => r.set(i.add(1n))); // i ≤ n ≤ 255: i + 1 can overflow
      s.if(
        i.lt(n),
        () => {},
        () => r.set(i.add(1n)), // the else branch: i ≥ n
      );
      r.set(r.get().add(1n)); // after the ifs: nothing holds
      return s.return({ r: r.get(), i2: i.add(1n) });
    });
    expect(analyze(script).adds).toEqual([true, true, false, false, false, false]);
  });

  test('a user s.while over a cell reads the cell afresh: nothing to match', () => {
    const script = evscript({ name: 'f', args: [t.uint256] }, (s, n) => {
      const i = s.let(t.uint256, 0n);
      s.while(
        () => i.get().lt(n),
        () => i.set(i.get().add(1n)),
      );
      return s.return({ i: i.get() });
    });
    expect(analyze(script).adds).toEqual([false]);
  });

  test('the while header sees no fact of its own loop; its body does', () => {
    const script = evscript({ name: 'f', args: [t.uint256, t.uint256] }, (s, a, n) => {
      const r = s.let(t.uint256, 0n);
      s.while(
        () => {
          r.set(a.add(1n)); // recorded in the header, before the guard is tested
          return a.lt(n);
        },
        (loop) => {
          r.set(a.add(1n)); // the body: a < n holds
          loop.break();
        },
      );
      r.set(a.add(1n)); // after the loop: nothing holds
      return s.return({ r: r.get() });
    });
    expect(analyze(script).adds).toEqual([false, true, false]);
  });

  test('a fn body called from inside a guarded loop starts with no facts', () => {
    const script = evscript({ name: 'f', args: [t.uint256] }, (s, n) => {
      const inc = s.fn('inc', [namedArg('x', t.uint256)] as const, (x) => x.add(1n));
      const last = s.let(t.uint256, 0n);
      s.for({ from: 0n, until: n }, (i) => last.set(inc(i)));
      return s.return({ last: last.get() });
    });
    // body step proven, the fn's x + 1 not (x is a fn param, no fact reaches it)
    expect(analyze(script).adds).toEqual([true, false]);
  });
});

describe('R2: index bounds', () => {
  test('a user s.for until arr.length + arr.at(i)', () => {
    const script = evscript({ name: 'f', args: [t.array(t.uint256)] }, (s, xs) => {
      const last = s.let(t.uint256, 0n);
      s.for({ from: 0n, until: xs.length() }, (i) => last.set(xs.at(i)));
      return s.return({ last: last.get() });
    });
    expect(analyze(script)).toMatchObject({ adds: [true], elems: [true] });
  });

  test('the output-array pattern: newArray(n) written under i < n', () => {
    const script = evscript({ name: 'f', args: [t.uint256] }, (s, n) => {
      const out = s.newArray(t.uint256, n);
      s.for({ from: 0n, until: n }, (i) => out.set(i, i));
      return s.return({ out: out.expr() });
    });
    expect(analyze(script)).toMatchObject({ adds: [true], elems: [true] });
  });

  test('an s.if(i < arr.length) guard proves the then-branch read, not the else or after', () => {
    const script = evscript({ name: 'f', args: [t.array(t.uint256), t.uint256] }, (s, xs, i) => {
      const r = s.let(t.uint256, 0n);
      s.if(
        i.lt(xs.length()),
        () => r.set(xs.at(i)),
        () => r.set(xs.at(i)),
      );
      return s.return({ r: r.get(), after: xs.at(i) });
    });
    expect(analyze(script).elems).toEqual([true, false, false]);
  });

  test('a guarded read nested in an s.if inside the loop body is still proven', () => {
    const script = evscript({ name: 'f', args: [t.array(t.uint256)] }, (s, xs) => {
      const r = s.let(t.uint256, 0n);
      s.for({ from: 0n, until: xs.length() }, (i) => {
        s.if(i.gt(2n), () => r.set(xs.at(i)));
      });
      return s.return({ r: r.get() });
    });
    expect(analyze(script).elems).toEqual([true]);
  });

  test('forEach over a fixed-size T[N] (its until is a len)', () => {
    const script = evscript({ name: 'f', args: [t.array(t.uint256, 3)] }, (s, xs) => {
      const last = s.let(t.uint256, 0n);
      s.forEach(xs, (x) => last.set(x));
      return s.return({ last: last.get() });
    });
    expect(analyze(script)).toMatchObject({ adds: [true], elems: [true] });
  });

  test('arr.at(i + 1), a different array, a converted signed counter: not proven', () => {
    const script = evscript(
      { name: 'f', args: [t.array(t.uint256), t.array(t.uint256)] },
      (s, xs, ys) => {
        const r = s.let(t.uint256, 0n);
        s.for({ from: 0n, until: xs.length() }, (i) => {
          r.set(xs.at(i.add(1n))); // i + 1 may equal the length
          r.set(ys.at(i)); // bounded by xs's length, not ys's
        });
        s.for({ type: t.int256, from: 0n, until: 2n }, (i) => {
          r.set(xs.at(i.toUint(t.uint256))); // a fresh value, no fact on it
        });
        return s.return({ r: r.get() });
      },
    );
    // the user i + 1 is itself proven (it is the step shape), the read past it is not
    expect(analyze(script)).toMatchObject({
      adds: [true, true, true],
      elems: [false, false, false],
    });
  });

  test('every length read of one array is one bound: newArray(xs.length()) under forEach(xs)', () => {
    const script = evscript({ name: 'f', args: [t.array(t.uint256)] }, (s, xs) => {
      const out = s.newArray(t.uint256, xs.length()); // len₁(xs)
      s.forEach(xs, (x, i) => out.set(i, x)); // guard i < len₂(xs)
      return s.return({ out: out.expr() });
    });
    // the forEach element load and the write into `out` are both proven
    expect(analyze(script)).toMatchObject({ adds: [true], elems: [true, true] });
  });

  test('two separate .length() reads of one array, guard on one and index under the other', () => {
    const script = evscript({ name: 'f', args: [t.array(t.uint256), t.uint256] }, (s, xs, i) => {
      const n = xs.length();
      const r = s.let(t.uint256, 0n);
      s.if(i.lt(n), () => r.set(xs.at(i)));
      s.if(i.lt(xs.length()), () => r.set(xs.at(i)));
      return s.return({ r: r.get() });
    });
    expect(analyze(script).elems).toEqual([true, true]);
  });

  test('length chains: newArray(out.length), newArray(out.expr().length()), forEach(out)', () => {
    const script = evscript({ name: 'f', args: [t.array(t.uint256)] }, (s, xs) => {
      const out = s.newArray(t.uint256, xs.length());
      const out2 = s.newArray(t.uint256, out.length);
      const out3 = s.newArray(t.uint256, out.expr().length());
      s.forEach(xs, (x, i) => {
        out2.set(i, x);
        out3.set(i, x);
      });
      s.forEach(out.expr(), (x, i) => out2.set(i, x));
      return s.return({ a: out2.expr(), b: out3.expr() });
    });
    expect(analyze(script)).toMatchObject({ elems: [true, true, true, true, true] });
  });

  test('lengths of two different arrays, or an arrnew of an unrelated length: not proven', () => {
    const script = evscript(
      { name: 'f', args: [t.array(t.uint256), t.array(t.uint256), t.uint256] },
      (s, xs, ys, n) => {
        const out = s.newArray(t.uint256, ys.length()); // ys's length, not xs's
        const other = s.newArray(t.uint256, n); // an unrelated length
        const last = s.let(t.uint256, 0n);
        s.forEach(xs, (x, i) => {
          out.set(i, x);
          other.set(i, x);
          last.set(ys.at(i));
        });
        return s.return({ a: out.expr(), b: other.expr(), last: last.get() });
      },
    );
    // forEach's own element load is proven; the three others are not
    expect(analyze(script)).toMatchObject({ elems: [true, false, false, false] });
  });

  test('.byteAt(i) under i < bytes.length keeps its check', () => {
    const script = evscript({ name: 'f', args: [t.bytes] }, (s, b) => {
      const r = s.let(t.bytes1, '0x00');
      s.for({ from: 0n, until: b.length() }, (i) => r.set(b.byteAt(i)));
      return s.return({ r: r.get() });
    });
    expect(analyze(script)).toMatchObject({ adds: [true], bytes: [false] });
  });

  test('a fn body indexing with a param starts with no facts', () => {
    const script = evscript({ name: 'f', args: [t.array(t.uint256)] }, (s, xs) => {
      const get = s.fn(
        'get',
        [namedArg('a', t.array(t.uint256)), namedArg('i', t.uint256)] as const,
        (a, i) => a.at(i),
      );
      const last = s.let(t.uint256, 0n);
      s.for({ from: 0n, until: xs.length() }, (i) => last.set(get(xs, i)));
      return s.return({ last: last.get() });
    });
    expect(analyze(script).elems).toEqual([false]);
  });
});
