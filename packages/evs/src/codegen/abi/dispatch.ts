/**
 * `codegen/abi/dispatch.ts` — the script's ABI entry and exit: `emitCalldataDecode` (the
 * dispatch-time decode of the script's arguments into their frame slots) and `emitReturnEncode`
 * (the return tuple, encoded into the output buffer).
 */

import { layoutOfType, headBytes, isDynamic, type TypeLayout } from '../../abi/layout.js';
import type { AsmWriter } from '../../asm/assembler.js';
import type { EvmVersion } from '../../asm/ops.js';
import { typeToAbiParam, isTupleType, abiParamToType, stringifyType } from '../../core/types.js';
import { FREE_PTR, MAX_U64 } from '../memory.js';
import { type DecodeFail, emitDecodeTupleToMem, emitDecodeArrayToMem } from './decode.js';
import {
  headOffsets,
  type PushBase,
  encodeFramesOf,
  reserveEncodeFrames,
  type PushWord,
  emitEncodeBlock,
} from './encode.js';
import {
  type SlotRef,
  type SharedTails,
  needsMemorySnapshot,
  TAIL_CURSOR,
  emitCeil32,
  emitNormalizeWord,
  internal,
  isRecursiveArray,
  wordElemAbi,
  wordNeedsNormalize,
  emitNormalizeElemsLoop,
  emitWithinStackBudget,
} from './shared.js';

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
    emitCeil32(w); // [size]
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
      if (!isTupleType(ref.type)) throw internal(`arg #${i} layout is tuple but type is not`);
      // for a DYNAMIC tuple, first bounds-check its offset word (off ≤ 2^64−1) and its whole head
      // (region+off+headBytes ≤ end — the tuple decoder reads every head word unchecked)
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
        w.push(headBytes(ref.type.components));
        w.op('ADD'); // [base+head]
        pushEnd();
        w.op('LT'); // [end < base+head]
        failCalldata(0); // []
      }
      const components = ref.type.components;
      emitWithinStackBudget(
        w,
        0,
        () => `script argument #${i} (${stringifyType(ref.type)})`,
        () => emitDecodeTupleToMem(w, components, pushTupleBase, pushEnd, failCalldata, 0),
      ); // [flat]
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
      emitWithinStackBudget(
        w,
        0,
        () => `script argument #${i} (${stringifyType(ref.type)})`,
        () => emitDecodeArrayToMem(w, layout, pushArrBase, pushEnd, failCalldata, 0),
      ); // [arr]
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
    emitCeil32(w); // [ceil32(len), ptr, len, src]
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
 * pointer is bumped at most once — by `reserveEncodeFrames`, before `out` is read, and only when
 * the return type has a composite-element array — never during the encode; RETURN terminates the
 * program.
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
