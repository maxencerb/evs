/**
 * `codegen/frame.ts` — static frame layout.
 *
 * Every arg, cell, value and fn param/result gets one 32-byte slot in the static frame
 * starting at `0x80`; statement templates load operands (`PUSH slot MLOAD` / `PUSH const`),
 * compute, and `MSTORE` the result. `FrameLayout` is the seam between codegen and the
 * allocator: `slotOfValue` / `slotOfCell` / `fnRegion` / `frameEnd` are the only API, so the
 * two allocators below are interchangeable from the lowering's point of view.
 *
 * **Default layout** (`optimize: false`) — one slot per value, no reuse, no liveness. Slot
 * order (deterministic):
 *   1. script args — ValueIds `0 … args.length−1` (the positional binding `ir/validate.ts`
 *      pins);
 *   2. cells, in CellId order;
 *   3. every other value defined in the main body or a *reachable* fn (id order), except
 *      folded word constants — those become PUSH immediates and `slotOfValue` returns `null`.
 *      A word constant that is **returned** still gets a slot (the return encoder reads
 *      memory), and dynamic (`kind: 'data'`) constants always get one (they hold the memref
 *      pointer produced by their CODECOPY materialization);
 *   4. per reachable fn (FnId order): its dedicated result slots, then its return-address
 *      spill slot (see `lower.ts` — the callee saves the return address at entry so its body
 *      runs at stack baseline 0).
 *
 * **Liveness layout** (`optimize: true`, issue #41) — a linear-scan allocator over per-value
 * live ranges, reusing a slot once its previous occupant is dead. Slot order:
 *   1. script args — dedicated, never reused (positionally pinned by the entry decode);
 *   2. cells — dedicated, never reused (mutable; written at any program point);
 *   3. the main body's pool: values defined by main-body statements, packed by live range;
 *   4. per reachable fn (FnId order): its params (dedicated — the caller MSTOREs them before
 *      the jump, outside the callee's linearized timeline), the fn's own pool (its body's
 *      values, packed by live range — never shared with the main body or another fn), its
 *      dedicated result slots, then its return-address spill slot.
 * Live ranges are computed over the linearized (pre-order) statement sequence of each body:
 *   - a value is live from its defining statement to its last read (a statement reads all of
 *     its operands before it stores its outputs — every template in `lower.ts`/`call.ts`
 *     does — so a value whose last read is statement `p` may hand its slot to a value `p`
 *     defines);
 *   - the return encoder reads every `returns[].value` after the body, and a fn's epilogue
 *     reads its `resultValues` after its body — both count as reads at the end;
 *   - a `while` reads its `cond` after its header, on every iteration; a range that crosses a
 *     loop boundary (defined outside, read inside — or the reverse, or read across the
 *     back-edge) is widened to the whole loop, and to every enclosing loop it then crosses;
 *   - a range ending inside an `if` it did not start in is widened to the end of the `if`
 *     (both branches are linearized; the value stays live through the whole statement).
 * Wherever the analysis widens it widens to a statement boundary, never narrows; wrong reuse
 * would be silent corruption, which is why the differential suite runs an `optimize: true`
 * twin of every corpus case.
 *
 * Values, params and results of *uncalled* fns get no slots (uncalled fns are dropped from
 * the emitted program); querying them is a compiler bug and throws.
 */

import { EvsInternalError } from '../core/errors.js';
import {
  walkStmts,
  type CellId,
  type FnId,
  type ScriptIr,
  type Stmt,
  type ValueId,
} from '../ir/nodes.js';

export interface FrameLayout {
  slotOfValue(v: ValueId): number | null; // null = folded const (operand becomes push)
  slotOfCell(c: CellId): number;
  fnRegion(f: FnId): { params: readonly number[]; results: readonly number[] };
  frameEnd: number; // 0x80 + 32 × slotCount, ceil to 32
}

export interface FrameOptions {
  /** `compile({ optimize })` — enables the liveness-based allocator (default: one slot per value). */
  optimize?: boolean;
}

/** Start of the static frame (just above the `0x60` zero slot). */
const FRAME_BASE = 0x80;
const SLOT_BYTES = 32;

function internal(message: string): EvsInternalError {
  return new EvsInternalError('INTERNAL', `codegen/frame: ${message}`);
}

// ---------------------------------------------------------------------------
// internal: per-fn return-address spill slots (module-private channel to lower.ts)
// ---------------------------------------------------------------------------

const RET_SLOTS = new WeakMap<FrameLayout, ReadonlyMap<FnId, number>>();

/**
 * @internal Return-address spill slot of fn `f` (allocated by `layoutFrames` for every
 * reachable fn). The callee stores the stack-passed return address here at entry and reloads
 * it for the return `JUMP`, so its body runs at stack baseline 0 (see lower.ts module notes).
 */
export function fnReturnAddressSlot(frame: FrameLayout, f: FnId): number {
  const slot = RET_SLOTS.get(frame)?.get(f);
  if (slot === undefined) {
    throw internal(`fnReturnAddressSlot: fns[${f}] has no frame region (uncalled or unknown fn)`);
  }
  return slot;
}

// ---------------------------------------------------------------------------
// reachability + statement scanning
// ---------------------------------------------------------------------------

/** Fns reachable from the main body through `fncall` statements (transitively). */
function reachableFns(ir: ScriptIr): ReadonlySet<FnId> {
  const seen = new Set<FnId>();
  const queue: FnId[] = [];
  const scan = (stmts: readonly Stmt[]): void => {
    walkStmts(stmts, (s) => {
      if (s.k === 'fncall' && !seen.has(s.fn)) {
        seen.add(s.fn);
        queue.push(s.fn);
      }
    });
  };
  scan(ir.body);
  for (let i = 0; i < queue.length; i++) {
    const f = queue[i];
    if (f === undefined) continue;
    const fn = ir.fns[f];
    if (fn === undefined) throw internal(`fncall references unknown FnId ${f}`);
    scan(fn.body);
  }
  return seen;
}

/** Every ValueId a statement defines. */
function outsOf(s: Stmt): readonly ValueId[] {
  switch (s.k) {
    case 'const':
    case 'un':
    case 'env':
    case 'convert':
    case 'select':
    case 'index':
    case 'len':
    case 'arrnew':
    case 'cellget':
    case 'bin':
    case 'tuplenew': // one frame slot — the tuple pointer
    case 'field': // one frame slot — the member word or nested pointer
    case 'encode': // one frame slot — the fresh bytes memref pointer
    case 'keccak256': // one frame slot — the bytes32 hash word
      return [s.out];
    case 'call':
      return s.successOut === undefined ? s.outs : [...s.outs, s.successOut];
    case 'fncall':
      return s.outs;
    default:
      return [];
  }
}

/**
 * Every ValueId a statement reads (its operands), EXCLUDING a `while`'s `cond` — that read
 * happens after the header on every iteration and is positioned separately by `linearize`.
 * Exhaustive over the statement kinds on purpose: a new kind whose operands went uncounted
 * would free slots too early, so adding one must fail to compile here.
 */
function insOf(s: Stmt): readonly ValueId[] {
  switch (s.k) {
    case 'const':
    case 'env':
    case 'cellget':
    case 'break':
    case 'continue':
    case 'while':
      return [];
    case 'bin':
      return [s.a, s.b];
    case 'un':
    case 'convert':
    case 'len':
    case 'keccak256':
      return [s.a];
    case 'select':
      return [s.cond, s.a, s.b];
    case 'index':
      return [s.arr, s.i];
    case 'arrnew':
      return [s.length];
    case 'arrset':
      return [s.arr, s.i, s.value];
    case 'tuplenew':
      return s.inits.map((init) => init.value);
    case 'field':
      return [s.tuple];
    case 'tupleset':
      return [s.tuple, s.value];
    case 'encode':
    case 'throw':
      return s.args;
    case 'cellnew':
      return [s.init];
    case 'cellset':
      return [s.value];
    case 'call':
      return s.gas === undefined ? [s.target, ...s.args] : [s.target, s.gas, ...s.args];
    case 'fncall':
      return s.args;
    case 'if':
      return [s.cond];
    default:
      return unreachableStmt(s);
  }
}

function unreachableStmt(s: never): never {
  const kind = String((s as { k: unknown }).k);
  throw internal(`unknown statement kind '${kind}' survived validateIr`);
}

// ---------------------------------------------------------------------------
// liveness — linearized positions, regions, live ranges
// ---------------------------------------------------------------------------

/** A statement block's nesting region over linearized positions (inclusive bounds). */
interface Region {
  loop: boolean; // `while` (header + body re-execute) vs `if` (branches are exclusive)
  start: number; // the position of the `while` / `if` statement itself
  end: number; // the last position inside its child blocks
}

/** Inclusive live range over linearized positions. */
interface LiveRange {
  start: number;
  end: number;
  /** `end` was pushed to a region boundary (not a real last read): the statement at `end`
   *  may not hand this slot to a value it defines — the occupant is still read afterwards
   *  (next iteration) or the boundary is merely conservative. */
  widened: boolean;
}

interface Linearized {
  /** Definitions: `[position, ValueId]` in statement order. */
  defs: { pos: number; value: ValueId }[];
  /** Reads: `[position, ValueId]` (a `while` cond is read at its own position after the header). */
  reads: { pos: number; value: ValueId }[];
  regions: Region[];
  /** One past the last position — where the body's epilogue reads land. */
  count: number;
}

function linearize(stmts: readonly Stmt[]): Linearized {
  const out: Linearized = { defs: [], reads: [], regions: [], count: 0 };
  const visit = (block: readonly Stmt[]): void => {
    for (const s of block) {
      const pos = out.count++;
      for (const v of insOf(s)) out.reads.push({ pos, value: v });
      for (const v of outsOf(s)) out.defs.push({ pos, value: v });
      if (s.k === 'if') {
        visit(s.then);
        visit(s.else);
        out.regions.push({ loop: false, start: pos, end: out.count - 1 });
      } else if (s.k === 'while') {
        visit(s.header);
        // the cond is read after the header, before the body — on every iteration. It takes a
        // position of its own (no statement lives there) so a header value defined after the
        // cond cannot take the cond's slot before the check reads it.
        out.reads.push({ pos: out.count++, value: s.cond });
        visit(s.body);
        out.regions.push({ loop: true, start: pos, end: out.count - 1 });
      }
    }
  };
  visit(stmts);
  return out;
}

/**
 * Live ranges of the values `pool` contains (others — args, params, cells, folded consts —
 * are ignored). `epilogueReads` are read at position `count` (after the last statement).
 */
function liveRanges(
  lin: Linearized,
  pool: ReadonlySet<ValueId>,
  epilogueReads: readonly ValueId[],
): Map<ValueId, LiveRange> {
  const defAt = new Map<ValueId, number>();
  for (const d of lin.defs) {
    if (!pool.has(d.value)) continue;
    if (defAt.has(d.value)) throw internal(`ValueId ${d.value} is defined twice`);
    defAt.set(d.value, d.pos);
  }
  for (const v of pool) {
    if (!defAt.has(v)) throw internal(`ValueId ${v} is in the pool but has no definition`);
  }
  const ranges = new Map<ValueId, LiveRange>();
  for (const [v, pos] of defAt) ranges.set(v, { start: pos, end: pos, widened: false });
  const wraps = new Set<ValueId>(); // read at a position before the definition (back-edge)
  const read = (v: ValueId, pos: number): void => {
    const r = ranges.get(v);
    if (r === undefined) return; // not pooled (arg, param, cell-less, folded, foreign)
    if (pos < r.start) {
      wraps.add(v);
      r.start = pos;
    }
    if (pos > r.end) r.end = pos;
  };
  for (const rd of lin.reads) read(rd.value, rd.pos);
  for (const v of epilogueReads) read(v, lin.count);

  // innermost regions first: a region's children start strictly after it does, and widening to
  // a region's bounds can only newly cross its ancestors — which are processed later.
  const regions = lin.regions.toSorted((x, y) => y.start - x.start);
  for (const [v, r] of ranges) {
    if (wraps.has(v)) {
      // a read before the definition in linear order can only be a loop back-edge (validateIr
      // enforces def-before-use under the scope rule): the value must survive the whole loop.
      const def = defAt.get(v) ?? r.start;
      const loop = regions.find((g) => g.loop && g.start <= r.start && def <= g.end);
      if (loop === undefined) {
        throw internal(`ValueId ${v} is read before its definition outside any loop`);
      }
      r.start = Math.min(r.start, loop.start);
      r.end = Math.max(r.end, loop.end);
      r.widened = true;
    }
    for (const g of regions) {
      const intersects = r.start <= g.end && r.end >= g.start;
      const contained = r.start >= g.start && r.end <= g.end;
      if (!intersects || contained) continue;
      if (g.loop) {
        // crosses a loop boundary: live for every iteration ⇒ the whole loop
        r.start = Math.min(r.start, g.start);
        r.end = Math.max(r.end, g.end);
        r.widened = true;
      } else if (r.start < g.start && r.end > g.start) {
        // defined before the `if`, last read inside one branch (a read AT `g.start` is only the
        // `if` cond, consumed before either branch): live through the whole `if`. A range
        // already reaching past the `if` is untouched — widening only, never clipping.
        r.end = Math.max(r.end, g.end);
        r.widened = true;
      }
      // (defined inside an `if` and read after it cannot pass validateIr; the linear range
      // already spans the other branch if it ever did)
    }
  }
  return ranges;
}

/**
 * Linear scan over the ranges: values in `(start, id)` order take the lowest free slot; a
 * slot is free once its occupant's range ended before the new value's start, or at the same
 * position when that end is the occupant's real last read and it was defined earlier (a
 * statement reads all operands before it stores its outputs — two values defined by the same
 * statement never share, and a widened range keeps its slot through its boundary statement).
 * Returns slot ORDINALS (0-based, relative to the pool base) and the pool's size.
 */
function linearScan(ranges: ReadonlyMap<ValueId, LiveRange>): {
  ordinals: Map<ValueId, number>;
  size: number;
} {
  const order = [...ranges.entries()].toSorted(
    ([va, ra], [vb, rb]) => ra.start - rb.start || va - vb,
  );
  const ordinals = new Map<ValueId, number>();
  const active: { start: number; end: number; widened: boolean; ordinal: number }[] = [];
  const free: number[] = []; // kept sorted ascending
  let size = 0;
  for (const [v, r] of order) {
    for (let i = active.length - 1; i >= 0; i--) {
      const a = active[i];
      if (a === undefined) continue;
      if (a.end < r.start || (a.end === r.start && a.start < r.start && !a.widened)) {
        active.splice(i, 1);
        free.push(a.ordinal);
      }
    }
    free.sort((x, y) => x - y);
    const ordinal = free.length > 0 ? (free.shift() ?? size++) : size++;
    ordinals.set(v, ordinal);
    active.push({ start: r.start, end: r.end, widened: r.widened, ordinal });
  }
  return { ordinals, size };
}

// ---------------------------------------------------------------------------
// layoutFrames
// ---------------------------------------------------------------------------

export function layoutFrames(ir: ScriptIr, options?: FrameOptions): FrameLayout {
  const reachable = reachableFns(ir);

  // gather defined values + folded word consts over main body and reachable fn bodies
  const defined = new Set<ValueId>();
  const folded = new Set<ValueId>();
  const scanBlock = (stmts: readonly Stmt[]): void => {
    walkStmts(stmts, (s) => {
      for (const out of outsOf(s)) defined.add(out);
      if (s.k === 'const' && s.data.kind === 'word') folded.add(s.out);
    });
  };
  scanBlock(ir.body);
  for (const f of reachable) {
    const fn = ir.fns[f];
    if (fn === undefined) continue; // unreachable: reachableFns validated ids
    for (const p of fn.params) defined.add(p.value);
    scanBlock(fn.body);
  }
  // returned word consts are read from memory by the return encoder → they keep a slot
  for (const r of ir.returns) folded.delete(r.value);

  let cursor = FRAME_BASE;
  const take = (): number => {
    const slot = cursor;
    cursor += SLOT_BYTES;
    return slot;
  };

  // 1. args (ValueIds 0 … nargs−1)
  const valueSlots = new Map<ValueId, number>();
  for (let i = 0; i < ir.args.length; i++) valueSlots.set(i, take());

  // 2. cells
  const cellSlots = ir.cells.map(() => take());

  const regions = new Map<FnId, { params: readonly number[]; results: readonly number[] }>();
  const retSlots = new Map<FnId, number>();

  if (options?.optimize === true) {
    // 3. main pool — packed by live range
    const poolOf = (stmts: readonly Stmt[]): Set<ValueId> => {
      const pool = new Set<ValueId>();
      walkStmts(stmts, (s) => {
        for (const out of outsOf(s)) {
          if (out >= ir.args.length && !folded.has(out)) pool.add(out);
        }
      });
      return pool;
    };
    const packInto = (
      stmts: readonly Stmt[],
      pool: ReadonlySet<ValueId>,
      epilogueReads: readonly ValueId[],
    ): void => {
      const { ordinals, size } = linearScan(liveRanges(linearize(stmts), pool, epilogueReads));
      const base = cursor;
      for (const [v, ordinal] of ordinals) valueSlots.set(v, base + SLOT_BYTES * ordinal);
      cursor += SLOT_BYTES * size;
    };
    packInto(
      ir.body,
      poolOf(ir.body),
      ir.returns.map((r) => r.value),
    );
    // 4. fn frames (reachable fns, FnId order): params, the fn's pool, results, return slot
    ir.fns.forEach((fn, f) => {
      if (!reachable.has(f)) return;
      const params = fn.params.map((p) => {
        const slot = take();
        valueSlots.set(p.value, slot);
        return slot;
      });
      packInto(fn.body, poolOf(fn.body), fn.resultValues);
      const results = fn.results.map(() => take());
      regions.set(f, { params, results });
      retSlots.set(f, take());
    });
  } else {
    // 3. remaining values in id order (skip args, skip folded consts)
    const rest = [...defined].filter((v) => v >= ir.args.length && !folded.has(v));
    rest.sort((x, y) => x - y);
    for (const v of rest) valueSlots.set(v, take());

    // 4. fn regions (reachable fns, FnId order): result slots then the return-address slot
    ir.fns.forEach((fn, f) => {
      if (!reachable.has(f)) return;
      const params = fn.params.map((p, i) => {
        const slot = valueSlots.get(p.value);
        if (slot === undefined) {
          throw internal(`fns[${f}].params[${i}] (ValueId ${p.value}) has no frame slot`);
        }
        return slot;
      });
      const results = fn.results.map(() => take());
      regions.set(f, { params, results });
      retSlots.set(f, take());
    });
  }

  const frameEnd = cursor; // FRAME_BASE + 32 × slotCount — already 32-aligned

  const layout: FrameLayout = {
    slotOfValue(v: ValueId): number | null {
      if (!Number.isInteger(v) || v < 0 || v >= ir.values.length) {
        throw internal(`slotOfValue: unknown ValueId ${v}`);
      }
      const slot = valueSlots.get(v);
      if (slot !== undefined) return slot;
      if (folded.has(v)) return null;
      throw internal(
        `slotOfValue: ValueId ${v} has no frame slot (not defined in the main body or a reachable fn)`,
      );
    },
    slotOfCell(c: CellId): number {
      const slot = cellSlots[c];
      if (slot === undefined) throw internal(`slotOfCell: unknown CellId ${c}`);
      return slot;
    },
    fnRegion(f: FnId): { params: readonly number[]; results: readonly number[] } {
      const region = regions.get(f);
      if (region === undefined) {
        throw internal(`fnRegion: fns[${f}] has no frame region (uncalled or unknown fn)`);
      }
      return region;
    },
    frameEnd,
  };
  RET_SLOTS.set(layout, retSlots);
  return layout;
}
