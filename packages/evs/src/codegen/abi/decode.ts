/**
 * `codegen/abi/decode.ts` — the recursive ABI decoder (memory head/tail → flat-pointer block):
 * tuples, and the array codec's two lowerings, the stack fast path and the heap-frame path. The
 * paths recurse into each other through `emitDecodeElement`, so they stay in one module.
 */

import { layoutOfType, isDynamic, type TypeLayout, staticSize } from '../../abi/layout.js';
import type { AsmWriter } from '../../asm/assembler.js';
import { MAX_TEMPLATE_DEPTH } from '../../asm/verify.js';
import { type NamedType, abiParamToType } from '../../core/types.js';
import { FREE_PTR, MAX_U64 } from '../memory.js';
import { type PushBase, headOffsets, emitOffsetBase, emitSubTupleBase } from './encode.js';
import {
  emitNormalizeWord,
  isRecursiveArray,
  wordElemAbi,
  wordNeedsNormalize,
  emitNormalizeElemsLoop,
  isStackDecodedArray,
  ELEM_BASE,
  DFRAME_SLOTS,
  DFRAME_ARR,
  DFRAME_LEN,
  DECODE_FRAME,
  DFRAME_PARENT,
  DFRAME_D,
  DFRAME_I,
  DFRAME_ELEM_BASE,
  tupleComponents,
} from './shared.js';

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
 * `decodeDynamic`/`decodeStatic` array arms byte-for-byte.
 *
 * Two lowerings, selected statically per array level (#52): the STACK fast path
 * ({@link emitDecodeArrayToMemStack}) for the one- and two-level shapes
 * ({@link isStackDecodedArray}), and the HEAP-FRAME path ({@link emitDecodeArrayToMemHeap}) for
 * everything deeper and every fixed-size array. The fast path keeps five loop words per level on
 * the operand stack, so it is emitted speculatively: when the fragment would exceed the 16-item
 * template budget at this depth (a fast-path shape nested inside deep tuples or heap levels), it
 * is rolled back and the heap-frame path is emitted instead. Every shape that decoded before #4
 * fit the budget where it was used, so its bytes are unchanged.
 */
export function emitDecodeArrayToMem(
  w: AsmWriter,
  layout: Extract<TypeLayout, { kind: 'array' }>,
  pushBase: PushBase,
  pushEnd: () => void,
  fail: DecodeFail,
  belowFlat: number,
): void {
  if (isStackDecodedArray(layout)) {
    // speculative: emit the fast path, keep it only if it fits the template budget at this
    // depth (a fast-path shape nested deep inside tuples / heap levels may not)
    const cp = w.checkpoint();
    emitDecodeArrayToMemStack(w, layout.elem, pushBase, pushEnd, fail, belowFlat);
    if (w.peakHeightSince(cp, belowFlat) <= MAX_TEMPLATE_DEPTH) return;
    w.rollback(cp);
  }
  emitDecodeArrayToMemHeap(w, layout, pushBase, pushEnd, fail, belowFlat);
}

/**
 * The stack fast path of {@link emitDecodeArrayToMem} for a DYNAMIC array `E[]`:
 *
 * - read `len` at `base`, bound `len ≤ 2^64−1`; bump-alloc `32 + 32·len`; `D = base + 32`.
 * - static element `E` (a STATIC tuple, or a word — `string[]`/`bytes[]` are dynamic): the body is
 *   contiguous, bound `D + len·staticSize ≤ end` up front, then each element decodes at
 *   `D + i·staticSize`. A static tuple element decodes to a fresh flat block (its pointer stored
 *   into `arr + 32 + 32·i`); a word element is normalized inline and stored as the slot value.
 * - dynamic element (dynamic tuple, inner `T[]`, `string`/`bytes`): the offset-word region
 *   (`len` words at `[D, D+32·len)`) must fit first; then each `offᵢ` at `D+32·i` (relative to `D`,
 *   bound `offᵢ ≤ 2^64−1`), `elemPtr = D + offᵢ` (bound `elemPtr + 32 ≤ end`), recurse the matching
 *   decoder, store the returned block pointer into `arr + 32 + 32·i`.
 *
 * No `emitMemCopy` (the array aliases leaf bytes and freshly allocates tuple/array blocks), so the
 * loop state rides on the stack: `[i, D, arr, len, saved, …below]` (`saved` = the caller's
 * `ELEM_BASE` scratch value, restored on exit); the loop labels are checked at absolute height
 * `belowFlat + 5`, mirroring {@link emitNormalizeElemsLoop}'s convention. Five live words per
 * level is why only the one- and two-level shapes take this path (see {@link isStackDecodedArray}).
 */
function emitDecodeArrayToMemStack(
  w: AsmWriter,
  elemLayout: TypeLayout,
  pushBase: PushBase,
  pushEnd: () => void,
  fail: DecodeFail,
  belowFlat: number,
): void {
  const elemDynamic = isDynamic(elemLayout);
  // D = base + 32, re-derivable from `pushBase()` so nothing has to ride the stack.
  const pushD = (): void => {
    pushBase();
    w.push(32);
    w.op('ADD');
  };

  // -- len at base; len ≤ 2^64−1 ------------------------------------------------------------
  pushBase();
  w.op('MLOAD'); // [len, …below]
  w.op('DUP1');
  w.push(MAX_U64);
  w.op('LT'); // [len > max, len, …]
  fail(belowFlat + 1); // [len, …]

  // -- allocate the pointer block [len][p0…]: 32 + 32·len bytes, bump FREE_PTR --------------
  w.push(FREE_PTR);
  w.op('MLOAD'); // [arr, len, …]
  w.op('DUP2'); // [len, arr, len, …]
  w.push(5);
  w.op('SHL'); // [32·len, arr, len, …]
  w.push(32);
  w.op('ADD'); // [size, arr, len, …]
  w.op('DUP2'); // [arr, size, arr, len, …]
  w.op('ADD'); // [arr+size, arr, len, …]
  w.push(FREE_PTR);
  w.op('MSTORE'); // [arr, len, …]      freePtr bumped
  // store len into arr[0]
  w.op('DUP2'); // [len, arr, len, …]
  w.op('DUP2'); // [arr, len, arr, len, …]
  w.op('MSTORE'); // [arr, len, …]

  // -- up-front element-body bounds (mirrors the interp) -----------------------------------
  if (elemDynamic) {
    // offset-word region: D + 32·len ≤ end  ⇔  ¬(end < D + 32·len)
    pushD(); // [D, arr, len, …]
    w.op('DUP3'); // [len, D, arr, len, …]
    w.push(5);
    w.op('SHL'); // [32·len, D, arr, len, …]
    w.op('ADD'); // [D+32·len, arr, len, …]
    pushEnd();
    w.op('LT'); // [end < D+32·len, arr, len, …]
    fail(belowFlat + 2); // [arr, len, …]
  } else {
    // static body: D + len·staticSize ≤ end  ⇔  ¬(end < D + len·ss)
    const ss = staticSize(elemLayout);
    pushD(); // [D, arr, len, …]
    w.op('DUP3'); // [len, D, arr, len, …]
    if (ss !== 1) {
      w.push(ss);
      w.op('MUL'); // [len·ss, D, arr, len, …]
    }
    w.op('ADD'); // [D+len·ss, arr, len, …]
    pushEnd();
    w.op('LT'); // [end < D+len·ss, arr, len, …]
    fail(belowFlat + 2); // [arr, len, …]
  }

  // -- element loop: state [i, D, arr, len, saved, …below] --------------------------------
  //  i counts up; D is the array data start (captured on the stack so the loop never re-invokes
  //  `pushBase` — which may itself read `ELEM_BASE`); arr is the destination pointer block; len is
  //  the bound; `saved` is the caller's prior `ELEM_BASE` scratch value, restored after the loop
  //  (so a nested array decode cannot clobber a parent's base). Each iteration computes the element
  //  source base from `D` + `i`, writes it to `ELEM_BASE`, then recurses the element decoder (which
  //  re-derives its base via `MLOAD(ELEM_BASE)`). Loop labels at height `belowFlat + 5`.
  // currently [arr, len, …below]; build [i, D, arr, len, saved, …below].
  w.push(ELEM_BASE);
  w.op('MLOAD'); // [saved, arr, len, …]
  w.op('SWAP2'); // [len, arr, saved, …]
  w.op('SWAP1'); // [arr, len, saved, …]
  pushD(); // [D, arr, len, saved, …]   (last pushBase call — ELEM_BASE still = parent base)
  w.push(0); // [i=0, D, arr, len, saved, …]

  const height = belowFlat + 5;
  const head = w.newLabel('arrdec');
  const done = w.newLabel('arrdec_done');
  w.label(head, height);
  // continue while i < len
  w.op('DUP4'); // [len, i, D, arr, len, saved, …]
  w.op('DUP2'); // [i, len, i, D, arr, len, saved, …]
  w.op('LT'); // [i < len, i, D, arr, len, saved, …]
  w.op('ISZERO');
  w.pushLabel(done);
  w.op('JUMPI'); // [i, D, arr, len, saved, …]

  // element source base from D and i:
  if (elemDynamic) {
    // offᵢ at D + 32·i (relative to D); offᵢ ≤ 2^64−1; elemPtr = D + offᵢ; elemPtr+32 ≤ end
    w.op('DUP1'); // [i, i, D, arr, len, saved, …]
    w.push(5);
    w.op('SHL'); // [32·i, i, D, arr, len, saved, …]
    w.op('DUP3'); // [D, 32·i, i, D, arr, len, saved, …]
    w.op('ADD'); // [D+32·i, i, D, arr, len, saved, …]
    w.op('MLOAD'); // [off, i, D, arr, len, saved, …]
    w.op('DUP1');
    w.push(MAX_U64);
    w.op('LT'); // [off > max, off, i, D, arr, len, saved, …]
    fail(belowFlat + 6); // [off, i, D, arr, len, saved, …]
    w.op('DUP3'); // [D, off, i, D, arr, len, saved, …]
    w.op('ADD'); // [elemPtr, i, D, arr, len, saved, …]
    w.op('DUP1');
    w.push(32);
    w.op('ADD'); // [elemPtr+32, elemPtr, i, D, arr, len, saved, …]
    pushEnd();
    w.op('LT'); // [end < elemPtr+32, elemPtr, i, D, arr, len, saved, …]
    fail(belowFlat + 6); // [elemPtr, i, D, arr, len, saved, …]
  } else {
    // static element source base = D + i·staticSize
    const ss = staticSize(elemLayout);
    w.op('DUP1'); // [i, i, D, arr, len, saved, …]
    if (ss !== 1) {
      w.push(ss);
      w.op('MUL'); // [i·ss, i, D, arr, len, saved, …]
    }
    w.op('DUP3'); // [D, i·ss, i, D, arr, len, saved, …]
    w.op('ADD'); // [elemBase, i, D, arr, len, saved, …]
  }

  // ELEM_BASE := elemBase; decode the element (recursive decoders read it back).
  w.push(ELEM_BASE);
  w.op('MSTORE'); // [i, D, arr, len, saved, …]
  const pushElemBase: PushBase = () => {
    w.push(ELEM_BASE);
    w.op('MLOAD');
  };
  emitDecodeElement(w, elemLayout, pushElemBase, pushEnd, fail, belowFlat + 5); // [elemVal, i, D, arr, len, saved, …]

  // store elemVal into arr + 32 + 32·i: stack [elemVal, i, D, arr, len, saved, …]
  w.op('DUP2'); // [i, elemVal, i, D, arr, len, saved, …]
  w.push(5);
  w.op('SHL'); // [32·i, elemVal, i, D, arr, len, saved, …]
  w.op('DUP5'); // [arr, 32·i, elemVal, i, D, arr, len, saved, …]
  w.op('ADD');
  w.push(32);
  w.op('ADD'); // [slotAddr, elemVal, i, D, arr, len, saved, …]
  w.op('MSTORE'); // [i, D, arr, len, saved, …]

  // i += 1
  w.push(1);
  w.op('ADD'); // [i+1, D, arr, len, saved, …]
  w.pushLabel(head);
  w.op('JUMP');
  w.label(done, height); // [i, D, arr, len, saved, …]
  w.op('POP'); // [D, arr, len, saved, …]
  w.op('POP'); // [arr, len, saved, …]
  w.op('SWAP2'); // [saved, len, arr, …]
  w.push(ELEM_BASE);
  w.op('MSTORE'); // [len, arr, …]   ELEM_BASE restored
  w.op('POP'); // [arr, …below]    net +1
}

/**
 * The heap-frame path of {@link emitDecodeArrayToMem}, for every array the stack fast path does
 * not take (fixed-size `E[N]` of any element, and nesting deeper than two levels — `uint256[][][]`,
 * `string[][]`, `tuple[][]`, `uint256[2][]`, …):
 *
 * - dynamic: read `len` at `base`, bound `len ≤ 2^64−1`, `D = base + 32`; fixed: `len = N`,
 *   `D = base`. Bump-alloc `32 + 32·len` for the pointer block.
 * - static element `E` (a word, a static tuple, or a static fixed array): the body is contiguous,
 *   bound `D + len·staticSize ≤ end` up front, then each element decodes at `D + i·staticSize`. A
 *   composite element decodes to a fresh block (its pointer stored into `arr + 32 + 32·i`); a word
 *   element is normalized inline and stored as the slot value.
 * - dynamic element (dynamic tuple, inner array, `string`/`bytes`, dynamic `T[N]`): the offset-word
 *   region (`len` words at `[D, D+32·len)`) must fit first; then each `offᵢ` at `D+32·i` (relative
 *   to `D`, bound `offᵢ ≤ 2^64−1`), `elemPtr = D + offᵢ` (bound `elemPtr + 32 ≤ end`), recurse the
 *   matching decoder, store the returned block pointer into `arr + 32 + 32·i`.
 *
 * The loop state (`elemBase, i, D, arr, len, parent`) lives in a heap-allocated DECODE FRAME
 * (allocated right after the pointer block; the current frame pointer sits in scratch
 * `DECODE_FRAME`, frames chain through `parent`), so the operand stack holds only `[arr]` above
 * `belowFlat` throughout — one live word per level instead of the fast path's five. No
 * `emitMemCopy` (the array aliases leaf bytes and freshly allocates tuple/array blocks). Loop
 * labels are checked at absolute height `belowFlat + 1`.
 */
function emitDecodeArrayToMemHeap(
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
  // nested decode's base thunk reads the PARENT's element base through the scratch slot.
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
  const head = w.newLabel('arrdec_heap');
  const done = w.newLabel('arrdec_heap_done');
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
  emitDecodeElement(
    w,
    elemLayout,
    () => pushDFrameLoad(w, DFRAME_ELEM_BASE),
    pushEnd,
    fail,
    belowFlat + 1,
  ); // [elemVal, arr, …]

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

  // -- restore the parent's scratch value ---------------------------------------------------
  pushDFrameLoad(w, DFRAME_PARENT); // [parent, arr, …]
  w.push(DECODE_FRAME);
  w.op('MSTORE'); // [arr, …below]    net +1
}

/** Pushes word `k` of the CURRENT heap decode frame (`MLOAD(MLOAD(DECODE_FRAME) + 32·k)`). */
function pushDFrameLoad(w: AsmWriter, k: number): void {
  w.push(DECODE_FRAME);
  w.op('MLOAD'); // [frame]
  if (k !== 0) {
    w.push(32 * k);
    w.op('ADD');
  }
  w.op('MLOAD');
}

/** Stores the top-of-stack value into word `k` of the CURRENT heap decode frame (consumes it). */
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
 * Decodes one array element whose source block starts at `pushBase()` (the owning array loop
 * wrote it to scratch — the element base itself on the stack path, word 0 of the current heap
 * frame on the heap-frame path), pushing the decoded element value (a normalized word for a word
 * element, otherwise a fresh block pointer / aliased bytes pointer). Net stack +1. The caller
 * already validated the per-element bounds (dynamic) / body bounds (static). `belowElem` is the
 * number of live items on the stack on entry (the array loop state).
 *
 * `pushBase` is stack-depth-independent (so the decoders' internal stack churn never loses the
 * base). A nested array decode saves/restores the scratch slot, so it cannot clobber this base.
 */
function emitDecodeElement(
  w: AsmWriter,
  elemLayout: TypeLayout,
  pushBase: PushBase,
  pushEnd: () => void,
  fail: DecodeFail,
  belowElem: number,
): void {
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
    // nested array element (`T[][]`, `T[N][]`, …): recurse — it saves/restores the scratch slot.
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
