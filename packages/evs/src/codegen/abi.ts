/**
 * `codegen/abi.ts` — the ABI emitters: dispatch-time calldata decode, return-tuple encode,
 * and the fork-portable memory-copy primitive.
 *
 * Every emitted sequence is net-zero on the operand stack (the statement-boundary invariant)
 * and stays within the 16-item template budget — `asm/verify.ts` machine-checks both on every
 * `assemble`.
 *
 * Memory-model conventions used throughout:
 * - scratch `0x00` holds the running tail cursor of the return encoder / calldata templates
 *   (intra-template temporary only — dead once the template ends);
 * - `0x40` is the free-memory pointer; `0x60` is the never-written zero slot;
 * - dynamic values are memrefs: a frame slot holds a pointer to `[len:32][payload…]`.
 *
 * Pre-cancun `emitMemCopy` lowers to a call into the shared `@memcpy` subroutine
 * (`codegen/tails.ts`). The subroutine entry is a *checked* label, so its calling convention
 * pins the absolute stack height: callers must invoke `emitMemCopy` with the operand stack
 * being EXACTLY `[dst, src, len]` (height 3, nothing beneath). Both emitters in this module
 * honor that by keeping their loop state in scratch memory instead of deep on the stack.
 */

import {
  headBytes,
  isDynamic,
  layoutOf,
  layoutOfType,
  staticSize,
  type TypeLayout,
} from '../abi/layout.js';
import type { AsmWriter, LabelId } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import { EvsInternalError, type SourceLoc } from '../core/errors.js';
import {
  abiParamToType,
  elemTypeOf,
  isArrayValueType,
  isDynamicType,
  isTupleType,
  typeToAbiParam,
  type EvsType,
  type NamedType,
  type WordType,
} from '../core/types.js';

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

/** 2^64 − 1 — the overflow-free bound for every decoded offset/length. */
const MAX_U64 = 0xffffffffffffffffn;

/** Free-memory-pointer slot. */
const FREE_PTR = 0x40;

/** Scratch slot for running tail cursors (intra-template temporary). */
const TAIL_CURSOR = 0x00;

/** Words per reserved encode loop frame: `{arrPtr, D, len, i}`. */
const FRAME_SLOTS = 4;
const FRAME_ARRPTR = 0;
const FRAME_D = 1;
const FRAME_LEN = 2;
const FRAME_I = 3;

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
 * Scratch slot holding the CURRENT array-decode frame pointer during {@link emitDecodeArrayToMem}.
 * An array decode keeps its whole loop state (`elemBase, i, D, arr, len, parent`) in a
 * heap-allocated frame instead of on the stack, so the operand stack stays flat however deep
 * arrays nest (`uint256[][][]`, `tuple[][]`, `string[2][][]`, …) — the template budget (16
 * DUP/SWAP reach) is never a function of the nesting depth. Frames chain through the `parent`
 * word: entering a nested array decode links a fresh frame and installs it here; leaving restores
 * the parent. The recursive element decoders re-derive their base from `MLOAD(MLOAD(DECODE_FRAME))`
 * (the frame's `elemBase` word), which is stack-depth-independent across their internal churn.
 * It is `0x20` — free during *decode* (the snapshot/calldata base lives in `0x00`; `STAGING_SLOT
 * 0x20` is only live during tuple-arg *encode*, which never overlaps a decode).
 */
const DECODE_FRAME = 0x20;
/** Words per array-decode frame: `{elemBase, i, D, arr, len, parent}`. */
const DFRAME_SLOTS = 6;
const DFRAME_ELEM_BASE = 0;
const DFRAME_I = 1;
const DFRAME_D = 2;
const DFRAME_ARR = 3;
const DFRAME_LEN = 4;
const DFRAME_PARENT = 5;

function internal(message: string): EvsInternalError {
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

/** An array layout the RECURSIVE array codec owns (as opposed to the flat word-array leaf
 *  path): any array whose element is not a word, or any fixed-size array. */
export function isRecursiveArray(l: TypeLayout): boolean {
  return l.kind === 'array' && (l.elem.kind !== 'word' || l.length !== null);
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
function wordElemAbi(layout: Extract<TypeLayout, { kind: 'array' }>): WordType {
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

// ---------------------------------------------------------------------------
// recursive ABI encoder (head/tail over a flat-pointer SRC tree)
// ---------------------------------------------------------------------------

/**
 * A "word source" thunk: emits code that pushes member `i`'s SRC word onto the stack — a
 * canonical word for a static member, or a memref pointer for a dynamic/composite member. For
 * the top-level return record each member is a frame slot; inside a (flat-pointer) tuple it is
 * `MLOAD(tuplePtr + 32·i)`.
 */
export type PushWord = (i: number) => void;

/**
 * A "destination base" thunk: emits code that pushes this ABI block's base pointer (where its
 * heads start). Re-derivable from the already-written output so nothing has to stay live across
 * an `emitMemCopy` (whose `[dst, src, len]` height contract forbids spectators on the stack):
 * the top level reads `MLOAD(0x40) (+dynOff)`; a nested dynamic tuple reads its parent's base
 * plus the offset its parent head already stored (`subBase = parentBase + MLOAD(parentBase+ho)`).
 */
export type PushBase = () => void;

/** @internal Shared by `codegen/call.ts`. Cumulative ABI head offset (bytes) of component `i`
 *  within `components` (static members — inner tuples, fixed-size arrays — inline their whole
 *  static size; every dynamic member is one offset word). */
export function headOffsetsOf(components: readonly NamedType[]): number[] {
  return headOffsets(components);
}

/** Cumulative ABI head offset (bytes) of component `i` within `components` (static members inline
 *  their whole static size; every dynamic member is one offset word). */
function headOffsets(components: readonly NamedType[]): number[] {
  const offs: number[] = [];
  let cursor = 0;
  for (const c of components) {
    offs.push(cursor);
    const layout = layoutOfType(abiParamToType(c));
    cursor += isDynamic(layout) ? 32 : staticSize(layout);
  }
  return offs;
}

/**
 * Encodes one ABI tuple block (head/tail) from a flat-pointer SRC tree into the DST buffer.
 * Heads land at `pushBase() + headOffsets(components)[i]`; the running tail high-water mark
 * lives in scratch `TAIL_CURSOR` and is shared across the whole encode (the output is laid out
 * front-to-back, so a single monotone cursor suffices for arbitrary nesting — a dynamic member's
 * head offset is `cursor − base` at the moment it is reached, then the member's tail is appended
 * and the cursor advanced). Net stack 0; every `emitMemCopy` runs at exactly `[dst, src, len]`.
 */
export function emitEncodeBlock(
  w: AsmWriter,
  components: readonly NamedType[],
  pushSrc: PushWord,
  pushBase: PushBase,
  tails: SharedTails,
  opts: EncodeOpts,
): void {
  const offs = headOffsets(components);
  components.forEach((comp, i) => {
    const ho = offs[i] ?? 0;
    const layout = layoutOfType(abiParamToType(comp));

    if (layout.kind === 'word') {
      pushSrc(i); // [word]
      pushBase();
      if (ho !== 0) {
        w.push(ho);
        w.op('ADD');
      } // [head, word]
      w.op('MSTORE', { note: `head ${comp.name || `#${i}`}` });
      return;
    }

    if (layout.kind === 'tuple' && !layout.dynamic) {
      // static inner tuple — inline its head into the parent head at base+ho (no offset word)
      emitEncodeBlock(
        w,
        comp.components ?? [],
        (j) => emitTupleMemberWord(w, pushSrc, i, j),
        () => emitOffsetBase(w, pushBase, ho),
        tails,
        opts,
      );
      return;
    }

    if (layout.kind === 'array' && !isDynamic(layout)) {
      // static fixed-size array `T[N]` — its N elements inline into the parent head at base+ho
      // (no offset word, no length word), exactly like a static tuple's members.
      emitEncodeArrayInline(
        w,
        layout,
        () => pushSrc(i),
        () => emitOffsetBase(w, pushBase, ho),
        tails,
        opts,
      );
      return;
    }

    // dynamic member (string / bytes / T[] / dynamic tuple): head offset + appended tail
    // head: MSTORE(base + ho, cursor − base)
    w.push(TAIL_CURSOR);
    w.op('MLOAD'); // [cursor]
    pushBase(); // [base, cursor]
    w.op('DUP1'); // [base, base, cursor]
    w.op('SWAP2'); // [cursor, base, base]
    w.op('SUB'); // [rel, base]
    w.op('SWAP1'); // [base, rel]
    if (ho !== 0) {
      w.push(ho);
      w.op('ADD');
    } // [head, rel]
    w.op('MSTORE', { note: `head ${comp.name || `#${i}`}` }); // []

    if (layout.kind === 'tuple') {
      // dynamic inner tuple: reserve its head region, then recurse (its own tails extend the
      // same cursor). subBase = the cursor value here; re-derivable as parentBase + (offset we
      // just stored at parentBase+ho).
      w.push(TAIL_CURSOR);
      w.op('MLOAD'); // [subBase]
      w.push(headBytes(comp.components ?? []));
      w.op('ADD'); // [subTail0]
      w.push(TAIL_CURSOR);
      w.op('MSTORE'); // []   cursor advanced past the sub-head
      emitEncodeBlock(
        w,
        comp.components ?? [],
        (j) => emitTupleMemberWord(w, pushSrc, i, j),
        () => emitSubTupleBase(w, pushBase, ho),
        tails,
        opts,
      );
      return;
    }

    // composite-element array member (`tuple[]`/`T[][]`/`string[]`) or a dynamic fixed-size
    // array (`string[2]`, `uint256[][3]`): the scratch-frame element loop. The member head
    // already stored its offset (cursor − base) above; the array's own block is appended at the
    // cursor by `emitEncodeArrayTail`, which keeps all of its loop state in a reserved memory
    // frame so the stack stays at the template baseline (no spectators across the per-element
    // `emitMemCopy`). The member memref pointer is `pushSrc(i)`.
    if (layout.kind === 'array' && isRecursiveArray(layout)) {
      emitEncodeArrayTail(w, layout, () => pushSrc(i), tails, opts);
      return;
    }

    // leaf dynamic (string / bytes / word-array): copy [len][payload] to the cursor, advance
    emitLeafDynTail(w, () => pushSrc(i), layout.kind === 'array', tails, opts);
  });
}

/** SRC word of member `j` of the (flat-pointer) tuple that is member `i` of the current SRC. */
function emitTupleMemberWord(w: AsmWriter, pushSrc: PushWord, i: number, j: number): void {
  pushSrc(i); // [tuplePtr]
  if (j !== 0) {
    w.push(32 * j);
    w.op('ADD');
  }
  w.op('MLOAD'); // [member word / pointer]
}

/** DST base of a static inner tuple: `parentBase + ho` (it inlines into the parent head). */
function emitOffsetBase(w: AsmWriter, pushBase: PushBase, ho: number): void {
  pushBase();
  if (ho !== 0) {
    w.push(ho);
    w.op('ADD');
  }
}

/** Base of a dynamic inner tuple: `parentBase + MLOAD(parentBase + ho)` (the offset word in the
 *  parent head points at the sub-block) — the DST base on the encode path, and a {@link PushBase}
 *  thunk for nested decodes. */
function emitSubTupleBase(w: AsmWriter, pushBase: PushBase, ho: number): void {
  pushBase(); // [base]
  w.op('DUP1'); // [base, base]
  if (ho !== 0) {
    w.push(ho);
    w.op('ADD');
  } // [base+ho, base]
  w.op('MLOAD'); // [off, base]
  w.op('ADD'); // [subBase]
}

/**
 * Appends a leaf dynamic member's tail (`[len][payload]`) at the scratch cursor and advances it.
 * `pushPtr` pushes the member's memref pointer (`[len][payload…]`). `isArray` distinguishes
 * `32·len` (word-array) from `len` (bytes/string, zero-padded). The cursor stays in scratch so
 * `emitMemCopy` runs at exactly `[dst, src, len]`.
 */
function emitLeafDynTail(
  w: AsmWriter,
  pushPtr: () => void,
  isArray: boolean,
  tails: SharedTails,
  opts: { evmVersion: EvmVersion },
): void {
  const pushNBytes = (): void => {
    pushPtr();
    w.op('MLOAD'); // [len]
    if (isArray) {
      w.push(5);
      w.op('SHL'); // [32·len]
    }
  };

  // length word: MSTORE(cursor, len)
  pushPtr();
  w.op('MLOAD'); // [len]
  w.push(TAIL_CURSOR);
  w.op('MLOAD'); // [cursor, len]
  w.op('MSTORE'); // []

  // payload copy: [dst = cursor+32, src = ptr+32, nbytes] — exactly height 3 (memcpy convention)
  pushNBytes(); // [n]
  pushPtr();
  w.push(32);
  w.op('ADD'); // [src, n]
  w.push(TAIL_CURSOR);
  w.op('MLOAD');
  w.push(32);
  w.op('ADD'); // [dst, src, n]
  emitMemCopy(w, tails, opts); // []

  if (!isArray) {
    // explicit zero-pad of the trailing partial word (pre-cancun memcpy over-copies whole words)
    w.push(0); // [0]
    pushNBytes(); // [n, 0]
    w.push(TAIL_CURSOR);
    w.op('MLOAD');
    w.op('ADD'); // [cursor+n, 0]
    w.push(32);
    w.op('ADD'); // [cursor+32+n, 0]
    w.op('MSTORE'); // []
  }

  // cursor += 32 + ceil32(nbytes) (arrays are word-exact already)
  pushNBytes(); // [n]
  if (!isArray) {
    w.push(31);
    w.op('ADD');
    w.push(31);
    w.op('NOT');
    w.op('AND'); // [ceil32(n)]
  }
  w.push(32);
  w.op('ADD'); // [inc]
  w.push(TAIL_CURSOR);
  w.op('MLOAD');
  w.op('ADD'); // [cursor']
  w.push(TAIL_CURSOR);
  w.op('MSTORE'); // []
}

// ---------------------------------------------------------------------------
// composite-element array encode (the scratch-frame element loop)
// ---------------------------------------------------------------------------

/**
 * @internal The number of array loop frames concurrently live while ENCODING a value of `l`. A
 * leaf (`word`/`bytes`/`string`/a dynamic word-element array — all emitted via the inline head
 * write or {@link emitLeafDynTail}) needs none; a tuple needs the max its members need; a
 * recursive-codec array ({@link emitEncodeArrayTail} / {@link emitEncodeArrayInline} — composite
 * element or fixed-size) needs one frame for its own loop plus whatever encoding ONE element
 * concurrently needs. The return encoder reserves `max` over the return record (its components
 * encode sequentially into the same frame region). Mirrors the dispatch in
 * {@link emitEncodeBlock}/{@link emitEncodeArrayTail} branch-for-branch so the reserved region is
 * always large enough and never overlaps the output buffer.
 */
export function encodeFramesOf(l: TypeLayout): number {
  if (l.kind === 'word' || l.kind === 'bytes') return 0;
  if (l.kind === 'array') {
    // a dynamic word-element array is a leaf (emitLeafDynTail), never an array loop.
    if (!isRecursiveArray(l)) return 0;
    // one own frame + the frames its element encode concurrently needs.
    return 1 + encodeFramesOf(l.elem);
  }
  // tuple: members encode into the parent's space; the deepest member governs.
  return l.components.reduce((n, c) => Math.max(n, encodeFramesOf(c)), 0);
}

/**
 * Reserves `frames` composite-array encode loop frames immediately BELOW the upcoming output/calldata
 * buffer by bumping the free pointer by `32·FRAME_SLOTS·frames`. The CALLER must read the
 * buffer base as `MLOAD(0x40)` AFTER this so the buffer sits just above frame 0 and {@link pushFrameSlot}
 * (which addresses each frame relative to `MLOAD(0x40)`) resolves correctly. The free pointer must not
 * be bumped again between this reservation and the encode (tails are written at the cursor, never via
 * the free pointer). No-op when `frames === 0`. Net stack 0.
 */
export function reserveEncodeFrames(w: AsmWriter, frames: number, note?: string): void {
  if (frames <= 0) return;
  w.push(FREE_PTR);
  w.op('MLOAD'); // [old]
  w.push(32 * FRAME_SLOTS * frames);
  w.op('ADD'); // [old + framesBytes]
  w.push(FREE_PTR);
  w.op('MSTORE', { note: note ?? `reserve ${frames} array-encode frame(s)` }); // []
}

/**
 * Pushes the absolute memory address of word `k` of composite-array loop frame `frameDepth`. The
 * frames live in a region reserved BELOW the output buffer at encode entry (the free pointer is
 * bumped by `32·FRAME_SLOTS·FRAMES` before `out = MLOAD(0x40)` is read, so `out` — which never
 * moves during the in-place encode — sits just above frame 0). Frame `f` occupies
 * `[out − 32·FRAME_SLOTS·(f+1), out − 32·FRAME_SLOTS·f)`; word `k` is `frameBase + 32·k`. Reading
 * the address off `MLOAD(0x40)` makes every frame access stack-depth-independent (the decode
 * `DECODE_FRAME` lesson), so loop state never has to ride the stack across an `emitMemCopy`.
 */
function pushFrameSlot(w: AsmWriter, frameDepth: number, k: number): void {
  const off = 32 * FRAME_SLOTS * (frameDepth + 1) - 32 * k;
  w.push(FREE_PTR);
  w.op('MLOAD'); // [out]
  w.push(off); // [off, out]
  w.op('SWAP1');
  w.op('SUB'); // [out − off = frameBase + 32·k]
}

/** Loads word `k` of frame `frameDepth` onto the stack. */
function pushFrameLoad(w: AsmWriter, frameDepth: number, k: number): void {
  pushFrameSlot(w, frameDepth, k);
  w.op('MLOAD');
}

/** Stores the top-of-stack value into word `k` of frame `frameDepth` (consumes the value). */
function emitFrameStore(w: AsmWriter, frameDepth: number, k: number): void {
  pushFrameSlot(w, frameDepth, k); // [addr, v]
  w.op('MSTORE'); // []
}

/**
 * Encodes a recursive-codec array — a composite-element `E[]` (`tuple[]` / `T[][]` /
 * `string[]`/`bytes[]`) or a dynamic fixed-size `E[N]` (`string[2]`, `uint256[][3]`) — as an
 * ABI array tail written at the shared tail cursor (`TAIL_CURSOR`), exactly mirroring the
 * interpreter's `encodeArrayTail`. `pushArrPtr` pushes the source array memref pointer
 * (`[len:32][p0:32]…[p_{len-1}:32]`; `len === N` for a fixed-size array). On entry the cursor
 * already points at this array's block start; on exit it has advanced past the whole tail. Net
 * stack 0.
 *
 *  1. Dynamic `E[]`: `MSTORE(cursor, len)` (`len = MLOAD(arrPtr)`); `D = cursor + 32`.
 *     Fixed `E[N]`: NO length word on the wire — `len = N`, `D = cursor`.
 *  2. STATIC element (a static tuple, a static fixed array, or a word — no per-element tail, no
 *     memcpy): advance the cursor to `D + len·staticSize`, then loop `i`: encode element `i` inline
 *     at `base = D + i·staticSize` (a word → `MSTORE`; a static tuple → `emitEncodeBlock` over its
 *     all-word head; a static fixed array → `emitEncodeArrayInline`). NO offset words.
 *  3. DYNAMIC element (dynamic tuple / inner array / `string`/`bytes`): advance the cursor to
 *     `D + 32·len` (reserve the offset words), then loop `i`: `MSTORE(D + 32·i, cursor − D)` (offset
 *     relative to `D`), then append element `i`'s tail at the cursor — a dynamic tuple reserves
 *     `headBytes` then `emitEncodeBlock`; a dynamic word-element inner array / `string`/`bytes` →
 *     `emitLeafDynTail`; any other inner array → recurse `emitEncodeArrayTail`. Each element
 *     extends the same monotone cursor.
 *
 * All loop state (`arrPtr, D, len, i`) lives in a reserved memory frame (`opts.frameDepth`), so the
 * operand stack stays at the template baseline throughout — every `emitMemCopy` runs at exactly
 * `[dst, src, len]` (the pre-cancun `@memcpy` height contract), even when this array nests inside a
 * tuple member at arbitrary tuple-encode depth, and however deep arrays nest in each other.
 */
export function emitEncodeArrayTail(
  w: AsmWriter,
  layout: Extract<TypeLayout, { kind: 'array' }>,
  pushArrPtr: PushBase,
  tails: SharedTails,
  opts: EncodeOpts,
): void {
  const f = opts.frameDepth ?? 0;
  const elemLayout = layout.elem;
  const elemDynamic = isDynamic(elemLayout);

  // -- frame.arrPtr := arrPtr ----------------------------------------------------------------
  pushArrPtr(); // [arrPtr]
  emitFrameStore(w, f, FRAME_ARRPTR); // []

  // -- frame.len := len; dynamic: MSTORE(cursor, len), D = cursor + 32; fixed: D = cursor ------
  if (layout.length === null) {
    pushFrameLoad(w, f, FRAME_ARRPTR);
    w.op('MLOAD'); // [len]
    w.op('DUP1'); // [len, len]
    emitFrameStore(w, f, FRAME_LEN); // [len]
    w.op('DUP1'); // [len, len]
    w.push(TAIL_CURSOR);
    w.op('MLOAD'); // [cursor, len, len]
    w.op('MSTORE'); // [len]            mem[cursor] = len
    // D = cursor + 32
    w.push(TAIL_CURSOR);
    w.op('MLOAD');
    w.push(32);
    w.op('ADD'); // [D, len]
  } else {
    w.push(layout.length, { note: `fixed len ${layout.length}` }); // [len]
    w.op('DUP1'); // [len, len]
    emitFrameStore(w, f, FRAME_LEN); // [len]
    // D = cursor (no length word on the wire)
    w.push(TAIL_CURSOR);
    w.op('MLOAD'); // [D, len]
  }
  w.op('DUP1'); // [D, D, len]
  emitFrameStore(w, f, FRAME_D); // [D, len]
  // advance cursor to D + (dynamic ? 32·len : len·staticSize)  (reserve offset words / static body)
  w.op('SWAP1'); // [len, D]
  if (elemDynamic) {
    w.push(5);
    w.op('SHL'); // [32·len, D]
  } else {
    const ss = staticSize(elemLayout);
    if (ss !== 1) {
      w.push(ss);
      w.op('MUL'); // [len·ss, D]
    }
  }
  w.op('ADD'); // [cursor' = D + body]
  w.push(TAIL_CURSOR);
  w.op('MSTORE'); // []

  emitEncodeArrayLoop(w, layout, f, tails, opts);
}

/**
 * Encodes a STATIC fixed-size array `E[N]` (static element) INLINE at `pushBase()` — no length
 * word, no offset words, no cursor movement: element `i` lands at `base + i·staticSize(E)`. Used
 * wherever a static member inlines into its parent's head (a tuple member, a script/call arg, a
 * static array element of an outer array). Same frame discipline as {@link emitEncodeArrayTail}.
 * Net stack 0.
 */
export function emitEncodeArrayInline(
  w: AsmWriter,
  layout: Extract<TypeLayout, { kind: 'array' }>,
  pushArrPtr: PushBase,
  pushBase: PushBase,
  tails: SharedTails,
  opts: EncodeOpts,
): void {
  if (layout.length === null || isDynamic(layout)) {
    throw internal(`emitEncodeArrayInline: ${layout.abi} is not a static fixed-size array`);
  }
  const f = opts.frameDepth ?? 0;
  pushArrPtr(); // [arrPtr]
  emitFrameStore(w, f, FRAME_ARRPTR); // []
  w.push(layout.length, { note: `fixed len ${layout.length}` }); // [N]
  emitFrameStore(w, f, FRAME_LEN); // []
  pushBase(); // [base]
  emitFrameStore(w, f, FRAME_D); // []   D = base (elements inline from here)
  emitEncodeArrayLoop(w, layout, f, tails, opts);
}

/** The shared element loop of {@link emitEncodeArrayTail} / {@link emitEncodeArrayInline}: frame
 *  `arrPtr`/`D`/`len` are set; iterates `i` over the frame, encoding each element (dynamic →
 *  offset word + tail at the cursor; static → inline at `D + i·staticSize`). Net stack 0. */
function emitEncodeArrayLoop(
  w: AsmWriter,
  layout: Extract<TypeLayout, { kind: 'array' }>,
  f: number,
  tails: SharedTails,
  opts: EncodeOpts,
): void {
  const elemLayout = layout.elem;
  const elemDynamic = isDynamic(elemLayout);

  // -- element loop: all state in the frame; stack stays at the template baseline ------------
  w.push(0);
  emitFrameStore(w, f, FRAME_I); // frame.i := 0

  const head = w.newLabel('arrenc');
  const done = w.newLabel('arrenc_done');
  w.label(head, 0);
  // continue while i < len
  pushFrameLoad(w, f, FRAME_I); // [i]
  pushFrameLoad(w, f, FRAME_LEN); // [len, i]
  w.op('GT'); // [len > i, ...]  i.e. i < len  → but GT is len>i which is i<len
  w.op('ISZERO'); // [¬(i < len)]
  w.pushLabel(done);
  w.op('JUMPI'); // []

  if (elemDynamic) {
    // MSTORE(D + 32·i, cursor − D)  (offset relative to D)
    pushFrameLoad(w, f, FRAME_I);
    w.push(5);
    w.op('SHL'); // [32·i]
    pushFrameLoad(w, f, FRAME_D); // [D, 32·i]
    w.op('ADD'); // [D+32·i]
    w.push(TAIL_CURSOR);
    w.op('MLOAD'); // [cursor, D+32·i]
    pushFrameLoad(w, f, FRAME_D); // [D, cursor, D+32·i]
    w.op('SWAP1'); // [cursor, D, D+32·i]
    w.op('SUB'); // [cursor−D, D+32·i]
    w.op('SWAP1'); // [D+32·i, rel]
    w.op('MSTORE'); // []

    // append element i's tail at the cursor
    emitEncodeArrayElementTail(w, elemLayout, f, tails, opts);
  } else {
    // static element: write inline at base = D + i·staticSize
    emitEncodeArrayElementStatic(w, elemLayout, f, tails, opts);
  }

  // i += 1
  pushFrameLoad(w, f, FRAME_I);
  w.push(1);
  w.op('ADD'); // [i+1]
  emitFrameStore(w, f, FRAME_I); // []
  w.pushLabel(head);
  w.op('JUMP');
  w.label(done, 0); // []
}

/** Pushes element `i`'s source memref pointer / inline word: `MLOAD(arrPtr + 32 + 32·i)`. Reads
 *  `arrPtr` and `i` from the loop frame, so it is stack-depth-independent. */
function pushElemSlot(w: AsmWriter, frameDepth: number): void {
  pushFrameLoad(w, frameDepth, FRAME_I);
  w.push(5);
  w.op('SHL'); // [32·i]
  pushFrameLoad(w, frameDepth, FRAME_ARRPTR);
  w.push(32);
  w.op('ADD'); // [arrPtr+32, 32·i]
  w.op('ADD'); // [arrPtr+32+32·i]   (address of slot pᵢ)
}

/** Encodes one STATIC element `i` inline at `base = D + i·staticSize` (no tail, no memcpy). A word
 *  element is `MSTORE`d directly; a static tuple element inlines its all-word head via
 *  {@link emitEncodeBlock}. All bases/sources are read from the frame (stack-depth-independent). */
function emitEncodeArrayElementStatic(
  w: AsmWriter,
  elemLayout: TypeLayout,
  frameDepth: number,
  tails: SharedTails,
  opts: EncodeOpts,
): void {
  // base = D + i·staticSize
  const pushBase: PushBase = () => {
    pushFrameLoad(w, frameDepth, FRAME_I);
    const ss = staticSize(elemLayout);
    if (ss !== 1) {
      w.push(ss);
      w.op('MUL'); // [i·ss]
    }
    pushFrameLoad(w, frameDepth, FRAME_D);
    w.op('ADD'); // [D + i·ss = base]
  };

  if (elemLayout.kind === 'word') {
    // MSTORE(base, elemᵢ) where elemᵢ = MLOAD(arrPtr+32+32·i) (the inline word slot)
    pushElemSlot(w, frameDepth);
    w.op('MLOAD'); // [elemᵢ]
    pushBase(); // [base, elemᵢ]
    w.op('MSTORE'); // []
    return;
  }
  if (elemLayout.kind === 'array') {
    // static fixed-size array element (`uint256[2]` inside `uint256[2][]`): inline its N elements
    // at base, reading the element's own block through the pointer in slot pᵢ (next frame).
    emitEncodeArrayInline(
      w,
      elemLayout,
      () => {
        pushElemSlot(w, frameDepth);
        w.op('MLOAD'); // [elemPtrᵢ]
      },
      pushBase,
      tails,
      { ...opts, frameDepth: frameDepth + 1 },
    );
    return;
  }
  if (elemLayout.kind !== 'tuple') {
    throw internal(`static array element of unexpected kind '${elemLayout.kind}'`);
  }
  // static tuple element: member words come from MLOAD(elemPtrᵢ + 32·j) where elemPtrᵢ is the
  // pointer stored in slot pᵢ. emitEncodeBlock writes the inline head at base (no tail since the
  // tuple is static), at frameDepth + 1 (an inner static fixed-array member takes the next frame).
  const components = tupleComponents(elemLayout);
  const pushSrc: PushWord = (j) => {
    pushElemSlot(w, frameDepth);
    w.op('MLOAD'); // [elemPtrᵢ]
    if (j !== 0) {
      w.push(32 * j);
      w.op('ADD');
    }
    w.op('MLOAD'); // [member word]
  };
  emitEncodeBlock(w, components, pushSrc, pushBase, tails, {
    ...opts,
    frameDepth: frameDepth + 1,
  });
}

/** Appends one DYNAMIC element `i`'s tail at the cursor: a dynamic tuple → reserve `headBytes` then
 *  `emitEncodeBlock`; a `string`/`bytes` or word-element inner array → `emitLeafDynTail`; a
 *  composite inner array → recurse `emitEncodeArrayTail` (next frame). */
function emitEncodeArrayElementTail(
  w: AsmWriter,
  elemLayout: TypeLayout,
  frameDepth: number,
  tails: SharedTails,
  opts: EncodeOpts,
): void {
  // bytes/string element: leaf dynamic tail at the cursor.
  if (elemLayout.kind === 'bytes') {
    emitLeafDynTail(
      w,
      () => {
        pushElemSlot(w, frameDepth);
        w.op('MLOAD');
      },
      false,
      tails,
      opts,
    );
    return;
  }

  if (elemLayout.kind === 'array') {
    // dynamic word-element inner array (`uint256[]` inside `uint256[][]`) → leaf word-array tail.
    if (!isRecursiveArray(elemLayout)) {
      emitLeafDynTail(
        w,
        () => {
          pushElemSlot(w, frameDepth);
          w.op('MLOAD');
        },
        true,
        tails,
        opts,
      );
      return;
    }
    // any other inner array (composite element, or a dynamic fixed-size array) → recurse with the
    // NEXT frame (concurrent with this loop's frame).
    emitEncodeArrayTail(
      w,
      elemLayout,
      () => {
        pushElemSlot(w, frameDepth);
        w.op('MLOAD');
      },
      tails,
      { ...opts, frameDepth: frameDepth + 1 },
    );
    return;
  }

  if (elemLayout.kind !== 'tuple') {
    throw internal(`dynamic array element of unexpected kind '${elemLayout.kind}'`);
  }
  // dynamic tuple element: reserve its head region at the cursor, then encode its head/tail. Its
  // base IS the cursor value here; re-derivable as parentBase + (the offset we just stored) — but
  // simpler and stack-depth-independent: read it back from where we leave it. We capture the
  // sub-block base = current cursor, advance the cursor past the sub-head, then emitEncodeBlock with
  // base = that captured value re-read from the frame's spare? No spare slot — instead recompute the
  // base from D + the offset we stored: base = D + MLOAD(D + 32·i).
  const components = tupleComponents(elemLayout);
  const headSize = headBytes(components);
  // advance cursor past the sub-head (reserve headBytes): cursor += headSize
  w.push(TAIL_CURSOR);
  w.op('MLOAD');
  w.push(headSize);
  w.op('ADD'); // [cursor + headSize]
  w.push(TAIL_CURSOR);
  w.op('MSTORE'); // []   cursor advanced past the sub-head
  // base of this element = D + offset(i) = D + MLOAD(D + 32·i)
  const pushBase: PushBase = () => {
    pushFrameLoad(w, frameDepth, FRAME_I);
    w.push(5);
    w.op('SHL'); // [32·i]
    pushFrameLoad(w, frameDepth, FRAME_D); // [D, 32·i]
    w.op('ADD'); // [D+32·i]
    w.op('MLOAD'); // [off]
    pushFrameLoad(w, frameDepth, FRAME_D); // [D, off]
    w.op('ADD'); // [base = D + off]
  };
  const pushSrc: PushWord = (j) => {
    pushElemSlot(w, frameDepth);
    w.op('MLOAD'); // [elemPtrᵢ]
    if (j !== 0) {
      w.push(32 * j);
      w.op('ADD');
    }
    w.op('MLOAD'); // [member word / pointer]
  };
  emitEncodeBlock(w, components, pushSrc, pushBase, tails, {
    ...opts,
    frameDepth: frameDepth + 1,
  });
}

// ---------------------------------------------------------------------------
// encode-to-bytes emitters — `s.encode` / `s.encodePacked` (issue #17)
// ---------------------------------------------------------------------------

/** One `encode`/`encodePacked` operand: its ABI param (name irrelevant) and a thunk pushing its
 *  SRC word — the canonical word for a static value, the memref pointer for a dynamic/composite
 *  one. The thunk must be stack-depth-independent (it runs at arbitrary depth). */
export interface EncodeSrcItem {
  param: NamedType;
  pushSrc: () => void;
}

/** loc/note metadata for the first emitted node of an encode template (sourcemap attribution). */
export interface EncodeMeta {
  loc?: SourceLoc | null;
  note?: string;
}

/** `[…] → […]` — initializes the shared tail cursor to `MLOAD(FREE_PTR) + 32 + headSize`
 *  (the payload starts one length word past the fresh memref pointer). */
function emitBytesCursorInit(w: AsmWriter, headSize: number, meta?: EncodeMeta): void {
  w.push(FREE_PTR, meta);
  w.op('MLOAD'); // [ptr]
  w.push(32 + headSize);
  w.op('ADD'); // [payload cursor]
  w.push(TAIL_CURSOR);
  w.op('MSTORE'); // []
}

/**
 * `[…] → [ptr, …]` — finalizes a `bytes` memref whose payload was written at the tail cursor:
 * `total = cursor − ptr − 32` is stored as the length word at `ptr`, the free pointer is bumped
 * to `ceil32(cursor)` (the ABI encoder's cursor is already 32-aligned; the packed encoder's is
 * not), and the memref pointer is left on the stack for the caller to store.
 */
function emitBytesFinalize(w: AsmWriter, note: string): void {
  w.push(TAIL_CURSOR);
  w.op('MLOAD'); // [cursor]
  w.push(FREE_PTR);
  w.op('MLOAD'); // [ptr, cursor]
  w.op('DUP1'); // [ptr, ptr, cursor]
  w.op('DUP3'); // [cursor, ptr, ptr, cursor]
  w.op('SUB'); // [cursor−ptr, ptr, cursor]
  w.push(32);
  w.op('SWAP1');
  w.op('SUB'); // [total, ptr, cursor]
  w.op('DUP2'); // [ptr, total, ptr, cursor]
  w.op('MSTORE', { note }); // [ptr, cursor]           mem[ptr] = total
  w.op('SWAP1'); // [cursor, ptr]
  w.push(31);
  w.op('ADD');
  w.push(31);
  w.op('NOT');
  w.op('AND'); // [ceil32(cursor), ptr]
  w.push(FREE_PTR);
  w.op('MSTORE'); // [ptr]                              freePtr bumped past the payload
}

/**
 * Materializes the STANDARD ABI encoding (`abi.encode`) of `items` into a fresh `bytes` memref
 * and leaves its pointer on the stack (net stack +1). The items encode as a top-level tuple —
 * heads at the payload start, dynamic offsets relative to it, tails appended at the shared
 * scratch cursor — via {@link emitEncodeBlock}, i.e. exactly the return-encode shape minus the
 * outer RETURN and the single-output wrapper. Composite-array loop frames are reserved BELOW
 * the memref, so the free pointer must not move between entry and the final bump here.
 */
export function emitAbiEncodeToBytes(
  w: AsmWriter,
  items: readonly EncodeSrcItem[],
  tails: SharedTails,
  opts: { evmVersion: EvmVersion },
  meta?: EncodeMeta,
): void {
  const params = items.map((it) => it.param);
  const frames = params.reduce(
    (n, p) => Math.max(n, encodeFramesOf(layoutOfType(abiParamToType(p)))),
    0,
  );
  reserveEncodeFrames(w, frames);
  emitBytesCursorInit(w, headBytes(params), meta);

  const pushSrc: PushWord = (i) => {
    const item = items[i];
    if (item === undefined) throw internal(`emitAbiEncodeToBytes: missing item #${i}`);
    item.pushSrc();
  };
  const pushBase: PushBase = () => {
    // payload base = MLOAD(FREE_PTR) + 32 — the free pointer holds still during the encode.
    w.push(FREE_PTR);
    w.op('MLOAD');
    w.push(32);
    w.op('ADD');
  };
  emitEncodeBlock(w, params, pushSrc, pushBase, tails, opts);
  emitBytesFinalize(w, 'encode abi length'); // [ptr]
}

/**
 * Materializes the PACKED encoding (`abi.encodePacked`) of `items` into a fresh `bytes` memref
 * and leaves its pointer on the stack (net stack +1). Packed rules (Solidity spec, byte-equal to
 * viem `encodePacked`): a word writes its exact byte width unpadded (the value is left-aligned
 * into a word via SHL and MSTOREd at the cursor — the trailing bytes are zeros, overwritten by
 * the next segment); `string`/`bytes` copy their raw payload (no length prefix); a word-element
 * array copies its `32·len`-byte body verbatim (elements pack padded to 32 bytes, and memref
 * elements are already canonical words). Composite types never reach here (validateIr).
 *
 * The cursor stays in scratch so every {@link emitMemCopy} runs at exactly `[dst, src, len]`;
 * the pre-cancun `@memcpy` whole-word over-copy is healed by the next segment's write or by the
 * final explicit zero-pad word, which also zero-pads the trailing partial word of the memref.
 */
export function emitPackedEncodeToBytes(
  w: AsmWriter,
  items: readonly { layout: TypeLayout; pushSrc: () => void }[],
  tails: SharedTails,
  opts: { evmVersion: EvmVersion },
  meta?: EncodeMeta,
): void {
  emitBytesCursorInit(w, 0, meta);

  const advanceCursorBy = (n: number): void => {
    w.push(TAIL_CURSOR);
    w.op('MLOAD');
    w.push(n);
    w.op('ADD');
    w.push(TAIL_CURSOR);
    w.op('MSTORE');
  };
  // cursor += top-of-stack byte count (consumes it)
  const advanceCursorByStack = (): void => {
    w.push(TAIL_CURSOR);
    w.op('MLOAD');
    w.op('ADD'); // [cursor + n]
    w.push(TAIL_CURSOR);
    w.op('MSTORE');
  };

  for (const item of items) {
    const { layout, pushSrc } = item;

    if (layout.kind === 'word') {
      const size = layout.bits / 8; // bool → 1, address → 20, uintN/intN → N/8, bytesN → N
      pushSrc(); // [word]
      if (!layout.leftAligned && layout.bits < 256) {
        w.push(256 - layout.bits);
        w.op('SHL'); // left-align the packed lane; low bytes become zeros
      }
      w.push(TAIL_CURSOR);
      w.op('MLOAD'); // [cursor, word]
      w.op('MSTORE', { note: `packed ${layout.abi}` }); // []
      advanceCursorBy(size);
      continue;
    }

    if (layout.kind === 'tuple' || (layout.kind === 'array' && layout.elem.kind !== 'word')) {
      throw internal(`packed encode over unsupported layout '${layout.kind}' survived validateIr`);
    }

    // string/bytes (raw payload) or word-element array (32·len-byte body — a fixed-size `T[N]`
    // memref carries `len === N`, so the same copy applies): copy from ptr+32.
    const isArray = layout.kind === 'array';
    const pushNBytes = (): void => {
      pushSrc();
      w.op('MLOAD'); // [len]
      if (isArray) {
        w.push(5);
        w.op('SHL'); // [32·len]
      }
    };
    pushNBytes(); // [n]
    pushSrc();
    w.push(32);
    w.op('ADD'); // [src, n]
    w.push(TAIL_CURSOR);
    w.op('MLOAD'); // [dst, src, n]
    emitMemCopy(w, tails, opts); // []
    pushNBytes(); // [n]
    advanceCursorByStack(); // []
  }

  // explicit zero-pad of the trailing partial word: memory above the free pointer is not
  // guaranteed zero and the memref invariant promises zero-padded payloads; this also
  // covers any pre-cancun @memcpy whole-word over-copy left by the LAST segment.
  w.push(0);
  w.push(TAIL_CURSOR);
  w.op('MLOAD');
  w.op('MSTORE', { note: 'packed zero-pad' });

  emitBytesFinalize(w, 'encode packed length'); // [ptr]
}

// ---------------------------------------------------------------------------
// typed zero values (tryCall zero block, `arrnew` composite slots)
// ---------------------------------------------------------------------------

/** The never-written zero slot: an empty `string`/`bytes`/`T[]` memref points here. */
export const ZERO_SLOT = 0x60;

/**
 * @internal Shared by `codegen/call.ts` / `codegen/lower.ts`. Pushes a zero value of `type` onto
 * the stack (net +1): `0` for a word; the `0x60` zero slot for a `string`/`bytes`/dynamic `T[]` (an
 * empty memref); a freshly-allocated zero-filled flat block for a tuple (its dynamic members point
 * at `0x60`, nested composites recurse); a fresh `[N][slots]` block for a fixed-size `T[N]` (word
 * slots zero, composite slots each a recursive zero value — its length is part of the type, so it
 * can never be "empty"). Matches the interpreter's `zeroValue`.
 */
export function emitZeroValue(w: AsmWriter, type: EvsType): void {
  const layout = layoutOfType(type);
  if (layout.kind === 'word') {
    w.push(0);
    return;
  }
  if (layout.kind === 'bytes' || (layout.kind === 'array' && layout.length === null)) {
    w.push(ZERO_SLOT);
    return;
  }
  if (layout.kind === 'tuple') {
    if (!isTupleType(type)) throw internal('emitZeroValue: tuple layout for a non-tuple type');
    const n = type.components.length;
    emitZeroBlock(w, 32 * n, 'zero-fill tuple'); // [flat]
    // set non-word members: dynamic → 0x60; nested composite → its own zero block
    type.components.forEach((c, j) => {
      const ct = abiParamToType(c);
      if (!isDynamicType(ct)) return; // word member stays 0 (zero-filled)
      emitZeroValue(w, ct); // [member, flat]
      w.op('DUP2'); // [flat, member, flat]
      if (j !== 0) {
        w.push(32 * j);
        w.op('ADD');
      }
      w.op('MSTORE'); // [flat]
    });
    return;
  }
  // fixed-size array `T[N]`: `[N][slot0…slot_{N-1}]`
  const n = layout.length ?? 0;
  if (!isArrayValueType(type)) throw internal('emitZeroValue: array layout for a non-array type');
  emitZeroBlock(w, 32 + 32 * n, `zero-fill ${layout.abi}`); // [arr]
  w.push(n);
  w.op('DUP2');
  w.op('MSTORE'); // [arr]   length word = N
  const elem = elemTypeOf(type);
  if (isDynamicType(elem)) {
    for (let i = 0; i < n; i++) {
      emitZeroValue(w, elem); // [slot, arr]
      w.op('DUP2');
      w.push(32 + 32 * i);
      w.op('ADD');
      w.op('MSTORE'); // [arr]
    }
  }
}

/** `[…] → [ptr, …]`: bump-allocates `bytes` and zero-fills them via CALLDATACOPY past the calldata
 *  end (memory above the free pointer is dirty). */
function emitZeroBlock(w: AsmWriter, bytes: number, note: string): void {
  w.push(FREE_PTR);
  w.op('MLOAD'); // [ptr]
  w.op('DUP1');
  w.push(bytes);
  w.op('ADD'); // [ptr+bytes, ptr]
  w.push(FREE_PTR);
  w.op('MSTORE'); // [ptr]   freePtr bumped
  w.push(bytes);
  w.op('CALLDATASIZE');
  w.op('DUP3'); // [ptr, cds, bytes, ptr]
  w.op('CALLDATACOPY', { note }); // [ptr]
}

// ---------------------------------------------------------------------------
// recursive ABI decoder (memory head/tail → flat-pointer block)
// ---------------------------------------------------------------------------

/**
 * @internal Shared by `codegen/call.ts`. A decode failure router: stack on entry `[bad, …live]`
 * → on the continue path `[…live]` (`liveDepth` items). Strict/calldata callers jump straight to
 * a checked stub; try-mode callers invert the branch, clean the stack, and jump to the zero block.
 */
export type DecodeFail = (liveDepth: number) => void;

/**
 * Decodes one ABI tuple located in memory at `pushBase()` (offsets inside the tuple are relative
 * to that base) into a freshly-allocated flat-pointer block, and leaves the block pointer on the
 * stack. `pushEnd()` pushes the one-past-last valid source byte (bounds). Mirrors the interpreter's
 * `decodeOutputs` byte-for-byte: static word → normalized canonical word; static inner tuple →
 * inlined recurse; dynamic member (string/bytes/T[]) → a memref **aliasing** the source; dynamic
 * inner tuple → recurse into its own block. Net stack +1 (the flat pointer). No `emitMemCopy`
 * (dynamic members alias in place), so the element-normalize loops are the only checked regions.
 */
export function emitDecodeTupleToMem(
  w: AsmWriter,
  components: readonly NamedType[],
  pushBase: PushBase,
  pushEnd: () => void,
  fail: DecodeFail,
  belowFlat: number,
): void {
  const offs = headOffsets(components);
  const n = components.length;

  // allocate the flat block (32·n words); bump the free pointer
  w.push(FREE_PTR);
  w.op('MLOAD'); // [flat, …below]
  w.op('DUP1');
  w.push(32 * n);
  w.op('ADD'); // [flat+32n, flat, …]
  w.push(FREE_PTR);
  w.op('MSTORE'); // [flat, …]      freePtr bumped

  components.forEach((comp, j) => {
    const ho = offs[j] ?? 0;
    const layout = layoutOfType(abiParamToType(comp));
    // stack here: [flat, …below]; `belowFlat` items sit beneath flat.

    if (layout.kind === 'word') {
      pushBase();
      if (ho !== 0) {
        w.push(ho);
        w.op('ADD');
      }
      w.op('MLOAD'); // [raw, flat, …]
      emitNormalizeWord(w, layout.abi); // normalize-don't-revert
      w.op('DUP2'); // [flat, word, flat, …]
      if (j !== 0) {
        w.push(32 * j);
        w.op('ADD');
      }
      w.op('MSTORE'); // [flat, …]
      return;
    }

    if (layout.kind === 'tuple' && !layout.dynamic) {
      // static inner tuple — its ABI region inlines at base+ho (no offset word)
      emitDecodeTupleToMem(
        w,
        comp.components ?? [],
        () => emitOffsetBase(w, pushBase, ho),
        pushEnd,
        fail,
        belowFlat + 1,
      ); // [subFlat, flat, …]
      w.op('DUP2'); // [flat, subFlat, flat, …]
      if (j !== 0) {
        w.push(32 * j);
        w.op('ADD');
      }
      w.op('MSTORE'); // [flat, …]
      return;
    }

    if (layout.kind === 'array' && !isDynamic(layout)) {
      // static fixed-size array member — its N elements inline at base+ho (no offset word, no
      // length word); the array decoder allocates the `[N][p0…]` pointer block.
      emitDecodeArrayToMem(
        w,
        layout,
        () => emitOffsetBase(w, pushBase, ho),
        pushEnd,
        fail,
        belowFlat + 1,
      ); // [arr, flat, …]
      w.op('DUP2'); // [flat, arr, flat, …]
      if (j !== 0) {
        w.push(32 * j);
        w.op('ADD');
      }
      w.op('MSTORE'); // [flat, …]
      return;
    }

    // dynamic member: offset word at base+ho points to the member's block at base+off
    pushBase(); // [base, flat, …]
    if (ho !== 0) {
      w.push(ho);
      w.op('ADD');
    }
    w.op('MLOAD'); // [off, flat, …]
    // off ≤ 2^64−1
    w.op('DUP1');
    w.push(MAX_U64);
    w.op('LT'); // [off > max, off, flat, …]
    fail(belowFlat + 2); // [off, flat, …]
    // ptr := base + off
    pushBase();
    w.op('ADD'); // [ptr, flat, …]
    // ptr + 32 ≤ end
    w.op('DUP1');
    w.push(32);
    w.op('ADD'); // [ptr+32, ptr, flat, …]
    pushEnd();
    w.op('LT'); // [end < ptr+32, ptr, flat, …]
    fail(belowFlat + 2); // [ptr, flat, …]

    if (layout.kind === 'tuple') {
      // dynamic inner tuple at ptr — recurse (its offsets are relative to ptr)
      // [ptr, flat, …]; need the block pointer it returns stored into flat+32·j
      emitDecodeTupleToMem(
        w,
        comp.components ?? [],
        () => {
          // base of the sub-tuple = ptr, which is on the stack just below subFlat work;
          // re-derive instead of holding it: it is `parentBase + MLOAD(parentBase+ho)`.
          emitSubTupleBase(w, pushBase, ho);
        },
        pushEnd,
        fail,
        belowFlat + 2,
      ); // [subFlat, ptr, flat, …]
      w.op('DUP3'); // [flat, subFlat, ptr, flat, …]
      if (j !== 0) {
        w.push(32 * j);
        w.op('ADD');
      }
      w.op('MSTORE'); // [ptr, flat, …]
      w.op('POP'); // [flat, …]
      return;
    }

    // composite-element array member (`tuple[]`, `T[][]`, `string[]`) or a dynamic fixed-size
    // array (`string[2]`): recurse the array decoder, which freshly allocates a `[len][p0…]`
    // pointer block (its elements alias/recurse). stack here is `[ptr, flat, …below]`; ptr is the
    // array block start, re-derivable as `parentBase + MLOAD(parentBase+ho)` so nothing live has
    // to ride through the array decoder.
    if (layout.kind === 'array' && isRecursiveArray(layout)) {
      w.op('POP'); // [flat, …below]   (ptr re-derived by the thunk below)
      emitDecodeArrayToMem(
        w,
        layout,
        () => emitSubTupleBase(w, pushBase, ho),
        pushEnd,
        fail,
        belowFlat + 1,
      ); // [arr, flat, …]
      w.op('DUP2'); // [flat, arr, flat, …]
      if (j !== 0) {
        w.push(32 * j);
        w.op('ADD');
      }
      w.op('MSTORE'); // [flat, …]
      return;
    }

    // leaf dynamic (string/bytes/word-array): bounds on len + payload, normalize array elems, alias ptr
    const isArray = layout.kind === 'array';
    const elemAbi = isArray ? wordElemAbi(layout) : null;
    w.op('DUP1');
    w.op('MLOAD'); // [len, ptr, flat, …]
    w.op('DUP1');
    w.push(MAX_U64);
    w.op('LT'); // [len > max, len, ptr, flat, …]
    fail(belowFlat + 3); // [len, ptr, flat, …]
    // nbytes = len (bytes/string) | 32·len (arrays); end check: ptr + 32 + nbytes ≤ end
    if (isArray) {
      w.push(5);
      w.op('SHL'); // [nbytes, ptr, flat, …]
    }
    w.op('DUP2');
    w.op('ADD');
    w.push(32);
    w.op('ADD'); // [ptr+32+nbytes, ptr, flat, …]
    pushEnd();
    w.op('LT'); // [end < tailEnd, ptr, flat, …]
    fail(belowFlat + 2); // [ptr, flat, …]

    if (elemAbi !== null && wordNeedsNormalize(elemAbi)) {
      // eager element normalization over the aliased region
      w.op('DUP1');
      w.op('MLOAD');
      w.push(5);
      w.op('SHL'); // [nbytes, ptr, flat, …]
      w.op('DUP2');
      w.op('ADD');
      w.push(32);
      w.op('ADD'); // [end, ptr, flat, …]
      w.op('DUP2');
      w.push(32);
      w.op('ADD'); // [cur, end, ptr, flat, …]
      emitNormalizeElemsLoop(w, elemAbi, belowFlat + 2);
      w.op('POP');
      w.op('POP'); // [ptr, flat, …]
    }

    // alias: store ptr into flat + 32·j (ptr is consumed as the MSTORE value)
    w.op('DUP2'); // [flat, ptr, flat, …]
    if (j !== 0) {
      w.push(32 * j);
      w.op('ADD');
    } // [flat+32j, ptr, flat, …]
    w.op('MSTORE'); // [flat, …]
  });
}

/**
 * Decodes an array located in memory at `pushBase()` — a dynamic `E[]` (the `[len:32][…]` block
 * start) or a fixed-size `E[N]` (its first element / offset word; no length on the wire) — into a
 * freshly-allocated pointer block `[len:32][p0:32]…[p_{len-1}:32]` (`len === N` for a fixed-size
 * array), and leaves that block pointer on the stack (net stack +1). Mirrors the interpreter's
 * `decodeDynamic`/`decodeStatic` array arms byte-for-byte:
 *
 * - dynamic: read `len` at `base`, bound `len ≤ 2^64−1`, `D = base + 32`; fixed: `len = N`,
 *   `D = base`. Bump-alloc `32 + 32·len` for the pointer block.
 * - static element `E` (a word, a static tuple, or a static fixed array): the body is contiguous,
 *   bound `D + len·staticSize ≤ end` up front, then each element decodes at `D + i·staticSize`. A
 *   composite element decodes to a fresh block (its pointer stored into `arr + 32 + 32·i`); a word
 *   element is normalized inline and stored as the slot value.
 * - dynamic element (dynamic tuple, inner `T[]`, `string`/`bytes`, dynamic `T[N]`): the offset-word
 *   region (`len` words at `[D, D+32·len)`) must fit first; then each `offᵢ` at `D+32·i` (relative
 *   to `D`, bound `offᵢ ≤ 2^64−1`), `elemPtr = D + offᵢ` (bound `elemPtr + 32 ≤ end`), recurse the
 *   matching decoder, store the returned block pointer into `arr + 32 + 32·i`.
 *
 * The loop state (`elemBase, i, D, arr, len, parent`) lives in a heap-allocated DECODE FRAME
 * (allocated right after the pointer block; the current frame pointer sits in scratch
 * `DECODE_FRAME`, frames chain through `parent`), so the operand stack holds only `[arr]` above
 * `belowFlat` throughout — the template budget is independent of the array nesting depth, and
 * arrays nest arbitrarily (`uint256[][][]`, `tuple[][]`, `string[2][][]`, …). No `emitMemCopy`
 * (the array aliases leaf bytes and freshly allocates tuple/array blocks). Loop labels are checked
 * at absolute height `belowFlat + 1`.
 */
export function emitDecodeArrayToMem(
  w: AsmWriter,
  layout: Extract<TypeLayout, { kind: 'array' }>,
  pushBase: PushBase,
  pushEnd: () => void,
  fail: DecodeFail,
  belowFlat: number,
): void {
  const elemLayout = layout.elem;
  const elemDynamic = isDynamic(elemLayout);

  // -- len: dynamic → MLOAD(base), bound ≤ 2^64−1; fixed → the constant N ---------------------
  if (layout.length === null) {
    pushBase();
    w.op('MLOAD'); // [len, …below]
    w.op('DUP1');
    w.push(MAX_U64);
    w.op('LT'); // [len > max, len, …]
    fail(belowFlat + 1); // [len, …]
  } else {
    w.push(layout.length, { note: `fixed len ${layout.length}` }); // [len, …]
  }

  // -- allocate the pointer block [len][p0…] (32 + 32·len bytes) AND the decode frame right
  //    after it (32·DFRAME_SLOTS bytes); bump FREE_PTR once past both --------------------------
  w.push(FREE_PTR);
  w.op('MLOAD'); // [arr, len, …]
  w.op('DUP2'); // [len, arr, len, …]
  w.push(5);
  w.op('SHL'); // [32·len, arr, len, …]
  w.push(32);
  w.op('ADD'); // [32+32·len, arr, len, …]
  w.op('DUP2');
  w.op('ADD'); // [frame, arr, len, …]
  w.op('DUP1');
  w.push(32 * DFRAME_SLOTS);
  w.op('ADD'); // [frame+192, frame, arr, len, …]
  w.push(FREE_PTR);
  w.op('MSTORE'); // [frame, arr, len, …]      freePtr bumped past the frame
  // mem[arr] := len
  w.op('DUP3');
  w.op('DUP3');
  w.op('MSTORE'); // [frame, arr, len, …]
  // frame.arr := arr ; frame.len := len ; frame.parent := MLOAD(DECODE_FRAME)
  w.op('DUP2');
  w.op('DUP2');
  w.push(32 * DFRAME_ARR);
  w.op('ADD');
  w.op('MSTORE'); // [frame, arr, len, …]
  w.op('DUP3');
  w.op('DUP2');
  w.push(32 * DFRAME_LEN);
  w.op('ADD');
  w.op('MSTORE'); // [frame, arr, len, …]
  w.push(DECODE_FRAME);
  w.op('MLOAD'); // [parent, frame, arr, len, …]
  w.op('DUP2');
  w.push(32 * DFRAME_PARENT);
  w.op('ADD');
  w.op('MSTORE'); // [frame, arr, len, …]
  // frame.D := base (+32 for a dynamic array) — `pushBase` must run BEFORE the frame switch: a
  // nested decode's base thunk reads the PARENT frame's elemBase.
  pushBase(); // [base, frame, arr, len, …]
  if (layout.length === null) {
    w.push(32);
    w.op('ADD'); // [D, frame, arr, len, …]
  }
  w.op('DUP2');
  w.push(32 * DFRAME_D);
  w.op('ADD');
  w.op('MSTORE'); // [frame, arr, len, …]
  // switch the current frame
  w.push(DECODE_FRAME);
  w.op('MSTORE'); // [arr, len, …]

  // -- up-front element-body bounds (mirrors the interp): D + body ≤ end ----------------------
  pushDFrameLoad(w, DFRAME_D); // [D, arr, len, …]
  w.op('DUP3'); // [len, D, arr, len, …]
  if (elemDynamic) {
    w.push(5);
    w.op('SHL'); // [32·len, D, arr, len, …]
  } else {
    const ss = staticSize(elemLayout);
    if (ss !== 1) {
      w.push(ss);
      w.op('MUL'); // [len·ss, D, arr, len, …]
    }
  }
  w.op('ADD'); // [D+body, arr, len, …]
  pushEnd();
  w.op('LT'); // [end < D+body, arr, len, …]
  fail(belowFlat + 2); // [arr, len, …]
  w.op('SWAP1');
  w.op('POP'); // [arr, …]   (len lives in the frame from here on)

  // -- element loop: state in the frame; stack stays at [arr, …below] ------------------------
  w.push(0);
  emitDFrameStore(w, DFRAME_I); // frame.i := 0

  const height = belowFlat + 1;
  const head = w.newLabel('arrdec');
  const done = w.newLabel('arrdec_done');
  w.label(head, height); // [arr, …]
  // continue while i < len
  pushDFrameLoad(w, DFRAME_I); // [i, arr, …]
  pushDFrameLoad(w, DFRAME_LEN); // [len, i, arr, …]
  w.op('GT'); // [len > i, arr, …]   i.e. i < len
  w.op('ISZERO');
  w.pushLabel(done);
  w.op('JUMPI'); // [arr, …]

  // element source base from D and i → frame.elemBase
  if (elemDynamic) {
    // offᵢ at D + 32·i (relative to D); offᵢ ≤ 2^64−1; elemPtr = D + offᵢ; elemPtr+32 ≤ end
    pushDFrameLoad(w, DFRAME_I);
    w.push(5);
    w.op('SHL'); // [32·i, arr, …]
    pushDFrameLoad(w, DFRAME_D);
    w.op('ADD');
    w.op('MLOAD'); // [off, arr, …]
    w.op('DUP1');
    w.push(MAX_U64);
    w.op('LT'); // [off > max, off, arr, …]
    fail(belowFlat + 2); // [off, arr, …]
    pushDFrameLoad(w, DFRAME_D);
    w.op('ADD'); // [elemPtr, arr, …]
    w.op('DUP1');
    w.push(32);
    w.op('ADD'); // [elemPtr+32, elemPtr, arr, …]
    pushEnd();
    w.op('LT'); // [end < elemPtr+32, elemPtr, arr, …]
    fail(belowFlat + 2); // [elemPtr, arr, …]
  } else {
    // static element source base = D + i·staticSize
    const ss = staticSize(elemLayout);
    pushDFrameLoad(w, DFRAME_I); // [i, arr, …]
    if (ss !== 1) {
      w.push(ss);
      w.op('MUL'); // [i·ss, arr, …]
    }
    pushDFrameLoad(w, DFRAME_D);
    w.op('ADD'); // [elemBase, arr, …]
  }
  emitDFrameStore(w, DFRAME_ELEM_BASE); // [arr, …]

  // decode the element (the recursive decoders read their base back from the frame)
  emitDecodeElement(w, elemLayout, pushEnd, fail, belowFlat + 1); // [elemVal, arr, …]

  // store elemVal into arr + 32 + 32·i
  pushDFrameLoad(w, DFRAME_I);
  w.push(5);
  w.op('SHL'); // [32·i, elemVal, arr, …]
  w.op('DUP3');
  w.op('ADD');
  w.push(32);
  w.op('ADD'); // [slotAddr, elemVal, arr, …]
  w.op('MSTORE'); // [arr, …]

  // i += 1
  pushDFrameLoad(w, DFRAME_I);
  w.push(1);
  w.op('ADD');
  emitDFrameStore(w, DFRAME_I); // [arr, …]
  w.pushLabel(head);
  w.op('JUMP');
  w.label(done, height); // [arr, …]

  // -- restore the parent frame ----------------------------------------------------------------
  pushDFrameLoad(w, DFRAME_PARENT); // [parent, arr, …]
  w.push(DECODE_FRAME);
  w.op('MSTORE'); // [arr, …below]    net +1
}

/** Pushes word `k` of the CURRENT decode frame (`MLOAD(MLOAD(DECODE_FRAME) + 32·k)`). */
function pushDFrameLoad(w: AsmWriter, k: number): void {
  w.push(DECODE_FRAME);
  w.op('MLOAD'); // [frame]
  if (k !== 0) {
    w.push(32 * k);
    w.op('ADD');
  }
  w.op('MLOAD');
}

/** Stores the top-of-stack value into word `k` of the CURRENT decode frame (consumes the value). */
function emitDFrameStore(w: AsmWriter, k: number): void {
  w.push(DECODE_FRAME);
  w.op('MLOAD'); // [frame, v]
  if (k !== 0) {
    w.push(32 * k);
    w.op('ADD');
  }
  w.op('MSTORE'); // []
}

/**
 * Decodes one array element whose source block starts at the current decode frame's `elemBase`
 * (the array loop wrote it there), pushing the decoded element value (a normalized word for a
 * word element, otherwise a fresh block pointer / aliased bytes pointer). Net stack +1. The caller
 * already validated the per-element bounds (dynamic) / body bounds (static). `belowElem` is the
 * number of live items on the stack on entry.
 *
 * The recursive tuple/array decoders re-derive their base through `pushBase =
 * MLOAD(MLOAD(DECODE_FRAME))`, which is stack-depth-independent (so the decoders' internal stack
 * churn never loses the base). A nested array decode links its own frame and restores this one on
 * exit, so it cannot clobber this base.
 */
function emitDecodeElement(
  w: AsmWriter,
  elemLayout: TypeLayout,
  pushEnd: () => void,
  fail: DecodeFail,
  belowElem: number,
): void {
  const pushBase: PushBase = () => pushDFrameLoad(w, DFRAME_ELEM_BASE);

  if (elemLayout.kind === 'word') {
    // word element: base points at the inline word; normalize and push it.
    pushBase();
    w.op('MLOAD'); // [raw, …]
    emitNormalizeWord(w, elemLayout.abi); // [word, …]
    return;
  }

  if (elemLayout.kind === 'tuple') {
    // tuple element (static or dynamic): decode into a flat block; offsets relative to base.
    emitDecodeTupleToMem(w, tupleComponents(elemLayout), pushBase, pushEnd, fail, belowElem); // [flat, …]
    return;
  }

  if (elemLayout.kind === 'array') {
    // nested array element (`T[][]`, `T[N][]`, …): recurse — it links/restores its own frame.
    emitDecodeArrayToMem(w, elemLayout, pushBase, pushEnd, fail, belowElem); // [arr, …]
    return;
  }

  // bytes/string element (`string[]`/`bytes[]`): base points at `[len][payload]`; bounds + alias.
  // len ≤ 2^64−1; ptr + 32 + len ≤ end. The decoded value IS base (we alias in place).
  pushBase(); // [base, …]
  w.op('DUP1');
  w.op('MLOAD'); // [len, base, …]
  w.op('DUP1');
  w.push(MAX_U64);
  w.op('LT'); // [len > max, len, base, …]
  fail(belowElem + 2); // [len, base, …]
  w.op('DUP2');
  w.op('ADD');
  w.push(32);
  w.op('ADD'); // [base+32+len, base, …]
  pushEnd();
  w.op('LT'); // [end < base+32+len, base, …]
  fail(belowElem + 1); // [base, …]   (base is the aliased bytes block = the elem value)
}

/** A tuple layout's components as `NamedType[]` (reconstructed for the recursive decoders). */
function tupleComponents(l: Extract<TypeLayout, { kind: 'tuple' }>): readonly NamedType[] {
  return l.components.map((c, i) => layoutToNamed(c, i));
}

function layoutToNamed(l: TypeLayout, i: number): NamedType {
  void i;
  if (l.kind === 'tuple') {
    return { name: '', type: l.abi, components: l.components.map((c, k) => layoutToNamed(c, k)) };
  }
  if (l.kind === 'array') {
    // an array-of-tuple member (`tuple[]`, `tuple[2][]`, …) carries the LEAF tuple's components
    // under the array tag — the same `PlainAbiParam` shape the ABI uses.
    let leaf: TypeLayout = l.elem;
    while (leaf.kind === 'array') leaf = leaf.elem;
    if (leaf.kind === 'tuple') {
      return {
        name: '',
        type: l.abi,
        components: leaf.components.map((c, k) => layoutToNamed(c, k)),
      };
    }
  }
  return { name: '', type: l.abi };
}

// ---------------------------------------------------------------------------
// emitCalldataDecode
// ---------------------------------------------------------------------------

/**
 * Decodes the script arguments from calldata into their frame slots.
 *
 * - One up-front size guard: `CALLDATASIZE < 4 + headBytes(args)` → `tails.invalidCalldata`
 *   (a static tuple arg inlines its whole head, so the head walk is cumulative, not `32·i`).
 * - Word args: `CALLDATALOAD` + normalize (mask / SIGNEXTEND / `ISZERO ISZERO`) + `MSTORE`
 *   (normalize-don't-revert on dirty high bits).
 * - Dynamic args: overflow-free bounds checks (`off ≤ 2^64−1`, `4+off+32 ≤ cds`,
 *   `len ≤ 2^64−1`, tail-end ≤ cds) → `tails.invalidCalldata` on any structural failure;
 *   then allocate, `CALLDATACOPY` the `[len][payload]` segment, explicit zero-pad of the
 *   trailing partial word (bytes/string), eager element normalization (arrays of sub-word
 *   element types), and store the memref pointer.
 * - Tuple args: the whole calldata is snapshotted into memory once (ceil32, zero-padded by
 *   CALLDATACOPY past-end), then `emitDecodeTupleToMem` builds the flat-pointer block from the
 *   snapshot (its dynamic members alias the snapshot). Tuple-arg offsets are relative to the
 *   args region start (calldata byte 4 → snapshot byte `snap+4`).
 *
 * Net stack 0. Nothing here is fork-dependent (zero-push lowering is the assembler's job).
 */
export function emitCalldataDecode(
  w: AsmWriter,
  args: readonly SlotRef[],
  tails: SharedTails,
  _opts: { evmVersion: EvmVersion },
): void {
  const params = args.map((ref) => typeToAbiParam('', ref.type));
  const headOffs = headOffsets(params); // cumulative head byte offsets within the args region
  // tuple args AND recursive-codec array args (`tuple[]`/`T[][]`/`string[]`, every `T[N]`) decode
  // from a memory snapshot of the calldata (the recursive decoders read source bytes from memory,
  // not calldata).
  const hasTuple = args.some((ref) => needsMemorySnapshot(layoutOfType(ref.type)));

  // -- size guard: cds < 4 + headBytes(args) → EvsInvalidCalldata ----------------------
  const minSize = 4 + headBytes(params);
  w.push(minSize, { note: `calldata floor ${minSize}` });
  w.op('CALLDATASIZE'); // [cds, minSize]
  w.op('LT'); // [cds < minSize]
  w.pushLabel(tails.invalidCalldata);
  w.op('JUMPI');

  // tuple args decode from a single memory snapshot of the whole calldata (zero-padded by the
  // CALLDATACOPY past-end idiom — copying ceil32(cds) bytes reads zeros past the calldata end)
  const snapSlot = TAIL_CURSOR; // scratch holds the snapshot base pointer for the arg loop
  if (hasTuple) {
    // size := ceil32(cds)
    w.op('CALLDATASIZE');
    w.push(31);
    w.op('ADD');
    w.push(31);
    w.op('NOT');
    w.op('AND'); // [size]
    w.push(FREE_PTR);
    w.op('MLOAD'); // [snap, size]
    // freePtr := snap + size
    w.op('DUP1');
    w.op('DUP3');
    w.op('ADD'); // [snap+size, snap, size]
    w.push(FREE_PTR);
    w.op('MSTORE'); // [snap, size]
    // scratch[snapSlot] := snap
    w.op('DUP1');
    w.push(snapSlot);
    w.op('MSTORE'); // [snap, size]
    // CALLDATACOPY(dst = snap, off = 0, len = size)
    w.op('SWAP1'); // [size, snap]
    w.push(0); // [0, size, snap]
    w.op('DUP3'); // [snap, 0, size, snap]
    w.op('CALLDATACOPY'); // [snap]
    w.op('POP'); // []
  }

  const failCalldata: DecodeFail = () => {
    w.pushLabel(tails.invalidCalldata);
    w.op('JUMPI');
  };

  // snapshot-relative source thunks for the recursive decoders (tuple / composite-array args)
  const pushArgsBase = (): void => {
    w.push(snapSlot);
    w.op('MLOAD'); // [snap]
    w.push(4);
    w.op('ADD'); // [snap+4]  (args region start in the snapshot)
  };
  const pushEnd = (): void => {
    w.push(snapSlot);
    w.op('MLOAD');
    w.op('CALLDATASIZE');
    w.op('ADD'); // [snap + cds]  (one past last valid source byte)
  };

  args.forEach((ref, i) => {
    const layout = layoutOfType(ref.type);
    const headOff = 4 + (headOffs[i] ?? 32 * i);

    if (layout.kind === 'word') {
      w.push(headOff, { note: `arg #${i} head` });
      w.op('CALLDATALOAD'); // [raw]
      emitNormalizeWord(w, layout.abi);
      w.push(ref.slot);
      w.op('MSTORE'); // []
      return;
    }

    if (layout.kind === 'tuple') {
      // tuple arg: decode from the memory snapshot; offsets are relative to the args region
      // (snapshot byte snap+4). A static tuple inlines at snap+4+headOff; a dynamic tuple's
      // block is at snap+4+off where off = MLOAD(snap+4+headOff).
      const pushTupleBase: PushBase = layout.dynamic
        ? () => {
            // base = (snap+4) + MLOAD(snap+4+headOff_within_region)
            pushArgsBase(); // [argsBase]
            w.op('DUP1'); // [argsBase, argsBase]
            const within = headOff - 4;
            if (within !== 0) {
              w.push(within);
              w.op('ADD');
            }
            w.op('MLOAD'); // [off, argsBase]
            w.op('ADD'); // [base]
          }
        : () => {
            pushArgsBase();
            const within = headOff - 4;
            if (within !== 0) {
              w.push(within);
              w.op('ADD');
            } // [base = snap+4+within]
          };
      // for a DYNAMIC tuple, first bounds-check its offset word (off ≤ 2^64−1, region+off+? ≤ end)
      if (layout.dynamic) {
        pushArgsBase();
        const within = headOff - 4;
        if (within !== 0) {
          w.push(within);
          w.op('ADD');
        }
        w.op('MLOAD'); // [off]
        w.op('DUP1');
        w.push(MAX_U64);
        w.op('LT'); // [off > max, off]
        failCalldata(1); // [off]
        pushArgsBase();
        w.op('ADD'); // [base]
        w.push(32);
        w.op('ADD'); // [base+32]
        pushEnd();
        w.op('LT'); // [end < base+32]
        failCalldata(0); // []
      }
      if (!isTupleType(ref.type)) throw internal(`arg #${i} layout is tuple but type is not`);
      emitDecodeTupleToMem(w, ref.type.components, pushTupleBase, pushEnd, failCalldata, 0); // [flat]
      w.push(ref.slot);
      w.op('MSTORE'); // []
      return;
    }

    if (layout.kind === 'array' && isRecursiveArray(layout)) {
      // recursive-codec array arg (`tuple[]`/`T[][]`/`string[]`, or any `T[N]`): decode from the
      // snapshot. A STATIC fixed-size array inlines at snap+4+headOff (no offset word); otherwise
      // the head word at snap+4+headOff is an offset relative to the args region (snap+4) and the
      // array block starts at (snap+4)+off.
      const within = headOff - 4;
      let pushArrBase: PushBase;
      if (isDynamic(layout)) {
        // bounds the offset word: off ≤ 2^64−1, region+off+32 ≤ end
        pushArgsBase();
        if (within !== 0) {
          w.push(within);
          w.op('ADD');
        }
        w.op('MLOAD'); // [off]
        w.op('DUP1');
        w.push(MAX_U64);
        w.op('LT'); // [off > max, off]
        failCalldata(1); // [off]
        pushArgsBase();
        w.op('ADD'); // [base]
        w.push(32);
        w.op('ADD'); // [base+32]
        pushEnd();
        w.op('LT'); // [end < base+32]
        failCalldata(0); // []
        pushArrBase = () => {
          pushArgsBase();
          w.op('DUP1'); // [argsBase, argsBase]
          if (within !== 0) {
            w.push(within);
            w.op('ADD');
          }
          w.op('MLOAD'); // [off, argsBase]
          w.op('ADD'); // [base]
        };
      } else {
        pushArrBase = () => {
          pushArgsBase();
          if (within !== 0) {
            w.push(within);
            w.op('ADD');
          } // [base = snap+4+within]
        };
      }
      emitDecodeArrayToMem(w, layout, pushArrBase, pushEnd, failCalldata, 0); // [arr]
      w.push(ref.slot);
      w.op('MSTORE'); // []
      return;
    }

    emitDynCalldataArg(w, ref, layout, headOff, i, tails);
  });
}

/** One dynamic (`string`/`bytes`/`T[]`) script argument — net stack 0. */
function emitDynCalldataArg(
  w: AsmWriter,
  ref: SlotRef,
  layout: Extract<TypeLayout, { kind: 'bytes' | 'array' }>,
  headOff: number,
  index: number,
  tails: SharedTails,
): void {
  const isArray = layout.kind === 'array';

  // off := CALLDATALOAD(headOff); off ≤ 2^64−1
  w.push(headOff, { note: `arg #${index} head` });
  w.op('CALLDATALOAD'); // [off]
  w.push(MAX_U64);
  w.op('DUP2');
  w.op('GT'); // [off > max, off]
  w.pushLabel(tails.invalidCalldata);
  w.op('JUMPI'); // [off]

  // 4 + off + 32 ≤ cds  ⇔  ¬(cds < off + 36)
  w.op('DUP1');
  w.push(36);
  w.op('ADD'); // [off+36, off]
  w.op('CALLDATASIZE');
  w.op('LT'); // [cds < off+36, off]
  w.pushLabel(tails.invalidCalldata);
  w.op('JUMPI'); // [off]

  // src := 4 + off; len := CALLDATALOAD(src); len ≤ 2^64−1
  w.push(4);
  w.op('ADD'); // [src]
  w.op('DUP1');
  w.op('CALLDATALOAD'); // [len, src]
  w.push(MAX_U64);
  w.op('DUP2');
  w.op('GT'); // [len > max, len, src]
  w.pushLabel(tails.invalidCalldata);
  w.op('JUMPI'); // [len, src]

  // end := src + 32 + nbytes (nbytes = len | 32·len); end ≤ cds (overflow-free: both ≤ 2^64ish)
  if (isArray) {
    w.op('DUP1');
    w.push(5);
    w.op('SHL'); // [32·len, len, src]
    w.op('DUP3');
    w.op('ADD'); // [src + 32·len, len, src]
  } else {
    w.op('DUP2');
    w.op('DUP2');
    w.op('ADD'); // [src + len, len, src]
  }
  w.push(32);
  w.op('ADD'); // [end, len, src]
  w.op('CALLDATASIZE');
  w.op('LT'); // [cds < end, len, src]
  w.pushLabel(tails.invalidCalldata);
  w.op('JUMPI'); // [len, src]

  // allocate 32 + ceil32(len) (bytes/string) | 32 + 32·len (arrays)
  w.push(FREE_PTR);
  w.op('MLOAD'); // [ptr, len, src]
  if (isArray) {
    w.op('DUP2');
    w.push(5);
    w.op('SHL'); // [32·len, ptr, len, src]
  } else {
    w.op('DUP2');
    w.push(31);
    w.op('ADD');
    w.push(31);
    w.op('NOT');
    w.op('AND'); // [ceil32(len), ptr, len, src]
  }
  w.push(32);
  w.op('ADD'); // [size, ptr, len, src]
  w.op('DUP2');
  w.op('ADD'); // [ptr+size, ptr, len, src]
  w.push(FREE_PTR);
  w.op('MSTORE'); // [ptr, len, src]   freePtr bumped

  // CALLDATACOPY(ptr, src, 32 + nbytes) — the [len][payload] segment, byte-exact
  if (isArray) {
    w.op('DUP2');
    w.push(5);
    w.op('SHL');
  } else {
    w.op('DUP2');
  }
  w.push(32);
  w.op('ADD'); // [copyLen, ptr, len, src]
  w.op('DUP4'); // [src, copyLen, ptr, len, src]
  w.op('DUP3'); // [ptr, src, copyLen, ptr, len, src]
  w.op('CALLDATACOPY'); // [ptr, len, src]

  if (!isArray) {
    // explicit zero-pad of the trailing partial word: MSTORE(ptr + 32 + len, 0) — memory
    // above the free pointer is NOT guaranteed zero, and the memref
    // invariant promises zero-padded payloads.
    w.push(0); // [0, ptr, len, src]
    w.op('DUP2');
    w.op('DUP4');
    w.op('ADD'); // [ptr+len, 0, ptr, len, src]
    w.push(32);
    w.op('ADD'); // [pad, 0, ptr, len, src]
    w.op('MSTORE'); // [ptr, len, src]
  } else {
    // array: dynamic word-element arrays only — the caller dispatches every other array
    // (composite element, fixed-size) to the recursive path before reaching here.
    const elemAbi = wordElemAbi(layout);
    if (wordNeedsNormalize(elemAbi)) {
      // eager element normalization (skipped for full-word element types)
      w.op('DUP2');
      w.push(5);
      w.op('SHL'); // [32·len, ptr, len, src]
      w.op('DUP2');
      w.op('ADD');
      w.push(32);
      w.op('ADD'); // [end, ptr, len, src]
      w.op('DUP2');
      w.push(32);
      w.op('ADD'); // [cur, end, ptr, len, src]
      emitNormalizeElemsLoop(w, elemAbi, 3);
      w.op('POP');
      w.op('POP'); // [ptr, len, src]
    }
  }

  // slot := ptr; cleanup
  w.push(ref.slot);
  w.op('MSTORE'); // [len, src]
  w.op('POP');
  w.op('POP'); // []
}

// ---------------------------------------------------------------------------
// emitReturnEncode
// ---------------------------------------------------------------------------

/**
 * Encodes the return record as the single named tuple output and RETURNs it.
 * The record is treated as a synthetic top-level tuple: a static word
 * component reads its canonical frame slot; a dynamic component (string/bytes/T[]) or a tuple
 * component reads its memref pointer (a flat-pointer block) and recurses through
 * {@link emitEncodeBlock}.
 *
 * 1. `out = MLOAD(0x40)`; if the record is ABI-dynamic, `MSTORE(out, 0x20)` (top-level tuple
 *    offset) and `base = out + 0x20`, else `base = out` (both shapes decode identically).
 * 2. `emitEncodeBlock` writes heads (at `base + headOffsets[i]`) and appends every dynamic
 *    member's tail at the running scratch cursor.
 * 3. `RETURN(out, total)`.
 *
 * The running tail cursor lives in scratch `0x00` so every `emitMemCopy` call happens with
 * the stack being exactly `[dst, src, len]` (the pre-cancun `@memcpy` convention). The free
 * pointer is never bumped here — RETURN terminates the program.
 */
export function emitReturnEncode(
  w: AsmWriter,
  components: readonly { name: string; ref: SlotRef }[],
  tails: SharedTails,
  opts: { evmVersion: EvmVersion },
): void {
  // synthetic top-level tuple: one component per return value, sourced from its frame slot
  const named = components.map((c) => typeToAbiParam(c.name, c.ref.type));
  const anyDyn = named.some((c) => isDynamic(layoutOfType(abiParamToType(c))));
  const dynOff = anyDyn ? 32 : 0;
  const headSize = headBytes(named);

  // Reserve the composite-array encode loop frames BELOW the output buffer: bump the free
  // pointer by 32·FRAME_SLOTS·FRAMES BEFORE reading `out`, so `out = MLOAD(0x40)` sits above frame 0
  // and `RETURN(out, cursor − out)` never returns scratch. FRAMES = the max concurrent array-nesting
  // depth of the return type (0 for a record with no composite-element array — no bump at all).
  const frames = named.reduce(
    (n, c) => Math.max(n, encodeFramesOf(layoutOfType(abiParamToType(c)))),
    0,
  );
  reserveEncodeFrames(w, frames);

  // out := MLOAD(0x40); optional top-level tuple offset; tail cursor := out + dynOff + heads
  w.push(FREE_PTR);
  w.op('MLOAD', { note: 'return buffer' }); // [out]
  if (anyDyn) {
    w.push(0x20); // [0x20, out]
    w.op('DUP2'); // [out, 0x20, out]
    w.op('MSTORE'); // [out]            mem[out] = 0x20 (top-level tuple offset)
  }
  w.push(dynOff + headSize);
  w.op('ADD'); // [tail0]
  w.push(TAIL_CURSOR);
  w.op('MSTORE'); // []                 scratch[0x00] = tail cursor

  const pushSrc: PushWord = (i) => {
    const c = components[i];
    if (c === undefined) throw internal(`missing return component #${i}`);
    w.push(c.ref.slot);
    w.op('MLOAD'); // [canonical word | memref pointer]
  };
  const pushBase: PushBase = () => {
    w.push(FREE_PTR);
    w.op('MLOAD');
    if (dynOff !== 0) {
      w.push(dynOff);
      w.op('ADD');
    } // [base = out + dynOff]
  };
  emitEncodeBlock(w, named, pushSrc, pushBase, tails, opts);

  // RETURN(out, tail − out)
  w.push(TAIL_CURSOR);
  w.op('MLOAD'); // [tail]
  w.push(FREE_PTR);
  w.op('MLOAD'); // [out, tail]
  w.op('DUP1'); // [out, out, tail]
  w.op('SWAP2'); // [tail, out, out]
  w.op('SUB'); // [size, out]
  w.op('SWAP1'); // [out, size]
  w.op('RETURN', { note: 'return tuple' });
}

// ---------------------------------------------------------------------------
// emitMemCopy — evmVersion lowering (MCOPY on cancun, @memcpy subroutine before)
// ---------------------------------------------------------------------------

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
