/**
 * `codegen/lower/context.ts` — what every statement template shares: the `LowerCtx` contract,
 * the module-internal channel shared with `program.ts`, and the operand / slot / constant /
 * range-check helpers.
 */

import type { LabelId, AsmWriter } from '../../asm/assembler.js';
import type { EvmVersion } from '../../asm/ops.js';
import { EvsInternalError } from '../../core/errors.js';
import { type EvsType, type WordType, isWordType, bitsOf, isSigned } from '../../core/types.js';
import {
  type ScriptIr,
  type ValueId,
  type ConstData,
  type SiteId,
  type FnId,
  type Stmt,
  walkStmts,
} from '../../ir/nodes.js';
import { type SharedTails, fmtType } from '../abi.js';
import type { FrameLayout } from '../frame.js';
import { FREE_PTR } from '../memory.js';

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

export interface LowerCtx {
  ir: ScriptIr;
  frame: FrameLayout;
  tails: SharedTails;
  opts: { evmVersion: EvmVersion };
  loop: { breakTo: LabelId; continueTo: LabelId } | null;
  dataSeg: (bytes: Uint8Array) => LabelId;
}

/**
 * Operand-stack height at every statement boundary — also inside fn bodies, which spill their
 * return address on entry (see the fncall convention in the module header).
 */
export const STMT_BASELINE = 0;

// ---------------------------------------------------------------------------
// module-internal channel shared with program.ts (keyed by the ctx object)
// ---------------------------------------------------------------------------

/** @internal */
export interface LowerInternals {
  /** every `const` stmt's payload, keyed by its out ValueId (call-site literal folding). */
  consts: ReadonlyMap<ValueId, ConstData>;
  /** every value an `env address` stmt defines (the script's own address → SELFBALANCE). */
  selfAddresses: ReadonlySet<ValueId>;
  /** strict-call decode-fail stubs the program assembler must emit after the body. */
  dfailStubs: { label: LabelId; site: SiteId }[];
  /** fn entry labels, allocated on first `fncall` — uncalled fns never enter the map. */
  fnEntries: Map<FnId, LabelId>;
  /** fn emission worklist in discovery order (grows while subroutines are emitted). */
  fnQueue: FnId[];
  /**
   * The last `storeOut`: the value stored and the writer mark right after its MSTORE. A load
   * order hint only (see {@link justStored}); it never affects what a template computes.
   */
  lastStore: { value: ValueId; mark: number } | null;
}

/**
 * @internal Every value an `env address` statement defines, in the body and in every fn body
 * (values are single-assignment, so a ValueId is the script's own address wherever it is read).
 * The ONE definition of "the script's own address": `s.balance` of these values lowers to
 * SELFBALANCE (`values.ts`) and gets the self-balance ENV_FRAME_DEPENDENT note (`program.ts`
 * `collectDiagnostics`) — both read this set, so the note and the opcode cannot drift apart.
 */
export function selfAddressValues(ir: ScriptIr): ReadonlySet<ValueId> {
  const out = new Set<ValueId>();
  const scan = (s: Stmt): void => {
    if (s.k === 'env' && s.op === 'address') out.add(s.out);
  };
  walkStmts(ir.body, scan);
  for (const fn of ir.fns) walkStmts(fn.body, scan);
  return out;
}

const INTERNALS = new WeakMap<LowerCtx, LowerInternals>();

/** @internal Lazily-created per-lowering state (program.ts reads it after the body pass). */
export function lowerInternals(ctx: LowerCtx): LowerInternals {
  let state = INTERNALS.get(ctx);
  if (state === undefined) {
    const consts = new Map<ValueId, ConstData>();
    const scan = (s: Stmt): void => {
      if (s.k === 'const') consts.set(s.out, s.data);
    };
    walkStmts(ctx.ir.body, scan);
    for (const fn of ctx.ir.fns) walkStmts(fn.body, scan);
    const selfAddresses = selfAddressValues(ctx.ir);
    state = {
      consts,
      selfAddresses,
      dfailStubs: [],
      fnEntries: new Map(),
      fnQueue: [],
      lastStore: null,
    };
    INTERNALS.set(ctx, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

export function internal(message: string): EvsInternalError {
  return new EvsInternalError('INTERNAL', `codegen/lower: ${message}`);
}

export interface NodeMeta {
  note?: string;
}

export function meta(note?: string): NodeMeta {
  return note === undefined ? {} : { note };
}

export function typeOf(ctx: LowerCtx, v: ValueId): EvsType {
  const info = ctx.ir.values[v];
  if (info === undefined) throw internal(`unknown ValueId ${v}`);
  return info.type;
}

export function requireSlot(ctx: LowerCtx, v: ValueId, what: string): number {
  const slot = ctx.frame.slotOfValue(v);
  if (slot === null) throw internal(`${what}: ValueId ${v} is a folded const with no slot`);
  return slot;
}

export function wordConstValue(data: ConstData, what: string): bigint {
  if (data.kind !== 'word') throw internal(`${what}: expected a word const, got '${data.kind}'`);
  return BigInt(data.hex);
}

/** Loads the operand onto the stack: PUSH for folded word consts, PUSH slot MLOAD otherwise. */
export function loadOperand(w: AsmWriter, ctx: LowerCtx, v: ValueId, m?: NodeMeta): void {
  const slot = ctx.frame.slotOfValue(v);
  if (slot === null) {
    const data = lowerInternals(ctx).consts.get(v);
    if (data === undefined) throw internal(`ValueId ${v} folded but its const stmt is missing`);
    w.push(wordConstValue(data, `ValueId ${v}`), m);
    return;
  }
  w.push(slot, m);
  w.op('MLOAD');
}

/**
 * The compile-time value of `v` when it is a folded word const (operand becomes a PUSH), else
 * `undefined`. Values that own a slot are never reported, even when a const defines them.
 */
export function foldedConst(ctx: LowerCtx, v: ValueId): bigint | undefined {
  if (ctx.frame.slotOfValue(v) !== null) return undefined;
  const data = lowerInternals(ctx).consts.get(v);
  return data !== undefined && data.kind === 'word' ? BigInt(data.hex) : undefined;
}

/** `[v, …] → […]`: stores the stack top into the out value's slot. */
export function storeOut(w: AsmWriter, ctx: LowerCtx, v: ValueId, m?: NodeMeta): void {
  w.push(requireSlot(ctx, v, 'storeOut'), m);
  w.op('MSTORE');
  lowerInternals(ctx).lastStore = { value: v, mark: w.mark() };
}

/**
 * Whether the last node emitted is the `storeOut` of `v`. A template that loads `v` first then
 * emits `PUSH s MSTORE PUSH s MLOAD`, which the peephole's store-then-reload rewrite turns into
 * `DUP1 PUSH s MSTORE` under `optimize: true`. Commutative templates use it to pick their load
 * order; it is a hint, so a stale answer only costs that fusion.
 */
export function justStored(w: AsmWriter, ctx: LowerCtx, v: ValueId): boolean {
  const last = lowerInternals(ctx).lastStore;
  return last !== null && last.value === v && last.mark === w.mark();
}

/**
 * Bump-allocates a block at the free pointer: `[] → [ptr]` for a constant `size`, or
 * `[size] → [ptr]` for a runtime size on the stack (`'onStack'`). The free pointer ends at
 * `ptr + size`; the block is not zeroed, so the caller writes every word of it. The single
 * allocation point of `slice` and `bytesN → string`.
 */
export function emitBumpAlloc(w: AsmWriter, size: number | 'onStack'): void {
  if (size === 'onStack') {
    w.push(FREE_PTR);
    w.op('MLOAD'); // [ptr, size]
    w.op('SWAP1');
    w.op('DUP2');
    w.op('ADD'); // [ptr+size, ptr]
  } else {
    w.push(FREE_PTR);
    w.op('MLOAD'); // [ptr]
    w.op('DUP1');
    w.push(size);
    w.op('ADD'); // [ptr+size, ptr]
  }
  w.push(FREE_PTR);
  w.op('MSTORE'); // [ptr]   freePtr bumped
}

interface NumClass {
  bits: number;
  signed: boolean;
}

/** Narrows an operand type that the op table guarantees to be a word type. */
export function asWordType(type: EvsType): WordType {
  if (!isWordType(type)) throw internal(`expected a word type, got '${fmtType(type)}'`);
  return type;
}

export function numClass(type: EvsType): NumClass {
  return { bits: bitsOf(asWordType(type)), signed: isSigned(type) };
}

export const MIN_I256 = 1n << 255n;
/** −1 as a sign-extended word (every signed const is stored sign-extended to 256 bits). */
export const MINUS_ONE_WORD = (1n << 256n) - 1n;

export function maxUint(bits: number): bigint {
  return (1n << BigInt(bits)) - 1n;
}

export function maxInt(bits: number): bigint {
  return (1n << BigInt(bits - 1)) - 1n;
}

/** `[r, …] → [r, …]` or Panic 0x11: unsigned upper-bound check `r > max(bits)`. */
export function emitMaxCheck(w: AsmWriter, ctx: LowerCtx, max: bigint, note: string): void {
  w.op('DUP1'); // [r, r, …]
  w.push(max, { note }); // [max, r, r, …]
  w.op('LT'); // [max < r, r, …]
  w.pushLabel(ctx.tails.panicOverflow);
  w.op('JUMPI'); // [r, …]
}

/** `[r, …] → [r, …]` or Panic 0x11: SIGNEXTEND fixpoint check for intN, N < 256. */
export function emitFixpointCheck(w: AsmWriter, ctx: LowerCtx, bits: number): void {
  w.op('DUP1'); // [r, r, …]
  w.push(bits / 8 - 1, { note: `signextend int${bits}` }); // [k, r, r, …]
  w.op('SIGNEXTEND'); // [sx, r, …]
  w.op('DUP2'); // [r, sx, r, …]
  w.op('EQ'); // [r == sx, r, …]
  w.op('ISZERO');
  w.pushLabel(ctx.tails.panicOverflow);
  w.op('JUMPI'); // [r, …]
}
