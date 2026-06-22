/**
 * M7 `codegen/abi.ts` — the ABI emitters: dispatch-time calldata decode (architecture §8.1),
 * return-tuple encode (§8.2), and the fork-portable memory-copy primitive (§10 lowering table).
 *
 * Contract: docs/design/module-interfaces.md §M7 (frozen signatures) + architecture.md §5
 * (memory model, canonical word invariant), §8 (encode/decode shapes), §10 (evmVersion
 * lowering). Every emitted sequence is net-zero on the operand stack (the statement-boundary
 * invariant) and stays within the 16-item template budget — `asm/verify.ts` machine-checks
 * both on every `assemble`.
 *
 * Conventions used throughout (architecture §5):
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

import { headBytes, isDynamic, layoutOf, layoutOfType, type TypeLayout } from '../abi/layout.js';
import type { AsmWriter, LabelId } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import { EvsInternalError } from '../core/errors.js';
import {
  abiParamToType,
  isTupleType,
  typeToAbiParam,
  type EvsType,
  type NamedType,
  type WordType,
} from '../core/types.js';

// ---------------------------------------------------------------------------
// frozen contract types (module-interfaces §M7)
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

/** 2^64 − 1 — the overflow-free bound for every decoded offset/length (architecture §7/§8). */
const MAX_U64 = 0xffffffffffffffffn;

/** Free-memory-pointer slot (architecture §5). */
const FREE_PTR = 0x40;

/** Scratch slot for running tail cursors (intra-template temporary, architecture §5). */
const TAIL_CURSOR = 0x00;

function internal(message: string): EvsInternalError {
  return new EvsInternalError('INTERNAL', `codegen/abi: ${message}`);
}

function wordLayoutOf(type: WordType): Extract<TypeLayout, { kind: 'word' }> {
  const layout = layoutOf(type);
  if (layout.kind !== 'word') {
    throw internal(`expected a word type, got ${JSON.stringify(type)}`);
  }
  return layout;
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
 * canonical form of `type` (architecture §5): `uintN`/`address` masked, `intN` sign-extended,
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
 * memref payload (architecture §7.2 step 5 / §8.1).
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
// recursive ABI encoder (head/tail over a flat-pointer SRC tree) — architecture §8.2/§3
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
 *  within `components` (static inner tuples inline their whole head; everything else is one word). */
export function headOffsetsOf(components: readonly NamedType[]): number[] {
  return headOffsets(components);
}

/** Cumulative ABI head offset (bytes) of component `i` within `components` (static inner tuples
 *  inline their whole head; everything else is one word). */
function headOffsets(components: readonly NamedType[]): number[] {
  const offs: number[] = [];
  let cursor = 0;
  for (const c of components) {
    offs.push(cursor);
    const layout = layoutOfType(abiParamToType(c));
    cursor += layout.kind === 'tuple' && !layout.dynamic ? headBytes(c.components ?? []) : 32;
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
  opts: { evmVersion: EvmVersion },
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

    // leaf dynamic (string / bytes / T[]): copy [len][payload] to the cursor, advance
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

/** DST base of a dynamic inner tuple: `parentBase + MLOAD(parentBase + ho)` (the offset the
 *  parent head already stored points at the sub-block). */
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
// recursive ABI decoder (memory head/tail → flat-pointer block) — architecture §3/§7.2/§8.1
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
          emitSubTupleBaseFromOffset(w, pushBase, ho);
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

    // leaf dynamic (string/bytes/T[]): bounds on len + payload, normalize array elems, alias ptr
    const isArray = layout.kind === 'array';
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

    if (isArray && wordNeedsNormalize(layout.elem.abi)) {
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
      emitNormalizeElemsLoop(w, layout.elem.abi, belowFlat + 2);
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

/** Re-derives a dynamic sub-tuple's base = `parentBase + MLOAD(parentBase + ho)` (the offset word
 *  the parent stored), for use as a {@link PushBase} thunk inside a nested decode. */
function emitSubTupleBaseFromOffset(w: AsmWriter, pushBase: PushBase, ho: number): void {
  pushBase(); // [base]
  w.op('DUP1'); // [base, base]
  if (ho !== 0) {
    w.push(ho);
    w.op('ADD');
  } // [base+ho, base]
  w.op('MLOAD'); // [off, base]
  w.op('ADD'); // [subBase]
}

// ---------------------------------------------------------------------------
// emitCalldataDecode — architecture §8.1
// ---------------------------------------------------------------------------

/**
 * Decodes the script arguments from calldata into their frame slots (architecture §8.1).
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
  const hasTuple = params.some((p) => p.type.startsWith('tuple'));

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

    emitDynCalldataArg(w, ref, layout, headOff, i, tails);
  });
}

/** One dynamic (`string`/`bytes`/`T[]`) script argument — architecture §8.1, net stack 0. */
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
    // above the free pointer is NOT guaranteed zero (architecture §5), and the memref
    // invariant promises zero-padded payloads.
    w.push(0); // [0, ptr, len, src]
    w.op('DUP2');
    w.op('DUP4');
    w.op('ADD'); // [ptr+len, 0, ptr, len, src]
    w.push(32);
    w.op('ADD'); // [pad, 0, ptr, len, src]
    w.op('MSTORE'); // [ptr, len, src]
  } else if (wordNeedsNormalize(layout.elem.abi)) {
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
    emitNormalizeElemsLoop(w, layout.elem.abi, 3);
    w.op('POP');
    w.op('POP'); // [ptr, len, src]
  }

  // slot := ptr; cleanup
  w.push(ref.slot);
  w.op('MSTORE'); // [len, src]
  w.op('POP');
  w.op('POP'); // []
}

// ---------------------------------------------------------------------------
// emitReturnEncode — architecture §8.2
// ---------------------------------------------------------------------------

/**
 * Encodes the return record as the single named tuple output and RETURNs it
 * (architecture §8.2). The record is treated as a synthetic top-level tuple: a static word
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
// emitMemCopy — §10 lowering (MCOPY on cancun, @memcpy subroutine before)
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
