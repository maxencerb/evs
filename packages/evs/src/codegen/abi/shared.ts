/**
 * `codegen/abi/shared.ts` — what every ABI emitter shares: the contract types handed in by the
 * program lowering (`SharedTails`, `SlotRef`), the scratch-slot and loop-frame layout constants
 * of the encoder and the decoder, word normalization, the tuple-layout helpers, and the
 * fork-portable `emitMemCopy` / `emitCeil32` primitives.
 */

import { type TypeLayout, layoutOf } from '../../abi/layout.js';
import type { LabelId, AsmWriter } from '../../asm/assembler.js';
import type { EvmVersion } from '../../asm/ops.js';
import { EvsInternalError } from '../../core/errors.js';
import type { EvsType, WordType, NamedType } from '../../core/types.js';
import { SCRATCH_0, SCRATCH_1 } from '../memory.js';

// ---------------------------------------------------------------------------
// contract types
// ---------------------------------------------------------------------------

export interface SharedTails {
  panicOverflow: LabelId;
  panicDivZero: LabelId;
  panicBounds: LabelId;
  panicAlloc: LabelId;
  invalidCalldata: LabelId;
  decodeRevert: LabelId;
  memcpy: LabelId | null; // null on cancun (MCOPY inline)
}

/** Absolute memory offset of a frame slot plus the evs type stored there. */
export interface SlotRef {
  slot: number;
  type: EvsType;
}

// ---------------------------------------------------------------------------
// shared constants / helpers
// ---------------------------------------------------------------------------

/** Scratch slot for running tail cursors (intra-template temporary). */
export const TAIL_CURSOR = SCRATCH_0;

/** Words per reserved encode loop frame: `{arrPtr, D, len, i}`. */
export const FRAME_SLOTS = 4;
export const FRAME_ARRPTR = 0;
export const FRAME_D = 1;
export const FRAME_LEN = 2;
export const FRAME_I = 3;

/**
 * Encode-time options threaded through {@link emitEncodeBlock}/{@link emitEncodeArrayTail}. The
 * `evmVersion` selects the memcpy lowering; `frameDepth` is the next free composite-array loop
 * frame index (each `emitEncodeArrayTail` consumes one frame and threads `frameDepth + 1` into the
 * encode of its elements, so concurrently-live array loops never share a frame). Default 0.
 */
export interface EncodeOpts {
  evmVersion: EvmVersion;
  frameDepth?: number;
}

/**
 * Scratch slot the array decoder ({@link emitDecodeArrayToMem}) keeps its per-element SOURCE base
 * in, read back by the recursive element decoders so the base is stack-depth-independent across
 * their internal churn. It is scratch `0x20` — free during *decode* (see the ownership table in
 * `codegen/memory.ts`). Its meaning depends on the decoder path that owns the innermost loop:
 *
 * - the STACK fast path (the shapes that fit the template budget, see
 *   {@link isStackDecodedArray}) stores the element base itself here (`ELEM_BASE`) and keeps
 *   the loop state on the operand stack;
 * - the HEAP-FRAME path (every deeper shape) stores the pointer of its heap-allocated loop frame
 *   here (`DECODE_FRAME`); the element base is word 0 of that frame.
 *
 * Both paths save the slot's prior value on entry and restore it on exit (the stack path keeps
 * it on the stack, the heap path in the frame's `parent` word), and both read their parent's base
 * before overwriting the slot — so the two nest inside each other in any order.
 */
export const ELEM_BASE = SCRATCH_1;
export const DECODE_FRAME = SCRATCH_1;
/** Words per heap array-decode frame: `{elemBase, i, D, arr, len, parent}`. */
export const DFRAME_SLOTS = 6;
export const DFRAME_ELEM_BASE = 0;
export const DFRAME_I = 1;
export const DFRAME_D = 2;
export const DFRAME_ARR = 3;
export const DFRAME_LEN = 4;
export const DFRAME_PARENT = 5;

export function internal(message: string): EvsInternalError {
  return new EvsInternalError('INTERNAL', `codegen/abi: ${message}`);
}

/** Human-readable rendering of a value type for error messages / debug notes (tuples → their
 *  JSON descriptor). Shared across the codegen emitters. */
export function fmtType(t: EvsType): string {
  return typeof t === 'string' ? t : JSON.stringify(t);
}

/**
 * @internal Shared by `codegen/call.ts`. True when decoding `l` needs a memory snapshot of the
 * source bytes: a tuple, or any array other than a dynamic word-element `T[]` (composite elements
 * `tuple[]`/`T[][]`/`string[]`, and every fixed-size `T[N]`) — all decode through the recursive
 * memory decoders, which read from memory (not calldata/returndata directly). A dynamic word
 * array / `string` / `bytes` keeps its direct alias-and-normalize fast path.
 */
export function needsMemorySnapshot(l: TypeLayout): boolean {
  return l.kind === 'tuple' || isRecursiveArray(l);
}

/** @internal An array layout the RECURSIVE array codec owns (as opposed to the flat word-array
 *  leaf path): any array whose element is not a word, or any fixed-size array. */
export function isRecursiveArray(l: TypeLayout): boolean {
  return l.kind === 'array' && (l.elem.kind !== 'word' || l.length !== null);
}

/**
 * Whether the array decoder may take its STACK fast path for `l` (#52): exactly the one- and
 * two-level shapes evs decoded on the stack before #4 — a DYNAMIC array whose element is a word,
 * `string`/`bytes`, a tuple, or a dynamic word-element array (`T[]`, `string[]`/`bytes[]`,
 * `tuple[]`, `T[][]`). Every other array (any fixed-size `T[N]`, and nesting deeper than that —
 * `uint256[][][]`, `string[][]`, `tuple[][]`, `T[N][]`, …) takes the heap-frame path. The choice
 * is per array level and static (made at codegen time, see {@link emitDecodeArrayToMem}); the two
 * paths nest in either order (see {@link ELEM_BASE}), so a heap-frame level's elements still take
 * the fast path when they qualify (`uint256[][][]` = one heap level over a stack-decoded
 * `uint256[][]`).
 */
export function isStackDecodedArray(l: Extract<TypeLayout, { kind: 'array' }>): boolean {
  if (l.length !== null) return false;
  const e = l.elem;
  if (e.kind === 'word' || e.kind === 'bytes' || e.kind === 'tuple') return true;
  return e.length === null && e.elem.kind === 'word';
}

function wordLayoutOf(type: WordType): Extract<TypeLayout, { kind: 'word' }> {
  const layout = layoutOf(type);
  if (layout.kind !== 'word') {
    throw internal(`expected a word type, got ${JSON.stringify(type)}`);
  }
  return layout;
}

/**
 * The element word abi of a DYNAMIC word-element array layout (`T[]`, the flat leaf shape).
 * Composite-element and fixed-size arrays are handled by the recursive array paths
 * (`emitDecodeArrayToMem` / `emitEncodeArrayTail` and the `isRecursiveArray` dispatches in the
 * callers), so reaching this with one is an internal invariant violation.
 */
export function wordElemAbi(layout: Extract<TypeLayout, { kind: 'array' }>): WordType {
  if (layout.elem.kind !== 'word' || isRecursiveArray(layout)) {
    throw internal('wordElemAbi: a recursive-codec array reached the flat word-array path');
  }
  return layout.elem.abi;
}

/**
 * @internal Shared by `codegen/call.ts`. True when a decoded word of `type` can carry dirty
 * bits that normalization must clean — false only for the three full-word types.
 */
export function wordNeedsNormalize(type: WordType): boolean {
  return type !== 'uint256' && type !== 'int256' && type !== 'bytes32';
}

/**
 * @internal Shared by `codegen/call.ts`. Normalizes the word on top of the stack to the
 * canonical form of `type`: `uintN`/`address` masked, `intN` sign-extended,
 * `bool` collapsed to 0/1 (`ISZERO ISZERO`), `bytesN` masked left-aligned. Net stack 0.
 */
export function emitNormalizeWord(w: AsmWriter, type: WordType): void {
  if (type === 'bool') {
    w.op('ISZERO');
    w.op('ISZERO');
    return;
  }
  const layout = wordLayoutOf(type);
  if (layout.bits === 256) return; // uint256 / int256 / bytes32 — every word is canonical
  if (layout.signed) {
    w.push(layout.bits / 8 - 1);
    w.op('SIGNEXTEND');
    return;
  }
  const mask = layout.leftAligned
    ? ((1n << BigInt(layout.bits)) - 1n) << BigInt(256 - layout.bits)
    : (1n << BigInt(layout.bits)) - 1n;
  w.push(mask, { note: `mask ${type}` });
  w.op('AND');
}

/**
 * @internal Shared by `codegen/call.ts`. Eager element-normalization loop over an array
 * memref payload.
 *
 * Stack contract: entry `[cur, end, …depthBelow items]` → exit `[cur, end, …]` with
 * `cur == end`; the loop labels are checked at absolute height `depthBelow + 2`, so the
 * caller must pass the exact number of live items beneath `[cur, end]`.
 */
export function emitNormalizeElemsLoop(w: AsmWriter, elem: WordType, depthBelow: number): void {
  const height = depthBelow + 2;
  const head = w.newLabel(`elemnorm_${elem}`);
  const done = w.newLabel(`elemnorm_${elem}_done`);
  w.label(head, height);
  w.op('DUP2'); // [end, cur, end, …]
  w.op('DUP2'); // [cur, end, cur, end, …]
  w.op('LT'); // [cur < end, cur, end, …]
  w.op('ISZERO');
  w.pushLabel(done);
  w.op('JUMPI'); // [cur, end, …]
  w.op('DUP1');
  w.op('MLOAD'); // [word, cur, end, …]
  emitNormalizeWord(w, elem);
  w.op('DUP2');
  w.op('MSTORE'); // [cur, end, …]
  w.push(32);
  w.op('ADD'); // [cur+32, end, …]
  w.pushLabel(head);
  w.op('JUMP');
  w.label(done, height);
}

/** A tuple layout's components as `NamedType[]` (reconstructed for the recursive decoders). */
export function tupleComponents(l: Extract<TypeLayout, { kind: 'tuple' }>): readonly NamedType[] {
  return l.components.map((c) => layoutToNamed(c));
}

function layoutToNamed(l: TypeLayout): NamedType {
  if (l.kind === 'tuple') {
    return { name: '', type: l.abi, components: l.components.map((c) => layoutToNamed(c)) };
  }
  if (l.kind === 'array') {
    // an array-of-tuple member (`tuple[]`, `tuple[2][]`, …) carries the LEAF tuple's components
    // under the array tag — the same `PlainAbiParam` shape the ABI uses.
    let leaf: TypeLayout = l.elem;
    while (leaf.kind === 'array') leaf = leaf.elem;
    if (leaf.kind === 'tuple') {
      return { name: '', type: l.abi, components: leaf.components.map((c) => layoutToNamed(c)) };
    }
  }
  return { name: '', type: l.abi };
}

// ---------------------------------------------------------------------------
// emitMemCopy — evmVersion lowering (MCOPY on cancun, @memcpy subroutine before)
// ---------------------------------------------------------------------------

/** @internal Shared by `codegen/call.ts`. Rounds the top of the stack up to a whole word:
 *  `[x] → [ceil32(x)]` (`(x + 31) & ~31`). */
export function emitCeil32(w: AsmWriter): void {
  w.push(31);
  w.op('ADD');
  w.push(31);
  w.op('NOT');
  w.op('AND');
}

/**
 * Memory copy primitive. Stack contract: `[dst, src, len] → []`.
 *
 * - cancun: a single `MCOPY` (byte-exact, works at any stack depth).
 * - paris/shanghai: a call into the shared `@memcpy` word-loop subroutine
 *   (`codegen/tails.ts`). The subroutine copies `ceil32(len)` bytes (whole words) — callers
 *   that need byte-exact tails must zero-pad `[dst+len, dst+ceil32(len))` afterwards — and
 *   its entry label is *checked* at absolute height 4, so pre-cancun callers MUST invoke this
 *   with the operand stack being exactly `[dst, src, len]` (nothing beneath). The stack
 *   verifier enforces the convention on every assemble.
 */
export function emitMemCopy(
  w: AsmWriter,
  tails: SharedTails,
  opts: { evmVersion: EvmVersion },
): void {
  if (opts.evmVersion === 'cancun') {
    w.op('MCOPY');
    return;
  }
  if (tails.memcpy === null) {
    throw internal(
      `emitMemCopy: tails.memcpy is null on a ${opts.evmVersion} build — createSharedTails must allocate the @memcpy label before cancun`,
    );
  }
  const ret = w.newLabel('memcpy_ret');
  w.pushLabel(ret); // [ret, dst, src, len]
  w.pushLabel(tails.memcpy);
  w.op('JUMP', { note: 'call @memcpy' });
  w.label(ret, 0); // subroutine consumed all four items; caller resumes empty
}
