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
 * The two scratch words are never live across a statement boundary. Each emitter aliases them
 * under a role name, and the phases that share a word never overlap:
 * - `0x00`: the running tail cursor of the return encoder / calldata templates (`TAIL_CURSOR` in
 *   `abi/shared.ts` and `call/shared.ts`), and the returndata snapshot base during output decode
 *   (`SNAP_SLOT` in `call/shared.ts` — live only after the call, once the calldata cursor is dead);
 * - `0x20`: the array-decode element base / heap-frame pointer during *decode* (`ELEM_BASE` /
 *   `DECODE_FRAME` in `abi/shared.ts`), the data-literal staging base during tuple-arg *encode*
 *   (`STAGING_SLOT` in `call/calldata.ts`), and the wrapper argsSize across the simulate payload
 *   copy (`SIM_ARGSIZE_SLOT` in `call/simulate-call.ts`).
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
  isDynamicType,
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

/** Free-memory-pointer slot. */
export const FREE_PTR = 0x40;

/** The never-written zero slot: an empty memref for string/bytes/`T[]` zero values. */
export const ZERO_SLOT = 0x60;

/** Start of the static frame (just above the zero slot). */
export const FRAME_BASE = 0x80;

/** 2^64 − 1 — the overflow-free bound for every decoded offset/length. */
export const MAX_U64 = 0xffffffffffffffffn;

/**
 * Pushes a zero value of `type` onto the stack (net +1): `0` for a word, the `0x60` zero slot for
 * a string/bytes/dynamic `T[]` (an empty memref — `tuple[]` included), a freshly-allocated
 * zero-filled flat block for a plain tuple (its memref members set by
 * {@link emitZeroMemrefMembers}), or a fresh `[N][slot…]` block for a fixed-size `T[N]` (its
 * length is part of the type, so it can never be "empty": word slots stay zero, composite slots
 * each get their own typed zero via a loop). Matches the interpreter's `zeroValue`. Every call
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
    w.push(isDynamicType(type) ? ZERO_SLOT : 0);
    return;
  }
  const n = type.components.length;
  // allocate 32·n, zero-fill via CALLDATACOPY past the calldata end (memory above freePtr is dirty)
  w.push(FREE_PTR);
  w.op('MLOAD'); // [flat]
  w.op('DUP1');
  w.push(32 * n);
  w.op('ADD'); // [flat+32n, flat]
  w.push(FREE_PTR);
  w.op('MSTORE'); // [flat]   freePtr bumped
  w.push(32 * n);
  w.op('CALLDATASIZE');
  w.op('DUP3'); // [flat, cds, 32n, flat]
  w.op('CALLDATACOPY', { note: 'zero-fill tuple' }); // [flat]
  emitZeroMemrefMembers(w, type.components, height + 1);
}

/** The fixed-size arm of {@link emitZeroValue}: `[…] → [arr, …]` with `arr` a fresh zero-filled
 *  `[N][slot…]` block whose memref slots (composite element) each hold their own typed zero. */
function emitZeroFixedArray(w: AsmWriter, type: ArrayType | TupleType, height: number): void {
  const n = fixedLengthOf(type) ?? 0;
  const elem = elemTypeOf(type);
  const bytes = 32 + 32 * n;
  w.push(FREE_PTR);
  w.op('MLOAD'); // [arr]
  w.op('DUP1');
  w.push(bytes);
  w.op('ADD'); // [arr+bytes, arr]
  w.push(FREE_PTR);
  w.op('MSTORE'); // [arr]   freePtr bumped
  w.push(bytes);
  w.op('CALLDATASIZE');
  w.op('DUP3'); // [arr, cds, bytes, arr]
  w.op('CALLDATACOPY', { note: `zero-fill ${stringifyType(type)}` }); // [arr]
  w.push(n);
  w.op('DUP2');
  w.op('MSTORE'); // [arr]   length word = N
  if (!isDynamicType(elem)) return; // word slots: the zero-fill already is their zero value
  // memref slots: p walks [arr+32, arr+32+32N), storing a fresh typed zero into each
  w.op('DUP1');
  w.push(32);
  w.op('ADD'); // [p, arr]
  w.op('DUP2');
  w.push(bytes);
  w.op('ADD'); // [end, p, arr]
  w.op('SWAP1'); // [p, end, arr]
  const head = w.newLabel('zero_fixed');
  const done = w.newLabel('zero_fixed_done');
  w.label(head, height + 3); // [p, end, arr]
  w.op('DUP2'); // [end, p, end, arr]
  w.op('DUP2'); // [p, end, p, end, arr]
  w.op('LT'); // [p < end, p, end, arr]
  w.op('ISZERO');
  w.pushLabel(done);
  w.op('JUMPI'); // [p, end, arr]
  emitZeroValue(w, elem, height + 3); // [zero, p, end, arr]
  w.op('DUP2'); // [p, zero, p, end, arr]
  w.op('MSTORE', { note: 'zero element' }); // [p, end, arr]
  w.push(32);
  w.op('ADD'); // [p+32, end, arr]
  w.pushLabel(head);
  w.op('JUMP');
  w.label(done, height + 3); // [p, end, arr]
  w.op('POP');
  w.op('POP'); // [arr]
}

/**
 * With a zero-filled flat tuple block `[flat]` on top of the stack (left there), stores the zero
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
    if (!isDynamicType(ct)) return; // word member stays 0 (zero-filled)
    emitZeroValue(w, ct, height); // [member, flat]
    w.op('DUP2'); // [flat, member, flat]
    if (j !== 0) {
      w.push(32 * j);
      w.op('ADD');
    }
    w.op('MSTORE', { note: `zero member [${j}]` }); // [flat]
  });
}
