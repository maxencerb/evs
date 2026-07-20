/**
 * M8 `codegen/lower.ts` — the statement templates (architecture §6 checked-op table —
 * NORMATIVE; §5 canonical word invariant; §3 control-flow shapes; §9 fncall convention).
 *
 * Contract: docs/design/module-interfaces.md §M8 (frozen `LowerCtx` / `lowerStmts`).
 *
 * Invariants (machine-checked by `asm/verify.ts` on every assemble):
 * - every statement template is net-zero on the operand stack; the stack is empty at every
 *   statement boundary;
 * - simulated depth stays ≤ 16 inside templates;
 * - panic exits jump to the shared `'any'` tails (`SharedTails`), never revert inline.
 *
 * Operand convention (architecture §15.1/§15.3): binary templates load the RIGHT operand
 * first, then the left — the left operand sits on top, so `SUB`/`DIV`/`LT`/… compute
 * `op(a, b)` directly. Folded word constants (`FrameLayout.slotOfValue === null`) load as
 * PUSH immediates; everything else as `PUSH slot MLOAD`.
 *
 * fncall convention (architecture §9, one recorded refinement): the caller MSTOREs args into
 * the callee's static param slots, pushes `@ret_k`, and jumps to the entry JUMPDEST
 * (annotated at stack height 1 — the return address). The callee then immediately SPILLS the
 * return address into its dedicated frame slot (`frame.ts` `fnReturnAddressSlot`) so the body
 * runs at stack baseline 0, and reloads it for the return JUMP. Rationale (recorded
 * deviation from §9's "return address stays on the stack during the body"): the frozen M7
 * emitters (`emitStaticCall`, `emitMemCopy`) pin checked labels at absolute height 0/1/4, so
 * a baseline-1 body could not contain calls; and nested fncalls would present two different
 * absolute heights to a single callee entry annotation, which the §10 verifier cannot
 * express. No recursion ⇒ one spill slot per fn is sound.
 */

import type { AsmWriter, LabelId } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import { HEX_BYTES_RE, hexToBytes, padWordAligned } from '../core/bytes.js';
import { EvsInternalError, type SourceLoc } from '../core/errors.js';
import {
  bitsOf,
  isSigned,
  isTupleType,
  isWordType,
  type EvsType,
  type WordType,
} from '../core/types.js';
import {
  walkStmts,
  type ConstData,
  type FnId,
  type ScriptIr,
  type SiteId,
  type Stmt,
  type ValueId,
} from '../ir/nodes.js';
import { emitNormalizeWord, fmtType, wordNeedsNormalize, type SharedTails } from './abi.js';
import { emitSimulateCall, emitStaticCall, type CallSitePlan } from './call.js';
import { fnReturnAddressSlot, type FrameLayout } from './frame.js';

// ---------------------------------------------------------------------------
// frozen contract (module-interfaces §M8)
// ---------------------------------------------------------------------------

export interface LowerCtx {
  ir: ScriptIr;
  frame: FrameLayout;
  tails: SharedTails;
  opts: { evmVersion: EvmVersion };
  loop: { breakTo: LabelId; continueTo: LabelId } | null;
  fnBaseline: 0 | 1; // stack baseline (1 inside fn bodies)
  dataSeg: (bytes: Uint8Array) => LabelId;
  siteOf(stmt: Stmt): SiteId;
}

export function lowerStmts(w: AsmWriter, stmts: readonly Stmt[], ctx: LowerCtx): void {
  for (const s of stmts) lowerStmt(w, s, ctx);
}

// ---------------------------------------------------------------------------
// module-internal channel shared with program.ts (keyed by the ctx object)
// ---------------------------------------------------------------------------

/** @internal */
export interface LowerInternals {
  /** every `const` stmt's payload, keyed by its out ValueId (call-site literal folding). */
  consts: ReadonlyMap<ValueId, ConstData>;
  /** strict-call decode-fail stubs the program assembler must emit after the body. */
  dfailStubs: { label: LabelId; site: SiteId }[];
  /** fn entry labels, allocated on first `fncall` — uncalled fns never enter the map. */
  fnEntries: Map<FnId, LabelId>;
  /** fn emission worklist in discovery order (grows while subroutines are emitted). */
  fnQueue: FnId[];
  /** `compile({ locations })` — false strips locs from emitted nodes. */
  locations: boolean;
}

const INTERNALS = new WeakMap<LowerCtx, LowerInternals>();

/** @internal Lazily-created per-lowering state (program.ts reads it after the body pass). */
export function lowerInternals(ctx: LowerCtx): LowerInternals {
  let state = INTERNALS.get(ctx);
  if (state === undefined) {
    const consts = new Map<ValueId, ConstData>();
    const scan = (stmts: readonly Stmt[]): void => {
      walkStmts(stmts, (s) => {
        if (s.k === 'const') consts.set(s.out, s.data);
      });
    };
    scan(ctx.ir.body);
    for (const fn of ctx.ir.fns) scan(fn.body);
    state = { consts, dfailStubs: [], fnEntries: new Map(), fnQueue: [], locations: true };
    INTERNALS.set(ctx, state);
  }
  return state;
}

/**
 * @internal Emits the subroutine bodies of every fn discovered through `fncall` statements
 * (architecture §9: JUMPDEST subroutine, entry at stack height 1, return address spilled to
 * the fn's frame slot, results copied to the fn's static result region, dynamic return
 * JUMP). Lowering a body may discover further fns; the worklist drains them all. Uncalled
 * fns are never emitted.
 */
export function emitFnSubroutines(w: AsmWriter, ctx: LowerCtx): void {
  const state = lowerInternals(ctx);
  for (let i = 0; i < state.fnQueue.length; i++) {
    const f = state.fnQueue[i];
    if (f === undefined) continue;
    const fn = ctx.ir.fns[f];
    const entry = state.fnEntries.get(f);
    if (fn === undefined || entry === undefined) {
      throw internal(`emitFnSubroutines: fns[${f}] missing from the IR or the entry map`);
    }
    const region = ctx.frame.fnRegion(f);
    const retSlot = fnReturnAddressSlot(ctx.frame, f);
    w.label(entry, 1, `fn_${fn.name}`); // [ret]
    w.push(retSlot, { note: `spill return address (${fn.name})` });
    w.op('MSTORE'); // []
    const savedLoop = ctx.loop;
    ctx.loop = null;
    lowerStmts(w, fn.body, ctx);
    ctx.loop = savedLoop;
    fn.resultValues.forEach((rv, j) => {
      const slot = region.results[j];
      if (slot === undefined) throw internal(`fns[${f}] result region is missing slot #${j}`);
      loadOperand(w, ctx, rv);
      w.push(slot, { note: `result #${j} (${fn.name})` });
      w.op('MSTORE');
    });
    w.push(retSlot);
    w.op('MLOAD');
    w.op('JUMP', { note: `return (${fn.name})` }); // dynamic return jump (checked region)
  }
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function internal(message: string): EvsInternalError {
  return new EvsInternalError('INTERNAL', `codegen/lower: ${message}`);
}

interface NodeMeta {
  loc?: SourceLoc | null;
  note?: string;
}

function meta(ctx: LowerCtx, s: Stmt, note?: string): NodeMeta {
  const m: NodeMeta = { loc: lowerInternals(ctx).locations ? s.loc : null };
  if (note !== undefined) m.note = note;
  return m;
}

function typeOf(ctx: LowerCtx, v: ValueId): EvsType {
  const info = ctx.ir.values[v];
  if (info === undefined) throw internal(`unknown ValueId ${v}`);
  return info.type;
}

function requireSlot(ctx: LowerCtx, v: ValueId, what: string): number {
  const slot = ctx.frame.slotOfValue(v);
  if (slot === null) throw internal(`${what}: ValueId ${v} is a folded const with no slot`);
  return slot;
}

function wordConstValue(data: ConstData, what: string): bigint {
  if (data.kind !== 'word') throw internal(`${what}: expected a word const, got '${data.kind}'`);
  return BigInt(data.hex);
}

/** Loads the operand onto the stack: PUSH for folded word consts, PUSH slot MLOAD otherwise. */
function loadOperand(w: AsmWriter, ctx: LowerCtx, v: ValueId, m?: NodeMeta): void {
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

/** `[v, …] → […]`: stores the stack top into the out value's slot. */
function storeOut(w: AsmWriter, ctx: LowerCtx, v: ValueId, m?: NodeMeta): void {
  w.push(requireSlot(ctx, v, 'storeOut'), m);
  w.op('MSTORE');
}

interface NumClass {
  bits: number;
  signed: boolean;
}

/** Narrows an operand type that the op table guarantees to be a word type. */
function asWordType(type: EvsType): WordType {
  if (!isWordType(type)) throw internal(`expected a word type, got '${fmtType(type)}'`);
  return type;
}

function numClass(type: EvsType): NumClass {
  return { bits: bitsOf(asWordType(type)), signed: isSigned(type) };
}

const MIN_I256 = 1n << 255n;

function maxUint(bits: number): bigint {
  return (1n << BigInt(bits)) - 1n;
}

function maxInt(bits: number): bigint {
  return (1n << BigInt(bits - 1)) - 1n;
}

/** `[r, …] → [r, …]` or Panic 0x11: unsigned upper-bound check `r > max(bits)`. */
function emitMaxCheck(w: AsmWriter, ctx: LowerCtx, max: bigint, note: string): void {
  w.op('DUP1'); // [r, r, …]
  w.push(max, { note }); // [max, r, r, …]
  w.op('LT'); // [max < r, r, …]
  w.pushLabel(ctx.tails.panicOverflow);
  w.op('JUMPI'); // [r, …]
}

/** `[r, …] → [r, …]` or Panic 0x11: SIGNEXTEND fixpoint check for intN, N < 256. */
function emitFixpointCheck(w: AsmWriter, ctx: LowerCtx, bits: number): void {
  w.op('DUP1'); // [r, r, …]
  w.push(bits / 8 - 1, { note: `signextend int${bits}` }); // [k, r, r, …]
  w.op('SIGNEXTEND'); // [sx, r, …]
  w.op('DUP2'); // [r, sx, r, …]
  w.op('EQ'); // [r == sx, r, …]
  w.op('ISZERO');
  w.pushLabel(ctx.tails.panicOverflow);
  w.op('JUMPI'); // [r, …]
}

// ---------------------------------------------------------------------------
// statement dispatch
// ---------------------------------------------------------------------------

function lowerStmt(w: AsmWriter, s: Stmt, ctx: LowerCtx): void {
  switch (s.k) {
    case 'const':
      lowerConst(w, s, ctx);
      return;
    case 'bin':
      lowerBin(w, s, ctx);
      return;
    case 'un':
      lowerUn(w, s, ctx);
      return;
    case 'env':
      lowerEnv(w, s, ctx);
      return;
    case 'convert':
      lowerConvert(w, s, ctx);
      return;
    case 'select':
      lowerSelect(w, s, ctx);
      return;
    case 'index':
      lowerIndex(w, s, ctx);
      return;
    case 'len':
      loadOperand(w, ctx, s.a, meta(ctx, s, 'len')); // [ptr]
      w.op('MLOAD'); // [len]
      storeOut(w, ctx, s.out);
      return;
    case 'arrnew':
      lowerArrnew(w, s, ctx);
      return;
    case 'arrset':
      lowerArrset(w, s, ctx);
      return;
    case 'tuplenew':
      lowerTupleNew(w, s, ctx);
      return;
    case 'field':
      lowerField(w, s, ctx);
      return;
    case 'tupleset':
      lowerTupleSet(w, s, ctx);
      return;
    case 'cellnew':
    case 'cellset':
      loadOperand(w, ctx, s.k === 'cellnew' ? s.init : s.value, meta(ctx, s, `cell ${s.cell} ←`));
      w.push(ctx.frame.slotOfCell(s.cell));
      w.op('MSTORE');
      return;
    case 'cellget':
      w.push(ctx.frame.slotOfCell(s.cell), meta(ctx, s, `cell ${s.cell} →`));
      w.op('MLOAD');
      storeOut(w, ctx, s.out);
      return;
    case 'call':
      lowerCall(w, s, ctx);
      return;
    case 'fncall':
      lowerFncall(w, s, ctx);
      return;
    case 'if':
      lowerIf(w, s, ctx);
      return;
    case 'while':
      lowerWhile(w, s, ctx);
      return;
    case 'break':
    case 'continue': {
      if (ctx.loop === null) throw internal(`'${s.k}' outside a loop survived validateIr`);
      w.pushLabel(s.k === 'break' ? ctx.loop.breakTo : ctx.loop.continueTo, meta(ctx, s, s.k));
      w.op('JUMP');
      return;
    }
    default: {
      const kind = String((s as { k: unknown }).k);
      throw internal(`unknown statement kind '${kind}' survived validateIr`);
    }
  }
}

// ---------------------------------------------------------------------------
// const — word consts fold to PUSH operands; data consts materialize via CODECOPY
// ---------------------------------------------------------------------------

function lowerConst(w: AsmWriter, s: Extract<Stmt, { k: 'const' }>, ctx: LowerCtx): void {
  if (s.data.kind === 'word') {
    const slot = ctx.frame.slotOfValue(s.out);
    if (slot === null) return; // folded — operands PUSH it directly
    // returned consts keep a slot (the return encoder reads memory): materialize it
    w.push(wordConstValue(s.data, `const #${s.out}`), meta(ctx, s, `const ${fmtType(s.type)}`));
    w.push(slot);
    w.op('MSTORE');
    return;
  }
  // dynamic literal: data segment + CODECOPY into a fresh allocation (architecture §3/§10).
  // The image is the memref `[len:32][payload…]`, zero-padded to a word boundary so the
  // trailing partial word lands clean (memory above the free pointer is not zero — §5).
  const bytes = literalBytes(s.data.hex, `const #${s.out}`);
  const padded = padWordAligned(bytes);
  const label = ctx.dataSeg(padded);
  w.push(0x40, meta(ctx, s, `literal ${fmtType(s.type)} (${bytes.length}B)`));
  w.op('MLOAD'); // [ptr]
  w.push(padded.length); // [size, ptr]
  w.pushLabel(label); // [src, size, ptr]
  w.op('DUP3'); // [ptr, src, size, ptr]
  w.op('CODECOPY'); // [ptr]
  w.op('DUP1');
  w.push(padded.length);
  w.op('ADD'); // [ptr+size, ptr]
  w.push(0x40);
  w.op('MSTORE'); // [ptr]          freePtr bumped
  storeOut(w, ctx, s.out); // []
}

function literalBytes(hex: string, what: string): Uint8Array {
  if (!HEX_BYTES_RE.test(hex)) throw internal(`${what}: malformed hex ${hex}`);
  return hexToBytes(hex);
}

// ---------------------------------------------------------------------------
// bin — checked arithmetic (architecture §6, NORMATIVE), comparisons, logic, bits
// ---------------------------------------------------------------------------

function lowerBin(w: AsmWriter, s: Extract<Stmt, { k: 'bin' }>, ctx: LowerCtx): void {
  const type = typeOf(ctx, s.a);
  switch (s.op) {
    case 'add':
    case 'sub':
    case 'mul':
      lowerCheckedArith(w, s, ctx, type);
      return;
    case 'div':
    case 'mod':
      lowerDivMod(w, s, ctx, type);
      return;
    case 'lt':
    case 'gt':
    case 'lte':
    case 'gte': {
      const signed = isSigned(type);
      loadOperand(w, ctx, s.b, meta(ctx, s, `${s.op} ${fmtType(type)}`));
      loadOperand(w, ctx, s.a); // [a, b]
      if (s.op === 'lt' || s.op === 'gte') w.op(signed ? 'SLT' : 'LT');
      else w.op(signed ? 'SGT' : 'GT');
      if (s.op === 'lte' || s.op === 'gte') w.op('ISZERO');
      storeOut(w, ctx, s.out);
      return;
    }
    case 'eq':
    case 'neq':
      loadOperand(w, ctx, s.b, meta(ctx, s, `${s.op} ${fmtType(type)}`));
      loadOperand(w, ctx, s.a);
      w.op('EQ');
      if (s.op === 'neq') w.op('ISZERO');
      storeOut(w, ctx, s.out);
      return;
    case 'and':
    case 'or':
      // eager bool logic on canonical 0/1 words (architecture §6)
      loadOperand(w, ctx, s.b, meta(ctx, s, `bool ${s.op}`));
      loadOperand(w, ctx, s.a);
      w.op(s.op === 'and' ? 'AND' : 'OR');
      storeOut(w, ctx, s.out);
      return;
    case 'bitand':
    case 'bitor':
    case 'bitxor':
      // canonical-preserving on canonical operands (no post-masking needed)
      loadOperand(w, ctx, s.b, meta(ctx, s, `${s.op} ${fmtType(type)}`));
      loadOperand(w, ctx, s.a);
      w.op(s.op === 'bitand' ? 'AND' : s.op === 'bitor' ? 'OR' : 'XOR');
      storeOut(w, ctx, s.out);
      return;
    case 'shl':
    case 'shr':
      lowerShift(w, s, ctx, type);
      return;
    default: {
      const op = String((s as { op: unknown }).op);
      throw internal(`unknown bin op '${op}' survived validateIr`);
    }
  }
}

/** add / sub / mul — the width-dependent checked templates of architecture §6. */
function lowerCheckedArith(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'bin' }>,
  ctx: LowerCtx,
  type: EvsType,
): void {
  const { bits, signed } = numClass(type);
  const m = meta(ctx, s, `checked ${s.op} ${fmtType(type)}`);
  loadOperand(w, ctx, s.b, m); // [b]
  loadOperand(w, ctx, s.a); // [a, b]

  if (s.op === 'add' && !signed) {
    if (bits === 256) {
      // §15.1 verbatim: overflow ⇔ r < b
      w.op('DUP2'); // [b, a, b]
      w.op('ADD'); // [r, b]
      w.op('DUP1'); // [r, r, b]
      w.op('SWAP2'); // [b, r, r]
      w.op('GT'); // [b > r, r]
      w.pushLabel(ctx.tails.panicOverflow);
      w.op('JUMPI'); // [r]
      storeOut(w, ctx, s.out); // []
      return;
    }
    // canonical operands ⇒ true sum < 2^257 never wraps: range check alone
    w.op('ADD'); // [r]
    emitMaxCheck(w, ctx, maxUint(bits), `max ${fmtType(type)}`);
    storeOut(w, ctx, s.out);
    return;
  }

  if (s.op === 'sub' && !signed) {
    // underflow ⇔ a < b, checked BEFORE the SUB (result stays canonical)
    w.op('DUP2'); // [b, a, b]
    w.op('DUP2'); // [a, b, a, b]
    w.op('LT'); // [a < b, a, b]
    w.pushLabel(ctx.tails.panicOverflow);
    w.op('JUMPI'); // [a, b]
    w.op('SUB'); // [r]
    storeOut(w, ctx, s.out);
    return;
  }

  if (s.op === 'mul' && !signed) {
    if (bits <= 128) {
      // true product < 2^256 for canonical operands ⇒ range check alone is sound
      w.op('MUL'); // [r]
      emitMaxCheck(w, ctx, maxUint(bits), `max ${fmtType(type)}`);
      storeOut(w, ctx, s.out);
      return;
    }
    // 256-bit product can wrap (N > 128) ⇒ div-back; sub-word widths ALSO range-check
    w.op('DUP2'); // [b, a, b]
    w.op('DUP2'); // [a, b, a, b]
    w.op('MUL'); // [r, a, b]
    emitUnsignedDivBack(w, ctx); // [r, a, b] (or Panic 0x11)
    if (bits < 256) emitMaxCheck(w, ctx, maxUint(bits), `max ${fmtType(type)}`);
    storeOut(w, ctx, s.out); // [a, b]
    w.op('POP');
    w.op('POP');
    return;
  }

  // ---- signed templates -------------------------------------------------------------
  if ((s.op === 'add' || s.op === 'sub') && bits < 256) {
    // canonical operands ⇒ true result representable in 256 bits: fixpoint check alone
    w.op(s.op === 'sub' ? 'SUB' : 'ADD'); // [r]
    emitFixpointCheck(w, ctx, bits);
    storeOut(w, ctx, s.out);
    return;
  }

  if (s.op === 'add' || s.op === 'sub') {
    // int256: solc sign-case formula (architecture §6)
    w.op('DUP2'); // [b, a, b]
    w.op('DUP2'); // [a, b, a, b]
    w.op(s.op === 'add' ? 'ADD' : 'SUB'); // [r, a, b]
    emitSignedAddSubCheck(w, ctx, s.op); // [r, a, b] (or Panic 0x11)
    storeOut(w, ctx, s.out); // [a, b]
    w.op('POP');
    w.op('POP');
    return;
  }

  // signed mul
  if (bits <= 128) {
    // |product| ≤ 2^254 ⇒ no signed 256-bit wrap ⇒ fixpoint check alone
    w.op('MUL'); // [r]
    emitFixpointCheck(w, ctx, bits);
    storeOut(w, ctx, s.out);
    return;
  }
  w.op('DUP2'); // [b, a, b]
  w.op('DUP2'); // [a, b, a, b]
  w.op('MUL'); // [r, a, b]
  emitSignedMulCheck(w, ctx); // [r, a, b] (or Panic 0x11)
  if (bits < 256) emitFixpointCheck(w, ctx, bits); // 128 < N < 256: int256 check THEN fixpoint
  storeOut(w, ctx, s.out); // [a, b]
  w.op('POP');
  w.op('POP');
}

/** `[r, a, b] → [r, a, b]` or Panic 0x11: `iszero(or(iszero(a), eq(div(r, a), b)))`. */
function emitUnsignedDivBack(w: AsmWriter, ctx: LowerCtx): void {
  w.op('DUP1'); // [r, r, a, b]
  w.op('DUP3'); // [a, r, r, a, b]
  w.op('SWAP1'); // [r, a, r, a, b]
  w.op('DIV'); // [r/a, r, a, b]    (div-by-zero yields 0 — guarded by iszero(a) below)
  w.op('DUP4'); // [b, r/a, r, a, b]
  w.op('EQ'); // [r/a == b, r, a, b]
  w.op('DUP3'); // [a, eq, r, a, b]
  w.op('ISZERO'); // [a == 0, eq, r, a, b]
  w.op('OR'); // [ok, r, a, b]
  w.op('ISZERO'); // [overflow, r, a, b]
  w.pushLabel(ctx.tails.panicOverflow);
  w.op('JUMPI'); // [r, a, b]
}

/**
 * `[r, a, b] → [r, a, b]` or Panic 0x11 — int256 add/sub sign-case formulas (§6):
 *   add: or(and(iszero(slt(b,0)), slt(r,a)), and(slt(b,0), sgt(r,a)))
 *   sub: or(and(iszero(slt(b,0)), sgt(r,a)), and(slt(b,0), slt(r,a)))
 */
function emitSignedAddSubCheck(w: AsmWriter, ctx: LowerCtx, op: 'add' | 'sub'): void {
  w.push(0); // [0, r, a, b]
  w.op('DUP4'); // [b, 0, r, a, b]
  w.op('SLT'); // [s = b<0, r, a, b]
  w.op('DUP1'); // [s, s, r, a, b]
  w.op('ISZERO'); // [!s, s, r, a, b]
  w.op('DUP4'); // [a, !s, s, r, a, b]
  w.op('DUP4'); // [r, a, !s, s, r, a, b]
  w.op(op === 'add' ? 'SLT' : 'SGT'); // [c1, !s, s, r, a, b]
  w.op('AND'); // [p1, s, r, a, b]
  w.op('SWAP1'); // [s, p1, r, a, b]
  w.op('DUP4'); // [a, s, p1, r, a, b]
  w.op('DUP4'); // [r, a, s, p1, r, a, b]
  w.op(op === 'add' ? 'SGT' : 'SLT'); // [c2, s, p1, r, a, b]
  w.op('AND'); // [p2, p1, r, a, b]
  w.op('OR'); // [overflow, r, a, b]
  w.pushLabel(ctx.tails.panicOverflow);
  w.op('JUMPI'); // [r, a, b]
}

/**
 * `[r, a, b] → [r, a, b]` or Panic 0x11 — int256 mul (§6): the sdiv-back test plus the lone
 * case it misses (`a == −1, b == −2^255`):
 *   or(and(eq(a, not(0)), eq(b, shl(255, 1))), and(iszero(iszero(a)), iszero(eq(sdiv(r, a), b))))
 */
function emitSignedMulCheck(w: AsmWriter, ctx: LowerCtx): void {
  w.op('DUP1'); // [r, r, a, b]
  w.op('DUP3'); // [a, r, r, a, b]
  w.op('SWAP1'); // [r, a, r, a, b]
  w.op('SDIV'); // [r sdiv a, r, a, b]
  w.op('DUP4'); // [b, q, r, a, b]
  w.op('EQ'); // [q == b, r, a, b]
  w.op('ISZERO'); // [neq, r, a, b]
  w.op('DUP3'); // [a, neq, r, a, b]
  w.op('ISZERO');
  w.op('ISZERO'); // [a != 0, neq, r, a, b]
  w.op('AND'); // [p2, r, a, b]
  w.op('DUP3'); // [a, p2, r, a, b]
  w.push(0);
  w.op('NOT'); // [not(0), a, p2, r, a, b]
  w.op('EQ'); // [a == −1, p2, r, a, b]
  w.op('DUP5'); // [b, a == −1, p2, r, a, b]
  w.push(MIN_I256, { note: 'min int256' }); // [min, b, …]
  w.op('EQ'); // [b == min, a == −1, p2, r, a, b]
  w.op('AND'); // [p1, p2, r, a, b]
  w.op('OR'); // [overflow, r, a, b]
  w.pushLabel(ctx.tails.panicOverflow);
  w.op('JUMPI'); // [r, a, b]
}

/** div / mod — zero check first (Panic 0x12), then the §6 width templates. */
function lowerDivMod(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'bin' }>,
  ctx: LowerCtx,
  type: EvsType,
): void {
  const { bits, signed } = numClass(type);
  loadOperand(w, ctx, s.b, meta(ctx, s, `checked ${s.op} ${fmtType(type)}`)); // [b]
  w.op('DUP1');
  w.op('ISZERO'); // [b == 0, b]
  w.pushLabel(ctx.tails.panicDivZero);
  w.op('JUMPI'); // [b]
  loadOperand(w, ctx, s.a); // [a, b]
  if (!signed) {
    w.op(s.op === 'div' ? 'DIV' : 'MOD'); // [r] — result ≤ a ⇒ canonical
    storeOut(w, ctx, s.out);
    return;
  }
  if (s.op === 'mod') {
    w.op('SMOD'); // [r] — |r| < |b| ⇒ always canonical
    storeOut(w, ctx, s.out);
    return;
  }
  if (bits === 256) {
    // EVM SDIV silently wraps −2^255 / −1 — explicit Panic 0x11 (§6)
    w.op('DUP1'); // [a, a, b]
    w.push(MIN_I256, { note: 'min int256' });
    w.op('EQ'); // [a == min, a, b]
    w.op('DUP3'); // [b, a == min, a, b]
    w.push(0);
    w.op('NOT'); // [not(0), b, …]
    w.op('EQ'); // [b == −1, a == min, a, b]
    w.op('AND'); // [overflow, a, b]
    w.pushLabel(ctx.tails.panicOverflow);
    w.op('JUMPI'); // [a, b]
    w.op('SDIV'); // [r]
    storeOut(w, ctx, s.out);
    return;
  }
  w.op('SDIV'); // [r]
  emitFixpointCheck(w, ctx, bits); // catches minN / −1 uniformly (§6)
  storeOut(w, ctx, s.out);
}

/** shl / shr — Solidity shifts are unchecked; results re-canonicalized to the width (§6). */
function lowerShift(
  w: AsmWriter,
  s: Extract<Stmt, { k: 'bin' }>,
  ctx: LowerCtx,
  type: EvsType,
): void {
  const wt = asWordType(type);
  const signed = isSigned(type);
  loadOperand(w, ctx, s.a, meta(ctx, s, `${s.op} ${fmtType(type)}`)); // [value]
  loadOperand(w, ctx, s.b); // [shift, value]
  if (s.op === 'shl') {
    w.op('SHL'); // [value << shift]
    // mask (uintN/bytesN) / sign-extend (intN) back to the width
    if (wordNeedsNormalize(wt)) emitNormalizeWord(w, wt);
  } else if (signed) {
    w.op('SAR'); // canonical-preserving on sign-extended operands
  } else {
    w.op('SHR');
    // left-aligned bytesN: SHR moves bits out of the lane — re-mask. uintN stays canonical.
    if (wt.startsWith('bytes') && wordNeedsNormalize(wt)) {
      emitNormalizeWord(w, wt);
    }
  }
  storeOut(w, ctx, s.out);
}

// ---------------------------------------------------------------------------
// un / env / convert
// ---------------------------------------------------------------------------

function lowerUn(w: AsmWriter, s: Extract<Stmt, { k: 'un' }>, ctx: LowerCtx): void {
  const type = typeOf(ctx, s.a);
  loadOperand(w, ctx, s.a, meta(ctx, s, `${s.op} ${fmtType(type)}`));
  if (s.op === 'not' || s.op === 'iszero') {
    w.op('ISZERO'); // canonical 0/1 bool
  } else {
    // bitnot — NOT denormalizes uintN (high bits) and bytesN (low bits); it preserves
    // sign-extension for intN, so only the unsigned lanes re-mask (§6).
    w.op('NOT');
    const wt = asWordType(type);
    if (!isSigned(wt) && wordNeedsNormalize(wt)) {
      emitNormalizeWord(w, wt);
    }
  }
  storeOut(w, ctx, s.out);
}

function lowerEnv(w: AsmWriter, s: Extract<Stmt, { k: 'env' }>, ctx: LowerCtx): void {
  switch (s.op) {
    case 'address':
      w.op('ADDRESS', meta(ctx, s, 'env address'));
      break;
    case 'caller':
      w.op('CALLER', meta(ctx, s, 'env caller'));
      break;
    case 'timestamp':
      w.op('TIMESTAMP', meta(ctx, s, 'env timestamp'));
      break;
    case 'blocknumber':
      w.op('NUMBER', meta(ctx, s, 'env blocknumber'));
      break;
    case 'chainid':
      w.op('CHAINID', meta(ctx, s, 'env chainid'));
      break;
    default: {
      const op = String((s as { op: unknown }).op);
      throw internal(`unknown env op '${op}' survived validateIr`);
    }
  }
  storeOut(w, ctx, s.out);
}

/**
 * convert (§6): free widening / free reinterpret where lossless; otherwise the logical value
 * is range-checked against the target (Panic 0x11) — matching the reference interpreter:
 * checked narrowing, cross-signedness, and `asAddress`'s high-96-bits-zero check.
 */
function lowerConvert(w: AsmWriter, s: Extract<Stmt, { k: 'convert' }>, ctx: LowerCtx): void {
  const from = typeOf(ctx, s.a);
  const to = typeOf(ctx, s.out);
  loadOperand(w, ctx, s.a, meta(ctx, s, `convert ${fmtType(from)} → ${fmtType(to)}`)); // [v]

  const reinterpret =
    from === to ||
    (from === 'uint256' && to === 'bytes32') ||
    (from === 'bytes32' && to === 'uint256');
  if (reinterpret) {
    storeOut(w, ctx, s.out);
    return;
  }
  if (to === 'address') {
    // asAddress: high 96 bits must be zero
    w.op('DUP1'); // [v, v]
    w.push(160);
    w.op('SHR'); // [v >> 160, v]
    w.pushLabel(ctx.tails.panicOverflow);
    w.op('JUMPI'); // [v]
    storeOut(w, ctx, s.out);
    return;
  }

  const f = numClass(from);
  const t = numClass(to);
  if (f.signed === t.signed) {
    if (t.bits < f.bits) {
      // checked narrowing
      if (t.signed) emitFixpointCheck(w, ctx, t.bits);
      else emitMaxCheck(w, ctx, maxUint(t.bits), `max ${fmtType(to)}`);
    } // else free widening
  } else if (!f.signed && t.signed) {
    // uintN → intM: free iff N < M (the value range fits the sign bit), else checked
    if (f.bits >= t.bits) emitMaxCheck(w, ctx, maxInt(t.bits), `max ${fmtType(to)}`);
  } else if (t.bits === 256) {
    // intN → uint256: only negativity can fail (sign-extended negatives are ≥ 2^255)
    w.op('DUP1'); // [v, v]
    w.push(255);
    w.op('SHR'); // [sign, v]
    w.pushLabel(ctx.tails.panicOverflow);
    w.op('JUMPI'); // [v]
  } else {
    // intN → uintM (M < 256): negatives are huge unsigned ⇒ one upper-bound check covers both
    emitMaxCheck(w, ctx, maxUint(t.bits), `max ${fmtType(to)}`);
  }
  storeOut(w, ctx, s.out);
}

// ---------------------------------------------------------------------------
// select / index / arrnew / arrset
// ---------------------------------------------------------------------------

function lowerSelect(w: AsmWriter, s: Extract<Stmt, { k: 'select' }>, ctx: LowerCtx): void {
  const base = ctx.fnBaseline;
  const takeA = w.newLabel(`select_a_${s.site}`);
  const done = w.newLabel(`select_done_${s.site}`);
  loadOperand(w, ctx, s.cond, meta(ctx, s, 'select')); // [cond]
  w.pushLabel(takeA);
  w.op('JUMPI'); // []
  loadOperand(w, ctx, s.b);
  storeOut(w, ctx, s.out);
  w.pushLabel(done);
  w.op('JUMP');
  w.label(takeA, base);
  loadOperand(w, ctx, s.a);
  storeOut(w, ctx, s.out);
  w.label(done, base);
}

function lowerIndex(w: AsmWriter, s: Extract<Stmt, { k: 'index' }>, ctx: LowerCtx): void {
  loadOperand(w, ctx, s.i, meta(ctx, s, 'index')); // [i]
  loadOperand(w, ctx, s.arr); // [ptr, i]
  w.op('DUP1');
  w.op('MLOAD'); // [len, ptr, i]
  w.op('DUP3'); // [i, len, ptr, i]
  w.op('LT'); // [i < len, ptr, i]
  w.op('ISZERO');
  w.pushLabel(ctx.tails.panicBounds);
  w.op('JUMPI'); // [ptr, i]               Panic 0x32 on OOB
  w.op('SWAP1'); // [i, ptr]
  w.push(5);
  w.op('SHL'); // [32·i, ptr]
  w.op('ADD'); // [ptr + 32·i]
  w.push(32);
  w.op('ADD'); // [addr]
  w.op('MLOAD'); // [elem]               elements are canonical (decode normalizes eagerly)
  storeOut(w, ctx, s.out);
}

function lowerArrnew(w: AsmWriter, s: Extract<Stmt, { k: 'arrnew' }>, ctx: LowerCtx): void {
  loadOperand(w, ctx, s.length, meta(ctx, s, `arrnew ${fmtType(s.elem)}[]`)); // [n]
  w.op('DUP1');
  w.push(0xffffffffn, { note: 'alloc cap 2^32−1' }); // [cap, n, n]
  w.op('LT'); // [cap < n, n]
  w.pushLabel(ctx.tails.panicAlloc);
  w.op('JUMPI'); // [n]                   Panic 0x41 on len ≥ 2^32
  w.push(0x40);
  w.op('MLOAD'); // [ptr, n]
  // freePtr += 32 + 32·n
  w.op('DUP2'); // [n, ptr, n]
  w.push(5);
  w.op('SHL'); // [32n, ptr, n]
  w.push(32);
  w.op('ADD'); // [size, ptr, n]
  w.op('DUP2'); // [ptr, size, ptr, n]
  w.op('ADD'); // [ptr+size, ptr, n]
  w.push(0x40);
  w.op('MSTORE'); // [ptr, n]
  // zero-fill [ptr, ptr+size) — CALLDATACOPY from past the calldata end reads zeros (§5)
  w.op('DUP2');
  w.push(5);
  w.op('SHL');
  w.push(32);
  w.op('ADD'); // [size, ptr, n]
  w.op('CALLDATASIZE'); // [cds, size, ptr, n]
  w.op('DUP3'); // [ptr, cds, size, ptr, n]
  w.op('CALLDATACOPY', { note: 'zero-fill' }); // [ptr, n]
  // length word
  w.op('DUP2'); // [n, ptr, n]
  w.op('DUP2'); // [ptr, n, ptr, n]
  w.op('MSTORE'); // [ptr, n]
  storeOut(w, ctx, s.out); // [n]
  w.op('POP'); // []
}

function lowerArrset(w: AsmWriter, s: Extract<Stmt, { k: 'arrset' }>, ctx: LowerCtx): void {
  loadOperand(w, ctx, s.value, meta(ctx, s, 'arrset')); // [v]
  loadOperand(w, ctx, s.i); // [i, v]
  loadOperand(w, ctx, s.arr); // [ptr, i, v]
  w.op('DUP1');
  w.op('MLOAD'); // [len, ptr, i, v]
  w.op('DUP3'); // [i, len, ptr, i, v]
  w.op('LT'); // [i < len, ptr, i, v]
  w.op('ISZERO');
  w.pushLabel(ctx.tails.panicBounds);
  w.op('JUMPI'); // [ptr, i, v]           Panic 0x32 on OOB
  w.op('SWAP1'); // [i, ptr, v]
  w.push(5);
  w.op('SHL'); // [32·i, ptr, v]
  w.op('ADD'); // [ptr + 32·i, v]
  w.push(32);
  w.op('ADD'); // [addr, v]
  w.op('MSTORE'); // []                  value is canonical (operand types validated)
}

// ---------------------------------------------------------------------------
// tuples / structs — FLAT-POINTER layout (architecture §5, spec §3): a tuple is a memref to a
// packed `[w0][w1]…[w_{n-1}]` block of `n` words (NO length prefix). A static member's word is
// canonical; a dynamic/composite member's word is a memref pointer.
// ---------------------------------------------------------------------------

/** The component count of the tuple-typed out value (the flat block has exactly this many words). */
function tupleArity(ctx: LowerCtx, v: ValueId): number {
  const ty = typeOf(ctx, v);
  if (!isTupleType(ty)) throw internal(`tuple op over a non-tuple value (ValueId ${v})`);
  return ty.components.length;
}

/** `s.tuple(type, init)` → bump-alloc `32·n`, zero-fill (CALLDATACOPY past-end, §5), MSTORE each
 *  provided member at `ptr + 32·i`. Omitted/literal-0 members need no MSTORE (the block is zero). */
function lowerTupleNew(w: AsmWriter, s: Extract<Stmt, { k: 'tuplenew' }>, ctx: LowerCtx): void {
  const n = tupleArity(ctx, s.out);
  const size = 32 * n;
  w.push(0x40, meta(ctx, s, `tuplenew ${n} words`));
  w.op('MLOAD'); // [ptr]
  // freePtr += size
  w.op('DUP1'); // [ptr, ptr]
  w.push(size);
  w.op('ADD'); // [ptr+size, ptr]
  w.push(0x40);
  w.op('MSTORE'); // [ptr]
  // zero-fill [ptr, ptr+size): CALLDATACOPY from past the calldata end reads zeros (§5). At stack
  // height exactly [ptr] here; the @memcpy contract is not used (no memref copy).
  w.push(size); // [size, ptr]
  w.op('CALLDATASIZE'); // [cds, size, ptr]
  w.op('DUP3'); // [ptr, cds, size, ptr]
  w.op('CALLDATACOPY', { note: 'zero-fill' }); // [ptr]
  // MSTORE each provided member at ptr + 32·index
  for (const init of s.inits) {
    loadOperand(w, ctx, init.value, meta(ctx, s, `member [${init.index}] ←`)); // [v, ptr]
    w.op('DUP2'); // [ptr, v, ptr]
    if (init.index > 0) {
      w.push(32 * init.index);
      w.op('ADD'); // [ptr+32·i, v, ptr]
    }
    w.op('MSTORE'); // [ptr]
  }
  storeOut(w, ctx, s.out); // []
}

/** `field i` read = `MLOAD(tuplePtr + 32·i)` → the canonical word or the member pointer. */
function lowerField(w: AsmWriter, s: Extract<Stmt, { k: 'field' }>, ctx: LowerCtx): void {
  loadOperand(w, ctx, s.tuple, meta(ctx, s, `field [${s.index}]`)); // [ptr]
  if (s.index > 0) {
    w.push(32 * s.index);
    w.op('ADD'); // [ptr+32·i]
  }
  w.op('MLOAD'); // [word]
  storeOut(w, ctx, s.out);
}

/** `field i` write = `MSTORE(tuplePtr + 32·i, value)`. */
function lowerTupleSet(w: AsmWriter, s: Extract<Stmt, { k: 'tupleset' }>, ctx: LowerCtx): void {
  loadOperand(w, ctx, s.value, meta(ctx, s, `tupleset [${s.index}] ←`)); // [v]
  loadOperand(w, ctx, s.tuple); // [ptr, v]
  if (s.index > 0) {
    w.push(32 * s.index);
    w.op('ADD'); // [ptr+32·i, v]
  }
  w.op('MSTORE'); // []
}

// ---------------------------------------------------------------------------
// call / fncall
// ---------------------------------------------------------------------------

function lowerCall(w: AsmWriter, s: Extract<Stmt, { k: 'call' }>, ctx: LowerCtx): void {
  const state = lowerInternals(ctx);
  const tryMode = s.mode === 'try';
  const site = ctx.siteOf(s);
  const dfailLabel = w.newLabel(tryMode ? `zero_${site}` : `dfail_${site}`);
  if (!tryMode) state.dfailStubs.push({ label: dfailLabel, site });

  const refOf = (v: ValueId): CallSitePlan['argRefs'][number] => {
    const data = state.consts.get(v);
    if (data !== undefined && ctx.frame.slotOfValue(v) === null) return { literal: data };
    // dynamic literals carry a slot (materialized memref) but still fold into the
    // CalldataTemplate's const segments — architecture §7.1 const-merging
    if (data !== undefined && data.kind === 'data') return { literal: data };
    return { slot: requireSlot(ctx, v, `call arg/target (site ${site})`), type: typeOf(ctx, v) };
  };

  let successRef: CallSitePlan['successRef'] = null;
  if (tryMode) {
    if (s.successOut === undefined) {
      throw internal(`try call (site ${site}) without successOut survived validateIr`);
    }
    successRef = { slot: requireSlot(ctx, s.successOut, 'successOut'), type: 'bool' };
  }

  const stmt = state.locations ? s : { ...s, loc: null };
  const plan: CallSitePlan = {
    stmt,
    targetRef: refOf(s.target),
    ...(s.gas === undefined ? {} : { gasRef: refOf(s.gas) }),
    argRefs: s.args.map(refOf),
    outRefs: s.outs.map((o) => ({
      slot: requireSlot(ctx, o, `call out (site ${site})`),
      type: typeOf(ctx, o),
    })),
    successRef,
    dfailLabel,
    siteId: site,
  };
  // issue #1: kind 'static' (STATICCALL) / 'call' (CALL) share emitStaticCall; 'simulate' is the
  // self-call trampoline + rollback macro.
  if (s.kind === 'simulate') {
    emitSimulateCall(w, plan, ctx.tails, ctx.opts, ctx.dataSeg);
  } else {
    emitStaticCall(w, plan, ctx.tails, ctx.opts, ctx.dataSeg);
  }
}

function lowerFncall(w: AsmWriter, s: Extract<Stmt, { k: 'fncall' }>, ctx: LowerCtx): void {
  const state = lowerInternals(ctx);
  const fn = ctx.ir.fns[s.fn];
  if (fn === undefined) throw internal(`fncall to unknown FnId ${s.fn} survived validateIr`);
  let entry = state.fnEntries.get(s.fn);
  if (entry === undefined) {
    entry = w.newLabel(`fn_${fn.name}`);
    state.fnEntries.set(s.fn, entry);
    state.fnQueue.push(s.fn);
  }
  const region = ctx.frame.fnRegion(s.fn);

  // args → callee param slots (architecture §9)
  s.args.forEach((a, i) => {
    const slot = region.params[i];
    if (slot === undefined) throw internal(`fns[${s.fn}] param region is missing slot #${i}`);
    loadOperand(w, ctx, a, i === 0 ? meta(ctx, s, `fncall ${fn.name}`) : undefined);
    w.push(slot);
    w.op('MSTORE');
  });

  const ret = w.newLabel(`ret_${s.site}`);
  w.pushLabel(ret, s.args.length === 0 ? meta(ctx, s, `fncall ${fn.name}`) : undefined); // [ret]
  w.pushLabel(entry);
  w.op('JUMP'); // → callee (entry label carries stack 1)
  w.label(ret, ctx.fnBaseline);

  // result region → per-callsite out slots (two calls never alias)
  s.outs.forEach((o, j) => {
    const src = region.results[j];
    if (src === undefined) throw internal(`fns[${s.fn}] result region is missing slot #${j}`);
    w.push(src);
    w.op('MLOAD');
    storeOut(w, ctx, o);
  });
}

// ---------------------------------------------------------------------------
// control flow
// ---------------------------------------------------------------------------

function lowerIf(w: AsmWriter, s: Extract<Stmt, { k: 'if' }>, ctx: LowerCtx): void {
  const base = ctx.fnBaseline;
  const hasElse = s.else.length > 0;
  const elseL = hasElse ? w.newLabel(`else_${s.site}`) : null;
  const endL = w.newLabel(`endif_${s.site}`);
  loadOperand(w, ctx, s.cond, meta(ctx, s, 'if')); // [cond]
  w.op('ISZERO');
  w.pushLabel(elseL ?? endL);
  w.op('JUMPI'); // []
  lowerStmts(w, s.then, ctx);
  if (elseL !== null) {
    w.pushLabel(endL);
    w.op('JUMP');
    w.label(elseL, base);
    lowerStmts(w, s.else, ctx);
  }
  w.label(endL, base);
}

function lowerWhile(w: AsmWriter, s: Extract<Stmt, { k: 'while' }>, ctx: LowerCtx): void {
  const base = ctx.fnBaseline;
  const head = w.newLabel(`while_${s.site}`);
  const end = w.newLabel(`endwhile_${s.site}`);
  w.label(head, base); // re-executed every iteration (architecture §15.3)
  lowerStmts(w, s.header, ctx);
  loadOperand(w, ctx, s.cond, meta(ctx, s, 'while cond')); // [cond]
  w.op('ISZERO');
  w.pushLabel(end);
  w.op('JUMPI'); // []
  const saved = ctx.loop;
  ctx.loop = { breakTo: end, continueTo: head };
  lowerStmts(w, s.body, ctx);
  ctx.loop = saved;
  w.pushLabel(head);
  w.op('JUMP');
  w.label(end, base);
}
