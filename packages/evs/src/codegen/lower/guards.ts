/**
 * `codegen/lower/guards.ts` — dominating guard facts: the runtime checks the IR's own control
 * structure already proves redundant, found once per lowering (`LowerCtx.guards`).
 *
 * Values are single-assignment and `validateIr` enforces def-before-use with block scoping, so
 * when the bool `c` is defined by `bin lt a=x b=y`, `x < y` holds for the visible instances of
 * `x` and `y` wherever control is dominated by "`c` was just tested true". Two statement shapes
 * establish that **fact** `(x, y)`:
 * - a `while` whose `cond` is defined by a `bin lt` (wherever that statement sits): in its
 *   **body** only (not its header, not after the loop);
 * - an `if` whose `cond` is defined by a `bin lt`: in its **then** block only.
 * Facts nest (a body inside a body sees both) and never cross into an fn body: the body and
 * every fn body are walked separately, each starting with no facts. Only `lt` creates a fact.
 *
 * Two rules consume the facts:
 * - **R1, step overflow.** A checked `bin add` of `x` and a `const` whose word is 1 (either
 *   order, folded or not) under a fact `(x, y)` cannot overflow: `x < y ≤ max(type)` ⇒
 *   `x + 1 ≤ max(type)`, for every numeric type, signed included (`lt` and `add` take
 *   same-typed operands and `x` is shared, so all of them have one type).
 * - **R2, index bounds.** An `index` / `arrset` of array `A` at `x` under a fact `(x, y)` where
 *   `y` is `A`'s length is in bounds. Lengths compare by canonical key, not by ValueId, because
 *   two `.length()` reads of one array are two `len` values: `canon(y)` is `canon(L)` when `y`
 *   is a `len` of an array defined by `arrnew length=L`, "the length of `B`" when `y` is any
 *   other `len a=B`, else "the value `y`"; `A`'s own key is `canon(L)` when `A` is an
 *   `arrnew length=L`, else "the length of `A`". So `newArray(t, xs.length())` written under
 *   `forEach(xs)`'s guard, and chains like `newArray(t, out.length())`, are proven. `A` must be an array type (a `string` / `bytes` `.byteAt` keeps its check) and `x`
 *   unsigned. Array lengths are immutable in evs memory (no push / pop, the length word is never
 *   rewritten, and a failed `try*` output is a zero value of its type — the canonical zero-length
 *   value for a dynamic array, a fresh `[N][0…]` block for a fixed-size `T[N]` — which is never
 *   resized either), so the length read
 *   before the guard equals the word the bounds check would load. `s.forEach` records its
 *   `until` through `len` for a fixed-size `T[N]` too, so no constant-length rule is needed.
 *
 * `s.for` / `s.forEach` record exactly these shapes: the header guard `lt(i, until)` and the
 * step `add(i, step)` share the header's snapshot `i` (`builder/expr/control.ts`), and
 * `s.forEach`'s element load is `index arr=A i=i` with `until = len(A)`. The lowering selects
 * check-free templates for the proven statements (`arith.ts`, `composites.ts`) in both
 * `optimize` modes, and `codegen/sites.ts` asks the same sets, so no proven site claims a
 * Panic code. The interpreter keeps every check: it is the oracle the differential suite
 * holds the bytecode to.
 */

import { isArrayValueType, isNumeric, isSigned } from '../../core/types.js';
import type { ConstData, ScriptIr, Stmt, ValueId } from '../../ir/nodes.js';

/** The statements the lowering may emit without their runtime check, by object identity
 *  (lowering and the site table walk the same `ctx.ir` objects). A statement object that
 *  occurs at more than one place in the tree (hand-built IR may share one, see `ir/dce.ts`) is
 *  in a set only when EVERY occurrence is proven: the lowering emits each occurrence from the
 *  same object, so one unproven occurrence keeps the check for all of them. */
export interface GuardFacts {
  /** Checked `bin add` statements proven unable to overflow (R1). */
  readonly noOverflow: ReadonlySet<Stmt>;
  /** `index` / `arrset` statements whose index is proven in bounds (R2). */
  readonly inBounds: ReadonlySet<Stmt>;
}

/** A dominating `x < y`. */
interface Fact {
  readonly x: ValueId;
  readonly y: ValueId;
}

/** Computes the {@link GuardFacts} of a validated IR; `consts` maps every `const` stmt's out
 *  ValueId to its payload (`LowerCtx.consts`). */
export function guardFacts(ir: ScriptIr, consts: ReadonlyMap<ValueId, ConstData>): GuardFacts {
  const defs = new Map<ValueId, Stmt>();
  const collect = (stmts: readonly Stmt[]): void => {
    for (const s of stmts) {
      if ('out' in s) defs.set(s.out, s);
      if (s.k === 'if') {
        collect(s.then);
        collect(s.else);
      } else if (s.k === 'while') {
        collect(s.header);
        collect(s.body);
      }
    }
  };
  collect(ir.body);
  for (const fn of ir.fns) collect(fn.body);

  const noOverflow = new Set<Stmt>();
  const inBounds = new Set<Stmt>();

  const typeOf = (v: ValueId) => ir.values[v]?.type;
  const isOne = (v: ValueId): boolean => {
    const d = consts.get(v);
    return d !== undefined && d.kind === 'word' && BigInt(d.hex) === 1n;
  };
  const factOf = (cond: ValueId): Fact | undefined => {
    const d = defs.get(cond);
    return d !== undefined && d.k === 'bin' && d.op === 'lt' ? { x: d.a, y: d.b } : undefined;
  };
  // lengths are immutable, so every `len` of one array is one number and the length of an
  // `arrnew` is its `length` operand: canonical keys compare them across separate reads (the
  // recursion ends — values are single-assignment and defined before use)
  const lengthOf = (arr: ValueId): string => {
    const alloc = defs.get(arr);
    return alloc !== undefined && alloc.k === 'arrnew' ? canon(alloc.length) : `len:${arr}`;
  };
  const canon = (y: ValueId): string => {
    const len = defs.get(y);
    return len !== undefined && len.k === 'len' ? lengthOf(len.a) : `val:${y}`;
  };
  const lengthIs = (arr: ValueId, y: ValueId): boolean => canon(y) === lengthOf(arr);
  const indexInBounds = (arr: ValueId, i: ValueId, facts: readonly Fact[]): boolean => {
    const arrType = typeOf(arr);
    const iType = typeOf(i);
    if (arrType === undefined || !isArrayValueType(arrType)) return false;
    if (iType === undefined || !isNumeric(iType) || isSigned(iType)) return false;
    return facts.some((f) => f.x === i && lengthIs(arr, f.y));
  };

  // a statement object may occur more than once in the tree (an `arrset` defines no value, so
  // `validateIr` accepts the same object twice, and a shared `if` / `while` walks its children
  // twice): a verdict holds only when EVERY occurrence is proven, so each unproven occurrence is
  // remembered and struck from the result at the end
  const overflowUnproven = new Set<Stmt>();
  const boundsUnproven = new Set<Stmt>();

  const walk = (stmts: readonly Stmt[], facts: readonly Fact[]): void => {
    for (const s of stmts) {
      switch (s.k) {
        case 'bin':
          if (s.op !== 'add') break;
          if (facts.some((f) => (f.x === s.a && isOne(s.b)) || (f.x === s.b && isOne(s.a)))) {
            noOverflow.add(s);
          } else {
            overflowUnproven.add(s);
          }
          break;
        case 'index':
        case 'arrset':
          if (indexInBounds(s.arr, s.i, facts)) inBounds.add(s);
          else boundsUnproven.add(s);
          break;
        case 'if': {
          const fact = factOf(s.cond);
          walk(s.then, fact === undefined ? facts : [...facts, fact]);
          walk(s.else, facts);
          break;
        }
        case 'while': {
          const fact = factOf(s.cond);
          walk(s.header, facts);
          walk(s.body, fact === undefined ? facts : [...facts, fact]);
          break;
        }
        default:
          break;
      }
    }
  };
  walk(ir.body, []);
  for (const fn of ir.fns) walk(fn.body, []);
  for (const s of overflowUnproven) noOverflow.delete(s);
  for (const s of boundsUnproven) inBounds.delete(s);
  return { noOverflow, inBounds };
}
