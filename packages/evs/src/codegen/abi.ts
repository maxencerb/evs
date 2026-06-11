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

import { layoutOf, type TypeLayout } from '../abi/layout.js';
import type { AsmWriter, LabelId } from '../asm/assembler.js';
import type { EvmVersion } from '../asm/ops.js';
import { EvsInternalError } from '../core/errors.js';
import type { EvsType, WordType } from '../core/types.js';

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
// emitCalldataDecode — architecture §8.1
// ---------------------------------------------------------------------------

/**
 * Decodes the script arguments from calldata into their frame slots (architecture §8.1).
 *
 * - One up-front size guard: `CALLDATASIZE < 4 + 32·nArgs` → `tails.invalidCalldata`.
 * - Word args: `CALLDATALOAD` + normalize (mask / SIGNEXTEND / `ISZERO ISZERO`) + `MSTORE`
 *   (normalize-don't-revert on dirty high bits).
 * - Dynamic args: overflow-free bounds checks (`off ≤ 2^64−1`, `4+off+32 ≤ cds`,
 *   `len ≤ 2^64−1`, tail-end ≤ cds) → `tails.invalidCalldata` on any structural failure;
 *   then allocate, `CALLDATACOPY` the `[len][payload]` segment, explicit zero-pad of the
 *   trailing partial word (bytes/string), eager element normalization (arrays of sub-word
 *   element types), and store the memref pointer.
 *
 * Net stack 0. Nothing here is fork-dependent (zero-push lowering is the assembler's job).
 */
export function emitCalldataDecode(
  w: AsmWriter,
  args: readonly SlotRef[],
  tails: SharedTails,
  _opts: { evmVersion: EvmVersion },
): void {
  // -- size guard: cds < 4 + 32·n → EvsInvalidCalldata --------------------------------
  const minSize = 4 + 32 * args.length;
  w.push(minSize, { note: `calldata floor ${minSize}` });
  w.op('CALLDATASIZE'); // [cds, minSize]
  w.op('LT'); // [cds < minSize]
  w.pushLabel(tails.invalidCalldata);
  w.op('JUMPI');

  args.forEach((ref, i) => {
    const layout = layoutOf(ref.type);
    const headOff = 4 + 32 * i;
    if (layout.kind === 'word') {
      w.push(headOff, { note: `arg #${i} head` });
      w.op('CALLDATALOAD'); // [raw]
      emitNormalizeWord(w, layout.abi);
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
 * (architecture §8.2).
 *
 * Two-pass head/tail emitted as straight-line code from the compile-time component walk:
 * 1. `out = MLOAD(0x40)`; if any component is dynamic, `MSTORE(out, 0x20)` (top-level tuple
 *    offset) and `base = out + 0x20`, else `base = out` (both shapes decode identically).
 * 2. Heads at `base + 32·i`: word components verbatim (slots are canonical); dynamic
 *    components get the running tail offset relative to `base`.
 * 3. Tails in component order: `MSTORE(tail, len)`, payload copy via `emitMemCopy`, explicit
 *    zero-pad of the trailing partial word, cursor advance.
 * 4. `RETURN(out, total)`.
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
  const layouts = components.map((c) => layoutOf(c.ref.type));
  const anyDyn = layouts.some((l) => l.kind !== 'word');
  const dynOff = anyDyn ? 32 : 0;
  const headSize = 32 * components.length;

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

  components.forEach((c, i) => {
    const layout = layouts[i];
    if (layout === undefined) throw internal(`missing layout for component #${i}`);
    const headOffset = dynOff + 32 * i; // relative to out
    if (layout.kind === 'word') {
      w.push(c.ref.slot);
      w.op('MLOAD', { note: `head ${c.name}` }); // [v]   slots are canonical — no cleanup
      w.push(FREE_PTR);
      w.op('MLOAD'); // [out, v]
      if (headOffset !== 0) {
        w.push(headOffset);
        w.op('ADD');
      } // [out+headOffset, v]
      w.op('MSTORE'); // []
      return;
    }

    const isArray = layout.kind === 'array';
    /** Reload the component's payload byte count `nbytes` onto the stack. */
    const pushNBytes = (): void => {
      w.push(c.ref.slot);
      w.op('MLOAD');
      w.op('MLOAD'); // [len]
      if (isArray) {
        w.push(5);
        w.op('SHL'); // [32·len]
      }
    };

    // head: MSTORE(base + 32·i, tail − base)   (base = out + dynOff)
    w.push(FREE_PTR);
    w.op('MLOAD');
    w.push(dynOff);
    w.op('ADD'); // [base]
    w.push(TAIL_CURSOR);
    w.op('MLOAD'); // [tail, base]
    w.op('SUB'); // [rel]
    w.push(FREE_PTR);
    w.op('MLOAD');
    w.push(headOffset);
    w.op('ADD'); // [headAddr, rel]
    w.op('MSTORE', { note: `head ${c.name}` }); // []

    // length word: MSTORE(tail, len)
    w.push(c.ref.slot);
    w.op('MLOAD');
    w.op('MLOAD'); // [len]
    w.push(TAIL_CURSOR);
    w.op('MLOAD'); // [tail, len]
    w.op('MSTORE'); // []

    // payload copy: [dst = tail+32, src = ptr+32, nbytes] — exactly height 3 (memcpy convention)
    pushNBytes(); // [n]
    w.push(c.ref.slot);
    w.op('MLOAD');
    w.push(32);
    w.op('ADD'); // [src, n]
    w.push(TAIL_CURSOR);
    w.op('MLOAD');
    w.push(32);
    w.op('ADD'); // [dst, src, n]
    emitMemCopy(w, tails, opts); // []

    if (!isArray) {
      // explicit zero-pad AFTER the copy: the pre-cancun word loop copies whole words, so a
      // dirty partial source word (snapshot-aliased memrefs) is cleaned here; arrays are
      // always word-exact.
      w.push(0); // [0]
      pushNBytes(); // [n, 0]
      w.push(TAIL_CURSOR);
      w.op('MLOAD');
      w.op('ADD'); // [tail+n, 0]
      w.push(32);
      w.op('ADD'); // [tail+32+n, 0]
      w.op('MSTORE', { note: `zero-pad ${c.name}` }); // []
    }

    // tail += 32 + ceil32(nbytes)
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
    w.op('ADD'); // [tail']
    w.push(TAIL_CURSOR);
    w.op('MSTORE'); // []
  });

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
