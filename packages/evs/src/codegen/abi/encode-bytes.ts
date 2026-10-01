/**
 * `codegen/abi/encode-bytes.ts` — the encode-to-bytes emitters behind `s.encode` /
 * `s.encodePacked` (issue #17): ABI or packed encoding of recorded values into a fresh bytes
 * memref.
 */

import { layoutOfType, headBytes, type TypeLayout } from '../../abi/layout.js';
import type { AsmWriter } from '../../asm/assembler.js';
import type { EvmVersion } from '../../asm/ops.js';
import { type NamedType, abiParamToType } from '../../core/types.js';
import { FREE_PTR, TAIL_CURSOR } from '../memory.js';
import {
  encodeFramesOf,
  reserveEncodeFrames,
  type PushWord,
  type PushBase,
  emitEncodeBlock,
} from './encode.js';
import { emitCeil32, type SharedTails, internal, emitMemCopy } from './shared.js';

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

/** note metadata for the first emitted node of an encode template (sourcemap attribution). */
export interface EncodeMeta {
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
  w.push(32);
  w.op('ADD'); // [ptr+32, ptr, cursor]
  w.op('DUP3'); // [cursor, ptr+32, ptr, cursor]
  w.op('SUB'); // [total = cursor−ptr−32, ptr, cursor]
  w.op('DUP2'); // [ptr, total, ptr, cursor]
  w.op('MSTORE', { note }); // [ptr, cursor]           mem[ptr] = total
  w.op('SWAP1'); // [cursor, ptr]
  emitCeil32(w); // [ceil32(cursor), ptr]
  w.push(FREE_PTR);
  w.op('MSTORE'); // [ptr]                              freePtr bumped past the payload
}

/**
 * Materializes the STANDARD ABI encoding (`abi.encode`) of `items` into a fresh `bytes` memref
 * and leaves its pointer on the stack (net stack +1). The items encode as a top-level tuple —
 * heads at the payload start, dynamic offsets relative to it, tails appended at the shared
 * scratch cursor — via {@link emitEncodeBlock}, i.e. exactly the return-encode shape minus the
 * outer RETURN and the single-output wrapper. Encode frames are reserved BELOW
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
