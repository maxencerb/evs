/**
 * `codegen/abi/encode.ts` — the recursive ABI encoder (head/tail over a flat-pointer SRC tree)
 * and the composite-element array encode, whose loop state lives in the scratch frames reserved
 * below the output buffer.
 */

import {
  layoutOfType,
  isDynamic,
  staticSize,
  headBytes,
  type TypeLayout,
} from '../../abi/layout.js';
import type { AsmWriter } from '../../asm/assembler.js';
import type { EvmVersion } from '../../asm/ops.js';
import { type NamedType, abiParamToType } from '../../core/types.js';
import { FREE_PTR, TAIL_CURSOR } from '../memory.js';
import {
  type SharedTails,
  type EncodeOpts,
  isRecursiveArray,
  emitMemCopy,
  emitCeil32,
  FRAME_SLOTS,
  FRAME_ARRPTR,
  FRAME_LEN,
  FRAME_D,
  FRAME_I,
  FRAME_ELEM,
  FRAME_BASE,
  internal,
  tupleComponents,
} from './shared.js';

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
 * heads start). Read from memory, never kept on the stack, so nothing has to stay live across an
 * `emitMemCopy` (whose `[dst, src, len]` height contract forbids spectators on the stack): the
 * top level reads `MLOAD(0x40) (+dynOff)`; a tuple element of an array, and a dynamic tuple
 * nested deeper than {@link FRAMELESS_TUPLE_LEVELS} levels below the top level or an element,
 * reads the base it saved in its encode frame (one load at any depth); the levels in between
 * add the offset their parent head already stored (`subBase = parentBase + MLOAD(parentBase+ho)`).
 */
export type PushBase = () => void;

/** @internal Shared with `codegen/call/`. Cumulative ABI head offset (bytes) of component `i`
 *  within `components` (static members — inner tuples, fixed-size arrays — inline their whole
 *  static size; every dynamic member is one offset word). */
export function headOffsets(components: readonly NamedType[]): number[] {
  const offs: number[] = [];
  let cursor = 0;
  for (const c of components) {
    offs.push(cursor);
    const layout = layoutOfType(abiParamToType(c));
    cursor += isDynamic(layout) ? 32 : staticSize(layout);
  }
  return offs;
}

/** @internal Shared with `codegen/call/`. Head offset `i` of a {@link headOffsets} result; a
 *  missing entry (an index past the component list) is an internal error, never a guess. */
export function headOffsetAt(offs: readonly number[], i: number): number {
  const ho = offs[i];
  if (ho === undefined) throw internal(`no head offset for component #${i} of ${offs.length}`);
  return ho;
}

/**
 * Encodes one ABI tuple block (head/tail) from a flat-pointer SRC tree into the DST buffer.
 * Heads land at `pushBase() + headOffsets(components)[i]`; the running tail high-water mark
 * lives in scratch `TAIL_CURSOR` and is shared across the whole encode (the output is laid out
 * front-to-back, so a single monotone cursor suffices for arbitrary nesting — a dynamic member's
 * head offset is `cursor − base` at the moment it is reached, then the member's tail is appended
 * and the cursor advanced). Net stack 0; every `emitMemCopy` runs at exactly `[dst, src, len]`.
 *
 * This is the entry for a TOP-LEVEL block (a return record, a call's args, an `s.encode`
 * payload), whose `pushSrc` / `pushBase` are cheap root reads; see {@link encodeBlock} for the
 * blocks nested inside it.
 */
export function emitEncodeBlock(
  w: AsmWriter,
  components: readonly NamedType[],
  pushSrc: PushWord,
  pushBase: PushBase,
  tails: SharedTails,
  opts: EncodeOpts,
): void {
  encodeBlock(w, components, pushSrc, pushBase, tails, opts, 0);
}

/**
 * {@link emitEncodeBlock} at any depth. `tupleDepth` counts the dynamic tuple levels between this
 * block and its root — the top-level block or an array element, whose base and source pointer
 * are one read each. The first {@link FRAMELESS_TUPLE_LEVELS} dynamic tuple levels re-derive
 * their base from their parent's (`emitSubTupleBase`: the offset word the parent head already
 * holds) and read their members through the parent's source; every deeper level saves its base
 * (and, when read more than once, its source pointer) in an encode frame of its own, so reading
 * them is one load however deep the nesting goes instead of a walk back up the chain on every
 * access (quadratic in the depth).
 */
function encodeBlock(
  w: AsmWriter,
  components: readonly NamedType[],
  pushSrc: PushWord,
  pushBase: PushBase,
  tails: SharedTails,
  opts: EncodeOpts,
  tupleDepth: number,
): void {
  const offs = headOffsets(components);
  components.forEach((comp, i) => {
    const ho = headOffsetAt(offs, i);
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
      encodeBlock(
        w,
        comp.components ?? [],
        (j) => emitTupleMemberWord(w, () => pushSrc(i), j),
        () => emitOffsetBase(w, pushBase, ho),
        tails,
        opts,
        tupleDepth,
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
    pushBase(); // [base]
    w.op('DUP1'); // [base, base]
    w.push(TAIL_CURSOR);
    w.op('MLOAD'); // [cursor, base, base]
    w.op('SUB'); // [rel, base]
    w.op('SWAP1'); // [base, rel]
    if (ho !== 0) {
      w.push(ho);
      w.op('ADD');
    } // [head, rel]
    w.op('MSTORE', { note: `head ${comp.name || `#${i}`}` }); // []

    if (layout.kind === 'tuple') {
      // dynamic inner tuple: reserve its head region at the cursor (subBase = the cursor here),
      // then recurse — its own tails extend the same cursor.
      const subComponents = comp.components ?? [];
      if (tupleDepth < FRAMELESS_TUPLE_LEVELS) {
        // near the root: subBase re-derives as parentBase + (the offset just stored at
        // parentBase+ho), and the source pointer is one more load off the parent's.
        emitAdvanceCursor(w, headBytes(subComponents));
        encodeBlock(
          w,
          subComponents,
          (j) => emitTupleMemberWord(w, () => pushSrc(i), j),
          () => emitSubTupleBase(w, pushBase, ho),
          tails,
          opts,
          tupleDepth + 1,
        );
        return;
      }
      // deeper: save subBase (and the source pointer) in this level's own frame.
      const f = opts.frameDepth ?? 0;
      w.push(TAIL_CURSOR);
      w.op('MLOAD'); // [subBase]
      emitFrameStore(w, f, FRAME_BASE); // []
      emitAdvanceCursor(w, headBytes(subComponents));
      const reads = pointerReads(layout, tupleDepth + 1);
      const pushTuplePtr = emitCachePointer(w, f, reads, () => pushSrc(i));
      encodeBlock(
        w,
        subComponents,
        (j) => emitTupleMemberWord(w, pushTuplePtr, j),
        () => pushFrameLoad(w, f, FRAME_BASE),
        tails,
        { ...opts, frameDepth: f + 1 },
        tupleDepth + 1,
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

/** SRC word of member `j` of the (flat-pointer) tuple whose pointer `pushTuplePtr` pushes. */
function emitTupleMemberWord(w: AsmWriter, pushTuplePtr: () => void, j: number): void {
  pushTuplePtr(); // [tuplePtr]
  if (j !== 0) {
    w.push(32 * j);
    w.op('ADD');
  }
  w.op('MLOAD'); // [member word / pointer]
}

/** Reserves `size` bytes at the tail cursor: `cursor += size`. Net stack 0. */
function emitAdvanceCursor(w: AsmWriter, size: number): void {
  w.push(TAIL_CURSOR);
  w.op('MLOAD');
  w.push(size);
  w.op('ADD'); // [cursor + size]
  w.push(TAIL_CURSOR);
  w.op('MSTORE'); // []
}

/** DST base of a static inner tuple: `parentBase + ho` (it inlines into the parent head). */
export function emitOffsetBase(w: AsmWriter, pushBase: PushBase, ho: number): void {
  pushBase();
  if (ho !== 0) {
    w.push(ho);
    w.op('ADD');
  }
}

/** Base of a dynamic inner tuple: `parentBase + MLOAD(parentBase + ho)` (the offset word in the
 *  parent head points at the sub-block) — the DST base on the encode path, and a {@link PushBase}
 *  thunk for nested decodes. */
export function emitSubTupleBase(w: AsmWriter, pushBase: PushBase, ho: number): void {
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
 * @internal Shared with `codegen/call/calldata.ts` (calldata templates). Appends a leaf dynamic member's
 * tail (`[len][payload]`) at the scratch cursor and advances it.
 * `pushPtr` pushes the member's memref pointer (`[len][payload…]`). `isArray` distinguishes
 * `32·len` (word-array) from `len` (bytes/string, zero-padded). The cursor stays in scratch so
 * `emitMemCopy` runs at exactly `[dst, src, len]`.
 */
export function emitLeafDynTail(
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
    emitCeil32(w); // [ceil32(n)]
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
 * @internal The number of encode frames concurrently live while ENCODING a value of `l` as a
 * member of a top-level block (a return record, a call's args, an `s.encode` payload). A leaf
 * (`word`/`bytes`/`string`/a dynamic word-element array — all emitted via the inline head write
 * or {@link emitLeafDynTail}) needs none; a recursive-codec array ({@link emitEncodeArrayTail} /
 * {@link emitEncodeArrayInline} — composite element or fixed-size) needs one frame for its own
 * loop plus whatever encoding ONE element concurrently needs; a tuple needs the max its members
 * need, plus one frame of its own for a dynamic tuple nested deep enough to keep its base in one
 * (see {@link encodeBlock}). The callers reserve the max over their components (which
 * encode sequentially into the same frame region). Mirrors the dispatch in {@link encodeBlock} /
 * {@link emitEncodeArrayLoop} branch-for-branch so the reserved region is always large enough
 * and never overlaps the output buffer.
 */
export function encodeFramesOf(l: TypeLayout): number {
  return framesOf(l, 0);
}

/**
 * How many dynamic tuple levels below a root (the top-level block or an array element) re-derive
 * their base instead of saving it in an encode frame (see {@link encodeBlock}). Up to two levels
 * the re-derivation costs less than reserving a frame; past that, the walk back to the root on
 * every member access costs more.
 */
const FRAMELESS_TUPLE_LEVELS = 2;

/** {@link encodeFramesOf} for `l` encoded in a block `tupleDepth` dynamic tuple levels below its
 *  root (see {@link encodeBlock}). */
function framesOf(l: TypeLayout, tupleDepth: number): number {
  if (l.kind === 'word' || l.kind === 'bytes') return 0;
  if (l.kind === 'array') {
    // a dynamic word-element array is a leaf (emitLeafDynTail), never an array loop.
    if (!isRecursiveArray(l)) return 0;
    // one own frame + the frames ONE element concurrently needs. A tuple element is a root: its
    // pointer and base sit in the array's own frame, so only its members count.
    return 1 + (l.elem.kind === 'tuple' ? componentFramesOf(l.elem, 0) : framesOf(l.elem, 0));
  }
  if (!l.dynamic) return componentFramesOf(l, tupleDepth); // inlines into the parent block
  const own = tupleDepth < FRAMELESS_TUPLE_LEVELS ? 0 : 1;
  return own + componentFramesOf(l, tupleDepth + 1);
}

/** The frames a tuple's members need (they encode one after the other, so the max). */
function componentFramesOf(l: Extract<TypeLayout, { kind: 'tuple' }>, tupleDepth: number): number {
  return l.components.reduce((n, c) => Math.max(n, framesOf(c, tupleDepth)), 0);
}

/**
 * Reserves `frames` encode frames immediately BELOW the upcoming output/calldata buffer by
 * bumping the free pointer by `32·FRAME_SLOTS·frames`. The CALLER must read the buffer base as
 * `MLOAD(0x40)` AFTER this so the buffer sits just above frame 0 and {@link pushFrameSlot} (which
 * addresses each frame relative to `MLOAD(0x40)`) resolves correctly. The free pointer must not
 * be bumped again between this reservation and the encode (tails are written at the cursor,
 * never via the free pointer). No-op when `frames === 0`. Net stack 0.
 */
export function reserveEncodeFrames(w: AsmWriter, frames: number, note?: string): void {
  if (frames <= 0) return;
  w.push(FREE_PTR);
  w.op('MLOAD'); // [old]
  w.push(32 * FRAME_SLOTS * frames);
  w.op('ADD'); // [old + framesBytes]
  w.push(FREE_PTR);
  w.op('MSTORE', { note: note ?? `reserve ${frames} encode frame(s)` }); // []
}

/**
 * Pushes the absolute memory address of word `k` of encode frame `frameDepth`. The frames live
 * in a region reserved BELOW the output buffer at encode entry (the free pointer is bumped by
 * `32·FRAME_SLOTS·FRAMES` before `out = MLOAD(0x40)` is read, so `out` — which never moves during
 * the in-place encode — sits just above frame 0). Frame `f` occupies
 * `[out − 32·FRAME_SLOTS·(f+1), out − 32·FRAME_SLOTS·f)`; word `k` is `frameBase + 32·k`. Reading
 * the address off `MLOAD(0x40)` makes every frame access stack-depth-independent (the decode
 * `ELEM_BASE` lesson), so loop state never has to ride the stack across an `emitMemCopy`.
 */
function pushFrameSlot(w: AsmWriter, frameDepth: number, k: number): void {
  const off = 32 * FRAME_SLOTS * (frameDepth + 1) - 32 * k;
  w.push(off); // [off]
  w.push(FREE_PTR);
  w.op('MLOAD'); // [out, off]
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
 * All loop state (`arrPtr, D, len, i`, plus the per-element `elem` / `base` caches) lives in a
 * reserved memory frame (`opts.frameDepth`), so the operand stack stays at the template baseline
 * throughout — every `emitMemCopy` runs at exactly `[dst, src, len]` (the pre-cancun `@memcpy`
 * height contract), even when this array nests inside a tuple member at arbitrary tuple-encode
 * depth, and however deep arrays nest in each other.
 */
function emitEncodeArrayTail(
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
  if (layout.length === null) w.op('DUP1'); // [arrPtr, arrPtr]   the length word is read next
  emitFrameStore(w, f, FRAME_ARRPTR); // [] | [arrPtr]

  // -- frame.len := len; dynamic: MSTORE(cursor, len), D = cursor + 32; fixed: D = cursor ------
  if (layout.length === null) {
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
function emitEncodeArrayInline(
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

/**
 * The shared element loop of {@link emitEncodeArrayTail} / {@link emitEncodeArrayInline}: frame
 * `arrPtr`/`D`/`len` are set; iterates `i` over the frame, encoding each element (dynamic →
 * offset word + tail at the cursor; static → inline at `D + i·staticSize`). The element word
 * `MLOAD(arrPtr + 32 + 32·i)` is loaded once per iteration into the frame's `elem` word whenever
 * the element's encode reads it more than once (see {@link pointerReads}). Net stack 0.
 */
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
  // exit once i ≥ len
  pushFrameLoad(w, f, FRAME_I); // [i]
  pushFrameLoad(w, f, FRAME_LEN); // [len, i]
  w.op('GT'); // [len > i]
  w.op('ISZERO'); // [i ≥ len]
  w.pushLabel(done);
  w.op('JUMPI'); // []

  const pushElem = emitCachePointer(w, f, pointerReads(elemLayout, 0), () => {
    pushElemSlot(w, f);
    w.op('MLOAD'); // [elemᵢ]
  });

  if (elemDynamic) {
    // MSTORE(D + 32·i, cursor − D)  (offset relative to D)
    pushFrameLoad(w, f, FRAME_D); // [D]
    w.push(TAIL_CURSOR);
    w.op('MLOAD'); // [cursor, D]
    w.op('SUB'); // [cursor−D]
    pushFrameLoad(w, f, FRAME_I);
    w.push(5);
    w.op('SHL'); // [32·i, rel]
    pushFrameLoad(w, f, FRAME_D); // [D, 32·i, rel]
    w.op('ADD'); // [D+32·i, rel]
    w.op('MSTORE'); // []

    // append element i's tail at the cursor
    emitEncodeArrayElementTail(w, elemLayout, f, pushElem, tails, opts);
  } else {
    // static element: write inline at base = D + i·staticSize
    emitEncodeArrayElementStatic(w, elemLayout, f, pushElem, tails, opts);
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

/** Pushes the address of element `i`'s slot in the source array, `arrPtr + 32 + 32·i` (it holds
 *  the element's inline word or memref pointer). Reads `arrPtr` and `i` from the loop frame, so
 *  it is stack-depth-independent. */
function pushElemSlot(w: AsmWriter, frameDepth: number): void {
  pushFrameLoad(w, frameDepth, FRAME_I);
  w.push(5);
  w.op('SHL'); // [32·i]
  pushFrameLoad(w, frameDepth, FRAME_ARRPTR);
  w.push(32);
  w.op('ADD'); // [arrPtr+32, 32·i]
  w.op('ADD'); // [arrPtr+32+32·i]   (address of slot pᵢ)
}

/**
 * How many times encoding `l` as a member of a block `tupleDepth` dynamic tuple levels below its
 * root evaluates that block's source thunk for it — counted up to 2, which stands for "more than
 * once". A word is read once, a recursive array once (into its own frame's `arrPtr`), a leaf
 * dynamic value several times ({@link emitLeafDynTail} reads its pointer for the length, the
 * payload copy and the cursor advance), a tuple once per read of its own members — except a
 * dynamic tuple deep enough to own a frame, which reads it once (see {@link encodeBlock}).
 */
function srcReads(l: TypeLayout, tupleDepth: number): number {
  if (l.kind === 'word') return 1;
  if (l.kind === 'bytes') return 2;
  if (l.kind === 'array') return isRecursiveArray(l) ? 1 : 2;
  if (!l.dynamic) return pointerReads(l, tupleDepth);
  return tupleDepth < FRAMELESS_TUPLE_LEVELS ? pointerReads(l, tupleDepth + 1) : 1;
}

/** How many times (up to 2) encoding the value `l` reads its own pointer: once per member read
 *  for a tuple whose members encode `tupleDepth` levels below their root, else
 *  {@link srcReads}. */
function pointerReads(l: TypeLayout, tupleDepth: number): number {
  if (l.kind !== 'tuple') return srcReads(l, tupleDepth);
  return Math.min(
    2,
    l.components.reduce((n, c) => n + srcReads(c, tupleDepth), 0),
  );
}

/**
 * Returns a thunk pushing the pointer (or word) `pushPtr` pushes, read `reads` times (see
 * {@link pointerReads}) by an encode at frame `f`. When that is more than once, it is evaluated
 * here, once, into the frame's `elem` word and the thunk is a single frame load; otherwise the
 * thunk is `pushPtr` itself (a store plus a load would cost more than the one read). Net stack 0.
 */
function emitCachePointer(w: AsmWriter, f: number, reads: number, pushPtr: () => void): () => void {
  if (reads < 2) return pushPtr;
  pushPtr(); // [ptr]
  emitFrameStore(w, f, FRAME_ELEM); // []
  return () => pushFrameLoad(w, f, FRAME_ELEM);
}

/** Encodes one STATIC element `i` inline at `base = D + i·staticSize` (no tail, no memcpy). A word
 *  element is `MSTORE`d directly; a static tuple element inlines its all-word head via
 *  {@link encodeBlock}, with `base` cached in the frame when its members read it more than once.
 *  `pushElem` pushes the element word / pointer. Every base and source is read from the frame
 *  (stack-depth-independent). */
function emitEncodeArrayElementStatic(
  w: AsmWriter,
  elemLayout: TypeLayout,
  frameDepth: number,
  pushElem: () => void,
  tails: SharedTails,
  opts: EncodeOpts,
): void {
  // base = D + i·staticSize
  const emitElemBase = (): void => {
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
    // MSTORE(base, elemᵢ) where elemᵢ is the inline word in slot pᵢ
    pushElem(); // [elemᵢ]
    emitElemBase(); // [base, elemᵢ]
    w.op('MSTORE'); // []
    return;
  }
  if (elemLayout.kind === 'array') {
    // static fixed-size array element (`uint256[2]` inside `uint256[2][]`): inline its N elements
    // at base, reading the element's own block through the pointer in slot pᵢ (next frame).
    emitEncodeArrayInline(w, elemLayout, pushElem, emitElemBase, tails, {
      ...opts,
      frameDepth: frameDepth + 1,
    });
    return;
  }
  if (elemLayout.kind !== 'tuple') {
    throw internal(`static array element of unexpected kind '${elemLayout.kind}'`);
  }
  // static tuple element: member words come from MLOAD(elemPtrᵢ + 32·j). encodeBlock writes the
  // inline head at base (no tail since the tuple is static), at frameDepth + 1 (an inner static
  // fixed-array member takes the next frame). The head writes read base once per member read.
  let pushBase: PushBase = emitElemBase;
  if (pointerReads(elemLayout, 0) > 1) {
    emitElemBase(); // [base]
    emitFrameStore(w, frameDepth, FRAME_BASE); // []
    pushBase = () => pushFrameLoad(w, frameDepth, FRAME_BASE);
  }
  encodeBlock(
    w,
    tupleComponents(elemLayout),
    (j) => emitTupleMemberWord(w, pushElem, j),
    pushBase,
    tails,
    { ...opts, frameDepth: frameDepth + 1 },
    0,
  );
}

/** Appends one DYNAMIC element `i`'s tail at the cursor: a dynamic tuple → reserve `headBytes`
 *  (its base, the cursor here, cached in the frame) then {@link encodeBlock}; a `string`/`bytes`
 *  or word-element inner array → `emitLeafDynTail`; a composite inner array → recurse
 *  `emitEncodeArrayTail` (next frame). `pushElem` pushes the element's memref pointer. */
function emitEncodeArrayElementTail(
  w: AsmWriter,
  elemLayout: TypeLayout,
  frameDepth: number,
  pushElem: () => void,
  tails: SharedTails,
  opts: EncodeOpts,
): void {
  // bytes/string element: leaf dynamic tail at the cursor.
  if (elemLayout.kind === 'bytes') {
    emitLeafDynTail(w, pushElem, false, tails, opts);
    return;
  }

  if (elemLayout.kind === 'array') {
    // dynamic word-element inner array (`uint256[]` inside `uint256[][]`) → leaf word-array tail.
    if (!isRecursiveArray(elemLayout)) {
      emitLeafDynTail(w, pushElem, true, tails, opts);
      return;
    }
    // any other inner array (composite element, or a dynamic fixed-size array) → recurse with the
    // NEXT frame (concurrent with this loop's frame).
    emitEncodeArrayTail(w, elemLayout, pushElem, tails, { ...opts, frameDepth: frameDepth + 1 });
    return;
  }

  if (elemLayout.kind !== 'tuple') {
    throw internal(`dynamic array element of unexpected kind '${elemLayout.kind}'`);
  }
  // dynamic tuple element: its base is the cursor here — save it in the frame, reserve its head
  // region (cursor += headBytes), then encode its head/tail at frameDepth + 1.
  const components = tupleComponents(elemLayout);
  w.push(TAIL_CURSOR);
  w.op('MLOAD'); // [base]
  emitFrameStore(w, frameDepth, FRAME_BASE); // []
  emitAdvanceCursor(w, headBytes(components));
  encodeBlock(
    w,
    components,
    (j) => emitTupleMemberWord(w, pushElem, j),
    () => pushFrameLoad(w, frameDepth, FRAME_BASE),
    tails,
    { ...opts, frameDepth: frameDepth + 1 },
    0,
  );
}
