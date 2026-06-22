/**
 * M8 `codegen/frame.ts` — static frame layout (architecture §5).
 *
 * Contract: docs/design/module-interfaces.md §M8 (frozen) + architecture.md §5 (memory model).
 *
 * Every arg, cell, value and fn param/result gets one 32-byte slot in the static frame
 * starting at `0x80`; statement templates load operands (`PUSH slot MLOAD` / `PUSH const`),
 * compute, and `MSTORE` the result. No slot reuse, no liveness — `FrameLayout` is the
 * pluggable seam for a liveness-based allocator later.
 *
 * Slot order (deterministic, mirrors the worked example in architecture §15.3):
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
 * Values, params and results of *uncalled* fns get no slots (uncalled fns are dropped from
 * the emitted program — architecture §9); querying them is a compiler bug and throws.
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

/** Start of the static frame (architecture §5 memory map). */
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
      return [s.out];
    case 'call':
      return s.successOut === undefined ? s.outs : [...s.outs, s.successOut];
    case 'fncall':
      return s.outs;
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// layoutFrames
// ---------------------------------------------------------------------------

export function layoutFrames(ir: ScriptIr): FrameLayout {
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

  // 3. remaining values in id order (skip args, skip folded consts)
  const rest = [...defined].filter((v) => v >= ir.args.length && !folded.has(v));
  rest.sort((x, y) => x - y);
  for (const v of rest) valueSlots.set(v, take());

  // 4. fn regions (reachable fns, FnId order): result slots then the return-address slot
  const regions = new Map<FnId, { params: readonly number[]; results: readonly number[] }>();
  const retSlots = new Map<FnId, number>();
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
