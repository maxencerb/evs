/**
 * Unit tests — the SiteId table (`codegen/sites.ts`): per-site `panicCodes` in lockstep with the
 * lowering, and operand-naming details that keep same-kind sites distinguishable.
 *
 * The lockstep corpus compiles one checked operation per script and compares the codes its site
 * claims with the panic tails the bytecode references (tails are emitted only when referenced,
 * so `sourceMap.labels` lists exactly the panics the program can jump to). A lowering change
 * that adds or elides a check fails here until `classifySite` follows it.
 */

import { inspect } from 'node:util';

import { describe, expect, test } from 'vite-plus/test';

import type { SourceMap } from '../asm/sourcemap.js';
import { evscript } from '../builder/script.js';
import { compile, type CompileOptions } from '../compile.js';
import { t } from '../core/types.js';

/** The shared panic tails (`codegen/tails.ts`) and the code each one reverts with. */
const PANIC_TAILS: Readonly<Record<string, number>> = {
  panic_overflow: 0x11,
  panic_divzero: 0x12,
  panic_bounds: 0x32,
  panic_alloc: 0x41,
};

/** Any recorded script (its own `compile` keeps the call free of the artifact's generics). */
type AnyScript = {
  readonly compile: (options?: CompileOptions) => { readonly sourceMap: SourceMap };
};

interface LockstepCase {
  readonly name: string;
  readonly script: AnyScript;
  readonly codes: readonly number[]; // the union of every site's panicCodes
  // tails the bytecode references although no input can reach them (emitted, never taken)
  readonly unreachable?: readonly number[];
}

const CASES: readonly LockstepCase[] = [
  // add / sub / mul — checked unless a folded operand makes overflow impossible
  {
    name: 'add uint256',
    script: evscript({ name: 'f', args: [t.uint256, t.uint256] }, (s, a, b) =>
      s.return({ r: a.add(b) }),
    ),
    codes: [0x11],
  },
  {
    name: 'add uint8 + literal',
    script: evscript({ name: 'f', args: [t.uint8] }, (s, a) => s.return({ r: a.add(1n) })),
    codes: [0x11],
  },
  {
    name: 'sub int256',
    script: evscript({ name: 'f', args: [t.int256, t.int256] }, (s, a, b) =>
      s.return({ r: a.sub(b) }),
    ),
    codes: [0x11],
  },
  {
    name: 'mul int64',
    script: evscript({ name: 'f', args: [t.int64, t.int64] }, (s, a, b) =>
      s.return({ r: a.mul(b) }),
    ),
    codes: [0x11],
  },
  // a folded operand selects a constant template (lowerCheckedArith): unsigned x·0 / x·1 and
  // int256 x ± 0 carry no check, so they are plain statements
  {
    name: 'mul uint256 by 1',
    script: evscript({ name: 'f', args: [t.uint256] }, (s, a) => s.return({ r: a.mul(1n) })),
    codes: [],
  },
  {
    name: 'mul uint8 by 0',
    script: evscript({ name: 'f', args: [t.uint8] }, (s, a) => s.return({ r: a.mul(0n) })),
    codes: [],
  },
  {
    name: 'literal 1 mul uint256',
    script: evscript({ name: 'f', args: [t.uint256] }, (s, a) =>
      s.return({ r: s.lit(t.uint256, 1n).mul(a) }),
    ),
    codes: [],
  },
  {
    name: 'add int256 + 0',
    script: evscript({ name: 'f', args: [t.int256] }, (s, a) => s.return({ r: a.add(0n) })),
    codes: [],
  },
  {
    name: 'literal 0 add int256',
    script: evscript({ name: 'f', args: [t.int256] }, (s, a) =>
      s.return({ r: s.lit(t.int256, 0n).add(a) }),
    ),
    codes: [],
  },
  {
    name: 'sub int256 - 0',
    script: evscript({ name: 'f', args: [t.int256] }, (s, a) => s.return({ r: a.sub(0n) })),
    codes: [],
  },
  // … and every other constant still reaches the overflow tail
  {
    name: 'mul uint256 by 2',
    script: evscript({ name: 'f', args: [t.uint256] }, (s, a) => s.return({ r: a.mul(2n) })),
    codes: [0x11],
  },
  {
    name: 'add uint256 + 0 (general template)',
    script: evscript({ name: 'f', args: [t.uint256] }, (s, a) => s.return({ r: a.add(0n) })),
    codes: [0x11],
  },
  {
    name: 'add int8 + 0 (general template)',
    script: evscript({ name: 'f', args: [t.int8] }, (s, a) => s.return({ r: a.add(0n) })),
    codes: [0x11],
  },
  {
    name: 'literal 0 sub int256 (0 - min overflows)',
    script: evscript({ name: 'f', args: [t.int256] }, (s, a) =>
      s.return({ r: s.lit(t.int256, 0n).sub(a) }),
    ),
    codes: [0x11],
  },
  // div / mod
  {
    name: 'div uint256 by runtime',
    script: evscript({ name: 'f', args: [t.uint256, t.uint256] }, (s, a, b) =>
      s.return({ r: a.div(b) }),
    ),
    codes: [0x12],
  },
  {
    name: 'div uint256 by 7',
    script: evscript({ name: 'f', args: [t.uint256] }, (s, a) => s.return({ r: a.div(7n) })),
    codes: [],
  },
  {
    name: 'div int256 by runtime',
    script: evscript({ name: 'f', args: [t.int256, t.int256] }, (s, a, b) =>
      s.return({ r: a.div(b) }),
    ),
    codes: [0x12, 0x11],
  },
  {
    name: 'div int8 by runtime',
    script: evscript({ name: 'f', args: [t.int8, t.int8] }, (s, a, b) => s.return({ r: a.div(b) })),
    codes: [0x12, 0x11],
  },
  {
    name: 'div int256 by -1',
    script: evscript({ name: 'f', args: [t.int256] }, (s, a) => s.return({ r: a.div(-1n) })),
    codes: [0x11],
  },
  {
    name: 'div int256 by -7',
    script: evscript({ name: 'f', args: [t.int256] }, (s, a) => s.return({ r: a.div(-7n) })),
    codes: [],
  },
  {
    name: 'mod uint256 by runtime',
    script: evscript({ name: 'f', args: [t.uint256, t.uint256] }, (s, a, b) =>
      s.return({ r: a.mod(b) }),
    ),
    codes: [0x12],
  },
  {
    name: 'mod int256 by runtime',
    script: evscript({ name: 'f', args: [t.int256, t.int256] }, (s, a, b) =>
      s.return({ r: a.mod(b) }),
    ),
    codes: [0x12],
  },
  {
    name: 'mod int256 by -1',
    script: evscript({ name: 'f', args: [t.int256] }, (s, a) => s.return({ r: a.mod(-1n) })),
    codes: [],
  },
  // pow
  {
    name: 'pow runtime base and exponent',
    script: evscript({ name: 'f', args: [t.int256, t.uint256] }, (s, a, e) =>
      s.return({ r: s.pow(a, e) }),
    ),
    codes: [0x11],
  },
  {
    name: 'pow by 2',
    script: evscript({ name: 'f', args: [t.uint256] }, (s, a) => s.return({ r: s.pow(a, 2n) })),
    codes: [0x11],
  },
  {
    name: 'pow by 1',
    script: evscript({ name: 'f', args: [t.uint256] }, (s, a) => s.return({ r: s.pow(a, 1n) })),
    codes: [],
  },
  {
    name: 'pow by 0',
    script: evscript({ name: 'f', args: [t.uint256] }, (s, a) => s.return({ r: s.pow(a, 0n) })),
    codes: [],
  },
  {
    name: 'pow of literal 2',
    script: evscript({ name: 'f', args: [t.uint256] }, (s, e) =>
      s.return({ r: s.pow(s.lit(t.uint256, 2n), e) }),
    ),
    codes: [0x11],
  },
  {
    name: 'pow of literal 1',
    script: evscript({ name: 'f', args: [t.uint256] }, (s, e) =>
      s.return({ r: s.pow(s.lit(t.uint256, 1n), e) }),
    ),
    codes: [],
  },
  {
    name: 'pow of literal -1',
    script: evscript({ name: 'f', args: [t.uint256] }, (s, e) =>
      s.return({ r: s.pow(s.lit(t.int256, -1n), e) }),
    ),
    codes: [],
  },
  // addmod / mulmod
  {
    name: 'addmod by runtime modulus',
    script: evscript({ name: 'f', args: [t.uint256, t.uint256, t.uint256] }, (s, a, b, n) =>
      s.return({ r: s.addmod(a, b, n) }),
    ),
    codes: [0x12],
  },
  {
    name: 'mulmod by 7',
    script: evscript({ name: 'f', args: [t.uint256, t.uint256] }, (s, a, b) =>
      s.return({ r: s.mulmod(a, b, 7n) }),
    ),
    codes: [],
  },
  // mulDiv / mulDivRoundingUp — the quotient can always overflow uint256
  {
    name: 'mulDiv by runtime denominator',
    script: evscript({ name: 'f', args: [t.uint256, t.uint256, t.uint256] }, (s, a, b, d) =>
      s.return({ r: s.mulDiv(a, b, d) }),
    ),
    codes: [0x12, 0x11],
  },
  {
    name: 'mulDivRoundingUp by 7',
    script: evscript({ name: 'f', args: [t.uint256, t.uint256] }, (s, a, b) =>
      s.return({ r: s.mulDivRoundingUp(a, b, 7n) }),
    ),
    codes: [0x11],
  },
  // arrays
  {
    name: 'index',
    script: evscript({ name: 'f', args: [t.array(t.uint256), t.uint256] }, (s, a, i) =>
      s.return({ r: a.at(i) }),
    ),
    codes: [0x32],
  },
  {
    name: 'runtime-length allocation + write',
    script: evscript({ name: 'f', args: [t.uint256, t.uint256] }, (s, n, i) => {
      const arr = s.newArray(t.uint256, n);
      arr.set(i, 1n);
      return s.return({ r: arr.expr() });
    }),
    codes: [0x41, 0x32],
  },
  {
    name: 'literal-length allocation (its cap check can never fire)',
    script: evscript({ name: 'f', args: [t.uint256] }, (s, i) => {
      const arr = s.newArray(t.uint256, 3n);
      arr.set(i, 1n);
      return s.return({ r: arr.expr() });
    }),
    codes: [0x32],
    unreachable: [0x41],
  },
  // conversions
  {
    name: 'uint256 → uint8 (narrowing)',
    script: evscript({ name: 'f', args: [t.uint256] }, (s, x) =>
      s.return({ r: x.toUint(t.uint8) }),
    ),
    codes: [0x11],
  },
  {
    name: 'uint8 → uint256 (widening)',
    script: evscript({ name: 'f', args: [t.uint8] }, (s, x) =>
      s.return({ r: x.toUint(t.uint256) }),
    ),
    codes: [],
  },
  {
    name: 'uint8 → int16 (fits the sign bit)',
    script: evscript({ name: 'f', args: [t.uint8] }, (s, x) => s.return({ r: x.toInt(t.int16) })),
    codes: [],
  },
  {
    name: 'uint8 → int8',
    script: evscript({ name: 'f', args: [t.uint8] }, (s, x) => s.return({ r: x.toInt(t.int8) })),
    codes: [0x11],
  },
  {
    name: 'int8 → int16 (widening)',
    script: evscript({ name: 'f', args: [t.int8] }, (s, x) => s.return({ r: x.toInt(t.int16) })),
    codes: [],
  },
  {
    name: 'int16 → int8 (narrowing)',
    script: evscript({ name: 'f', args: [t.int16] }, (s, x) => s.return({ r: x.toInt(t.int8) })),
    codes: [0x11],
  },
  {
    name: 'int8 → uint256 (sign)',
    script: evscript({ name: 'f', args: [t.int8] }, (s, x) => s.return({ r: x.toUint(t.uint256) })),
    codes: [0x11],
  },
  {
    name: 'int8 → uint8',
    script: evscript({ name: 'f', args: [t.int8] }, (s, x) => s.return({ r: x.toUint(t.uint8) })),
    codes: [0x11],
  },
  {
    name: 'bytes32 → uint256 (reinterpret)',
    script: evscript({ name: 'f', args: [t.bytes32] }, (s, x) => s.return({ r: x.asUint256() })),
    codes: [],
  },
  {
    name: 'uint256 → address',
    script: evscript({ name: 'f', args: [t.uint256] }, (s, x) => s.return({ r: x.asAddress() })),
    codes: [0x11],
  },
];

/** The panic codes whose tails the compiled program references. */
function referencedPanics(labels: readonly { name: string }[]): number[] {
  return labels.flatMap((l) => {
    const code = PANIC_TAILS[l.name];
    return code === undefined ? [] : [code];
  });
}

const sorted = (codes: Iterable<number>): number[] => [...new Set(codes)].toSorted((a, b) => a - b);

describe('panicCodes lockstep with the lowering', () => {
  test.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    for (const optimize of [false, true]) {
      const { sourceMap } = c.script.compile({ optimize });
      const claimed = sourceMap.sites.flatMap((s) => [...(s.panicCodes ?? [])]);
      expect(sorted(claimed)).toEqual(sorted(c.codes));
      // a site is 'panic' exactly when it claims codes
      for (const s of sourceMap.sites) {
        expect(s.kind === 'panic').toBe((s.panicCodes?.length ?? 0) > 0);
      }
      expect(sorted(referencedPanics(sourceMap.labels))).toEqual(
        sorted([...c.codes, ...(c.unreachable ?? [])]),
      );
    }
  });
});

describe('constant-operand add / sub / mul: the claim follows the emitted check', () => {
  // every width class lowerCheckedArith distinguishes (sub-word ≤ 128, 128 < N < 256, 256)
  const TYPES = [t.uint8, t.uint128, t.uint136, t.uint256, t.int8, t.int128, t.int136, t.int256];
  const OPS = ['add', 'sub', 'mul'] as const;

  test.each(TYPES)('%s', (width) => {
    // one static type for the whole sweep: every width has the same arithmetic surface, and the
    // recorder and the lowering only ever see the run-time type name
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    const type = width as typeof t.uint256;
    const constants = type.startsWith('int') ? [0n, 1n, 2n, -1n, -2n] : [0n, 1n, 2n, 255n];
    for (const op of OPS) {
      for (const c of constants) {
        for (const side of ['right', 'left'] as const) {
          const script = evscript({ name: 'f', args: [type] }, (s, x) => {
            const k = s.lit(type, c);
            const [a, b] = side === 'right' ? [x, k] : [k, x];
            return s.return({ r: op === 'add' ? a.add(b) : op === 'sub' ? a.sub(b) : a.mul(b) });
          });
          for (const optimize of [false, true]) {
            const { sourceMap } = script.compile({ optimize });
            const claims = sourceMap.sites.some((s) => s.panicCodes?.includes(0x11) === true);
            const checks = referencedPanics(sourceMap.labels).includes(0x11);
            expect(claims, `${type} ${side} ${op} ${c} (optimize: ${optimize})`).toBe(checks);
          }
        }
      }
    }
  });
});

describe('details name the operands', () => {
  test('args by name, literals by value, other values by the #id their handle prints', () => {
    let product = '';
    const script = evscript({ name: 'f', args: [t.int256, t.uint256, t.uint256] }, (s, a, b, c) => {
      const p = b.mul(c);
      product = `#${/#(\d+)/.exec(inspect(p))?.[1] ?? '?'}`;
      return s.return({ q: a.div(-3n), r: a.div(a), p: p.add(1n), m: a.mod(7n) });
    });
    const details = compile(script).sourceMap.sites.map((s) => s.detail);
    expect(details).toContain(`checked mul args.arg1 * args.arg2 (uint256) — Panic 0x11`);
    expect(details).toContain(`checked add ${product} + 1 (uint256) — Panic 0x11`);
    expect(details).toContain('checked div args.arg0 / args.arg0 (int256) — Panic 0x12/0x11');
    // checks the lowering elides leave a plain statement, named without "checked"
    expect(details).toContain('div args.arg0 / -3 (int256)');
    expect(details).toContain('mod args.arg0 % 7 (int256)');
  });

  test('a debug name several values share gets its #id, a unique one stays bare', () => {
    const twoArrays = evscript({ name: 'f', args: [t.uint256, t.uint256] }, (s, n, i) => {
      const a = s.newArray(t.uint256, n);
      const b = s.newArray(t.uint256, n);
      a.set(i, 1n);
      b.set(i, 2n);
      return s.return({ a: a.expr(), b: b.expr() });
    });
    const writes = compile(twoArrays)
      .sourceMap.sites.map((s) => s.detail)
      .filter((d) => d.startsWith('array write'));
    expect(writes).toHaveLength(2);
    expect(new Set(writes).size).toBe(2);
    for (const w of writes) {
      expect(w).toMatch(/^array write s\.newArray\(uint256\)#\d+\[args\.arg1\] — Panic 0x32$/);
    }

    const oneArray = evscript({ name: 'f', args: [t.uint256, t.uint256] }, (s, n, i) => {
      const a = s.newArray(t.uint256, n);
      a.set(i, 1n);
      return s.return({ a: a.expr() });
    });
    expect(compile(oneArray).sourceMap.sites.map((s) => s.detail)).toContain(
      'array write s.newArray(uint256)[args.arg1] — Panic 0x32',
    );
  });
});
