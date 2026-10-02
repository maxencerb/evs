/**
 * `codegen/abi.ts` — the ABI emitters: dispatch-time calldata decode, return-tuple encode,
 * `s.encode` / `s.encodePacked` into a bytes value, and the fork-portable memory-copy primitive.
 *
 * A barrel over `codegen/abi/`:
 * - `shared.ts` — the contract types (`SharedTails`, `SlotRef`), the scratch / loop-frame layout
 *   constants, word normalization and the `emitMemCopy` / `emitCeil32` primitives;
 * - `encode.ts` — the recursive head/tail encoder and the composite-element array encode loop;
 * - `encode-bytes.ts` — the `s.encode` / `s.encodePacked` emitters (issue #17);
 * - `decode.ts` — the recursive decoder: tuples, and the array codec's fixed-word, stack and
 *   heap-frame paths (they recurse into each other, so they share one module), the decode-work
 *   budget, and `emitDecodeFromRegion`, the entry for a top-level value decoded from a calldata
 *   or returndata snapshot;
 * - `dispatch.ts` — the script's entry and exit: `emitCalldataDecode` and `emitReturnEncode`.
 *
 * Every emitted sequence is net-zero on the operand stack (the statement-boundary invariant)
 * and stays within the 16-item template budget — `asm/verify.ts` machine-checks both on every
 * `assemble`.
 *
 * Memory-model conventions used throughout:
 * - scratch `0x00` holds the running tail cursor of the return encoder / calldata templates
 *   (`TAIL_CURSOR`), or a decode's snapshot base (`SNAP_SLOT`) — both defined in
 *   `codegen/memory.ts`, intra-template temporaries only;
 * - `0x40` is the free-memory pointer; `0x60` is the never-written zero slot;
 * - dynamic values are memrefs: a frame slot holds a pointer to `[len:32][payload…]`.
 *
 * Pre-cancun `emitMemCopy` lowers to a call into the shared `@memcpy` subroutine
 * (`codegen/tails.ts`). The subroutine entry is a *checked* label, so its calling convention
 * pins the absolute stack height: callers must invoke `emitMemCopy` with the operand stack
 * being EXACTLY `[dst, src, len]` (height 3, nothing beneath). Both emitters in this module
 * honor that by keeping their loop state in scratch memory instead of deep on the stack.
 */

export {
  fmtType,
  usesRecursiveCodec,
  isRecursiveArray,
  wordNeedsNormalize,
  emitNormalizeWord,
  emitCopyNormalizeWordArray,
  emitWithinStackBudget,
  emitAboveU64,
  emitCeil32,
  emitMemCopy,
  layoutToNamed,
} from './abi/shared.js';
export type { SharedTails, SlotRef, EncodeOpts, CodecHook } from './abi/shared.js';
export {
  headOffsets,
  headOffsetAt,
  emitEncodeBlock,
  emitLeafDynTail,
  encodeFramesOf,
  reserveEncodeFrames,
  emitSharedEncodeBody,
} from './abi/encode.js';
export type { PushWord, PushBase, CodecRegisters } from './abi/encode.js';
export { emitAbiEncodeToBytes, emitPackedEncodeToBytes } from './abi/encode-bytes.js';
export type { EncodeSrcItem, EncodeMeta } from './abi/encode-bytes.js';
export {
  emitDecodeTupleToMem,
  emitDecodeFromRegion,
  needsDecodeBudget,
  effectiveDecodeBudget,
  emitInitDecodeBudget,
} from './abi/decode.js';
export type { DecodeFail, DecodeBudget, DecodeOptions, DecodeRegion } from './abi/decode.js';
export { emitCalldataDecode, emitReturnEncode } from './abi/dispatch.js';
