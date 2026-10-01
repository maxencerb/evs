/**
 * `codegen/abi/decode.ts` — the recursive ABI decoder (memory head/tail → flat-pointer block):
 * tuples, and the array codec's two lowerings, the stack fast path and the heap-frame path. The
 * paths recurse into each other through `emitDecodeElement`, so they stay in one module. It also
 * owns the decode-work budget that bounds what overlapping offsets can make them allocate.
 */

import {
  layoutOfType,
  isDynamic,
  type TypeLayout,
  staticSize,
  arrayDecodeCharge,
  tupleDecodeCharge,
  DECODE_BUDGET_SLACK,
  type DecodeCharge,
} from '../../abi/layout.js';
import type { AsmWriter } from '../../asm/assembler.js';
import type { EvmVersion, Mnemonic } from '../../asm/ops.js';
import { MAX_TEMPLATE_DEPTH } from '../../asm/verify.js';
import {
  type EvsType,
  type NamedType,
  type WordType,
  abiParamToType,
  isTupleType,
} from '../../core/types.js';
import { FREE_PTR } from '../memory.js';
import {
  type PushBase,
  headOffsets,
  headOffsetAt,
  emitOffsetBase,
  emitSubTupleBase,
} from './encode.js';
import {
  emitNormalizeWord,
  isRecursiveArray,
  wordElemAbi,
  wordNeedsNormalize,
  emitCopyNormalizeWordArray,
  emitCopyWordsLoop,
  isStackDecodedArray,
  ELEM_BASE,
  DFRAME_SLOTS,
  DFRAME_LEN,
  DECODE_FRAME,
  DFRAME_PARENT,
  DFRAME_D,
  DFRAME_I,
  DFRAME_ELEM_BASE,
  TFRAME_SLOTS,
  TFRAME_BASE,
  TFRAME_PARENT,
  tupleComponents,
  emitAboveU64,
  emitWithinStackBudget,
  internal,
  usesRecursiveCodec,
} from './shared.js';

// ---------------------------------------------------------------------------
// recursive ABI decoder (memory head/tail → flat-pointer block)
// ---------------------------------------------------------------------------

type ArrayLayout = Extract<TypeLayout, { kind: 'array' }>;

/**
 * @internal Shared with `codegen/call/`. A decode failure router: stack on entry `[bad, …live]`
 * → on the continue path `[…live]` (`liveDepth` items). Strict/calldata callers jump straight to
 * a checked stub; try-mode callers invert the branch, clean the stack, and jump to the zero block.
 */
export type DecodeFail = (liveDepth: number) => void;

/**
 * @internal Shared with `codegen/call/`. The source region a list of top-level ABI values is
 * decoded from — the script's arguments in a calldata snapshot, or a call's outputs in a
 * returndata snapshot — as thunks that re-read the snapshot base from scratch, so the decoders'
 * free-pointer churn never moves it.
 */
export interface DecodeRegion {
  /** Pushes the address of the region start: what head offsets and top-level offset words are
   *  relative to (`snap + 4` for the arguments, `snap` for a call's returndata). */
  readonly pushBase: PushBase;
  /** Pushes the address one past the last valid source byte. */
  readonly pushEnd: () => void;
  readonly fail: DecodeFail;
  /** Live operand-stack items beneath the decode (its absolute entry height). */
  readonly live: number;
  /**
   * How a dynamic recursive-codec ARRAY's offset word is bounded (its first word must lie inside
   * the source): `'end'` — `base + off + 32 ≤ end`, as for a dynamic tuple; `'returndata'` — the
   * call path's `off + 32 ≤ RETURNDATASIZE`, the same check for a region that starts at the
   * snapshot base, kept on the stack instead of re-deriving the base. A dynamic tuple is bounded
   * the `'end'` way in both regions.
   */
  readonly arrayOffsetBound: 'end' | 'returndata';
}

/**
 * @internal Shared with `codegen/call/`. Decodes the top-level value of `type` — a tuple or a
 * recursive-codec array (see {@link usesRecursiveCodec}) — whose head sits at `headOffset` in
 * `region`, into a fresh block, and pushes its pointer: `[…live] → [block, …live]`.
 *
 * A static value inlines at `base + headOffset`. A dynamic one's head word is an offset relative
 * to the region base; it is bounded (`off ≤ 2^64−1`, and its first block must lie inside the
 * source — a tuple's whole head, since the tuple decoder ({@link emitDecodeTupleToMem}) reads
 * every head word unchecked (the bound mirrors the interpreter's `decodeBlock` guard); an array's
 * length or first offset word, see {@link DecodeRegion.arrayOffsetBound})
 * before the decoder reads it, then re-derived inside the decoder's base thunk
 * (`base + MLOAD(base + headOffset)`), so nothing rides the stack through the recursion. `opts` is
 * threaded to the decoder unchanged. The decode runs inside {@link emitWithinStackBudget}, `what`
 * naming the value in its error.
 */
export function emitDecodeFromRegion(
  w: AsmWriter,
  type: EvsType,
  headOffset: number,
  region: DecodeRegion,
  opts: DecodeOptions,
  what: () => string,
): void {
  const l = layoutOfType(type);
  if (!usesRecursiveCodec(l)) {
    throw internal(`emitDecodeFromRegion: ${l.abi} does not decode through the recursive codec`);
  }
  const { live, fail } = region;
  let pushBlockBase: PushBase;
  if (isDynamic(l)) {
    region.pushBase();
    if (headOffset !== 0) {
      w.push(headOffset);
      w.op('ADD');
    }
    w.op('MLOAD'); // [off, …live]
    w.op('DUP1');
    emitAboveU64(w); // [off >> 64, off, …live]
    fail(live + 1); // [off, …live]
    if (l.kind === 'array' && region.arrayOffsetBound === 'returndata') {
      w.op('DUP1');
      w.push(minBlockBytes(l));
      w.op('ADD'); // [off+32, off, …live]
      w.op('RETURNDATASIZE');
      w.op('LT'); // [rds < off+32, off, …live]
      fail(live + 1); // [off, …live]
      w.op('POP'); // […live]   (the base is re-derived inside the thunk)
    } else {
      region.pushBase();
      w.op('ADD'); // [blockPtr, …live]
      w.push(minBlockBytes(l));
      w.op('ADD'); // [blockPtr+min, …live]
      region.pushEnd();
      w.op('LT'); // [end < blockPtr+min, …live]
      fail(live); // […live]
    }
    pushBlockBase = () => emitSubTupleBase(w, region.pushBase, headOffset);
  } else {
    pushBlockBase = () => emitOffsetBase(w, region.pushBase, headOffset);
  }
  emitWithinStackBudget(w, live, what, () => {
    if (l.kind === 'array') {
      emitDecodeArrayToMem(w, l, pushBlockBase, region.pushEnd, fail, live, opts);
      return;
    }
    if (l.kind !== 'tuple' || !isTupleType(type)) {
      throw internal(`emitDecodeFromRegion: ${l.abi} is neither a tuple nor an array`);
    }
    emitDecodeTupleToMem(w, type.components, pushBlockBase, region.pushEnd, fail, live, opts);
  }); // [block, …live]
}

// ---------------------------------------------------------------------------
// decode-work budget (see DECODE_BUDGET_SLACK in abi/layout.ts)
// ---------------------------------------------------------------------------
//
// A BUDGETED decode (a call's returndata) keeps the bytes it may still charge in the word at the
// source end, `MLOAD(pushEnd())` — an unaligned word just past the payload, which the caller
// reserves when it bumps the free pointer past the snapshot and initialises with
// {@link emitInitDecodeBudget}. Each charged block (`arrayDecodeCharge` / `tupleDecodeCharge`)
// subtracts its charge BEFORE it is allocated; running out takes the decode-failure path. The one
// allocation that can precede a charge is a sub-tuple's two-word TUPLE FRAME, which is uncharged
// (see {@link emitDecodeTupleToMem}). Script args (the caller's own calldata) decode unbudgeted.

/**
 * How a decoder charges the decode-work budget: `'off'` (unbudgeted: script args, or outputs that
 * can never charge), `'once'` (a call's outputs, outside every ABI-dynamic array) or `'repeated'`
 * (inside an element of an ABI-dynamic array, where overlapping offsets can re-decode a block:
 * dynamic tuples and dynamic `T[N]` are charged too).
 */
export type DecodeBudget = 'off' | 'once' | 'repeated';

/**
 * @internal Named settings the memory decoders thread through every nesting level (named, not
 * positional, so further per-decode settings join without a call binding one to the wrong slot).
 */
export interface DecodeOptions {
  /** How this decode charges the decode-work budget (see {@link DecodeBudget}). */
  readonly budget: DecodeBudget;
  /** The target fork: picks the fixed-word array copy (`MCOPY` on cancun, else a copy loop). */
  readonly evmVersion: EvmVersion;
}

/** The budget mode of an ABI-dynamic array's elements (they sit behind offsets or a length). */
function elemBudget(budget: DecodeBudget, l: ArrayLayout): DecodeBudget {
  return budget === 'off' || !isDynamic(l) ? budget : 'repeated';
}

/**
 * @internal Shared with `codegen/call/`. True when decoding `outputs` can charge the decode-work
 * budget at all — some output holds a block {@link mayChargeDecodeBudget} finds. A call site
 * reserves and initialises the budget word only then, so shapes that never charge (words,
 * strings, structs of those, `uint256[]`, …) keep their bytecode.
 */
export function needsDecodeBudget(outputs: readonly NamedType[]): boolean {
  return outputs.some((p) => mayChargeDecodeBudget(layoutOfType(abiParamToType(p)), true, false));
}

/** Whether decoding a value of layout `l` can charge the budget (`topLevel`: `l` is an output;
 *  `repeated`: inside an ABI-dynamic array's element) — the decoders' charge sites, walked. */
function mayChargeDecodeBudget(l: TypeLayout, topLevel: boolean, repeated: boolean): boolean {
  if (l.kind === 'tuple') {
    return (
      tupleDecodeCharge(l, repeated) !== null ||
      l.components.some((c) => mayChargeDecodeBudget(c, false, repeated))
    );
  }
  if (l.kind !== 'array') return false;
  return (
    arrayDecodeCharge(l, topLevel, repeated) !== null ||
    mayChargeDecodeBudget(l.elem, false, repeated || isDynamic(l))
  );
}

/**
 * @internal Shared with `codegen/call/`. `[] → []`: stores the initial decode-work budget,
 * `RETURNDATASIZE − payloadOffset + DECODE_BUDGET_SLACK` (the decoded payload starts
 * `payloadOffset` bytes into the returndata), into the reserved word at `pushEnd()`.
 */
export function emitInitDecodeBudget(
  w: AsmWriter,
  pushEnd: () => void,
  payloadOffset: number,
): void {
  w.op('RETURNDATASIZE');
  w.push(DECODE_BUDGET_SLACK - payloadOffset, { note: 'decode budget slack' });
  w.op('ADD'); // [budget]
  pushEnd();
  w.op('MSTORE'); // []
}

/**
 * `[bytes, …] → […]`: subtracts `bytes` from the decode-work budget, routing to `fail` once it is
 * spent. The remaining budget stays below 2^64 (the payload size plus the slack) and a charge far
 * below 2^192 (a constant, or `fixed + perElem·len` after the body bound held), so a subtraction
 * that wraps, and only one, sets a bit at or above 2^64. `below` is the number of live items
 * beneath `bytes`; the fragment peaks two items above it plus `pushEnd`'s own.
 */
function emitCharge(w: AsmWriter, pushEnd: () => void, fail: DecodeFail, below: number): void {
  pushEnd();
  w.op('MLOAD'); // [left, bytes, …]
  w.op('SUB'); // [left' = left − bytes, …]
  w.op('DUP1');
  emitAboveU64(w); // [left' ≥ 2^64 (wrapped: spent), left', …]
  fail(below + 1); // [left', …]
  pushEnd();
  w.op('MSTORE', { note: 'decode budget' }); // […]
}

/** Charges an array block about to be materialized, `fixed + perElem·len` bytes: `[len, …] →
 *  [len, …]`. `belowLen` is the number of live items beneath `len`. */
function emitChargeArrayBlock(
  w: AsmWriter,
  pushEnd: () => void,
  fail: DecodeFail,
  belowLen: number,
  c: DecodeCharge,
): void {
  if (c.perElem === 0) {
    w.push(c.fixed); // [bytes, len, …]
  } else {
    w.op('DUP1');
    if (c.perElem === 32) {
      w.push(5);
      w.op('SHL');
    } else {
      w.push(c.perElem);
      w.op('MUL');
    } // [perElem·len, len, …]
    if (c.fixed !== 0) {
      w.push(c.fixed);
      w.op('ADD');
    } // [bytes, len, …]
  }
  emitCharge(w, pushEnd, fail, belowLen + 1); // [len, …]
}

/**
 * Decodes one ABI tuple located in memory at `pushBase()` (offsets inside the tuple are relative
 * to that base) into a freshly-allocated flat-pointer block, and leaves the block pointer on the
 * stack. `pushEnd()` pushes the one-past-last valid source byte (bounds). Mirrors the interpreter's
 * `decodeOutputs` byte-for-byte: static word → normalized canonical word; static inner tuple →
 * inlined recurse; dynamic member (string/bytes/full-word T[]) → a memref **aliasing** the source;
 * narrow-element T[] → a normalized copy (never normalized in place: other values may alias the
 * same bytes); dynamic inner tuple → its whole head bounded (`ptr + headBytes ≤ end`), then a
 * recurse into its own block. Net stack +1 (the flat pointer); one live word (`flat`) per tuple
 * nesting level. No `emitMemCopy`, so the element-normalize loops are the only checked regions.
 *
 * `opts.budget` charges the decode-work budget for the blocks it materializes (see
 * {@link DecodeBudget}): under `'repeated'` a dynamic tuple charges its head size before it
 * allocates its flat block, and every narrow member copy / array member is charged by its own
 * rule. `opts.outputsBlock` marks the tuple as a call's whole output list (`s.simulate`), whose
 * own narrow word-array members are top-level outputs and not charged; it never reaches nested
 * decodes.
 *
 * A dynamic sub-tuple's base is `parentBase + MLOAD(parentBase + ho)`, re-derived at each use so
 * nothing but `flat` rides the stack. Re-deriving through every enclosing level would make each
 * member access cost O(depth) bytes, so a dynamic sub-tuple whose parent base is itself such a
 * derivation (`derivedBase`, internal to the recursion) gets a heap TUPLE FRAME `{base, parent}`
 * chained through scratch `0x20` (see `ELEM_BASE` in `shared.ts`) and its members read the base
 * back in O(1). The first derived level keeps the plain re-derivation, which is cheaper than a
 * frame for a single level, and so does a sub-tuple whose base is read fewer than 3 times
 * ({@link framesTuple}), where the frame would cost more than the re-derivations it saves. A
 * framed sub-tuple decodes through this same function, so it is charged exactly like an unframed
 * one (the frame itself is two words per framed tuple, a type-fixed overhead, never charged). The
 * frame is written, and the free pointer bumped past it, after the sub-tuple's head bound and
 * BEFORE the recursive call charges the sub-tuple: so its flat block is still charged before it
 * is allocated, but a failing charge leaves at most that 64-byte frame allocated uncharged —
 * bounded scratch that the strict path reverts over and a try verb's epilogue rolls back with the
 * rest of its decode.
 */
export function emitDecodeTupleToMem(
  w: AsmWriter,
  components: readonly NamedType[],
  pushBase: PushBase,
  pushEnd: () => void,
  fail: DecodeFail,
  belowFlat: number,
  opts: DecodeOptions & { readonly outputsBlock?: boolean },
  derivedBase = false,
): void {
  const { outputsBlock = false, ...inner } = opts;
  const { budget } = inner;
  const offs = headOffsets(components);
  const n = components.length;

  // a re-decodable dynamic tuple charges its head size before it allocates its flat block (a
  // framed sub-tuple's 64-byte frame is already allocated by now: see the TSDoc above)
  if (budget !== 'off') {
    const layouts = components.map((c) => layoutOfType(abiParamToType(c)));
    const self = {
      kind: 'tuple',
      abi: 'tuple',
      components: layouts,
      dynamic: layouts.some(isDynamic),
    } as const;
    const c = tupleDecodeCharge(self, budget === 'repeated');
    if (c !== null) {
      w.push(c); // [bytes, …below]
      emitCharge(w, pushEnd, fail, belowFlat); // […below]
    }
  }

  // allocate the flat block (32·n words); bump the free pointer
  w.push(FREE_PTR);
  w.op('MLOAD'); // [flat, …below]
  w.op('DUP1');
  w.push(32 * n);
  w.op('ADD'); // [flat+32n, flat, …]
  w.push(FREE_PTR);
  w.op('MSTORE'); // [flat, …]      freePtr bumped

  components.forEach((comp, j) => {
    const ho = headOffsetAt(offs, j);
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
      emitStoreFlatSlot(w, j); // [flat, …]
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
        inner,
        derivedBase,
      ); // [subFlat, flat, …]
      emitStoreFlatSlot(w, j); // [flat, …]
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
        inner,
      ); // [arr, flat, …]
      emitStoreFlatSlot(w, j); // [flat, …]
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
    emitAboveU64(w); // [off >> 64, off, flat, …]
    fail(belowFlat + 2); // [off, flat, …]
    // ptr := base + off
    pushBase();
    w.op('ADD'); // [ptr, flat, …]

    if (layout.kind === 'tuple' && derivedBase && framesTuple(layout)) {
      // dynamic inner tuple below a derived base, read often enough to repay a frame: bound its
      // whole head (ptr + headBytes ≤ end, the interpreter's `decodeBlock` guard), then hand ptr
      // to a tuple frame so its members read it back in O(1) instead of re-deriving it through
      // every enclosing offset word. The frame (64 B, uncharged) is allocated before the
      // recursive call charges the sub-tuple — see the TSDoc above.
      w.op('DUP1');
      w.push(minBlockBytes(layout));
      w.op('ADD'); // [ptr+min, ptr, flat, …]
      pushEnd();
      w.op('LT'); // [end < ptr+min, ptr, flat, …]
      fail(belowFlat + 2); // [ptr, flat, …]
      emitEnterTupleFrame(w); // [flat, …]
      emitDecodeTupleToMem(
        w,
        comp.components ?? [],
        () => pushDFrameLoad(w, TFRAME_BASE),
        pushEnd,
        fail,
        belowFlat + 1,
        inner,
      ); // [sub, flat, …]
      // restore the parent's scratch value
      pushDFrameLoad(w, TFRAME_PARENT);
      w.push(DECODE_FRAME);
      w.op('MSTORE'); // [sub, flat, …]
      emitStoreFlatSlot(w, j); // [flat, …]
      return;
    }

    if (layout.kind === 'tuple' || (layout.kind === 'array' && isRecursiveArray(layout))) {
      // dynamic inner tuple / composite-element array: bound its first block (ptr + minBytes ≤
      // end — the WHOLE head for a tuple, as the interpreter's `decodeBlock` does), consuming ptr:
      // the recursive decoder re-derives it as `parentBase + MLOAD(parentBase+ho)`, so nothing
      // live rides through the recursion but `flat` (one stack word per nesting level).
      w.push(minBlockBytes(layout));
      w.op('ADD'); // [ptr+min, flat, …]
      pushEnd();
      w.op('LT'); // [end < ptr+min, flat, …]
      fail(belowFlat + 1); // [flat, …]
      const pushSub: PushBase = () => emitSubTupleBase(w, pushBase, ho);
      if (layout.kind === 'tuple') {
        // its offsets are relative to ptr (the sub-tuple base), now a derived base
        const sub = comp.components ?? [];
        emitDecodeTupleToMem(w, sub, pushSub, pushEnd, fail, belowFlat + 1, inner, true);
      } else {
        // `tuple[]`, `T[][]`, `string[]`, dynamic `T[N]`: a fresh `[len][p0…]` pointer block
        emitDecodeArrayToMem(w, layout, pushSub, pushEnd, fail, belowFlat + 1, inner);
      } // [sub, flat, …]
      emitStoreFlatSlot(w, j); // [flat, …]
      return;
    }

    // ptr + 32 ≤ end (the length word)
    w.op('DUP1');
    w.push(32);
    w.op('ADD'); // [ptr+32, ptr, flat, …]
    pushEnd();
    w.op('LT'); // [end < ptr+32, ptr, flat, …]
    fail(belowFlat + 2); // [ptr, flat, …]

    // leaf dynamic (string/bytes/word-array): bounds on len + payload, normalize array elems, alias ptr
    const isArray = layout.kind === 'array';
    const elemAbi = isArray ? wordElemAbi(layout) : null;
    w.op('DUP1');
    w.op('MLOAD'); // [len, ptr, flat, …]
    w.op('DUP1');
    emitAboveU64(w); // [len >> 64, len, ptr, flat, …]
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
      // narrow elements: normalize into a fresh copy — never in place, since another decoded
      // value may alias the same source bytes (overlapping offsets in non-canonical data)
      const c =
        budget !== 'off' && layout.kind === 'array'
          ? arrayDecodeCharge(layout, outputsBlock, budget === 'repeated')
          : null;
      if (c !== null) {
        w.op('DUP1');
        w.op('MLOAD'); // [len, ptr, flat, …]
        emitChargeArrayBlock(w, pushEnd, fail, belowFlat + 2, c);
        w.op('POP'); // [ptr, flat, …]
      }
      emitCopyNormalizeWordArray(w, elemAbi, belowFlat + 1); // [copy, flat, …]
    }

    emitStoreFlatSlot(w, j); // [flat, …]   (the alias, or the normalized copy)
  });
}

/** Stores the decoded value of member `j` into its flat-block slot, consuming it:
 *  `[v, flat, …] → [flat, …]` (`MSTORE(flat + 32·j, v)`). */
function emitStoreFlatSlot(w: AsmWriter, j: number): void {
  w.op('DUP2'); // [flat, v, flat, …]
  if (j !== 0) {
    w.push(32 * j);
    w.op('ADD');
  } // [flat+32j, v, flat, …]
  w.op('MSTORE'); // [flat, …]
}

/**
 * Decodes an array located in memory at `pushBase()` — a dynamic `E[]` (the `[len:32][…]` block
 * start) or a fixed-size `E[N]` (its first element / offset word; no length on the wire) — into a
 * freshly-allocated pointer block `[len:32][p0:32]…[p_{len-1}:32]` (`len === N` for a fixed-size
 * array), and leaves that block pointer on the stack (net stack +1). Mirrors the interpreter's
 * `decodeDynamic`/`decodeStatic` array arms byte-for-byte.
 *
 * Three lowerings, selected statically per array level: the FIXED-WORD fast path
 * ({@link emitDecodeFixedWordArray}) for a fixed-size word array `E[N]` (one bulk copy, no
 * element loop), the STACK fast path ({@link emitDecodeArrayToMemStack}, #52) for the one- and
 * two-level dynamic shapes ({@link isStackDecodedArray}), and the HEAP-FRAME path
 * ({@link emitDecodeArrayToMemHeap}) for everything else. Both fast paths can need more stack than
 * the heap path, so they are emitted speculatively: when the fragment would exceed the 16-item
 * template budget at this depth (a fast-path shape nested inside deep tuples or heap levels), it
 * is rolled back and the heap-frame path is emitted instead. A shape therefore never needs more
 * stack than the heap path would, and every shape that decoded on the stack path before #4 keeps
 * that path.
 *
 * `opts.budget`: the stack and heap paths charge the block (`arrayDecodeCharge`, see
 * {@link DecodeBudget}) right after its body bound, before allocating it; the elements of an
 * ABI-dynamic array decode `'repeated'`. A static `T[N]` is never charged on its own (the block
 * that inlines it is charged its bytes), so the fixed-word path, which has no charge site, is
 * taken only when `arrayDecodeCharge` has none for it — always, today; a rule that ever charged
 * one would send it down the heap path rather than skip the charge.
 */
function emitDecodeArrayToMem(
  w: AsmWriter,
  layout: ArrayLayout,
  pushBase: PushBase,
  pushEnd: () => void,
  fail: DecodeFail,
  belowFlat: number,
  opts: DecodeOptions,
): void {
  const { budget } = opts;
  const charge = budget === 'off' ? null : arrayDecodeCharge(layout, false, budget === 'repeated');
  const inner: DecodeOptions = { ...opts, budget: elemBudget(budget, layout) };
  const n = layout.length;
  const elem = layout.elem;
  if (n !== null && elem.kind === 'word' && charge === null) {
    const fits = emitIfWithinBudget(w, belowFlat, () =>
      emitDecodeFixedWordArray(w, layout, n, elem.abi, pushBase, pushEnd, fail, belowFlat, opts),
    );
    if (fits) return;
  } else if (isStackDecodedArray(layout)) {
    const fits = emitIfWithinBudget(w, belowFlat, () =>
      emitDecodeArrayToMemStack(w, layout, pushBase, pushEnd, fail, belowFlat, inner, charge),
    );
    if (fits) return;
  }
  emitDecodeArrayToMemHeap(w, layout, pushBase, pushEnd, fail, belowFlat, inner, charge);
}

/** Emits a fast-path fragment speculatively: keeps it and returns true when its stack peak fits
 *  the template budget at this depth (entered at height `belowFlat`), else rolls it back. */
function emitIfWithinBudget(w: AsmWriter, belowFlat: number, emit: () => void): boolean {
  const cp = w.checkpoint();
  emit();
  if (w.peakHeightSince(cp, belowFlat) <= MAX_TEMPLATE_DEPTH) return true;
  w.rollback(cp);
  return false;
}

/**
 * Where an array decode loop keeps its state, for the emitters the stack and heap-frame paths
 * share. Each accessor pushes one loop word given how many items (`above`) sit on top of the loop
 * state: the stack path `DUP`s it out of `[i, D, arr, len, saved, …]`; the heap-frame path loads
 * `i` / `D` from the current decode frame and `DUP`s `arr`, the one loop word it keeps on the
 * stack.
 */
interface ArrayLoop {
  /** Live items at the loop head — the absolute height its labels are checked at. */
  readonly height: number;
  pushI(above: number): void;
  pushD(above: number): void;
  pushArr(above: number): void;
}

/**
 * Bounds an array's body against the source end BEFORE anything is allocated, mirroring the
 * interpreter: `D + body ≤ end`, where `D` is the data start (`base + 32` past a dynamic array's
 * length word, `base` itself for a fixed-size `E[N]`) and `body` the bytes the elements occupy
 * (`32·len` offset words for a dynamic element, `len·staticSize` inline for a static one — a
 * constant for `E[N]`). A length word the source cannot back fails here, so the allocation that
 * follows is bounded by the source size. `[len, …] → [len, …]` for a dynamic array (`len` on top),
 * `[…] → […]` for `E[N]`; `live` counts the items on the stack (`len` included).
 */
function emitArrayBodyBound(
  w: AsmWriter,
  layout: ArrayLayout,
  pushBase: PushBase,
  pushEnd: () => void,
  fail: DecodeFail,
  live: number,
): void {
  const elem = layout.elem;
  const elemDynamic = isDynamic(elem);
  pushBase(); // [base, len, …]
  if (layout.length === null) {
    w.push(32);
    w.op('ADD'); // [D, len, …]
    w.op('DUP2'); // [len, D, len, …]
    if (elemDynamic) {
      // offset-word region: D + 32·len ≤ end
      w.push(5);
      w.op('SHL'); // [32·len, D, len, …]
    } else {
      // static body: D + len·staticSize ≤ end
      const ss = staticSize(elem);
      if (ss !== 1) {
        w.push(ss);
        w.op('MUL'); // [len·ss, D, len, …]
      }
    }
  } else {
    // fixed `E[N]`: the body size is a constant
    w.push(layout.length * (elemDynamic ? 32 : staticSize(elem))); // [body, D, …]
  }
  w.op('ADD'); // [D+body, …]
  pushEnd();
  w.op('LT'); // [end < D+body, …]
  fail(live); // […]
}

/**
 * Pushes the source base of element `i` (`[…loop] → [elemBase, …loop]`): `D + i·staticSize` for a
 * static element (the body bound already covers it); for a dynamic element, `offᵢ` at `D + 32·i`
 * (relative to `D`, bound `offᵢ ≤ 2^64−1`), `elemPtr = D + offᵢ`, and its first block must fit:
 * `elemPtr + minBlockBytes ≤ end` (a dynamic tuple element's whole head).
 */
function emitElemSourceBase(
  w: AsmWriter,
  elemLayout: TypeLayout,
  loop: ArrayLoop,
  pushEnd: () => void,
  fail: DecodeFail,
): void {
  if (!isDynamic(elemLayout)) {
    const ss = staticSize(elemLayout);
    loop.pushI(0); // [i, …loop]
    if (ss !== 1) {
      w.push(ss);
      w.op('MUL'); // [i·ss, …loop]
    }
    loop.pushD(1);
    w.op('ADD'); // [elemBase, …loop]
    return;
  }
  loop.pushI(0);
  w.push(5);
  w.op('SHL'); // [32·i, …loop]
  loop.pushD(1);
  w.op('ADD');
  w.op('MLOAD'); // [off, …loop]
  w.op('DUP1');
  emitAboveU64(w); // [off >> 64, off, …loop]
  fail(loop.height + 1); // [off, …loop]
  loop.pushD(1);
  w.op('ADD'); // [elemPtr, …loop]
  w.op('DUP1');
  w.push(minBlockBytes(elemLayout));
  w.op('ADD'); // [elemPtr+min, elemPtr, …loop]
  pushEnd();
  w.op('LT'); // [end < elemPtr+min, elemPtr, …loop]
  fail(loop.height + 1); // [elemPtr, …loop]
}

/** Stores the decoded element value into its pointer-block slot, consuming it:
 *  `[elemVal, …loop] → […loop]` (`MSTORE(arr + 32 + 32·i, elemVal)`). */
function emitStoreArraySlot(w: AsmWriter, loop: ArrayLoop): void {
  loop.pushI(1);
  w.push(5);
  w.op('SHL'); // [32·i, elemVal, …loop]
  loop.pushArr(2); // [arr, 32·i, elemVal, …loop]
  w.op('ADD');
  w.push(32);
  w.op('ADD'); // [slotAddr, elemVal, …loop]
  w.op('MSTORE'); // […loop]
}

const DUPS: readonly Mnemonic[] = [
  'DUP1',
  'DUP2',
  'DUP3',
  'DUP4',
  'DUP5',
  'DUP6',
  'DUP7',
  'DUP8',
  'DUP9',
  'DUP10',
  'DUP11',
  'DUP12',
  'DUP13',
  'DUP14',
  'DUP15',
  'DUP16',
];

/** `DUP<n>` for a stack position computed at codegen time. */
function emitDup(w: AsmWriter, n: number): void {
  const op = DUPS[n - 1];
  if (op === undefined) throw internal(`DUP${n} is out of the EVM's reach`);
  w.op(op);
}

/**
 * The fast path of {@link emitDecodeArrayToMem} for a fixed-size WORD array `E[N]` (`uint256[4]`,
 * `address[3]`, `bool[2]`, …). On the wire it is N inline words with no length word, and its
 * decoded block `[N][w0…w_{N−1}]` is that body behind a length word, so after the constant body
 * bound (`base + 32·N ≤ end`, the heap path's check, before anything is allocated) the block is
 * allocated and the body copied in bulk:
 *
 * - a full-word element (`uint256`/`int256`/`bytes32`, nothing to normalize) on cancun: one `MCOPY`
 *   (about 3 gas per element);
 * - otherwise the fused copy-and-normalize loop of {@link emitCopyWordsLoop} (fork-independent,
 *   any stack depth; it normalizes a narrow element on the way, about 70 gas per element).
 *
 * The heap-frame element loop this replaces costs about 205 gas per element. Never
 * `CALLDATACOPY`: the source is a memory snapshot (of the calldata or of the returndata). The
 * MCOPY variant writes the body before bumping the free pointer, which keeps its stack peak at
 * the heap path's; the loop's peak is higher, hence the speculative emit in the caller.
 *
 * Decode-work budget: a static `E[N]` has no charge of its own (`arrayDecodeCharge` is `null`; its
 * `32·N` bytes are charged with the block that inlines it), so this path has no charge site and
 * the caller takes it only when there is no charge to apply. It materializes `32 + 32·N` bytes,
 * less than the heap path's frame plus block.
 */
function emitDecodeFixedWordArray(
  w: AsmWriter,
  layout: ArrayLayout,
  n: number,
  elem: WordType,
  pushBase: PushBase,
  pushEnd: () => void,
  fail: DecodeFail,
  belowFlat: number,
  opts: DecodeOptions,
): void {
  // -- body bound: base + 32·N ≤ end (no length word on the stack) ---------------------------
  emitArrayBodyBound(w, layout, pushBase, pushEnd, fail, belowFlat); // […]

  // -- allocate the `[N][w…]` block at the free pointer and push `arr` ----------------------
  const emitAllocBlock = (): void => {
    w.push(FREE_PTR);
    w.op('MLOAD'); // [arr, …]
    w.push(n, { note: `fixed len ${n}` });
    w.op('DUP2');
    w.op('MSTORE'); // [arr, …]      arr[0] := N
    w.op('DUP1');
    w.push(32 + 32 * n);
    w.op('ADD');
    w.push(FREE_PTR);
    w.op('MSTORE'); // [arr, …]      freePtr bumped
  };

  if (opts.evmVersion === 'cancun' && !wordNeedsNormalize(elem)) {
    // MCOPY(arr + 32, base, 32·N) into the block about to be allocated at the free pointer
    w.push(32 * n); // [32N, …]
    pushBase(); // [base, 32N, …]
    w.push(FREE_PTR);
    w.op('MLOAD');
    w.push(32);
    w.op('ADD'); // [arr+32, base, 32N, …]
    w.op('MCOPY'); // […]
    emitAllocBlock(); // [arr, …]
    return;
  }

  // copy loop over k = 32·N … 32: src[k] → arr[k], with src = base − 32 (one word before the
  // first element, the `[len][e…]` shape the loop expects)
  pushBase();
  w.push(32);
  w.op('SWAP1');
  w.op('SUB'); // [src, …]
  emitAllocBlock(); // [arr, src, …]
  w.push(32 * n); // [k = 32·N, arr, src, …]
  emitCopyWordsLoop(w, elem, belowFlat); // [arr, …]
}

/**
 * The stack fast path of {@link emitDecodeArrayToMem} for a DYNAMIC array `E[]`:
 *
 * - read `len` at `base`, bound `len ≤ 2^64−1`; `D = base + 32`; bound the body (below) — only
 *   then charge (`charge`) and bump-alloc `32 + 32·len`, so this level's block never outgrows its
 *   own source bytes. Overlapping offsets can still make a parent decode the same source block
 *   once per element, which only the decode-work budget bounds.
 * - static element `E` (a STATIC tuple, or a word — `string[]`/`bytes[]` are dynamic): the body is
 *   contiguous, bound `D + len·staticSize ≤ end` up front, then each element decodes at
 *   `D + i·staticSize`. A static tuple element decodes to a fresh flat block (its pointer stored
 *   into `arr + 32 + 32·i`); a word element is normalized inline and stored as the slot value.
 * - dynamic element (dynamic tuple, inner `T[]`, `string`/`bytes`): the offset-word region
 *   (`len` words at `[D, D+32·len)`) must fit first; then each `offᵢ` at `D+32·i` (relative to `D`,
 *   bound `offᵢ ≤ 2^64−1`), `elemPtr = D + offᵢ` (bound `elemPtr + 32 ≤ end`, the whole head for a
 *   dynamic tuple element), recurse the matching decoder, store the returned block pointer into `arr + 32 + 32·i`.
 *
 * No `emitMemCopy` (the array aliases leaf bytes and freshly allocates tuple/array blocks), so the
 * loop state rides on the stack: `[i, D, arr, len, saved, …below]` (`saved` = the caller's
 * `ELEM_BASE` scratch value, restored on exit); the loop labels are checked at absolute height
 * `belowFlat + 5`, mirroring {@link emitNormalizeElemsLoop}'s convention. Five live words per
 * level is why only the one- and two-level shapes take this path (see {@link isStackDecodedArray}).
 */
function emitDecodeArrayToMemStack(
  w: AsmWriter,
  layout: ArrayLayout,
  pushBase: PushBase,
  pushEnd: () => void,
  fail: DecodeFail,
  belowFlat: number,
  elemOpts: DecodeOptions,
  charge: DecodeCharge | null,
): void {
  const elemLayout = layout.elem;
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
  emitAboveU64(w); // [len >> 64, len, …]
  fail(belowFlat + 1); // [len, …]

  // -- up-front element-body bound, BEFORE anything is allocated: a length word the source cannot
  //    back fails here, so the allocation below is bounded by the source size (an unchecked `len`
  //    up to 2^64−1 would otherwise bump FREE_PTR by up to 2^69 bytes)
  emitArrayBodyBound(w, layout, pushBase, pushEnd, fail, belowFlat + 1); // [len, …]
  if (charge !== null) emitChargeArrayBlock(w, pushEnd, fail, belowFlat, charge); // [len, …]

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

  const loop: ArrayLoop = {
    height: belowFlat + 5,
    pushI: (above) => emitDup(w, 1 + above),
    pushD: (above) => emitDup(w, 2 + above),
    pushArr: (above) => emitDup(w, 3 + above),
  };
  const head = w.newLabel('arrdec');
  const done = w.newLabel('arrdec_done');
  w.label(head, loop.height);
  // continue while i < len
  w.op('DUP4'); // [len, i, D, arr, len, saved, …]
  w.op('DUP2'); // [i, len, i, D, arr, len, saved, …]
  w.op('LT'); // [i < len, i, D, arr, len, saved, …]
  w.op('ISZERO');
  w.pushLabel(done);
  w.op('JUMPI'); // [i, D, arr, len, saved, …]

  emitElemSourceBase(w, elemLayout, loop, pushEnd, fail); // [elemBase, i, D, arr, len, saved, …]

  // ELEM_BASE := elemBase; decode the element (recursive decoders read it back).
  w.push(ELEM_BASE);
  w.op('MSTORE'); // [i, D, arr, len, saved, …]
  const pushElemBase: PushBase = () => {
    w.push(ELEM_BASE);
    w.op('MLOAD');
  };
  emitDecodeElement(w, elemLayout, pushElemBase, pushEnd, fail, belowFlat + 5, elemOpts); // [elemVal, i, D, arr, len, saved, …]

  emitStoreArraySlot(w, loop); // [i, D, arr, len, saved, …]

  // i += 1
  w.push(1);
  w.op('ADD'); // [i+1, D, arr, len, saved, …]
  w.pushLabel(head);
  w.op('JUMP');
  w.label(done, loop.height); // [i, D, arr, len, saved, …]
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
 *   `D = base`. Bound the body (below) BEFORE anything is allocated or written, then bump-alloc
 *   the decode frame and the `32 + 32·len` pointer block after it.
 * - static element `E` (a word, a static tuple, or a static fixed array): the body is contiguous,
 *   bound `D + len·staticSize ≤ end` up front, then each element decodes at `D + i·staticSize`. A
 *   composite element decodes to a fresh block (its pointer stored into `arr + 32 + 32·i`); a word
 *   element is normalized inline and stored as the slot value.
 * - dynamic element (dynamic tuple, inner array, `string`/`bytes`, dynamic `T[N]`): the offset-word
 *   region (`len` words at `[D, D+32·len)`) must fit first; then each `offᵢ` at `D+32·i` (relative
 *   to `D`, bound `offᵢ ≤ 2^64−1`), `elemPtr = D + offᵢ` (bound `elemPtr + 32 ≤ end`, the whole
 *   head for a dynamic tuple element), recurse the matching decoder, store the returned block pointer into `arr + 32 + 32·i`.
 *
 * The loop state (`elemBase, i, D, len, parent`) lives in a heap-allocated DECODE FRAME
 * (allocated at the free pointer, right below the pointer block; the current frame pointer sits in scratch
 * `DECODE_FRAME`, frames chain through `parent`), so the operand stack holds only `[arr]` above
 * `belowFlat` throughout — one live word per level instead of the fast path's five. No
 * `emitMemCopy` (the array aliases leaf bytes and freshly allocates tuple/array blocks). Loop
 * labels are checked at absolute height `belowFlat + 1`.
 */
function emitDecodeArrayToMemHeap(
  w: AsmWriter,
  layout: ArrayLayout,
  pushBase: PushBase,
  pushEnd: () => void,
  fail: DecodeFail,
  belowFlat: number,
  elemOpts: DecodeOptions,
  charge: DecodeCharge | null,
): void {
  const elemLayout = layout.elem;

  // -- len: dynamic → MLOAD(base), bound ≤ 2^64−1; fixed → the constant N ---------------------
  if (layout.length === null) {
    pushBase();
    w.op('MLOAD'); // [len, …below]
    w.op('DUP1');
    emitAboveU64(w); // [len >> 64, len, …]
    fail(belowFlat + 1); // [len, …]
  } else {
    w.push(layout.length, { note: `fixed len ${layout.length}` }); // [len, …]
  }

  // -- up-front element-body bound, BEFORE the pointer block and the frame are allocated and
  //    written — the frame sits at arr + 32 + 32·len, so an unchecked length would expand memory
  //    by 32·len before the check could fail ----------------------------------------------------
  emitArrayBodyBound(w, layout, pushBase, pushEnd, fail, belowFlat + 1); // [len, …]
  // the block is charged here (`arrayDecodeCharge`), before anything is allocated
  if (charge !== null) emitChargeArrayBlock(w, pushEnd, fail, belowFlat, charge); // [len, …]

  // -- allocate the decode frame (32·DFRAME_SLOTS bytes) at the free pointer and the pointer
  //    block [len][p0…] (32 + 32·len bytes) right after it; bump FREE_PTR once past both. Every
  //    frame word is written addressed off the not-yet-bumped free pointer, so no more than
  //    `[addr, value, len]` ride on the stack here (the prologue peaks at `belowFlat + 4`, which
  //    is what bounds how deep heap levels nest inside tuples) ---------------------------------
  // frame.D := base (+32 for a dynamic array) — `pushBase` must run BEFORE the frame switch: a
  // nested decode's base thunk reads the PARENT's element base through the scratch slot.
  pushBase(); // [base, len, …]
  if (layout.length === null) {
    w.push(32);
    w.op('ADD'); // [D, len, …]
  }
  emitStoreAtFree(w, DFRAME_D); // [len, …]
  // frame.parent := MLOAD(DECODE_FRAME)
  w.push(DECODE_FRAME);
  w.op('MLOAD'); // [parent, len, …]
  emitStoreAtFree(w, DFRAME_PARENT); // [len, …]
  // frame.len := len ; mem[arr] := len (arr = frame + 32·DFRAME_SLOTS)
  w.op('DUP1');
  emitStoreAtFree(w, DFRAME_LEN); // [len, …]
  w.op('DUP1');
  emitStoreAtFree(w, DFRAME_SLOTS); // [len, …]
  // switch the current frame
  w.push(FREE_PTR);
  w.op('MLOAD'); // [frame, len, …]
  w.op('DUP1');
  w.push(DECODE_FRAME);
  w.op('MSTORE'); // [frame, len, …]
  w.push(32 * DFRAME_SLOTS);
  w.op('ADD'); // [arr, len, …]
  // freePtr := arr + 32 + 32·len (len lives in the frame from here on)
  w.op('SWAP1'); // [len, arr, …]
  w.push(5);
  w.op('SHL'); // [32·len, arr, …]
  w.op('DUP2');
  w.op('ADD');
  w.push(32);
  w.op('ADD'); // [arr+32+32·len, arr, …]
  w.push(FREE_PTR);
  w.op('MSTORE'); // [arr, …]      freePtr bumped

  // -- element loop: state in the frame; stack stays at [arr, …below] ------------------------
  w.push(0);
  emitDFrameStore(w, DFRAME_I); // frame.i := 0

  const loop: ArrayLoop = {
    height: belowFlat + 1,
    pushI: () => pushDFrameLoad(w, DFRAME_I),
    pushD: () => pushDFrameLoad(w, DFRAME_D),
    pushArr: (above) => emitDup(w, 1 + above),
  };
  const head = w.newLabel('arrdec_heap');
  const done = w.newLabel('arrdec_heap_done');
  w.label(head, loop.height); // [arr, …]
  // continue while i < len
  pushDFrameLoad(w, DFRAME_I); // [i, arr, …]
  pushDFrameLoad(w, DFRAME_LEN); // [len, i, arr, …]
  w.op('GT'); // [len > i, arr, …]   i.e. i < len
  w.op('ISZERO');
  w.pushLabel(done);
  w.op('JUMPI'); // [arr, …]

  // element source base from D and i → frame.elemBase
  emitElemSourceBase(w, elemLayout, loop, pushEnd, fail); // [elemBase, arr, …]
  emitDFrameStore(w, DFRAME_ELEM_BASE); // [arr, …]

  // decode the element (the recursive decoders read their base back from the frame)
  emitDecodeElement(
    w,
    elemLayout,
    () => pushDFrameLoad(w, DFRAME_ELEM_BASE),
    pushEnd,
    fail,
    belowFlat + 1,
    elemOpts,
  ); // [elemVal, arr, …]

  emitStoreArraySlot(w, loop); // [arr, …]

  // i += 1
  pushDFrameLoad(w, DFRAME_I);
  w.push(1);
  w.op('ADD');
  emitDFrameStore(w, DFRAME_I); // [arr, …]
  w.pushLabel(head);
  w.op('JUMP');
  w.label(done, loop.height); // [arr, …]

  // -- restore the parent's scratch value ---------------------------------------------------
  pushDFrameLoad(w, DFRAME_PARENT); // [parent, arr, …]
  w.push(DECODE_FRAME);
  w.op('MSTORE'); // [arr, …below]    net +1
}

/** The fewest base reads that repay a tuple frame (see {@link framesTuple}). */
const TFRAME_MIN_READS = 3;

/**
 * How many times decoding a dynamic sub-tuple of layout `l` UNFRAMED reads its base (each read a
 * re-derivation `parentBase + MLOAD(parentBase + ho)`): a word member 1, a static inner tuple its
 * own reads, a static array 2 (its body bound and its copy / frame), a dynamic member 2 (its offset
 * word, then `ptr`), plus a dynamic inner tuple's own reads when it is not framed itself (its base
 * is derived from this one), plus 2 for a composite-element array (its length and body reads).
 * A gas heuristic only: framing or not decodes the same bytes.
 */
function tupleBaseReads(l: Extract<TypeLayout, { kind: 'tuple' }>): number {
  return l.components.reduce((n, c) => {
    if (c.kind === 'word') return n + 1;
    if (!isDynamic(c)) return n + (c.kind === 'tuple' ? tupleBaseReads(c) : 2);
    if (c.kind === 'tuple') {
      const own = tupleBaseReads(c);
      return n + 2 + (own >= TFRAME_MIN_READS ? 0 : own);
    }
    return n + 2 + (isRecursiveArray(c) ? 2 : 0);
  }, 0);
}

/**
 * @internal Exported for the decoder tests.
 * Whether a dynamic sub-tuple below a derived base gets a tuple frame. Entering and leaving one
 * (two frame words, a free-pointer bump, 64 bytes of memory, the parent restore) costs about what
 * two-and-a-half re-derived base reads do, so a sub-tuple read fewer than 3 times (a lone
 * `string` / `bytes` / word-array member, or a lone framed inner tuple) keeps the re-derivation.
 */
export function framesTuple(l: Extract<TypeLayout, { kind: 'tuple' }>): boolean {
  return tupleBaseReads(l) >= TFRAME_MIN_READS;
}

/**
 * The smallest source block a DYNAMIC member / element of layout `l` needs at its pointer before
 * its decoder may read it: a dynamic tuple's whole head (`headBytes(components)` — the
 * interpreter's `decodeBlock` guard; each head word is read unchecked), else one word (the
 * length word of `string`/`bytes`/`T[]`, or the first offset word of a dynamic `T[N]`, whose
 * decoder then bounds its own body).
 */
function minBlockBytes(l: TypeLayout): number {
  if (l.kind !== 'tuple' || !l.dynamic) return 32;
  return l.components.reduce((n, c) => n + (isDynamic(c) ? 32 : staticSize(c)), 0);
}

/** Pushes the address of word `k` of the frame whose pointer is stored at `ptrSlot`:
 *  `MLOAD(ptrSlot) + 32·k`. */
function pushFrameWordAddr(w: AsmWriter, ptrSlot: number, k: number): void {
  w.push(ptrSlot);
  w.op('MLOAD'); // [frame]
  if (k !== 0) {
    w.push(32 * k);
    w.op('ADD');
  }
}

/** Stores the top-of-stack value (consumed) at `FREE_PTR + 32·k` — word `k` of a heap decode frame
 *  about to be allocated at the free pointer (see {@link emitDecodeArrayToMemHeap}). */
function emitStoreAtFree(w: AsmWriter, k: number): void {
  pushFrameWordAddr(w, FREE_PTR, k); // [addr, v]
  w.op('MSTORE'); // []
}

/** Pushes word `k` of the CURRENT decode frame, a heap array frame or a tuple frame
 *  (`MLOAD(MLOAD(DECODE_FRAME) + 32·k)`). */
function pushDFrameLoad(w: AsmWriter, k: number): void {
  pushFrameWordAddr(w, DECODE_FRAME, k);
  w.op('MLOAD');
}

/**
 * Enters a tuple decode frame (see {@link emitDecodeTupleToMem}): `[base, …] → […]`. Writes
 * `{base, parent = MLOAD(DECODE_FRAME)}` at the free pointer, points `DECODE_FRAME` at it and
 * bumps the free pointer past it. The caller restores the parent value when the tuple is done.
 */
function emitEnterTupleFrame(w: AsmWriter): void {
  emitStoreAtFree(w, TFRAME_BASE); // […]
  w.push(DECODE_FRAME);
  w.op('MLOAD'); // [parent, …]
  emitStoreAtFree(w, TFRAME_PARENT); // […]
  w.push(FREE_PTR);
  w.op('MLOAD'); // [frame, …]
  w.op('DUP1');
  w.push(DECODE_FRAME);
  w.op('MSTORE'); // [frame, …]
  w.push(32 * TFRAME_SLOTS);
  w.op('ADD');
  w.push(FREE_PTR);
  w.op('MSTORE'); // […]      freePtr bumped
}

/** Stores the top-of-stack value into word `k` of the CURRENT heap decode frame (consumes it). */
function emitDFrameStore(w: AsmWriter, k: number): void {
  pushFrameWordAddr(w, DECODE_FRAME, k); // [addr, v]
  w.op('MSTORE'); // []
}

/**
 * Decodes one array element whose source block starts at `pushBase()` (the owning array loop
 * wrote it to scratch — the element base itself on the stack path, word 0 of the current heap
 * frame on the heap-frame path), pushing the decoded element value (a normalized word for a word
 * element, otherwise a fresh block pointer, or a pointer aliasing the source for `string` /
 * `bytes` / a full-word `T[]`). Net stack +1. The caller already validated the per-element
 * bounds (dynamic) / body bounds (static). `belowElem` is the number of live items on the stack
 * on entry (the array loop state).
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
  opts: DecodeOptions,
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
    const components = tupleComponents(elemLayout);
    emitDecodeTupleToMem(w, components, pushBase, pushEnd, fail, belowElem, opts); // [flat, …]
    return;
  }

  const aliasedArray = elemLayout.kind === 'array' && aliasesSource(elemLayout);
  if (elemLayout.kind === 'array' && !aliasedArray) {
    // nested array element (`T[][]`, `T[N][]`, `uint8[][]`, …): recurse — it saves/restores the
    // scratch slot.
    emitDecodeArrayToMem(w, elemLayout, pushBase, pushEnd, fail, belowElem, opts); // [arr, …]
    return;
  }

  // leaf element aliased in place: base points at `[len][payload]` — `string`/`bytes`
  // (`string[]`/`bytes[]`) or a full-word `T[]` (`uint256[][]`, …), which needs no normalization,
  // so it aliases the source exactly like a top-level output or a struct member does (no copy:
  // N offsets at one inner array cost N bounds checks, not N copies). len ≤ 2^64−1;
  // ptr + 32 + nbytes ≤ end (nbytes = len, or 32·len for an array). The decoded value IS base.
  pushBase(); // [base, …]
  w.op('DUP1');
  w.op('MLOAD'); // [len, base, …]
  w.op('DUP1');
  emitAboveU64(w); // [len >> 64, len, base, …]
  fail(belowElem + 2); // [len, base, …]
  if (aliasedArray) {
    w.push(5);
    w.op('SHL'); // [nbytes, base, …]
  }
  w.op('DUP2');
  w.op('ADD');
  w.push(32);
  w.op('ADD'); // [base+32+nbytes, base, …]
  pushEnd();
  w.op('LT'); // [end < base+32+nbytes, base, …]
  fail(belowElem + 1); // [base, …]   (base is the aliased block = the elem value)
}

/** A dynamic full-word `T[]` (`uint256[]`, `int256[]`, `bytes32[]`): its source bytes already are
 *  the canonical memory block, so every decoder aliases it instead of copying it. */
function aliasesSource(l: ArrayLayout): boolean {
  return !isRecursiveArray(l) && !wordNeedsNormalize(wordElemAbi(l));
}
