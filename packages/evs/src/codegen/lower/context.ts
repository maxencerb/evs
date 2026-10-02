/**
 * `codegen/lower/context.ts` — what every statement template shares: the `LowerCtx` contract
 * (built once per lowering by `createLowerCtx`), and the operand / slot / constant /
 * range-check helpers.
 */

import type { LabelId, AsmWriter } from '../../asm/assembler.js';
import type { EvmVersion } from '../../asm/ops.js';
import { bytesToHex, HEX_BYTES_RE, hexToBytes, padWordAligned } from '../../core/bytes.js';
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

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

/** Where `break` / `continue` jump inside the innermost enclosing `while`. */
export interface LoopTargets {
  breakTo: LabelId;
  continueTo: LabelId;
}

/**
 * The state one lowering pass threads through every template. The first block is fixed for the
 * whole pass (`createLowerCtx` derives `consts` from the IR); the second changes while the body
 * and the fn subroutines are lowered, and `lowerProgram` reads `dfailStubs` / `fnQueue` back
 * afterwards.
 */
export interface LowerCtx {
  readonly ir: ScriptIr;
  readonly frame: FrameLayout;
  readonly tails: SharedTails;
  readonly opts: { evmVersion: EvmVersion };
  readonly dataSeg: (bytes: Uint8Array) => LabelId;
  /** Every `const` stmt's payload, keyed by its out ValueId (operand and call-site literal
   *  folding). */
  readonly consts: ReadonlyMap<ValueId, ConstData>;
  /** How many `const` stmts record each dynamic literal image, keyed by {@link literalImageKey}
   *  (body and every fn body): one data segment serves all of them, so `lowerConst` weighs the
   *  segment once against the per-use stores of the zero-fill form. */
  readonly literalUses: ReadonlyMap<string, number>;
  /** Every value an `env address` stmt defines (the script's own address → SELFBALANCE); see
   *  {@link selfAddressValues}. */
  readonly selfAddresses: ReadonlySet<ValueId>;
  /** How `mulDiv` sites are lowered: `null` inlines the body (one reachable site), otherwise
   *  every site calls the shared `@muldiv` subroutine, specialized to the rounding the sites
   *  use; see `lowerMulDiv`. */
  readonly mulDivShare: MulDivRounding | null;

  /** The innermost enclosing loop, `null` outside one (and at the top of every fn body). Set
   *  through `withLoop` only. */
  loop: LoopTargets | null;
  /** Strict-call decode-fail stubs the program assembler must emit after the body. */
  readonly dfailStubs: { label: LabelId; site: SiteId }[];
  /** Fn entry labels, allocated on first `fncall` — uncalled fns never enter the map. */
  readonly fnEntries: Map<FnId, LabelId>;
  /** Fn emission worklist in discovery order (grows while subroutines are emitted). */
  readonly fnQueue: FnId[];
  /**
   * The last `storeOut`: the value stored and the writer mark right after its MSTORE. A load
   * order hint only (see {@link justStored}); it never affects what a template computes.
   */
  lastStore: { value: ValueId; mark: number } | null;
}

/**
 * The rounding the shared `@muldiv` subroutine implements: `floor` when every site is a
 * `mulDiv`, `up` when every site is a `mulDivRoundingUp` (neither carries a rounding flag nor
 * the other mode's code), `mixed` when both occur (each site pushes a flag the subroutine tests).
 */
export type MulDivRounding = 'floor' | 'up' | 'mixed';

/**
 * How the program lowers its `mulDiv` / `mulDivRoundingUp` statements, from the sites it emits:
 * the main body's and those of the fns it can call (transitively) — an uncalled fn is never
 * emitted, so its sites must neither tip a one-site program into the shared subroutine nor
 * change its rounding. `null` (fewer than two sites) inlines the body. `recorded` counts the sites
 * of the whole IR (uncalled fns included): below two, no walk is needed.
 */
function mulDivShareOf(ir: ScriptIr, recorded: number): MulDivRounding | null {
  if (recorded < 2) return null;
  let floor = 0;
  let up = 0;
  walkEmittedStmts(ir, (s) => {
    if (s.k === 'modarith' && s.op === 'muldiv') floor += 1;
    if (s.k === 'modarith' && s.op === 'muldivup') up += 1;
  });
  if (floor + up < 2) return null;
  return up === 0 ? 'floor' : floor === 0 ? 'up' : 'mixed';
}

/**
 * @internal Visits every statement the lowering emits, each once: the main body's, then those of
 * every fn reachable through `fncall` (transitively, in discovery order; a fn called several
 * times is lowered once, and an uncalled fn is never emitted). `hot` tells whether the statement
 * can run many times per execution: it sits inside a `while` header (re-executed every iteration)
 * or body, or in a fn that a hot `fncall` reaches (a fn body is lowered once, so every statement
 * of a hot fn is hot). The call graph is acyclic; the seen-sets keep the walk finite anyway.
 */
export function walkEmittedStmts(ir: ScriptIr, visit: (s: Stmt, hot: boolean) => void): void {
  // no fn to reach (the common case): the body alone, in one pass
  if (ir.fns.length === 0) {
    walkWithLoops(ir.body, false, visit);
    return;
  }
  const reached: FnId[] = [];
  const seen = new Set<FnId>();
  const edges: { from: FnId | null; to: FnId; inLoop: boolean }[] = [];
  const scan = (stmts: readonly Stmt[], from: FnId | null): void => {
    walkWithLoops(stmts, false, (s, inLoop) => {
      if (s.k !== 'fncall') return;
      edges.push({ from, to: s.fn, inLoop });
      if (seen.has(s.fn)) return;
      seen.add(s.fn);
      reached.push(s.fn);
      const fn = ir.fns[s.fn];
      if (fn !== undefined) scan(fn.body, s.fn);
    });
  };
  scan(ir.body, null);
  // a fn is hot when some hot call reaches it: a fixpoint over the edges (each round adds a fn)
  const hotFns = new Set<FnId>();
  for (let changed = true; changed;) {
    changed = false;
    for (const e of edges) {
      if (hotFns.has(e.to) || !(e.inLoop || (e.from !== null && hotFns.has(e.from)))) continue;
      hotFns.add(e.to);
      changed = true;
    }
  }
  walkWithLoops(ir.body, false, visit);
  for (const f of reached) {
    const fn = ir.fns[f];
    if (fn !== undefined) walkWithLoops(fn.body, hotFns.has(f), visit);
  }
}

/** {@link walkStmts} that also tells whether each statement sits inside a `while` (or `inLoop`
 *  already holds for the whole list). */
function walkWithLoops(
  stmts: readonly Stmt[],
  inLoop: boolean,
  visit: (s: Stmt, inLoop: boolean) => void,
): void {
  for (const s of stmts) {
    visit(s, inLoop);
    if (s.k === 'if') {
      walkWithLoops(s.then, inLoop, visit);
      walkWithLoops(s.else, inLoop, visit);
    } else if (s.k === 'while') {
      walkWithLoops(s.header, true, visit);
      walkWithLoops(s.body, true, visit);
    }
  }
}

/**
 * Every value an `env address` statement defines, in the body and in every fn body (values are
 * single-assignment, so a ValueId is the script's own address wherever it is read). The ONE
 * definition of "the script's own address": `s.balance` of these values lowers to SELFBALANCE
 * (`values.ts`, through `LowerCtx.selfAddresses`) and gets the self-balance ENV_FRAME_DEPENDENT
 * note (`program.ts` `collectDiagnostics`) — both read this set, so the note and the opcode
 * cannot drift apart.
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

/** Builds the context for one lowering pass: scans the IR for its consts and self-address
 *  values, empty worklists. */
export function createLowerCtx(
  input: Pick<LowerCtx, 'ir' | 'frame' | 'tails' | 'opts' | 'dataSeg'>,
): LowerCtx {
  const consts = new Map<ValueId, ConstData>();
  const literalUses = new Map<string, number>();
  let mulDivSites = 0;
  const scan = (stmts: readonly Stmt[]): void => {
    walkStmts(stmts, (s) => {
      if (s.k === 'modarith' && (s.op === 'muldiv' || s.op === 'muldivup')) mulDivSites += 1;
      if (s.k !== 'const') return;
      consts.set(s.out, s.data);
      if (s.data.kind === 'word' || !HEX_BYTES_RE.test(s.data.hex)) return; // lowerConst rejects
      const key = literalImageKey(padWordAligned(hexToBytes(s.data.hex)));
      literalUses.set(key, (literalUses.get(key) ?? 0) + 1);
    });
  };
  scan(input.ir.body);
  for (const fn of input.ir.fns) scan(fn.body);
  return {
    ...input,
    consts,
    literalUses,
    selfAddresses: selfAddressValues(input.ir),
    mulDivShare: mulDivShareOf(input.ir, mulDivSites),
    loop: null,
    dfailStubs: [],
    fnEntries: new Map(),
    fnQueue: [],
    lastStore: null,
  };
}

/** The {@link LowerCtx.literalUses} key of a word-aligned literal image: its content, the same
 *  key the program's data-segment manager deduplicates on. */
export function literalImageKey(image: Uint8Array): string {
  return bytesToHex(image);
}

/** Runs `body` with `ctx.loop` set to `loop` (`null` for a fn body), then restores it. */
export function withLoop(
  ctx: Pick<LowerCtx, 'loop'>,
  loop: LoopTargets | null,
  body: () => void,
): void {
  const saved = ctx.loop;
  ctx.loop = loop;
  try {
    body();
  } finally {
    ctx.loop = saved;
  }
}

/**
 * Operand-stack height at every statement boundary — also inside fn bodies, which spill their
 * return address on entry (see the fncall convention in the module header).
 */
export const STMT_BASELINE = 0;

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
    const data = ctx.consts.get(v);
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
  const data = ctx.consts.get(v);
  return data !== undefined && data.kind === 'word' ? BigInt(data.hex) : undefined;
}

/** `[v, …] → […]`: stores the stack top into the out value's slot. */
export function storeOut(w: AsmWriter, ctx: LowerCtx, v: ValueId, m?: NodeMeta): void {
  w.push(requireSlot(ctx, v, 'storeOut'), m);
  w.op('MSTORE');
  ctx.lastStore = { value: v, mark: w.mark() };
}

/**
 * Whether the last node emitted is the `storeOut` of `v`. A template that loads `v` first then
 * emits `PUSH s MSTORE PUSH s MLOAD`, which the peephole's store-then-reload rewrite turns into
 * `DUP1 PUSH s MSTORE` under `optimize: true`. Commutative templates use it to pick their load
 * order; it is a hint, so a stale answer only costs that fusion.
 */
export function justStored(w: AsmWriter, ctx: LowerCtx, v: ValueId): boolean {
  const last = ctx.lastStore;
  return last !== null && last.value === v && last.mark === w.mark();
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
