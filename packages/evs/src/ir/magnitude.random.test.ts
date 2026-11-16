/**
 * Seeded random soundness test — `ir/magnitude.ts`. The analysis backs a warning that must never
 * be missing (`DEPLOYLESS_RESULT_PREFIX`), so its one invariant is checked against the reference
 * interpreter: for every value a generated script returns, on every run that returns,
 *
 *   a `uintN` is below `2^bits` and an `intN` is in `[-2^bits, 2^bits)`,
 *
 * where `bits` is what `magnitudeBits` claims for that value. The generator works on 256-bit
 * values whose bounds are well below their width (narrow arguments widened first), which is
 * where a transfer function that is off by one bit shows; it mixes checked and wrapping
 * arithmetic, literal and runtime operands, conversions, `select`, and a cell updated in a loop.
 * Arguments are drawn from the edges of their ranges most of the time: the bounds are tight
 * exactly there.
 */

import { describe, expect, test } from 'vite-plus/test';

import { evscript, type ReturnValue } from '../builder/script.js';
import { t } from '../core/types.js';
import { interpret, type MockChain } from './interp.js';
import { magnitudeBits } from './magnitude.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** A loose numeric / bool handle: the generator picks ops at run time, so the static types of
 *  the builder's `Expr<t>` cannot follow it. */
interface Num {
  add(o: unknown): Num;
  sub(o: unknown): Num;
  mul(o: unknown): Num;
  div(o: unknown): Num;
  mod(o: unknown): Num;
  pow(o: unknown): Num;
  shl(o: unknown): Num;
  shr(o: unknown): Num;
  bitAnd(o: unknown): Num;
  bitOr(o: unknown): Num;
  bitXor(o: unknown): Num;
  lt(o: unknown): Num;
  toUint(ty: unknown): Num;
  toInt(ty: unknown): Num;
  wrappingToUint(ty: unknown): Num;
  wrappingToInt(ty: unknown): Num;
}
interface Builder {
  let(ty: unknown, init: unknown): { get(): Num; set(v: unknown): void };
  select(cond: unknown, a: unknown, b: unknown): Num;
  wrappingAdd(a: unknown, b: unknown): Num;
  wrappingSub(a: unknown, b: unknown): Num;
  wrappingMul(a: unknown, b: unknown): Num;
  mulDiv(a: unknown, b: unknown, c: unknown): Num;
  addmod(a: unknown, b: unknown, n: unknown): Num;
  forEach(xs: unknown, body: (x: Num) => void): void;
}
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose builder handle (see Num)
const asBuilder = (v: unknown): Builder => v as Builder;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose builder handle (see Num)
const asNum = (v: unknown): Num => v as Num;
const asReturn = (v: Record<string, Num>): Record<string, ReturnValue> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the record holds evs handles
  v as unknown as Record<string, ReturnValue>;

/** The two 256-bit families the generated statements work on. */
type Fam = 'u' | 'i';
const WIDE = { u: t.uint256, i: t.int256 } as const;

/** The script args: narrow integers (widened into the pools), full-width ones, and a list. */
const ARGS = [
  { type: t.int8, fam: 'i', min: -(1n << 7n), max: (1n << 7n) - 1n },
  { type: t.int8, fam: 'i', min: -(1n << 7n), max: (1n << 7n) - 1n },
  { type: t.uint8, fam: 'u', min: 0n, max: (1n << 8n) - 1n },
  { type: t.int64, fam: 'i', min: -(1n << 63n), max: (1n << 63n) - 1n },
  { type: t.uint64, fam: 'u', min: 0n, max: (1n << 64n) - 1n },
  { type: t.int256, fam: 'i', min: -(1n << 255n), max: (1n << 255n) - 1n },
  { type: t.int256, fam: 'i', min: -(1n << 255n), max: (1n << 255n) - 1n },
  { type: t.uint256, fam: 'u', min: 0n, max: (1n << 256n) - 1n },
] as const;

interface Gen {
  int(n: number): number;
  chance(p: number): boolean;
  pick<T>(xs: readonly T[]): T;
}

function makeGen(seed: number): Gen {
  const rnd = mulberry32(seed);
  const int = (n: number): number => Math.floor(rnd() * n);
  return {
    int,
    chance: (p) => rnd() < p,
    pick: <T>(xs: readonly T[]): T => {
      const x = xs[int(xs.length)];
      if (x === undefined) throw new Error('pick from an empty list');
      return x;
    },
  };
}

/** A value of `[min, max]`, at or next to an edge most of the time. */
function edgeValue(g: Gen, min: bigint, max: bigint): bigint {
  const edges = [0n, 1n, 2n, max, max - 1n, max / 2n, min, min + 1n];
  if (min < 0n) edges.push(-1n, -2n, min / 2n);
  const v = g.chance(0.7) ? g.pick(edges) : BigInt(g.int(600)) - (min < 0n ? 300n : 0n);
  return v < min ? min : v > max ? max : v;
}

/** A literal operand: small, and negative one time in three for a signed family. */
function literal(g: Gen, fam: Fam): bigint {
  const magnitude = BigInt(g.pick([1, 1, 2, 3, 7, 16, 255, 256]));
  return fam === 'i' && g.chance(0.34) ? -magnitude : magnitude;
}

/** Generates one script: straight-line statements over two pools, one loop, a return of every
 *  value it made (up to the ABI's comfort). */
function randomScript(seed: number) {
  const g = makeGen(seed);
  return evscript(
    { name: `mag${seed}`, args: [...ARGS.map((a) => a.type), t.array(t.uint8)] },
    (builder, ...raw) => {
      const s = asBuilder(builder);
      const list = raw[ARGS.length];
      const pools: Record<Fam, Num[]> = { u: [], i: [] };
      ARGS.forEach((arg, index) => {
        const x = asNum(raw[index]);
        pools[arg.fam].push(arg.fam === 'u' ? x.toUint(t.uint256) : x.toInt(t.int256));
      });
      const value = (fam: Fam): Num => g.pick(pools[fam]);
      const operand = (fam: Fam): unknown => (g.chance(0.45) ? literal(g, fam) : value(fam));

      const step = (): void => {
        const fam: Fam = g.chance(0.6) ? 'i' : 'u';
        const x = value(fam);
        const r = g.int(22);
        if (r < 2) pools[fam].push(x.add(operand(fam)));
        else if (r < 4) pools[fam].push(x.sub(operand(fam)));
        else if (r < 6) pools[fam].push(x.mul(operand(fam)));
        else if (r < 10) pools[fam].push(x.div(operand(fam)));
        else if (r < 11) pools[fam].push(x.mod(operand(fam)));
        else if (r < 13) pools[fam].push(x.shr(BigInt(1 + g.int(9))));
        else if (r < 14) pools[fam].push(x.shr(value('u')));
        else if (r < 15) pools[fam].push(x.shl(BigInt(1 + g.int(4))));
        else if (r < 16)
          pools[fam].push(x[g.pick(['bitAnd', 'bitOr', 'bitXor'] as const)](value(fam)));
        else if (r < 17) pools[fam].push(s.select(value(fam).lt(value(fam)), x, value(fam)));
        else if (r < 18) {
          const op = g.pick(['wrappingAdd', 'wrappingSub', 'wrappingMul'] as const);
          pools[fam].push(s[op](x, operand(fam)));
        } else if (r < 19) pools[fam].push(x.pow(BigInt(g.int(4))));
        else if (r < 20 && fam === 'u') {
          pools.u.push(
            g.chance(0.5)
              ? s.mulDiv(x, value('u'), operand('u'))
              : s.addmod(x, value('u'), operand('u')),
          );
        } else if (fam === 'i') {
          // to the other family: checked (a negative value reverts) or wrapping
          pools.u.push(g.chance(0.6) ? x.toUint(t.uint256) : x.wrappingToUint(t.uint256));
        } else {
          pools.i.push(g.chance(0.6) ? x.toInt(t.int256) : x.wrappingToInt(t.int256));
        }
      };

      const steps = 6 + g.int(8);
      for (let k = 0; k < steps; k++) step();

      // a cell updated once per list element: the fixpoint has to cover what a loop can reach
      const fam: Fam = g.chance(0.5) ? 'i' : 'u';
      const cell = s.let(WIDE[fam], value(fam));
      const update = g.int(4);
      const other = operand(fam);
      s.forEach(list, (element) => {
        const x = fam === 'u' ? element.toUint(t.uint256) : element.toInt(t.int256);
        const current = cell.get();
        if (update === 0) cell.set(current.add(x));
        else if (update === 1) cell.set(current.div(other));
        else if (update === 2) cell.set(s.select(current.lt(x), current.sub(other), x));
        else cell.set(current.shr(1n).mul(other));
      });
      pools[fam].push(cell.get());
      for (let k = 0; k < 3; k++) step();

      const record: Record<string, Num> = {};
      for (const f of ['u', 'i'] as const) {
        pools[f].slice(-9).forEach((x, index) => {
          record[`${f}${index}`] = x;
        });
      }
      return builder.return(asReturn(record));
    },
  );
}

function randomArgs(g: Gen): unknown[] {
  const list = Array.from({ length: g.int(4) }, () => g.int(256));
  return [...ARGS.map((arg) => edgeValue(g, arg.min, arg.max)), list];
}

/** The generated scripts make no call. */
const NO_CHAIN: MockChain = { staticcall: () => ({ success: false, data: '0x' }) };

describe('magnitudeBits is sound on generated scripts', () => {
  const SCRIPTS = 300;
  const RUNS_PER_SCRIPT = 16;

  test(`${SCRIPTS} scripts: every returned value is within its claimed bound`, () => {
    const violations: string[] = [];
    let returned = 0;
    let checked = 0;
    let informative = 0;
    for (let seed = 1; seed <= SCRIPTS; seed++) {
      const script = randomScript(seed);
      const bound = magnitudeBits(script.ir);
      const g = makeGen(seed * 7919);
      for (let run = 0; run < RUNS_PER_SCRIPT; run++) {
        const args = randomArgs(g);
        const { outcome } = interpret(script.ir, args, NO_CHAIN);
        if (outcome.kind !== 'return') continue;
        returned++;
        for (const ret of script.ir.returns) {
          const actual = outcome.values[ret.name];
          if (typeof actual !== 'bigint') throw new Error(`${ret.name} is not an integer`);
          const bits = bound(ret.value);
          const limit = 1n << BigInt(bits);
          checked++;
          if (bits < 255) informative++;
          if (actual >= limit || actual < -limit) {
            violations.push(
              `seed ${seed}, run ${run}: ${ret.name} = ${actual}, claimed below 2^${bits} ` +
                `(args ${args.map(String).join(', ')})`,
            );
          }
        }
      }
    }
    expect(violations.slice(0, 5)).toEqual([]);
    // the property is not vacuous: most runs return, and many bounds are below the type's width
    expect(returned).toBeGreaterThan(SCRIPTS);
    expect(checked).toBeGreaterThan(10_000);
    expect(informative).toBeGreaterThan(checked / 4);
  });
});
