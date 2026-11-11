/**
 * Seeded random differential — store–reload fusion (#96). A few hundred generated scripts mix
 * uint256 / int256 / narrow-width arithmetic, comparisons, `select`, `s.if`, constants and random
 * operand reuse (chains, values read twice, values read later); for each, the `optimize: false`
 * and `optimize: true` bytecode must produce identical results (returndata and revert payloads),
 * agree with `interpret`, and the optimized run must never cost more gas. The generator draws
 * operands from the most recent values most of the time, so most statements feed the next one —
 * the shape the fusion pass rewrites. Modelled on the seeded allocator test in
 * `codegen/frame.test.ts`.
 */

import { encodeFunctionData } from 'viem';
import { describe, expect, test } from 'vite-plus/test';

import { chainOf } from '../../test/harness/differential.js';
import { execRuntime } from '../../test/harness/evm.js';
import { evscript, type ReturnValue } from '../builder/script.js';
import type { FuseStats } from '../codegen/fuse.js';
import { lowerProgram } from '../codegen/program.js';
import { compile } from '../compile.js';
import { t } from '../core/types.js';
import { eliminateDeadCode } from '../ir/dce.js';
import { interpret } from '../ir/interp.js';

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
  lt(o: unknown): Num;
  gt(o: unknown): Num;
  lte(o: unknown): Num;
  gte(o: unknown): Num;
  eq(o: unknown): Num;
  neq(o: unknown): Num;
  bitXor(o: unknown): Num;
  toUint(ty: unknown): Num;
  toInt(ty: unknown): Num;
}
interface Builder {
  let(ty: unknown, init: unknown): { get(): Num; set(v: unknown): void };
  if(cond: unknown, then: () => void, otherwise?: () => void): void;
  select(cond: unknown, a: unknown, b: unknown): Num;
  shl(a: unknown, n: unknown): Num;
  shr(a: unknown, n: unknown): Num;
  pow(a: unknown, e: unknown): Num;
}
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose builder handle (see Num)
const asBuilder = (v: unknown): Builder => v as Builder;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- loose builder handle (see Num)
const asNum = (v: unknown): Num => v as Num;
const asReturn = (v: Record<string, Num>): Record<string, ReturnValue> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the record holds evs handles
  v as unknown as Record<string, ReturnValue>;

type Fam = 'u256' | 'i256' | 'u8' | 'i16';
const FAMS: readonly Fam[] = ['u256', 'i256', 'u8', 'i16'];
const TYPE = { u256: t.uint256, i256: t.int256, u8: t.uint8, i16: t.int16 } as const;
const RANGE: Record<Fam, { min: bigint; max: bigint }> = {
  u256: { min: 0n, max: (1n << 256n) - 1n },
  i256: { min: -(1n << 255n), max: (1n << 255n) - 1n },
  u8: { min: 0n, max: 255n },
  i16: { min: -(1n << 15n), max: (1n << 15n) - 1n },
};
/** The script args: two of each family, in `FAMS` order. */
const ARG_FAMS: readonly Fam[] = ['u256', 'u256', 'i256', 'i256', 'u8', 'u8', 'i16', 'i16'];

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

/** A value of the family's range biased to the edges (0, ±1, small, min, max, near them). */
function edgeValue(g: Gen, fam: Fam): bigint {
  const { min, max } = RANGE[fam];
  const candidates = [0n, 1n, 2n, 3n, 7n, 10n, max, max - 1n, max / 2n, min, min + 1n];
  if (min < 0n) candidates.push(-1n, -2n, -7n);
  const v = g.chance(0.4) ? g.pick(candidates) : BigInt(g.int(1000)) - (min < 0n ? 500n : 0n);
  return v < min ? min : v > max ? max : v;
}

/** A constant operand: mostly small, sometimes an edge (a literal 0 divisor included). */
function constOperand(g: Gen, fam: Fam): bigint {
  return g.chance(0.6)
    ? BigInt(g.int(9) + (RANGE[fam].min < 0n && g.chance(0.3) ? -9 : 0))
    : edgeValue(g, fam);
}

/** Generates one script: straight-line statements, `s.if` blocks writing cells, a return. */
function randomScript(seed: number) {
  const g = makeGen(seed);
  const steps = 5 + g.int(10);
  return evscript(
    { name: `fz${seed}`, args: ARG_FAMS.map((f) => TYPE[f]) },
    (builder, ...argsRaw) => {
      const s = asBuilder(builder);
      const pools = new Map<Fam, Num[]>(FAMS.map((f) => [f, []]));
      ARG_FAMS.forEach((f, i) => pools.get(f)?.push(asNum(argsRaw[i])));
      const bools: Num[] = [];
      const cells = FAMS.map((f) => ({ fam: f, cell: s.let(TYPE[f], 0n) }));

      /** An operand of `fam`: the newest value (chains), any value (reuse), or a constant. */
      const operand = (pool: readonly Num[], fam: Fam): unknown => {
        const r = g.int(10);
        if (r < 5) return pool[pool.length - 1];
        if (r < 8) return g.pick(pool);
        return constOperand(g, fam);
      };
      const value = (pool: readonly Num[]): Num => {
        const last = pool[pool.length - 1];
        return g.chance(0.6) && last !== undefined ? last : g.pick(pool);
      };

      const step = (pool: Map<Fam, Num[]>, boolPool: Num[], depth: number): void => {
        const fam = g.pick(FAMS);
        const xs = pool.get(fam) ?? [];
        const x = value(xs);
        const r = g.int(20);
        let out: Num;
        if (r < 3) out = x.add(operand(xs, fam));
        else if (r < 6) out = x.sub(operand(xs, fam));
        else if (r < 8) out = x.mul(operand(xs, fam));
        else if (r < 10) out = x.div(operand(xs, fam));
        else if (r < 11) out = x.mod(operand(xs, fam));
        else if (r < 12) out = x.bitXor(operand(xs, fam));
        else if (r < 13 && fam === 'u256') out = s.shl(x, BigInt(g.int(300)));
        else if (r < 13) out = s.shr(x, BigInt(g.int(20)));
        else if (r < 14 && fam !== 'i256') out = s.pow(x, BigInt(g.int(4)));
        else if (r < 14 || r < 17) {
          const cmp = g.pick(['lt', 'gt', 'lte', 'gte', 'eq', 'neq'] as const);
          boolPool.push(x[cmp](operand(xs, fam)));
          return;
        } else if (r < 18 && boolPool.length > 0) {
          out = s.select(g.pick(boolPool), x, value(xs));
        } else if (r < 19 && fam === 'u8') {
          (pool.get('u256') ?? []).push(x.toUint(t.uint256));
          return;
        } else if (r < 19 && fam === 'i16') {
          (pool.get('i256') ?? []).push(x.toInt(t.int256));
          return;
        } else if (depth < 2) {
          // an if block: its values are scoped, so it works on copies and writes a cell
          const cond =
            boolPool.length > 0 && g.chance(0.7) ? g.pick(boolPool) : x.lt(operand(xs, fam));
          const target = g.pick(cells);
          const branch = (): void => {
            const inner = new Map<Fam, Num[]>(FAMS.map((f) => [f, [...(pool.get(f) ?? [])]]));
            const innerBools = [...boolPool];
            const n = 1 + g.int(3);
            for (let k = 0; k < n; k++) step(inner, innerBools, depth + 1);
            const src = inner.get(target.fam) ?? [];
            target.cell.set(value(src));
          };
          if (g.chance(0.5)) s.if(cond, branch);
          else s.if(cond, branch, branch);
          return;
        } else {
          out = x.add(1n);
        }
        xs.push(out);
      };

      for (let k = 0; k < steps; k++) step(pools, bools, 0);
      const record: Record<string, Num> = {};
      for (const f of FAMS) {
        const xs = pools.get(f) ?? [];
        record[`last_${f}`] = value(xs);
        if (g.chance(0.4)) record[`any_${f}`] = g.pick(xs);
      }
      cells.forEach((c, i) => {
        record[`cell${i}`] = c.cell.get();
      });
      if (bools.length > 0) record.flag = g.pick(bools);
      return builder.return(asReturn(record));
    },
  );
}

describe('store–reload fusion — seeded differential (optimize: false ≡ optimize: true ≡ interpret)', () => {
  test('300 generated scripts × 3 arg sets', async () => {
    const chain = chainOf({});
    const forms: FuseStats = {};
    let reverts = 0;
    let runs = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const script = randomScript(seed);
      const plain = compile(script);
      const { fused } = lowerProgram(eliminateDeadCode(script.ir), {
        evmVersion: 'cancun',
        optimize: true,
      });
      for (const [form, n] of Object.entries(fused ?? {})) forms[form] = (forms[form] ?? 0) + n;
      const optimized = compile(script, { optimize: true });
      expect(optimized.runtimeBytecode.length, `seed ${seed}: size`).toBeLessThanOrEqual(
        plain.runtimeBytecode.length,
      );
      const g = makeGen(seed * 7919);
      for (let k = 0; k < 3; k++) {
        const args = ARG_FAMS.map((f) => edgeValue(g, f));
        const label = `seed ${seed}, args (${args.join(', ')})`;
        const calldata = encodeFunctionData({
          abi: plain.abi,
          functionName: script.name,
          args,
        });
        const expected = interpret(script.ir, args, chain).outcome;
        // oxlint-disable-next-line no-await-in-loop -- sequential by design (deterministic labels)
        const [a, b] = await Promise.all([
          execRuntime(plain.runtimeBytecode, calldata),
          execRuntime(optimized.runtimeBytecode, calldata),
        ]);
        expect(a.success, `${label}: default outcome`).toBe(expected.kind === 'return');
        expect(a.data, `${label}: default payload`).toBe(expected.data);
        expect(b.success, `${label}: optimized outcome`).toBe(a.success);
        expect(b.data, `${label}: optimized payload`).toBe(a.data);
        expect(b.gasUsed, `${label}: optimized gas`).toBeLessThanOrEqual(a.gasUsed);
        runs += 1;
        if (!a.success) reverts += 1;
      }
    }
    // the corpus exercises both outcomes, and the pass fires (most windows are the bare form)
    expect(Object.values(forms).reduce((a, n) => a + n, 0)).toBeGreaterThan(300);
    expect(Object.keys(forms).length).toBeGreaterThanOrEqual(4);
    expect(reverts).toBeGreaterThan(runs / 10);
    expect(reverts).toBeLessThan(runs);
  }, 60_000);
});
