/**
 * `codegen/abi/shared.ts` — what every ABI emitter shares: the contract types handed in by the
 * program lowering (`SharedTails`, `SlotRef`), the scratch-slot and loop-frame layout constants
 * of the encoder and the decoder, the range check of a decoded word and the wrap of a computed
 * one, the tuple-layout helpers, and the fork-portable `emitMemCopy` / `emitCeil32` primitives.
 */

import { type TypeLayout, layoutOf } from '../../abi/layout.js';
import type { LabelId, AsmWriter } from '../../asm/assembler.js';
import { forkAtLeast, OPS, type EvmVersion } from '../../asm/ops.js';
import { MAX_TEMPLATE_DEPTH } from '../../asm/verify.js';
import { EvsCompileError, EvsInternalError } from '../../core/errors.js';
import type { EvsType, WordType, NamedType } from '../../core/types.js';
import type { EncodeMemberKind } from '../codec-keys.js';
import { FREE_PTR, SCRATCH_1 } from '../memory.js';

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
  mulDiv: LabelId; // the shared FullMath subroutine (`codegen/lower/muldiv.ts`)
  /** The codec-sharing hook (`codegen/codecs.ts`), `null` when nothing is shared: every codec
   *  is then inlined at its site, exactly as without the hook. */
  codecs: CodecHook | null;
}

/**
 * @internal The codec-sharing hook the program lowering hands the ABI emitters through
 * {@link SharedTails.codecs}, implemented by `CodecShare` in `codegen/codecs.ts` (declared here so
 * the emitters never import that module). Each method either emits the CALL of a shared codec
 * body for the use at hand and returns `true`, or returns `false` and leaves the use to its
 * inline emitter. Only statement-level site code calls it, never a body or a nested encode.
 */
export interface CodecHook {
  /**
   * One top-level composite member of a top-level encode block, of `kind` and `layout`, entered
   * at stack height 0. `pushSrc` pushes its source pointer; `pushBase` its DST base
   * (`parentBase + headOffset`) for a static member, `null` for a dynamic one, whose head offset
   * word the caller has already written. `name` annotates the call.
   */
  encodeMember(
    w: AsmWriter,
    kind: EncodeMemberKind,
    layout: TypeLayout,
    name: string,
    pushSrc: () => void,
    pushBase: (() => void) | null,
  ): boolean;
  /**
   * One decoder unit (a `dec|…` key from `codegen/codec-keys.ts`), entered at `[buf]`; on return
   * the decoded block pointer sits on top: `[buf] → [block, buf]`. `fail` is the site's own
   * post-snapshot decode-failure router, which the call routes a body failure through. `note`
   * annotates the call.
   */
  decode(w: AsmWriter, key: string, fail: (liveDepth: number) => void, note: string): boolean;
  /** The statement whose codec uses are emitted next (`RETURNS_SITE` for the return encode). */
  enterSite(site: number): void;
}

/** Absolute memory offset of a frame slot plus the evs type stored there. */
export interface SlotRef {
  slot: number;
  type: EvsType;
}

// ---------------------------------------------------------------------------
// shared constants / helpers
// ---------------------------------------------------------------------------

/**
 * Words per reserved encode frame: `{arrPtr, D, len, i, elem, base}`. An array loop owns the
 * whole frame — its loop state plus, per iteration, the cached element word (`elem`, the source
 * pointer of a composite element) and the DST base of a tuple element (`base`). A nested dynamic
 * tuple level uses only `elem` (its source pointer) and `base` (where its head starts).
 */
export const FRAME_SLOTS = 6;
export const FRAME_ARRPTR = 0;
export const FRAME_D = 1;
export const FRAME_LEN = 2;
export const FRAME_I = 3;
export const FRAME_ELEM = 4;
export const FRAME_BASE = 5;

/**
 * Encode-time options threaded through {@link emitEncodeBlock}/{@link emitEncodeArrayTail}. The
 * `evmVersion` selects the memcpy lowering; `frameDepth` is the next free encode frame index
 * (each array loop and each nested dynamic tuple level consumes one frame and threads
 * `frameDepth + 1` into the encode of what it contains, so concurrently-live levels never share a
 * frame). Default 0.
 */
export interface EncodeOpts {
  evmVersion: EvmVersion;
  frameDepth?: number;
}

/**
 * Scratch slot the array decoder (`emitDecodeArrayToMem` in `decode.ts`) keeps its per-element
 * SOURCE base in, read back by the recursive element decoders so the base is
 * stack-depth-independent across their internal churn. It is scratch `0x20` — free during
 * *decode* (see the ownership table in `codegen/memory.ts`). Its meaning depends on the decoder
 * path that owns the innermost loop:
 *
 * - the STACK fast path (the shapes that fit the template budget, see
 *   {@link isStackDecodedArray}) stores the element base itself here (`ELEM_BASE`) and keeps
 *   the loop state on the operand stack;
 * - the HEAP-FRAME path (every deeper shape) stores the pointer of its heap-allocated loop frame
 *   here (`DECODE_FRAME`); the element base is word 0 of that frame.
 *
 * The tuple decoder uses the same slot for a dynamic sub-tuple nested two levels below the
 * nearest O(1) base: it stores a two-word TUPLE FRAME `{base, parent}` here, so the sub-tuple's
 * members read their base back with the heap path's element-base load instead of re-deriving it
 * through every enclosing offset word.
 *
 * Every user saves the slot's prior value on entry and restores it on exit (the stack path keeps
 * it on the stack, the frames in their `parent` word), and each reads its parent's base before
 * overwriting the slot — so they nest inside each other in any order.
 */
export const ELEM_BASE = SCRATCH_1;
export const DECODE_FRAME = SCRATCH_1;
/** Words per heap array-decode frame: `{elemBase, i, D, len, parent}` (the destination pointer
 *  block itself rides on the operand stack — the one live word per heap level). */
export const DFRAME_SLOTS = 5;
export const DFRAME_ELEM_BASE = 0;
export const DFRAME_I = 1;
export const DFRAME_D = 2;
export const DFRAME_LEN = 3;
export const DFRAME_PARENT = 4;
/** Words per tuple-decode frame: `{base, parent}`. The base sits at word 0, like a heap frame's
 *  element base, so both read back the same way. */
export const TFRAME_SLOTS = 2;
export const TFRAME_BASE = 0;
export const TFRAME_PARENT = 1;

export function internal(message: string): EvsInternalError {
  return new EvsInternalError('INTERNAL', `codegen/abi: ${message}`);
}

/**
 * @internal Shared with `codegen/call/` and `codegen/lower/`. Runs a template fragment emitter (`emit`, entered at
 * absolute operand-stack height `entryHeight`) and checks what it produced against the 16-item
 * template budget. Used around the decoders and the try-mode zero values, whose stack use grows
 * with the nesting of the type: the array decoder already falls back from its stack fast path to
 * the heap-frame path wherever the fast path would not fit, but tuple levels and heap array
 * levels (one live word each) still add up, so a type that nests structs and arrays deeply
 * enough cannot be handled within the EVM's reachable stack window at all. That is a limit of
 * the shape, not a bug, so it surfaces as a coded `UNSUPPORTED_V0` compile error instead of the
 * asm verifier's INTERNAL one.
 */
export function emitWithinStackBudget(
  w: AsmWriter,
  entryHeight: number,
  what: () => string,
  emit: () => void,
): void {
  const cp = w.checkpoint();
  emit();
  const peak = w.peakHeightSince(cp, entryHeight);
  if (peak > MAX_TEMPLATE_DEPTH) {
    throw new EvsCompileError(
      'UNSUPPORTED_V0',
      `${what()} nests structs and arrays too deeply: handling it needs ${peak} operand-stack slots, over the EVM's ${MAX_TEMPLATE_DEPTH}-slot reach — flatten the type (fewer nested struct / array levels)`,
    );
  }
}

/**
 * @internal Shared with `codegen/call/static-call.ts`. The decoders' overflow-free `x ≤ 2^64−1` bound on an
 * offset or length word: `[x] → [x >> 64]`, nonzero exactly when `x > 2^64−1`. Three bytes
 * (`PUSH1 64 SHR`) where `PUSH8 0xff…ff LT` takes ten, for the same gas. The result is not a
 * boolean, so it may only feed a branch: a `JUMPI`, or a try-mode {@link DecodeFail} router's
 * `ISZERO`. That is why this is a helper at the bound sites and not a peephole rule.
 */
export function emitAboveU64(w: AsmWriter): void {
  w.push(64);
  w.op('SHR');
}

/** Human-readable rendering of a value type for error messages / debug notes (tuples → their
 *  JSON descriptor). Shared across the codegen emitters. */
export function fmtType(t: EvsType): string {
  return typeof t === 'string' ? t : JSON.stringify(t);
}

/**
 * @internal Shared with `codegen/call/`. True when a value of layout `l` goes through the
 * RECURSIVE codec: a tuple, or any array other than a dynamic word-element `T[]` (composite
 * elements `tuple[]`/`T[][]`/`string[]`, and every fixed-size `T[N]`). In both directions:
 *
 * - decode: it decodes through the recursive memory decoders (`emitDecodeArrayToMem` and
 *   `emitDecodeTupleToMem` in `decode.ts`), which read their source from a memory snapshot of
 *   the calldata or the returndata, not from calldata / returndata directly;
 * - encode: a call whose args hold one is built by the recursive head/tail encoder, not the
 *   const-folding calldata template.
 *
 * A word, `string` / `bytes` and a dynamic word array keep their direct check-and-alias
 * (decode) and leaf-tail (encode) paths.
 */
export function usesRecursiveCodec(l: TypeLayout): boolean {
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
 * is per array level and static (made at codegen time, see `emitDecodeArrayToMem`); the two
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
 * @internal Shared with `codegen/call/` and `codegen/lower/`. True when `type` is narrower than
 * its 32-byte word, so a word can be out of range for it — false only for the three full-word
 * types. Such a word is refused when it is decoded ({@link emitWordOutOfRange}) and wrapped back
 * into range after a conversion or a wrapping operation ({@link emitNormalizeWord}).
 */
export function wordNeedsNormalize(type: WordType): boolean {
  return type !== 'uint256' && type !== 'int256' && type !== 'bytes32';
}

/**
 * @internal Shared with `codegen/lower/`. Wraps the word on top of the stack into the canonical
 * form of `type`: `uintN`/`address` masked, `intN` sign-extended, `bool` collapsed to 0/1
 * (`ISZERO ISZERO`), `bytesN` masked left-aligned. Net stack 0.
 *
 * For a word the script computed itself (a conversion, a wrapping operation, a shift), whose
 * wrapped value is the defined result. A word the script did not compute (returndata, its own
 * arguments) is never wrapped: it goes through {@link emitWordOutOfRange} and is refused.
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
 * @internal Shared with `codegen/call/`. A decode failure router: stack on entry `[bad, …live]`
 * → on the continue path `[…live]` (`liveDepth` items). Strict/calldata callers jump straight to
 * a checked stub; try-mode callers invert the branch, clean the stack, and jump to the zero block.
 */
export type DecodeFail = (liveDepth: number) => void;

/**
 * @internal Shared with `codegen/call/`. The range check of a decoded word, one the script did
 * not compute (a call's returndata, the script's own arguments): `[word] → [bad, word]`, or
 * `[word] → [bad]` with `keep: false`. `bad` is nonzero exactly when `word` is not the canonical
 * form of `type`, which is when solc's ABI decoder reverts:
 *
 * | type              | `bad`                       | bytes (`keep`) |
 * | ----------------- | --------------------------- | -------------- |
 * | `uintN`, `address`| `word >> N`                 | 4              |
 * | `bool`            | `word >> 1`                 | 4              |
 * | `bytesN`          | `word << 8N` (the low bytes)| 4              |
 * | `intN`            | `signextend(word) ^ word`   | 6              |
 *
 * Each is the shortest test of its family: one shift where a mask-and-compare takes a `PUSH` of
 * the mask (up to 21 bytes for `address`), `EQ` and `ISZERO`. Like {@link emitAboveU64}, `bad` is
 * not a boolean, so it may only feed a branch (a {@link DecodeFail} router) or an `OR` of such
 * words ({@link WordRunChecks}). Only for a type that {@link wordNeedsNormalize}.
 */
export function emitWordOutOfRange(
  w: AsmWriter,
  type: WordType,
  opts: { readonly keep: boolean },
): void {
  if (!wordNeedsNormalize(type)) throw internal(`a ${type} word is never out of range`);
  const note = { note: `${type} out of range?` };
  if (type === 'bool') {
    if (opts.keep) w.op('DUP1');
    w.push(1);
    w.op('SHR', note);
    return;
  }
  const layout = wordLayoutOf(type);
  if (layout.signed) {
    w.op('DUP1');
    w.push(layout.bits / 8 - 1);
    w.op('SIGNEXTEND'); // [signextend(word), word]
    if (opts.keep) w.op('DUP2');
    w.op('XOR', note);
    return;
  }
  if (opts.keep) w.op('DUP1');
  w.push(layout.bits);
  w.op(layout.leftAligned ? 'SHL' : 'SHR', note);
}

function isWord(l: TypeLayout | undefined): l is Extract<TypeLayout, { kind: 'word' }> {
  return l !== undefined && l.kind === 'word';
}

/**
 * @internal Shared with `codegen/call/static-call.ts`. Range-checks the words of a list of
 * top-level values (a call's outputs, the script's arguments) with one failure branch per RUN of
 * consecutive words where it can, instead of one per word.
 *
 * A run with a single narrow word branches on it directly. A run with several keeps the `OR` of
 * their `bad` words ({@link emitWordOutOfRange}) on top of the stack and branches once, after its
 * last word: 2 bytes and 6 gas per word for the `SWAP1` / `OR` against the 4 bytes and 13 gas of
 * a strict branch, or the 11 bytes and more of a try-mode one. Every word of the run is stored
 * before that branch, which is harmless: the failure reverts (strict, arguments) or overwrites
 * every output with its zero value (try).
 *
 * While {@link pending}, the accumulated word sits on top of the caller's `live` items, so a
 * stack-relative read of the caller reaches one item deeper. The decoders of the values between
 * two runs never see it: the run is closed before they are emitted.
 */
export class WordRunChecks {
  private readonly w: AsmWriter;
  private readonly fail: DecodeFail;
  private readonly live: number;
  /** Per value: how many narrow words its run of consecutive words holds (0 for a non-word). */
  private readonly narrowInRun: readonly number[];
  /** Per value: whether the run it belongs to ends with it. */
  private readonly endsRun: readonly boolean[];
  private accumulated = false;

  constructor(w: AsmWriter, layouts: readonly TypeLayout[], fail: DecodeFail, live: number) {
    this.w = w;
    this.fail = fail;
    this.live = live;
    const counts: number[] = layouts.map(() => 0);
    let start = 0;
    layouts.forEach((l, j) => {
      if (!isWord(l)) {
        start = j + 1;
        return;
      }
      if (!wordNeedsNormalize(l.abi)) return;
      for (let k = start; k <= j; k++) counts[k] = (counts[k] ?? 0) + 1;
      for (let k = j + 1; isWord(layouts[k]); k++) counts[k] = (counts[k] ?? 0) + 1;
    });
    this.narrowInRun = counts;
    this.endsRun = layouts.map((l, j) => isWord(l) && !isWord(layouts[j + 1]));
  }

  /** Whether an accumulated word sits on top of the caller's live items. */
  get pending(): boolean {
    return this.accumulated;
  }

  /**
   * `[raw, acc?, …live] → [acc?, …live]`: range-checks `raw` as the word of value `j`, of `type`,
   * and stores it through `store` (`[value, …] → […]`, which must not read the stack below its
   * value). After the last word of a run the accumulated check branches: `[…live]`.
   */
  checkAndStore(j: number, type: WordType, store: () => void): void {
    const { w } = this;
    const narrow = wordNeedsNormalize(type);
    if (narrow && this.narrowInRun[j] === 1) {
      emitWordOutOfRange(w, type, { keep: true }); // [bad, raw, …live]
      this.fail(this.live + 1); // [raw, …live]
      store(); // […live]
      return;
    }
    if (narrow) {
      emitWordOutOfRange(w, type, { keep: true }); // [bad, raw, acc?, …live]
      w.op('SWAP1');
      store(); // [bad, acc?, …live]
      if (this.accumulated) w.op('OR'); // [acc, …live]
      this.accumulated = true;
    } else {
      store(); // [acc?, …live]
    }
    if (this.accumulated && this.endsRun[j] === true) {
      this.fail(this.live); // […live]
      this.accumulated = false;
    }
  }
}

/**
 * @internal The range-check loop over the elements of a word-array memref payload (the script's
 * word-array arguments, already copied out of the calldata): every element must be canonical for
 * `elem`, or `fail` is taken.
 *
 * Stack contract: entry `[cur, end, …depthBelow items]` → exit `[cur, end, …]` with
 * `cur == end`; the loop labels are checked at absolute height `depthBelow + 2`, so the
 * caller must pass the exact number of live items beneath `[cur, end]`.
 */
export function emitCheckElemsLoop(
  w: AsmWriter,
  elem: WordType,
  depthBelow: number,
  fail: DecodeFail,
): void {
  const height = depthBelow + 2;
  const head = w.newLabel(`elemcheck_${elem}`);
  const done = w.newLabel(`elemcheck_${elem}_done`);
  w.label(head, height);
  w.op('DUP2'); // [end, cur, end, …]
  w.op('DUP2'); // [cur, end, cur, end, …]
  w.op('LT'); // [cur < end, cur, end, …]
  w.op('ISZERO');
  w.pushLabel(done);
  w.op('JUMPI'); // [cur, end, …]
  w.op('DUP1');
  w.op('MLOAD'); // [word, cur, end, …]
  emitWordOutOfRange(w, elem, { keep: false }); // [bad, cur, end, …]
  fail(height); // [cur, end, …]
  w.push(32);
  w.op('ADD'); // [cur+32, end, …]
  w.pushLabel(head);
  w.op('JUMP');
  w.label(done, height);
}

/**
 * @internal Shared with `codegen/call/static-call.ts`. Copies a (bounds-checked) word-array memref `[len][e…]`
 * of narrow elements into a freshly-allocated block, range-checking every element on the way
 * (`fail` on one out of range): `[src, …] → [dst, …]`.
 *
 * Unlike a full-word `T[]`, which the decoders alias straight into the source snapshot, a
 * narrow-element array is materialized: each element is read once, checked, and written to a
 * block of its own (the block `arrayDecodeCharge` charges where overlapping offsets can decode
 * the same source bytes again).
 *
 * One fused loop ({@link emitCopyWordsLoop}; no `emitMemCopy`, so it is fork-independent and
 * works at any stack depth). Loop labels are checked at absolute height `depthBelow + 3`.
 */
export function emitCopyCheckedWordArray(
  w: AsmWriter,
  elem: WordType,
  depthBelow: number,
  fail: DecodeFail,
): void {
  w.push(FREE_PTR);
  w.op('MLOAD'); // [dst, src, …]
  w.op('DUP2');
  w.op('MLOAD'); // [len, dst, src, …]
  w.op('DUP1');
  w.op('DUP3');
  w.op('MSTORE'); // [len, dst, src, …]   dst[0] := len
  w.push(5);
  w.op('SHL'); // [k = 32·len, dst, src, …]
  w.op('DUP1');
  w.op('DUP3');
  w.op('ADD');
  w.push(32);
  w.op('ADD'); // [dst+32+32·len, k, dst, src, …]
  w.push(FREE_PTR);
  w.op('MSTORE'); // [k, dst, src, …]   freePtr bumped
  emitCopyWordsLoop(w, elem, depthBelow, fail); // [dst, …]
}

/**
 * The word-copy loop of {@link emitCopyCheckedWordArray}, shared with the fixed-size word-array
 * decode: `[k, dst, src, …] → [dst, …]`. `k` walks the byte offset `k … 32` down to 0 and copies
 * `src[k]` to `dst[k]` (so `src` / `dst` point one word before the first element, at the
 * length word of a `[len][e…]` block), taking `fail` on a word out of range for a narrow `elem`.
 * Loop labels are checked at absolute height `depthBelow + 3` (`[k, dst, src]` above
 * `depthBelow`).
 */
export function emitCopyWordsLoop(
  w: AsmWriter,
  elem: WordType,
  depthBelow: number,
  fail: DecodeFail,
): void {
  const height = depthBelow + 3;
  const head = w.newLabel(`elemcopy_${elem}`);
  const done = w.newLabel(`elemcopy_${elem}_done`);
  w.label(head, height);
  w.op('DUP1');
  w.op('ISZERO');
  w.pushLabel(done);
  w.op('JUMPI'); // [k, dst, src, …]
  w.op('DUP3');
  w.op('DUP2');
  w.op('ADD');
  w.op('MLOAD'); // [src[k], k, dst, src, …]
  if (wordNeedsNormalize(elem)) {
    emitWordOutOfRange(w, elem, { keep: true }); // [bad, word, k, dst, src, …]
    fail(height + 1); // [word, k, dst, src, …]
  }
  w.op('DUP3');
  w.op('DUP3');
  w.op('ADD'); // [dst+k, word, k, dst, src, …]
  w.op('MSTORE'); // [k, dst, src, …]
  w.push(32);
  w.op('SWAP1');
  w.op('SUB'); // [k−32, dst, src, …]
  w.pushLabel(head);
  w.op('JUMP');
  w.label(done, height); // [0, dst, src, …]
  w.op('POP');
  w.op('SWAP1');
  w.op('POP'); // [dst, …]
}

/** A tuple layout's components as `NamedType[]` (reconstructed for the recursive decoders). */
export function tupleComponents(l: Extract<TypeLayout, { kind: 'tuple' }>): readonly NamedType[] {
  return l.components.map((c) => layoutToNamed(c));
}

/** @internal A nameless `NamedType` of the layout `l` (the inverse of `layoutOfType`; shared
 *  with `codegen/codecs.ts`, whose bodies are built from layouts alone). */
export function layoutToNamed(l: TypeLayout): NamedType {
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

/** @internal Shared with `codegen/call/` and `codegen/lower/`. Rounds the top of the stack up to a whole word:
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
  if (forkAtLeast(opts.evmVersion, OPS.MCOPY.since)) {
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
