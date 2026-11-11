/* oxlint-disable vitest/expect-expect --
 * every test asserts through the `agree` runner (the shared `expectAgreement`). */
/**
 * Differential suite — store–reload fusion (#96): shapes where `optimize: true` keeps a
 * single-use temporary on the stack (`codegen/fuse.ts`), held to the interpreter by the harness
 * (every case also runs its `optimize: true` twin). Chains through every arithmetic template
 * family, division by zero reached with a fused value under the divisor, control flow at block
 * edges, fn bodies, loops, and values the pass must leave alone (used twice, used later,
 * returned). The last test checks that every window form fired somewhere in this file.
 */

import { describe, expect, test } from 'vite-plus/test';

import { expectAgreement, panicData } from '../../test/harness/differential.js';
import { evscript } from '../builder/script.js';
import type { FuseStats } from '../codegen/fuse.js';
import { lowerProgram } from '../codegen/program.js';
import { namedArg, t } from '../core/types.js';
import { eliminateDeadCode } from '../ir/dce.js';
import type { ScriptIr } from '../ir/nodes.js';

const MAX256 = (1n << 256n) - 1n;
const MIN_I256 = -(1n << 255n);
const MAX_I256 = (1n << 255n) - 1n;

/** The window forms fused across this file (`compile()` lowers `dce(ir)`). */
const seen: FuseStats = {};
function tally(script: { readonly ir: ScriptIr }): FuseStats {
  const { fused } = lowerProgram(eliminateDeadCode(script.ir), {
    evmVersion: 'cancun',
    optimize: true,
  });
  for (const [form, n] of Object.entries(fused ?? {})) seen[form] = (seen[form] ?? 0) + n;
  return fused ?? {};
}

async function agree(
  script: Parameters<typeof expectAgreement>[0] & { readonly ir: ScriptIr },
  argSets: readonly (readonly unknown[])[],
) {
  tally(script);
  return expectAgreement(script, argSets);
}

describe('unsigned chains', () => {
  test('sub / div / mod with runtime right operands', async () => {
    const script = evscript(
      { name: 'chainRt', args: [t.uint256, t.uint256, t.uint256, t.uint256] },
      (s, a, b, c, d) => s.return({ r: a.sub(b).div(c).mod(d) }),
    );
    const outcomes = await agree(script, [
      [100n, 1n, 3n, 7n],
      [MAX256, 0n, 1n, MAX256],
      [5n, 6n, 1n, 1n], // underflow
      [100n, 1n, 0n, 7n], // a − b fused under the zero divisor
      [100n, 1n, 3n, 0n], // the quotient fused under the zero modulus
    ]);
    expect(outcomes.map((o) => o.data)).toEqual([
      expect.any(String),
      expect.any(String),
      panicData(0x11n),
      panicData(0x12n),
      panicData(0x12n),
    ]);
  });

  test('sub / div / mod with constant right operands', async () => {
    const script = evscript({ name: 'chainK', args: [t.uint256] }, (s, a) =>
      s.return({ r: a.add(3n).sub(2n).div(7n).mod(5n).mul(9n) }),
    );
    await agree(script, [[0n], [1n], [100n], [MAX256 - 3n], [MAX256 - 2n]]);
  });

  test('mul → div (the POP POP tail, then the zero guard)', async () => {
    const script = evscript(
      { name: 'mulDivChain', args: [t.uint256, t.uint256, t.uint256] },
      (s, a, b, c) => s.return({ r: a.mul(b).div(c), q: a.mul(b).add(1n).div(7n) }),
    );
    const outcomes = await agree(script, [
      [6n, 7n, 3n],
      [1n << 128n, (1n << 128n) - 1n, 5n],
      [1n << 128n, 1n << 128n, 5n], // mul overflow
      [6n, 7n, 0n], // division by zero with the product fused under the divisor
    ]);
    expect(outcomes[2]?.data).toBe(panicData(0x11n));
    expect(outcomes[3]?.data).toBe(panicData(0x12n));
  });

  test('a literal zero divisor keeps its guard: Panic 0x12 with the fused value beneath', async () => {
    const script = evscript(
      { name: 'divZeroK', args: [t.uint256, t.uint256, t.bool] },
      (s, a, b, which) => {
        const r = s.let(t.uint256, 0n);
        s.if(
          which,
          () => r.set(a.add(1n).div(0n)), // the sum fused under PUSH 0 DUP1 ISZERO → panic
          () => r.set(a.mul(b).mod(0n)), // the product's POP POP tail, then the same guard
        );
        return s.return({ r: r.get() });
      },
    );
    const outcomes = await agree(script, [
      [1n, 2n, true],
      [1n, 2n, false],
      [MAX256, 2n, true], // a + 1 overflows first
      [MAX256, 2n, false], // a · b overflows first
    ]);
    expect(outcomes.map((o) => o.data)).toEqual([
      panicData(0x12n),
      panicData(0x12n),
      panicData(0x11n),
      panicData(0x11n),
    ]);
  });

  test('a 256-bit product written straight to a cell (the POP POP tail alone)', async () => {
    const script = evscript({ name: 'mulCell', args: [t.uint256, t.uint256] }, (s, a, b) => {
      const r = s.let(t.uint256, 0n);
      r.set(a.mul(b));
      r.set(r.get().mul(a.add(1n)));
      return s.return({ r: r.get() });
    });
    await agree(script, [
      [0n, 5n],
      [3n, 4n],
      [1n << 128n, 1n << 127n],
      [1n << 128n, 1n << 128n],
    ]);
  });

  test('addmod / mulmod / pow / shifts / select / bit ops downstream of a fused value', async () => {
    const script = evscript(
      { name: 'mixed', args: [t.uint256, t.uint256, t.uint256, t.bool] },
      (s, a, b, n, flag) =>
        s.return({
          am: s.addmod(a.add(1n), b, n),
          mm: s.mulmod(a, b.add(2n), n),
          p: s.pow(a.add(1n), b.mod(4n)),
          pk: s.pow(s.lit(t.uint256, 3n), a.mod(50n).add(1n)),
          sh: s.shr(s.shl(a.add(1n), b.mod(300n)), 3n),
          sel: s.select(a.lt(b), a.add(b.mod(10n)), b.mul(3n)),
          bits: a.bitXor(b).bitAnd(n.add(1n)).bitOr(1n),
          flagged: s.select(flag, a.mod(9n), b.mod(9n)),
        }),
    );
    const outcomes = await agree(script, [
      [3n, 5n, 7n, true],
      [0n, 0n, 1n, false],
      [MAX256 - 1n, 3n, 11n, true],
      [2n, 3n, 0n, false], // addmod by zero
      [MAX256, 1n, 5n, true], // a + 1 overflows
    ]);
    expect(outcomes[3]?.data).toBe(panicData(0x12n));
    expect(outcomes[4]?.data).toBe(panicData(0x11n));
  });

  test('narrow widths: uint8 / uint64 chains and conversions', async () => {
    const script = evscript({ name: 'narrow', args: [t.uint8, t.uint8, t.uint64] }, (s, a, b, c) =>
      s.return({
        r8: a.add(b).sub(1n).mul(2n),
        r64: c.mul(3n).div(a.add(1n).toUint(t.uint64)),
        up: a.toUint(t.uint256).mul(c.toUint(t.uint256)).add(1n),
      }),
    );
    await agree(script, [
      [1n, 2n, 3n],
      [100n, 27n, 5n],
      [200n, 100n, 5n], // uint8 overflow
      [0n, 0n, (1n << 64n) - 1n], // 0 + 0 − 1 underflows
      [255n, 0n, 7n], // a + 1 overflows uint8 (inside the divisor)
    ]);
  });
});

describe('signed chains', () => {
  test('int256 add / sub / mul / div chains', async () => {
    const script = evscript({ name: 'i256', args: [t.int256, t.int256, t.int256] }, (s, a, b, c) =>
      s.return({
        r: a.add(b).sub(c).mul(b),
        k: a.add(5n).sub(-3n).mul(-2n),
        d: a.sub(b).div(c),
      }),
    );
    const outcomes = await agree(script, [
      [1n, 2n, 3n],
      [-7n, 3n, -2n],
      [MAX_I256, 1n, 0n], // add overflow
      [MIN_I256, 1n, 1n], // sub overflow in d (a − b)
      [MIN_I256 + 1n, 1n, 0n], // r: (MIN + 2) − 0 then × 1; d divides by zero
      [MIN_I256, 0n, -1n], // MIN / −1 in d
    ]);
    expect(outcomes.map((o) => o.kind)).toContain('revert');
  });

  test('int8 / int64 chains', async () => {
    const script = evscript({ name: 'iNarrow', args: [t.int8, t.int8, t.int64] }, (s, a, b, c) =>
      s.return({
        r8: a.sub(b).mul(2n).add(1n),
        r64: c.mul(a.toInt(t.int64)).sub(1n).div(3n),
      }),
    );
    await agree(script, [
      [1n, 2n, 3n],
      [-64n, 0n, -5n],
      [-128n, 1n, 1n], // −129
      [100n, -100n, 1n], // 200 overflows int8
      [-1n, 0n, -(1n << 63n)], // c · −1 overflows int64
    ]);
  });
});

describe('control flow', () => {
  test('comparisons feeding if / while, nested ifs at block edges', async () => {
    const script = evscript(
      { name: 'ctl', args: [t.uint256, t.uint256, t.int256] },
      (s, x, y, z) => {
        const r = s.let(t.uint256, 0n);
        s.if(x.lte(10n), () => {
          s.if(y.gt(x.add(1n)), () => r.set(y.sub(x)));
          s.if(z.lt(-1n), () => r.set(r.get().add(100n)));
        });
        s.if(
          x.eq(y.mul(2n)),
          () => r.set(r.get().add(1n)),
          () => s.if(x.neq(0n), () => r.set(r.get().add(1000n))),
        );
        const n = s.let(t.uint256, x.mod(5n));
        s.while(
          () => n.get().gt(0n),
          () => {
            n.set(n.get().sub(1n));
            r.set(r.get().add(n.get().mul(2n)));
          },
        );
        return s.return({ r: r.get() });
      },
    );
    await agree(script, [
      [0n, 0n, 0n],
      [3n, 9n, -5n],
      [10n, 5n, 7n],
      [11n, 5n, -2n],
      [24n, 12n, MIN_I256],
      [MAX256, 0n, 0n],
    ]);
  });

  test('loops: s.for / s.forEach steps, break / continue, a guarded output array', async () => {
    const script = evscript(
      { name: 'loops', args: [t.array(t.uint256), t.uint256] },
      (s, xs, k) => {
        const total = s.let(t.uint256, 0n);
        const out = s.newArray(t.uint256, xs.length());
        s.forEach(xs, (x, i, loop) => {
          s.if(x.mod(3n).eq(0n), () => loop.continue());
          s.if(x.gt(k.mul(10n)), () => loop.break());
          out.set(i, x.add(i).mul(2n));
          total.set(total.get().add(x.div(k.add(1n))));
        });
        const odd = s.let(t.uint256, 0n);
        s.for({ from: 1n, until: k.add(1n) }, (i) => odd.set(odd.get().add(i.mul(i).mod(7n))));
        return s.return({ total: total.get(), out: out.expr(), odd: odd.get() });
      },
    );
    await agree(script, [
      [[], 0n],
      [[1n, 2n, 3n, 4n, 5n], 2n],
      [[7n, 300n, 8n], 5n],
      [[MAX256], 1n], // x + i fine, × 2 overflows
    ]);
  });

  test('fn bodies: the result defined last, a guard inside, a fn called twice', async () => {
    const script = evscript({ name: 'fns', args: [t.uint256, t.uint256] }, (s, a, b) => {
      const f = s.fn('f', [namedArg('x', t.uint256), namedArg('y', t.uint256)] as const, (x, y) =>
        x.add(1n).mul(y).div(x.add(2n)),
      );
      const g = s.fn('g', [namedArg('x', t.uint256)] as const, (x) => {
        const r = s.let(t.uint256, x);
        s.if(x.gt(5n), () => r.set(x.sub(5n).mul(3n)));
        return r.get();
      });
      return s.return({ p: f(a, b), q: f(b, a.add(1n)), r: g(a.mod(9n)) });
    });
    const outcomes = await agree(script, [
      [1n, 2n],
      [7n, 100n],
      [MAX256, 1n], // a + 1 overflows inside f
      [MAX256 - 1n, 3n], // (a + 1) · 3 overflows
    ]);
    expect(outcomes[2]?.data).toBe(panicData(0x11n));
  });
});

describe('values the pass leaves alone', () => {
  test('used twice, used later, returned, read by a call-free memref op', async () => {
    const script = evscript({ name: 'kept', args: [t.uint256, t.uint256] }, (s, a, b) => {
      const y = a.add(1n);
      const sq = y.mul(y); // y read twice by one statement
      const z = b.add(2n);
      const w = a.mul(3n); // read two statements later
      const both = z.add(w).add(z); // z read twice across statements
      const arr = s.newArray(t.uint256, 2n);
      arr.set(0n, sq);
      arr.set(1n, both);
      return s.return({ sq, both, w, arr: arr.expr() });
    });
    await agree(script, [
      [0n, 0n],
      [5n, 6n],
      [1n << 128n, 0n], // y · y overflows
    ]);
  });
});

test('every window form fired in this file', () => {
  for (const form of ['bare', 'P', 'I', 'M', 'IG', 'MG', 'PIG', 'PMG']) {
    expect(seen[form] ?? 0, `form ${form}`).toBeGreaterThan(0);
  }
});
