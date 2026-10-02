/**
 * `codegen/memory.ts` — the fixed low-memory map every emitter shares.
 *
 * | offset | role                                                                     |
 * | ------ | ------------------------------------------------------------------------ |
 * | `0x00` | scratch word 0 — intra-template temporary                                |
 * | `0x20` | scratch word 1 — intra-template temporary                                |
 * | `0x40` | free-memory pointer                                                      |
 * | `0x60` | zero slot — never written, so it reads as the empty memref `[len = 0]`   |
 * | `0x80` | start of the static frame (`codegen/frame.ts`)                           |
 *
 * A program that shares a codec subroutine (`codegen/codecs.ts`) appends up to three words right
 * after the static frame — the codec registers `RET` (a body's return address), `BASE` and
 * `SRC` (its spilled operands) — and starts the free pointer past them. They are reserved only
 * when something is shared, so every other program keeps its frame end.
 *
 * The two scratch words are never live across a statement boundary. Each emitter aliases them
 * under a role name, and the phases that share a word never overlap:
 * - `0x00`: the running tail cursor of the return encoder / calldata templates
 *   ({@link TAIL_CURSOR}), and the snapshot base during a decode from a memory snapshot of the
 *   calldata or the returndata ({@link SNAP_SLOT} — the script-argument decode runs before any
 *   encode, and a call's output decode only after the call, once its calldata cursor is dead);
 * - `0x20`: the array-decode element base / heap-frame or tuple-frame pointer during *decode*
 *   (`ELEM_BASE` / `DECODE_FRAME` in `abi/shared.ts`), the data-literal staging base during
 *   tuple-arg *encode* (`STAGING_SLOT` in `call/calldata.ts`), and the wrapper argsSize across the
 *   simulate payload copy (`SIM_ARGSIZE_SLOT` in `call/simulate-call.ts`).
 *
 * Memory above the free pointer is dirty: sub-call calldata images are built there without a
 * bump, and a failed try-decode rolls the free pointer back over its returndata snapshot.
 * {@link emitAlloc} is the bump allocator of the construction templates (`s.newArray`, `s.tuple`,
 * typed zero values, dynamic literals, `slice`, `bytesN → string`) and zero-fills a fresh block
 * (a CALLDATACOPY from past the calldata end) only when some word of it would otherwise be read
 * before it is written.
 *
 * It also owns the typed zero-value emitters ({@link emitZeroValue}, {@link emitZeroMemrefMembers})
 * shared by `s.newArray`, `s.tuple` and the try-mode zero block: a zero-filled block is only a
 * valid zero value for word slots — a string/bytes/`T[]` slot must point at the zero slot and a
 * nested tuple / fixed-size `T[N]` slot at its own fresh zeroed block, never at pointer `0x00`
 * (scratch).
 */

import type { AsmWriter } from '../asm/assembler.js';
import {
  abiParamToType,
  elemTypeOf,
  fixedLengthOf,
  isArrayValueType,
  isMemrefType,
  isTupleType,
  stringifyType,
  type ArrayType,
  type EvsType,
  type NamedType,
  type TupleType,
} from '../core/types.js';

/** Scratch word 0 (see the module header for its owners). */
export const SCRATCH_0 = 0x00;

/** Scratch word 1 (see the module header for its owners). */
export const SCRATCH_1 = 0x20;

/** Scratch `0x00` as the running tail cursor of an encode (the return tuple, a call's calldata,
 *  `s.encode`): the next free byte of the output, transient within one template. */
export const TAIL_CURSOR = SCRATCH_0;

/** Scratch `0x00` as the base of a memory snapshot of the calldata (the script-argument decode)
 *  or of a call's returndata (its output decode), which the recursive decoders read back so their
 *  free-pointer churn never moves it. Never live at the same time as {@link TAIL_CURSOR}. */
export const SNAP_SLOT = SCRATCH_0;

/** Free-memory-pointer slot. */
export const FREE_PTR = 0x40;

/** The never-written zero slot: an empty memref for string/bytes/`T[]` zero values. */
export const ZERO_SLOT = 0x60;

/** Start of the static frame (just above the zero slot). */
export const FRAME_BASE = 0x80;

/**
 * Bump-allocates a fresh block at the free pointer: `[…] → [ptr, …]` for a constant `size`, or
 * `[size, …] → [ptr, …]` for a runtime size already on the stack (`'onStack'`). The free pointer
 * ends at `ptr + size`.
 *
 * `zeroFill: true` zeroes `[ptr, ptr + size)` (CALLDATACOPY from past the calldata end reads
 * zeros); it is required whenever a word of the block can be read before the caller writes it,
 * since memory above the free pointer is dirty (see the module header). Pass `false` only when
 * the caller writes every word of the block itself. `note` annotates the first instruction.
 */
export function emitAlloc(
  w: AsmWriter,
  size: number | 'onStack',
  opts: { readonly zeroFill: boolean; readonly note?: string },
): void {
  const head = opts.note === undefined ? {} : { note: opts.note };
  if (size !== 'onStack') {
    w.push(FREE_PTR, head);
    w.op('MLOAD'); // [ptr]
    w.op('DUP1');
    w.push(size);
    w.op('ADD'); // [ptr+size, ptr]
    w.push(FREE_PTR);
    w.op('MSTORE'); // [ptr]   freePtr bumped
    if (!opts.zeroFill) return;
    w.push(size); // [size, ptr]
    w.op('CALLDATASIZE');
    w.op('DUP3'); // [ptr, cds, size, ptr]
    w.op('CALLDATACOPY', { note: 'zero-fill' }); // [ptr]
    return;
  }
  w.push(FREE_PTR, head);
  w.op('MLOAD'); // [ptr, size]
  if (!opts.zeroFill) {
    w.op('SWAP1'); // [size, ptr]
    w.op('DUP2'); // [ptr, size, ptr]
    w.op('ADD'); // [ptr+size, ptr]
    w.push(FREE_PTR);
    w.op('MSTORE'); // [ptr]   freePtr bumped
    return;
  }
  w.op('DUP2');
  w.op('DUP2');
  w.op('ADD'); // [ptr+size, ptr, size]
  w.push(FREE_PTR);
  w.op('MSTORE'); // [ptr, size]   freePtr bumped
  w.op('SWAP1'); // [size, ptr]
  w.op('CALLDATASIZE');
  w.op('DUP3'); // [ptr, cds, size, ptr]
  w.op('CALLDATACOPY', { note: 'zero-fill' }); // [ptr]
}

/**
 * Pushes a zero value of `type` onto the stack (net +1): `0` for a word, the `0x60` zero slot for
 * a string/bytes/dynamic `T[]` (an empty memref — `tuple[]` included), a freshly-allocated
 * flat block for a plain tuple (word members zero-filled, memref members set by
 * {@link emitZeroMemrefMembers}), or a fresh `[N][slot…]` block for a fixed-size `T[N]` (its
 * length is part of the type, so it can never be "empty": word slots are zero-filled, composite
 * slots each get their own typed zero via a loop). Matches the interpreter's `zeroValue`. Every call
 * allocates a NEW block for a tuple / fixed array: they have reference semantics, so two zero
 * values must never share one. `height` is the absolute operand-stack height on entry — the
 * fixed-array fill loop's labels are checked against it.
 */
export function emitZeroValue(w: AsmWriter, type: EvsType, height: number): void {
  if (isArrayValueType(type) && fixedLengthOf(type) !== null) {
    emitZeroFixedArray(w, type, height);
    return;
  }
  if (!isTupleType(type) || type.type !== 'tuple') {
    // a word, string/bytes, or any dynamic array (a `tuple[]` is an array: its zero is the empty
    // memref)
    w.push(isMemrefType(type) ? ZERO_SLOT : 0);
    return;
  }
  // the fill is the zero of the word members; memref members each get their typed zero below
  const hasWordMember = type.components.some((c) => !isMemrefType(abiParamToType(c)));
  emitAlloc(w, 32 * type.components.length, { zeroFill: hasWordMember }); // [flat]
  emitZeroMemrefMembers(w, type.components, height + 1);
}

/** The fixed-size arm of {@link emitZeroValue}: `[…] → [arr, …]` with `arr` a fresh `[N][slot…]`
 *  block — zero-filled word slots, or memref slots (composite element) each holding their own
 *  typed zero. */
function emitZeroFixedArray(w: AsmWriter, type: ArrayType | TupleType, height: number): void {
  const n = fixedLengthOf(type) ?? 0;
  const elem = elemTypeOf(type);
  const memrefSlots = isMemrefType(elem);
  // word slots: the fill is their zero value; memref slots are each written by the loop below
  emitAlloc(w, 32 + 32 * n, { zeroFill: !memrefSlots, note: `zero ${stringifyType(type)}` }); // [arr]
  w.push(n);
  w.op('DUP2');
  w.op('MSTORE'); // [arr]   length word = N
  if (!memrefSlots) return;
  // memref slots: p walks the slots DOWN from arr+32N to arr+32, storing a fresh typed zero into
  // each — two live words per level ([p, arr]; the bound is arr itself), so deeply nested
  // fixed-size zeros stay inside the stack window
  w.op('DUP1');
  w.push(32 * n);
  w.op('ADD'); // [p = arr+32N, arr]
  const head = w.newLabel('zero_fixed');
  const done = w.newLabel('zero_fixed_done');
  w.label(head, height + 2); // [p, arr]
  w.op('DUP2'); // [arr, p, arr]
  w.op('DUP2'); // [p, arr, p, arr]
  w.op('EQ'); // [p == arr, p, arr]
  w.pushLabel(done);
  w.op('JUMPI'); // [p, arr]
  emitZeroValue(w, elem, height + 2); // [zero, p, arr]
  w.op('DUP2'); // [p, zero, p, arr]
  w.op('MSTORE', { note: 'zero element' }); // [p, arr]
  w.push(32);
  w.op('SWAP1');
  w.op('SUB'); // [p−32, arr]
  w.pushLabel(head);
  w.op('JUMP');
  w.label(done, height + 2); // [p, arr]
  w.op('POP'); // [arr]
}

/**
 * With a fresh flat tuple block `[flat]` on top of the stack (left there), stores the zero
 * value of every memref member (string/bytes/`T[]` → `0x60`, nested tuple / fixed-size array → a
 * fresh zeroed block, recursively) into its slot, skipping the indices in `skip` (members the
 * caller initialises itself). Word members are left to the zero-fill — no code for them.
 * `height` is the absolute operand-stack height with `[flat]` on top.
 */
export function emitZeroMemrefMembers(
  w: AsmWriter,
  components: readonly NamedType[],
  height: number,
  skip?: ReadonlySet<number>,
): void {
  components.forEach((c, j) => {
    if (skip?.has(j) === true) return;
    const ct = abiParamToType(c);
    if (!isMemrefType(ct)) return; // word member stays 0 (zero-filled)
    emitZeroValue(w, ct, height); // [member, flat]
    w.op('DUP2'); // [flat, member, flat]
    if (j !== 0) {
      w.push(32 * j);
      w.op('ADD');
    }
    w.op('MSTORE', { note: `zero member [${j}]` }); // [flat]
  });
}
